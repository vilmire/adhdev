/**
 * Resolved launch trust plans and the daemon-owned worker trust ledger.
 *
 * A plan is resolved while the launch is being assembled. Runtime drivers only
 * receive absolute workspace/store paths and therefore never reinterpret `~`
 * through the daemon process's HOME.
 */
'use strict';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveConfigDir } from '../config/config-dir.js';
import type { PreLaunchTrust } from './spec/fsm-types.js';
import { isOverBroadTrustRoot, registeredGrokRepoRoot } from './workspace-trust-shared.js';

export type TrustScope = 'user' | 'worker';
export type TrustOrigin = 'user_confirmed' | 'worker_auto';

export interface TrustLifecycle {
    kind: 'persistent' | 'worktree';
    worktreePath?: string;
    meshId?: string;
    nodeId?: string;
    taskId?: string;
    /** ISO timestamp when known; null records that expiry is lifecycle-driven. */
    expiresAt: string | null;
}

/**
 * A repository-root grant that is authorized INDEPENDENTLY of the worker.
 *
 * Grok keys linked-worktree trust by the main repository (git common-dir
 * parent), not by the worktree path. Git metadata alone only nominates a
 * candidate; the grant exists only when that candidate is exactly one of the
 * owner's registered mesh roots (see cli-delegated-launch
 * `resolveOwnerRegisteredRepoRoots`). It is projected solely into the
 * worker-private store, so its lifetime is bounded by that private HOME, the
 * same as the worktree grant it accompanies.
 */
export interface AuthorizedRepoRootGrant {
    realpath: string;
    authority: 'owner_registered_mesh_node';
    meshId?: string;
}

export interface ResolvedTrustPlan {
    provider: string;
    workspaceRealpath: string;
    /** Grok worker plans only; absent means no repository-root grant. */
    authorizedRepoRoot?: AuthorizedRepoRootGrant;
    /** Absolute native trust-store path. Never contains `~`. */
    storePath: string;
    scope: TrustScope;
    origin: TrustOrigin;
    sessionKey: string;
    lifecycle: TrustLifecycle;
}

export interface ResolveTrustPlanInput {
    provider: string;
    workspace: string;
    trust: PreLaunchTrust;
    /** HOME against which a settings_path beginning with `~` is resolved. */
    storeHome: string;
    scope: TrustScope;
    origin: TrustOrigin;
    sessionKey: string;
    lifecycle: TrustLifecycle;
    /**
     * Owner-registered repository roots (absolute). Consulted only for a grok
     * worker plan, and only as an exact-match authority for the git-derived
     * repository root — never as a grant in its own right.
     */
    registeredRepoRoots?: readonly string[];
}

export function resolveWorkspaceRealpath(workspace: string): string {
    try {
        return fs.realpathSync(workspace);
    } catch {
        return path.resolve(workspace);
    }
}

function resolveSettingsStorePath(declaredPath: string, storeHome: string, workspaceRealpath: string): string {
    const trimmed = declaredPath.trim();
    if (trimmed === '~') return path.resolve(storeHome);
    if (trimmed.startsWith('~/')) return path.resolve(storeHome, trimmed.slice(2));
    if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
    return path.resolve(workspaceRealpath, trimmed);
}

/**
 * Resolve array-based trust stores, plus grok's TOML store for WORKER plans.
 *
 * Other named schemes retain their provider-owned behavior; kimi's
 * KIMI_CODE_HOME/os.homedir() resolution is unchanged and returns null here,
 * so it is materialized by the driver's named-scheme branch instead. A grok
 * USER plan also stays null: an interactive launch keeps honoring the owner's
 * own GROK_HOME exactly as before.
 *
 * A grok WORKER plan pins the store to `<storeHome>/.grok/trusted_folders.toml`
 * (the delegated launch exports GROK_HOME to that same directory), so the
 * projection can never land in the owner's store. It may carry an
 * `authorizedRepoRoot` — see `AuthorizedRepoRootGrant`.
 */
export function resolveLaunchTrustPlan(input: ResolveTrustPlanInput): ResolvedTrustPlan | null {
    if ('scheme' in input.trust) {
        if (input.trust.scheme !== 'grok_toml_file' || input.scope !== 'worker') return null;
        return resolveGrokWorkerTrustPlan(input);
    }
    const workspaceRealpath = resolveWorkspaceRealpath(input.workspace);
    const storePath = resolveSettingsStorePath(input.trust.settings_path, input.storeHome, workspaceRealpath);
    if (!path.isAbsolute(storePath)) throw new Error('resolved trust store path must be absolute');
    return {
        provider: input.provider,
        workspaceRealpath,
        storePath,
        scope: input.scope,
        origin: input.origin,
        sessionKey: input.sessionKey,
        lifecycle: { ...input.lifecycle },
    };
}

function resolveGrokWorkerTrustPlan(input: ResolveTrustPlanInput): ResolvedTrustPlan {
    const workspaceRealpath = resolveWorkspaceRealpath(input.workspace);
    const configRoot = path.resolve(input.storeHome, '.grok');
    const storePath = path.join(configRoot, 'trusted_folders.toml');
    if (!path.isAbsolute(storePath)) throw new Error('resolved trust store path must be absolute');
    const repoRoot = registeredGrokRepoRoot(input.workspace, input.registeredRepoRoots || []);
    const authorizedRepoRoot = repoRoot
        && repoRoot !== workspaceRealpath
        && !isOverBroadTrustRoot(repoRoot, configRoot)
        ? {
            realpath: repoRoot,
            authority: 'owner_registered_mesh_node' as const,
            ...(input.lifecycle.meshId ? { meshId: input.lifecycle.meshId } : {}),
        }
        : undefined;
    return {
        provider: input.provider,
        workspaceRealpath,
        ...(authorizedRepoRoot ? { authorizedRepoRoot } : {}),
        storePath,
        scope: input.scope,
        origin: input.origin,
        sessionKey: input.sessionKey,
        lifecycle: { ...input.lifecycle },
    };
}

export function loadPreLaunchTrustFromSpecPath(specPath: unknown): PreLaunchTrust | null {
    if (typeof specPath !== 'string' || !specPath.trim()) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { pre_launch_trust?: unknown };
        const trust = parsed?.pre_launch_trust;
        if (!trust || typeof trust !== 'object' || Array.isArray(trust)) return null;
        const candidate = trust as { scheme?: unknown; settings_path?: unknown; key?: unknown };
        if (candidate.scheme === 'kimi_workspace_file') return { scheme: 'kimi_workspace_file' };
        if (candidate.scheme === 'grok_toml_file') return { scheme: 'grok_toml_file' };
        if (candidate.scheme === 'codex_toml_file') return { scheme: 'codex_toml_file' };
        if (candidate.scheme === 'claude_json_projects') return { scheme: 'claude_json_projects' };
        if (typeof candidate.settings_path === 'string' && candidate.settings_path.trim()
            && typeof candidate.key === 'string' && candidate.key.trim()) {
            return { settings_path: candidate.settings_path, key: candidate.key };
        }
        return null;
    } catch {
        return null;
    }
}

export interface WorkerTrustUsage {
    sessionKey: string;
    taskId?: string;
    storePath: string;
    firstUsedAt: string;
    lastUsedAt: string;
    lifecycle: TrustLifecycle;
}

export interface WorkerTrustGrant {
    grantId: string;
    provider: string;
    workspaceRealpath: string;
    scope: 'worker';
    origin: 'worker_auto';
    firstUsedAt: string;
    lastUsedAt: string;
    lifecycle: TrustLifecycle;
    /** Latest independently authorized repository-root grant, if any. */
    authorizedRepoRoot?: AuthorizedRepoRootGrant;
    usages: WorkerTrustUsage[];
}

export interface WorkerTrustLedger {
    version: 1;
    grants: WorkerTrustGrant[];
}

export interface RecordWorkerTrustResult {
    ledgerPath: string;
    grant: WorkerTrustGrant;
    reused: boolean;
}

export function resolveWorkerTrustLedgerPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
): string {
    return path.join(resolveConfigDir(env, homeDir), 'trust', 'worker-auto-grants.json');
}

function readLedger(ledgerPath: string): WorkerTrustLedger {
    try {
        const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as WorkerTrustLedger;
        if (parsed?.version !== 1 || !Array.isArray(parsed.grants)) {
            throw new Error('unsupported trust ledger format');
        }
        return parsed;
    } catch (err: any) {
        if (err?.code === 'ENOENT') return { version: 1, grants: [] };
        throw err;
    }
}

function lifecycleExpired(lifecycle: TrustLifecycle, nowMs: number): boolean {
    if (!lifecycle.expiresAt) return false;
    const expiresAt = Date.parse(lifecycle.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

export function findActiveWorkerAutoGrant(
    ledger: WorkerTrustLedger,
    plan: ResolvedTrustPlan,
    nowMs = Date.now(),
): WorkerTrustGrant | null {
    return ledger.grants.find((grant) => grant.provider === plan.provider
        && grant.workspaceRealpath === plan.workspaceRealpath
        && grant.scope === 'worker'
        && grant.origin === 'worker_auto'
        && !lifecycleExpired(grant.lifecycle, nowMs)) || null;
}

function writeLedger(ledgerPath: string, ledger: WorkerTrustLedger): void {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, ledgerPath);
        if (process.platform !== 'win32') fs.chmodSync(ledgerPath, 0o600);
    } catch (err) {
        try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
        throw err;
    }
}

/** Query/upsert a worker-auto grant before its private native projection exists. */
export function recordWorkerAutoTrustGrant(
    plan: ResolvedTrustPlan,
    opts: { ledgerPath?: string; nowMs?: number; env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): RecordWorkerTrustResult {
    if (plan.scope !== 'worker' || plan.origin !== 'worker_auto') {
        throw new Error('worker trust ledger accepts only worker_auto/worker plans');
    }
    if (!path.isAbsolute(plan.storePath) || !path.isAbsolute(plan.workspaceRealpath)) {
        throw new Error('worker trust ledger requires absolute resolved paths');
    }

    const nowMs = opts.nowMs ?? Date.now();
    const now = new Date(nowMs).toISOString();
    const ledgerPath = opts.ledgerPath || resolveWorkerTrustLedgerPath(opts.env, opts.homeDir);
    const ledger = readLedger(ledgerPath);
    let grant = findActiveWorkerAutoGrant(ledger, plan, nowMs);
    const reused = grant !== null;
    const usage = grant?.usages.find((candidate) => candidate.sessionKey === plan.sessionKey);

    if (!grant) {
        grant = {
            grantId: crypto.randomUUID(),
            provider: plan.provider,
            workspaceRealpath: plan.workspaceRealpath,
            scope: 'worker',
            origin: 'worker_auto',
            firstUsedAt: now,
            lastUsedAt: now,
            lifecycle: { ...plan.lifecycle },
            usages: [],
        };
        ledger.grants.push(grant);
    } else {
        grant.lastUsedAt = now;
        grant.lifecycle = { ...plan.lifecycle };
    }
    // Provenance follows the CURRENT authority: a root that is no longer
    // owner-registered must not linger as if it were still authorized.
    if (plan.authorizedRepoRoot) grant.authorizedRepoRoot = { ...plan.authorizedRepoRoot };
    else delete grant.authorizedRepoRoot;

    if (usage) {
        usage.lastUsedAt = now;
        usage.storePath = plan.storePath;
        usage.lifecycle = { ...plan.lifecycle };
        if (plan.lifecycle.taskId) usage.taskId = plan.lifecycle.taskId;
    } else {
        grant.usages.push({
            sessionKey: plan.sessionKey,
            ...(plan.lifecycle.taskId ? { taskId: plan.lifecycle.taskId } : {}),
            storePath: plan.storePath,
            firstUsedAt: now,
            lastUsedAt: now,
            lifecycle: { ...plan.lifecycle },
        });
    }

    writeLedger(ledgerPath, ledger);
    return { ledgerPath, grant, reused };
}

