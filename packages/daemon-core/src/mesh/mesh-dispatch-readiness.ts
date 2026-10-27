/**
 * DISPATCH-READINESS — is a LOCAL node's workspace fit to receive a task, decided
 * BEFORE the queue claim opens an attempt (mesh-queue-assignment.ts tryAssignQueueTask).
 *
 * The gap: the claim path gated only on a worktree bootstrap that is still RUNNING.
 * Once a node's bootstrap was terminal, nothing re-checked the tree, so a worker was
 * handed a workspace whose declared build outputs were gone (a base merge that touched
 * the lockfile, a `git clean`, a fresh clone whose bootstrap never built) or whose git
 * could not talk to its remote, and the task failed inside the worker instead of
 * waiting for a fit workspace.
 *
 * Three parts, each deliberately narrow:
 *
 *  1. DIAGNOSIS — synchronous, spawns nothing, writes nothing. Stats and small reads:
 *     - `missing_build`: a file the repo's worktree bootstrap DECLARES it produces
 *       (`readyOutputs` in .adhdev/worktree_bootstrap.json) is missing. Declared, never
 *       guessed: heuristic detection must not become an execution path (CLAUDE.md);
 *     - `git_locked`: a fresh `index.lock` in the workspace's git dir (another git is
 *       mid-write); an old one is reported as `stale_index_lock` but never waited on;
 *     - `git_transport`: no `origin` url, or an `ext::`/`fd::` transport (the remote
 *       helper runs arbitrary programs — never something a worker should invoke).
 *     Only `missing_build` (preparable) and a fresh `git_locked` (transient) defer a
 *     claim; the rest are diagnostics on the refusal record — the worker may never need
 *     the network, so a transport oddity is surfaced, not turned into a queue stall.
 *
 *  2. INVALIDATION — the verdict is cached per workspace under a FINGERPRINT of every
 *     input the diagnosis read: the checked-out branch (HEAD), git config, the
 *     bootstrap config, its staleInputs (stat signature) and the presence of each
 *     declared output. A source/config change (lockfile, manifest, bootstrap config,
 *     branch switch) produces a new fingerprint and a fresh diagnosis; an unchanged one
 *     reuses the verdict (including "preparation failed" — see 3). A worker's own
 *     commits on the same branch do NOT change it, so they never re-trigger a bootstrap.
 *
 *  3. PREPARATION — bounded, under the EXISTING physical lease. A preparable blocker
 *     runs the repo's own declared worktree bootstrap (`.adhdev/worktree_bootstrap.json`,
 *     already serialized per daemon and bounded by its per-command timeouts) while
 *     holding the workspace mutation lease the auto fast-forward uses — so claims on the
 *     workspace defer for its duration and no auto ff can move HEAD under the build.
 *     Single-flight per workspace; a held lease is a CONFLICT (no work at all); an abort
 *     stops the wait but the lease is released only when the underlying run settles, so
 *     nothing is dispatched into a half-built tree. A preparation that does not make
 *     the workspace ready is remembered for that fingerprint and the claim FAILS OPEN
 *     (the pre-existing behaviour) — never a permanent stall.
 *
 * Non-goals (owner rules): no disk reservations, no shared caches, no automatic GC, no
 * change to credentials or HOME. A repo with no `readyOutputs`, and every BASE node (whose
 * checkout belongs to a person, not the daemon), is never prepared or deferred.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeMeshWorkspaceForCompare } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { loadMeshWorktreeBootstrapConfig, MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS, runMeshWorktreeBootstrap } from './worktree-bootstrap-config.js';
import { releaseWorkspaceMutationLease, tryAcquireWorkspaceMutationLease } from './mesh-auto-fast-forward.js';

export type DispatchReadinessBlockerKind = 'missing_build' | 'git_locked' | 'stale_index_lock' | 'git_transport';

export interface DispatchReadinessBlocker {
    kind: DispatchReadinessBlockerKind;
    detail: string;
    /** Clearing it needs the repo's preparation (bootstrap). */
    preparable: boolean;
    /** It clears on its own; the claim waits for it. */
    transient: boolean;
}

export interface DispatchReadinessDiagnosis {
    workspace: string;
    fingerprint: string;
    ready: boolean;
    blockers: DispatchReadinessBlocker[];
}

/** An index.lock older than this is a crashed writer's, not a live one. */
export const DISPATCH_READINESS_FRESH_LOCK_MS = 2 * 60_000;
/** Upper bound on one preparation, on top of the bootstrap's own per-command timeouts. */
export const DISPATCH_READINESS_PREPARE_MAX_MS = 20 * 60_000;

function statSig(path: string): string {
    try {
        const st = statSync(path);
        return `${st.isDirectory() ? 'd' : 'f'}:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
        return 'absent';
    }
}

function readTextFile(path: string): string | null {
    try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** The worktree's own git dir and the common dir holding config/refs. */
function resolveGitDirs(workspace: string): { gitDir: string; commonDir: string } | null {
    const dotGit = join(workspace, '.git');
    let gitDir = dotGit;
    try {
        if (statSync(dotGit).isFile()) {
            const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
            if (!m) return null;
            gitDir = isAbsolute(m[1]) ? m[1] : resolve(workspace, m[1]);
        }
    } catch {
        return null;
    }
    const common = readTextFile(join(gitDir, 'commondir'))?.trim();
    return { gitDir, commonDir: common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir };
}

function remoteOriginUrl(configText: string | null): string | null {
    if (!configText) return null;
    let inOrigin = false;
    for (const raw of configText.split(/\r?\n/)) {
        const line = raw.trim();
        const section = /^\[\s*remote\s+"([^"]*)"\s*\]$/.exec(line);
        if (section) { inOrigin = section[1] === 'origin'; continue; }
        if (line.startsWith('[')) { inOrigin = false; continue; }
        if (!inOrigin) continue;
        const m = /^url\s*=\s*(.+)$/.exec(line);
        if (m) return m[1].trim();
    }
    return null;
}

/** Read-only, spawn-free diagnosis of a workspace. `now` is a test seam. */
export function diagnoseDispatchReadiness(workspace: string, opts?: { now?: number; readyOutputs?: readonly string[]; staleInputs?: readonly string[] }): DispatchReadinessDiagnosis {
    const now = opts?.now ?? Date.now();
    const blockers: DispatchReadinessBlocker[] = [];
    const inputs: string[] = [];
    for (const location of MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS) inputs.push(`bootstrap:${location}:${statSig(join(workspace, location))}`);
    for (const relative of opts?.staleInputs ?? []) inputs.push(`stale:${relative}:${statSig(join(workspace, relative))}`);

    const missing: string[] = [];
    for (const relative of opts?.readyOutputs ?? []) {
        const present = existsSync(join(workspace, relative));
        inputs.push(`out:${relative}:${present ? 1 : 0}`);
        if (!present) missing.push(relative);
    }
    if (missing.length) {
        blockers.push({ kind: 'missing_build', detail: `missing build output: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`, preparable: true, transient: false });
    }

    const dirs = resolveGitDirs(workspace);
    if (dirs) {
        const head = readTextFile(join(dirs.gitDir, 'HEAD'))?.trim() ?? '';
        // The branch, not its tip: a detached HEAD's sha is the checkout itself.
        inputs.push(`head:${head}`);
        const configPath = join(dirs.commonDir, 'config');
        const configText = readTextFile(configPath);
        inputs.push(`config:${statSig(configPath)}`);
        const lockPath = join(dirs.gitDir, 'index.lock');
        const lockSig = statSig(lockPath);
        inputs.push(`lock:${lockSig}`);
        if (lockSig !== 'absent') {
            let age = Number.POSITIVE_INFINITY;
            try { age = now - statSync(lockPath).mtimeMs; } catch { /* vanished between stats */ }
            if (age < DISPATCH_READINESS_FRESH_LOCK_MS) blockers.push({ kind: 'git_locked', detail: 'another git process holds index.lock', preparable: false, transient: true });
            else if (Number.isFinite(age)) blockers.push({ kind: 'stale_index_lock', detail: `index.lock is ${Math.round(age / 1000)}s old (a crashed writer?)`, preparable: false, transient: false });
        }
        const url = remoteOriginUrl(configText);
        if (!url) blockers.push({ kind: 'git_transport', detail: 'no origin remote url', preparable: false, transient: false });
        else if (/^(ext|fd)::/i.test(url)) blockers.push({ kind: 'git_transport', detail: `unsupported transport ${url.split('::')[0]}::`, preparable: false, transient: false });
    } else {
        inputs.push('git:absent');
    }

    const fingerprint = createHash('sha256').update(inputs.join('\n')).digest('hex').slice(0, 32);
    return { workspace, fingerprint, ready: !blockers.some(b => b.preparable || b.transient), blockers };
}

// ── Cache + preparation state ────────────────────────────────────────────────

interface ReadinessRecord {
    diagnosis: DispatchReadinessDiagnosis;
    /** A preparation ran for this fingerprint and did not make it ready. */
    preparationFailed?: string;
}

const readinessByWorkspace = new Map<string, ReadinessRecord>();
const preparing = new Map<string, Promise<DispatchPreparationResult>>();

export type DispatchPreparationOutcome = 'ready' | 'not_needed' | 'conflict' | 'cancelled' | 'failed' | 'not_configured' | 'joined';
export interface DispatchPreparationResult { outcome: DispatchPreparationOutcome; diagnosis: DispatchReadinessDiagnosis; detail?: string }
export type DispatchPreparationRunner = (mesh: any, workspace: string) => Promise<{ status?: string; error?: string }>;

function keyOf(workspace: string): string { return normalizeMeshWorkspaceForCompare(workspace) || workspace; }

function declaredInputs(mesh: any, workspace: string): { readyOutputs: string[]; staleInputs: string[] } | null {
    try {
        const config = loadMeshWorktreeBootstrapConfig(mesh, workspace).config;
        if (!config || config.enabled === false || !Array.isArray(config.readyOutputs) || config.readyOutputs.length === 0) return null;
        return { readyOutputs: config.readyOutputs, staleInputs: Array.isArray(config.staleInputs) ? config.staleInputs : [] };
    } catch {
        return null;
    }
}

/** The cached diagnosis when its fingerprint still matches the workspace, else a fresh one. */
export function currentDispatchReadiness(mesh: any, workspace: string): ReadinessRecord {
    const key = keyOf(workspace);
    const fresh = diagnoseDispatchReadiness(workspace, declaredInputs(mesh, workspace) ?? undefined);
    const cached = readinessByWorkspace.get(key);
    if (cached && cached.diagnosis.fingerprint === fresh.fingerprint) return cached;
    const record: ReadinessRecord = { diagnosis: fresh };
    readinessByWorkspace.set(key, record);
    const notes = fresh.blockers.filter(b => !b.preparable && !b.transient);
    if (notes.length) LOG.info('MeshQueue', `DISPATCH READINESS: ${workspace}: ${notes.map(b => `${b.kind} (${b.detail})`).join('; ')} — reported only, claims are not held for it`);
    return record;
}

export function isDispatchPreparationInFlight(workspace: string): boolean { return preparing.has(keyOf(workspace)); }

/**
 * Bring a workspace to readiness: the repo's declared worktree bootstrap, run under the
 * workspace mutation lease, single-flight per workspace, bounded by `maxMs`.
 */
export function prepareDispatchReadiness(mesh: any, workspace: string, opts?: {
    signal?: AbortSignal;
    maxMs?: number;
    runner?: DispatchPreparationRunner;
}): Promise<DispatchPreparationResult> {
    const key = keyOf(workspace);
    const inFlight = preparing.get(key);
    if (inFlight) return inFlight.then(result => ({ ...result, outcome: result.outcome === 'ready' ? 'ready' : 'joined' }));
    const before = currentDispatchReadiness(mesh, workspace).diagnosis;
    if (before.ready || !before.blockers.some(b => b.preparable)) return Promise.resolve({ outcome: 'not_needed', diagnosis: before });
    if (opts?.signal?.aborted) return Promise.resolve({ outcome: 'cancelled', diagnosis: before });
    if (!declaredInputs(mesh, workspace)) return Promise.resolve({ outcome: 'not_configured', diagnosis: before });
    if (!tryAcquireWorkspaceMutationLease(workspace)) return Promise.resolve({ outcome: 'conflict', diagnosis: before, detail: 'workspace mutation lease is held (auto fast-forward or another preparation)' });

    const runner = opts?.runner ?? runMeshWorktreeBootstrap;
    let settledRun: Promise<unknown> = Promise.resolve();
    const run = (async (): Promise<DispatchPreparationResult> => {
        const work = Promise.resolve().then(() => runner(mesh, workspace));
        settledRun = work.then(() => undefined, () => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const stop = new Promise<'timeout' | 'cancelled'>(resolveStop => {
            timer = setTimeout(() => resolveStop('timeout'), opts?.maxMs ?? DISPATCH_READINESS_PREPARE_MAX_MS);
            timer.unref?.();
            onAbort = () => resolveStop('cancelled');
            opts?.signal?.addEventListener('abort', onAbort, { once: true });
        });
        try {
            const first = await Promise.race([work.then(state => ({ state }), error => ({ error })), stop]);
            if (first === 'cancelled') return { outcome: 'cancelled', diagnosis: before };
            if (first === 'timeout') return { outcome: 'failed', diagnosis: before, detail: 'preparation exceeded its bound' };
            const after = currentDispatchReadiness(mesh, workspace).diagnosis;
            if ('error' in first) return { outcome: 'failed', diagnosis: after, detail: String((first.error as any)?.message ?? first.error) };
            const status = first.state?.status;
            if (after.ready) return { outcome: 'ready', diagnosis: after };
            return { outcome: 'failed', diagnosis: after, detail: `bootstrap ${status ?? 'ended'}${first.state?.error ? `: ${first.state.error}` : ''}; ${after.blockers.map(b => b.detail).join('; ')}` };
        } finally {
            if (timer) clearTimeout(timer);
            if (onAbort) opts?.signal?.removeEventListener('abort', onAbort);
        }
    })();
    const tracked = run.then(result => {
        if (result.outcome === 'failed') {
            const record = currentDispatchReadiness(mesh, workspace);
            record.preparationFailed = result.detail ?? 'preparation did not make the workspace ready';
            LOG.warn('MeshQueue', `DISPATCH READINESS: preparation of ${workspace} failed (${record.preparationFailed}) — claims proceed as before for this workspace state`);
        }
        return result;
    });
    preparing.set(key, tracked);
    // The lease (and the in-flight marker that defers claims) lasts until the RUN itself
    // settles — a cancelled or timed-out wait never hands a half-built tree to a claim.
    void tracked.then(() => settledRun).finally(() => {
        preparing.delete(key);
        releaseWorkspaceMutationLease(workspace);
    });
    return tracked;
}

/**
 * Claim-path verdict (synchronous) for a LOCAL WORKTREE node. `defer` = leave the task
 * pending this tick; a preparable blocker kicks one background preparation. Fails open
 * for a workspace state whose preparation already failed, and for any repo that
 * declares no `readyOutputs`.
 */
export function dispatchReadinessClaimVerdict(mesh: any, workspace: string | undefined, opts?: { runner?: DispatchPreparationRunner }): { defer: boolean; reason?: string; diagnostics: DispatchReadinessBlocker[] } {
    if (!workspace || !existsSync(workspace)) return { defer: false, diagnostics: [] };
    if (isDispatchPreparationInFlight(workspace)) return { defer: true, reason: 'dispatch_readiness_preparing', diagnostics: [] };
    if (!declaredInputs(mesh, workspace)) return { defer: false, diagnostics: [] };
    const record = currentDispatchReadiness(mesh, workspace);
    const { diagnosis } = record;
    const diagnostics = diagnosis.blockers.filter(b => !b.preparable && !b.transient);
    if (diagnosis.ready) return { defer: false, diagnostics };
    if (diagnosis.blockers.some(b => b.transient)) return { defer: true, reason: 'dispatch_readiness_git_locked', diagnostics };
    if (record.preparationFailed) return { defer: false, reason: `dispatch_readiness_preparation_failed: ${record.preparationFailed}`, diagnostics };
    void prepareDispatchReadiness(mesh, workspace, opts?.runner ? { runner: opts.runner } : undefined).catch(() => undefined);
    return { defer: true, reason: `dispatch_readiness_preparing: ${diagnosis.blockers.filter(b => b.preparable).map(b => b.detail).join('; ')}`, diagnostics };
}

export function __resetDispatchReadinessForTests(): void {
    readinessByWorkspace.clear();
    preparing.clear();
}
