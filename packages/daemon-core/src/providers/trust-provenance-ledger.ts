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

export interface ResolvedTrustPlan {
    provider: string;
    workspaceRealpath: string;
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
 * Resolve array-based trust stores. Named schemes retain their provider-owned
 * behavior until that provider receives a private HOME; this intentionally
 * leaves kimi's current KIMI_CODE_HOME/os.homedir() behavior unchanged.
 */
export function resolveLaunchTrustPlan(input: ResolveTrustPlanInput): ResolvedTrustPlan | null {
    if ('scheme' in input.trust) return null;
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

export function loadPreLaunchTrustFromSpecPath(specPath: unknown): PreLaunchTrust | null {
    if (typeof specPath !== 'string' || !specPath.trim()) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { pre_launch_trust?: unknown };
        const trust = parsed?.pre_launch_trust;
        if (!trust || typeof trust !== 'object' || Array.isArray(trust)) return null;
        const candidate = trust as { scheme?: unknown; settings_path?: unknown; key?: unknown };
        if (candidate.scheme === 'kimi_workspace_file') return { scheme: 'kimi_workspace_file' };
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

