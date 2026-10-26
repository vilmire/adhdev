/** Task-worker lifetime reaper: accepted completion, per-machine idle cap and TTL.
 * All paths preserve session records and fail closed on unreadable work/runtime state.
 */

import { LOG } from '../logging/logger.js';
import type { RepoMeshPolicy } from '../repo-mesh-types.js';
import { resolveDelegatedSessionIdleTtlMs } from '../repo-mesh-types.js';
import { acceptedCompletionSessionIds, isSafeIdleTaskSession, includesSession, resetSessionStopRetries, sessionStopRetryDue, recordSessionStopFailure, clearSessionStopRetry } from './mesh-session-lifetime.js';
import { getQueue } from './mesh-work-queue.js';
import { getActiveDirectDispatchesStrict } from './mesh-direct-dispatch.js';
import { sessionIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';

/**
 * The subset of a SessionHostRecord this pass reads. Declared structurally rather
 * than importing SessionHostRecord so the pure selector stays testable with plain
 * object literals and daemon-core keeps no new value dependency on session-host-core.
 */
export interface ReapableSessionRecord {
    sessionId: string;
    state?: any;
    claimFence?: import('./mesh-session-stop-fence.js').SessionClaimFence;
    checkpointPending?: boolean;
    machineId?: string;
    lastActivityAt?: number;
    lifecycle?: string;
    surfaceKind?: string;
    meta?: Record<string, unknown> | null;
}

/** Why a candidate was kept. Surfaced in the dry-run plan and the debug log. */
type IdleSessionReapSkipReason =
    | 'unsafe_runtime'
    | 'not_live_runtime'
    | 'coordinator_session'
    | 'not_coordinator_launched'
    | 'other_mesh'
    | 'missing_last_activity'
    | 'within_ttl'
    | 'holds_active_task';

interface IdleSessionReapPlan {
    /** Sessions whose CLI runtime should be stopped (record preserved). */
    reap: Array<{ sessionId: string; idleMs: number; reason?: string }>;
    /** Every non-reaped candidate with the reason it was kept. */
    skipped: Array<{ sessionId: string; reason: IdleSessionReapSkipReason; idleMs?: number }>;
}

function readStringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Session ids that must not be reaped because they still hold non-terminal mesh work.
 *
 * Two independent sources, because a delegate can be driven either way:
 *  - the WORK QUEUE: entries in a non-terminal status ('pending' | 'assigned' —
 *    MeshActiveTaskStatus) carry `assignedSessionId` once claimed;
 *  - DIRECT DISPATCHES: `mesh_send_task` work that never becomes a queue row, keyed
 *    by `sessionId`, of which only the active (un-terminated) rows are returned.
 *
 * A pending queue row that is not yet assigned to any session contributes no id —
 * correctly, since it pins no particular session.
 *
 * ★THROWS when either source cannot be read (fail-closed). An unreadable queue is
 * NOT an empty queue: an empty holder set returned after a failed read would let
 * the pass reap sessions that are actively holding work (the 2026-10-10 orphan RCA,
 * finding D2). runIdleSessionReapPass catches the throw and aborts the whole pass —
 * it stops nobody — rather than reaping on untrusted data.
 *
 * Exported for direct testing: this set is the "(b) no assigned/generating/waiting
 * task" condition, and getting it wrong reaps a session mid-task.
 */
export function collectSessionIdsWithActiveWork(meshId: string, records?: ReapableSessionRecord[]): Set<string> {
    const ids = new Set<string>();
    for (const task of getQueue(meshId, { status: ['pending', 'assigned'] as any })) {
        const sessionId = readStringValue((task as any)?.assignedSessionId);
        if (sessionId) ids.add(sessionId);
        const target = readStringValue(task.targetSessionId);
        if (target) {
            const record = records?.find(r => sessionIdsEquivalent(r.sessionId, target));
            const nodeId = readStringValue(record?.meta?.meshNodeId);
            // A contradictory branch/node pin cannot reuse this physical session.
            if (!task.targetNodeId || !nodeId || meshNodeIdMatches({ nodeId }, task.targetNodeId)) ids.add(target);
        }
    }
    for (const dispatch of getActiveDirectDispatchesStrict(meshId)) {
        const sessionId = readStringValue((dispatch as any)?.sessionId);
        if (sessionId) ids.add(sessionId);
    }
    return ids;
}

/**
 * True when `candidate` is held by any id in `activeWorkSessionIds`.
 *
 * Uses `sessionIdsEquivalent`, never a raw `===`: session ids reach the queue store
 * and the session-host registry through several serialization forms, and a raw
 * comparison here is exactly the canon-identity defect class `check:canon-identity`
 * exists to catch. A raw miss would read a busy session as free and reap it mid-task.
 */
function heldByActiveWork(candidate: string, activeWorkSessionIds: Set<string>): boolean {
    for (const held of activeWorkSessionIds) {
        if (sessionIdsEquivalent(held, candidate)) return true;
    }
    return false;
}

/**
 * Pure selector: decide which delegate sessions are reapable. No I/O, no clock —
 * `now`, the records and the active-work set are all injected, so every branch is
 * testable without booting a daemon or a session host.
 *
 * Order matters only for the reported skip reason (the first matching exclusion
 * wins); the reap/keep verdict itself is independent of ordering.
 */
export function planIdleSessionReap(args: {
    meshId: string;
    records: ReapableSessionRecord[];
    activeWorkSessionIds: Set<string>;
    ttlMs: number;
    now: number;
    maxIdleSessions?: number;
    acceptedSessionIds?: Set<string>;
}): IdleSessionReapPlan {
    const { meshId, records, activeWorkSessionIds, ttlMs, now } = args;
    const plan: IdleSessionReapPlan = { reap: [], skipped: [] };
    if (!Array.isArray(records)) return plan;
    const eligible: Array<{ sessionId: string; idleMs: number; machineId: string; inMesh: boolean }> = [];

    for (const record of records) {
        const sessionId = readStringValue(record?.sessionId);
        if (!sessionId) continue;
        const meta = (record?.meta && typeof record.meta === 'object') ? record.meta : {};
        const skip = (reason: IdleSessionReapSkipReason, idleMs?: number) =>
            plan.skipped.push({ sessionId, reason, ...(idleMs !== undefined ? { idleMs } : {}) });

        // Only a live CLI runtime has anything to reclaim. A recovery_snapshot /
        // inactive_record is already runtime-free — stopping it is a no-op that would
        // only churn the ledger. `surfaceKind` is optional on the record, so absence is
        // tolerated and only an explicit non-live kind excludes.
        const surfaceKind = readStringValue(record?.surfaceKind);
        const lifecycle = readStringValue(record?.lifecycle);
        if ((surfaceKind && surfaceKind !== 'live_runtime')
            || (lifecycle && lifecycle !== 'running' && lifecycle !== 'starting')) {
            skip('not_live_runtime');
            continue;
        }

        // (c) NEVER the coordinator. Same marker the cleanupMeshSessions guard uses.
        if (readStringValue(meta.meshCoordinatorFor) === meshId) {
            skip('coordinator_session');
            continue;
        }

        // (d) Only coordinator-LAUNCHED delegates. Fail-closed: a session the owner
        // opened in the dashboard carries no such marker and is kept. This is the
        // exclusion that must never yield a false positive — see SAFETY POSTURE.
        if (meta.launchedByCoordinator !== true) {
            skip('not_coordinator_launched');
            continue;
        }

        // Count other meshes on the same machine for the idle cap, but only stop
        // sessions belonging to this mesh during this pass.
        const meshNodeFor = readStringValue(meta.meshNodeFor);
        const inMesh = !meshNodeFor || meshNodeFor === meshId;

        if (!isSafeIdleTaskSession(record.state, meta) || record.checkpointPending) {
            skip('unsafe_runtime');
            continue;
        }

        // (a) Idle age. `lastActivityAt` is required on a real SessionHostRecord; a
        // record missing it cannot be aged and is kept rather than guessed at.
        const lastActivityAt = typeof record?.lastActivityAt === 'number' && Number.isFinite(record.lastActivityAt)
            ? record.lastActivityAt
            : undefined;
        if (lastActivityAt === undefined) {
            skip('missing_last_activity');
            continue;
        }
        const idleMs = now - lastActivityAt;

        // (b) No non-terminal task bound to this session.
        if (heldByActiveWork(sessionId, activeWorkSessionIds)) {
            // Carry the age so the pass can report holders past the TTL.
            skip(ttlMs > 0 && idleMs >= ttlMs ? 'holds_active_task' : 'within_ttl', idleMs);
            continue;
        }

        if (idleMs < 0) { skip('within_ttl'); continue; }
        eligible.push({ sessionId, idleMs, machineId: record.machineId || 'local', inMesh });
    }
    const cap = args.maxIdleSessions ?? 0;
    const excess = new Set<string>();
    const machines = new Set(eligible.map(r => r.machineId));
    for (const machine of machines) {
        const idle = eligible.filter(r => r.machineId === machine).sort((a, b) => b.idleMs - a.idleMs || a.sessionId.localeCompare(b.sessionId));
        // Accepted workers already leaving do not evict additional reuse candidates.
        const retained = idle.filter(r => !includesSession(args.acceptedSessionIds ?? new Set(), r.sessionId) && !(ttlMs > 0 && r.idleMs >= ttlMs));
        if (cap > 0) for (const r of retained.slice(0, Math.max(0, retained.length - cap))) excess.add(r.sessionId);
    }
    for (const r of eligible.sort((a, b) => b.idleMs - a.idleMs)) {
        if (!r.inMesh) { plan.skipped.push({ sessionId: r.sessionId, reason: 'other_mesh' }); continue; }
        const reason = includesSession(args.acceptedSessionIds ?? new Set(), r.sessionId) ? 'accepted_completion'
            : ttlMs > 0 && r.idleMs >= ttlMs ? 'idle_ttl_exceeded'
            : excess.has(r.sessionId) ? 'idle_machine_cap' : undefined;
        if (reason) plan.reap.push({ sessionId: r.sessionId, idleMs: r.idleMs, reason });
        else plan.skipped.push({ sessionId: r.sessionId, reason: 'within_ttl' });
    }
    return plan;
}

/** A kept-past-TTL holder is re-reported at most this often per (mesh, session). */
export const IDLE_HOLDER_REPORT_INTERVAL_MS = 30 * 60_000;
const idleHolderReportedAt = new Map<string, number>();

/** Test-only reset of the kept-past-TTL report de-dup. */
export function resetIdleHolderReports(): void {
    idleHolderReportedAt.clear();
}

/**
 * Report delegates the reaper KEPT although they are idle past the TTL, because a
 * non-terminal task is still bound to them. A healthy session never sits there:
 * a task that is really running keeps the PTY (and so the idle clock) moving. The
 * shape seen live (2026-10-11) is a task that can no longer be closed — its
 * completion report was refused — pinning a finished worker's runtime for hours
 * with nothing in the log saying why the reaper left it alone.
 *
 * Content-free (ids + durations). Returns the session ids reported this call.
 */
export function reportIdlePastTtlHolders(args: {
    meshId: string;
    plan: IdleSessionReapPlan;
    ttlMs: number;
    now: number;
}): string[] {
    const reported: string[] = [];
    for (const entry of args.plan.skipped) {
        if (entry.reason !== 'holds_active_task' || typeof entry.idleMs !== 'number') continue;
        const key = `${args.meshId}:${entry.sessionId}`;
        const last = idleHolderReportedAt.get(key);
        if (last !== undefined && (args.now - last) < IDLE_HOLDER_REPORT_INTERVAL_MS) continue;
        idleHolderReportedAt.set(key, args.now);
        reported.push(entry.sessionId);
        LOG.warn(
            'MeshIdleSessionReaper',
            `Kept idle delegated session ${entry.sessionId} (mesh ${args.meshId}): idle ${Math.round(entry.idleMs / 60_000)}m `
            + `≥ TTL ${Math.round(args.ttlMs / 60_000)}m but a non-terminal task is still assigned to it `
            + `(reason=holds_active_task). A task that is really running keeps the session active, so this is `
            + `likely a stuck assignment — check the task with mesh_view_queue and cancel or requeue it; `
            + `the runtime is reclaimed once the task is terminal.`,
        );
    }
    return reported;
}

/** An aborted pass (unreadable active-work) is re-reported at most this often per mesh. */
export const REAP_ABORT_REPORT_INTERVAL_MS = 15 * 60_000;
const reapAbortReportedAt = new Map<string, number>();

/** Test-only reset of the aborted-pass report de-dup. */
export function resetReapAbortReports(): void {
    reapAbortReportedAt.clear();
}

/**
 * Bounded-cadence diagnostic for an aborted reap pass. One warn per mesh per
 * interval: the pass rides the 5-minute housekeeping tick, so an unbounded log
 * would spam the daemon log for as long as the queue store stays unreadable,
 * while zero log lines is exactly the "reaper silently never runs" blindness
 * this pass exists to close.
 */
function reportReapAborted(meshId: string, now: number, error: unknown): void {
    const last = reapAbortReportedAt.get(meshId);
    if (last !== undefined && (now - last) < REAP_ABORT_REPORT_INTERVAL_MS) return;
    reapAbortReportedAt.set(meshId, now);
    const message = error instanceof Error ? error.message : String(error);
    LOG.warn(
        'MeshIdleSessionReaper',
        `Idle session reap ABORTED for mesh ${meshId}: the active-work enumeration (queue/direct dispatches) `
        + `could not be read (${message}). An unreadable queue is not an empty queue — no session was stopped. `
        + `Legitimate reaping resumes on the next tick once the read succeeds.`,
    );
}

/** Injected side effects, so the orchestrator is testable without a router. */
export interface IdleSessionReaperDeps {
    listSessions(): Promise<ReapableSessionRecord[]>;
    /** Existing persisted output read; injectable for focused tests. */
    acceptedSessionIds?(meshId: string): Set<string>;
    /** Stop executor; must confirm the stopped ids, with host-side safety checks. */
    cleanupMeshSessions(args: {
        meshId: string;
        nodeId: string;
        node: any;
        mode: 'stop';
        sessionIds: string[];
        dryRun?: boolean;
        source: 'mesh_cleanup_sessions';
    }): Promise<{ success: boolean; [key: string]: unknown }>;
}

interface IdleSessionReapOutcome {
    plan: IdleSessionReapPlan;
    stoppedSessionIds: string[];
    /** Cumulative count of runtimes this daemon has stopped, for observability. */
    totalStopped: number;
    /**
     * Set when the pass deliberately stopped NOBODY because the active-work
     * enumeration could not be read. Distinct from an empty plan (nothing to
     * reap): here the pass never computed a plan at all.
     */
    abortedReason?: 'active_work_unreadable';
}

/** Process-lifetime count of reaped sessions (observability requirement 4). */
let reapedSessionCount = 0;

/** Test-only reset of the cumulative counter. */
export function resetIdleSessionReapCounter(): void {
    reapedSessionCount = 0;
    resetSessionStopRetries();
}

export function getIdleSessionReapCount(): number {
    return reapedSessionCount;
}

/**
 * Run one reaper pass for a single mesh. Best-effort by contract: this rides the
 * reconcile tick, so a throw here must never break reconciliation — every failure is
 * logged and swallowed, and the next tick simply retries.
 *
 * Returns the plan and what was actually stopped (empty on dry-run).
 */
export async function runIdleSessionReapPass(
    deps: IdleSessionReaperDeps,
    args: {
        meshId: string;
        policy: RepoMeshPolicy | undefined;
        now?: number;
        dryRun?: boolean;
    },
): Promise<IdleSessionReapOutcome> {
    const empty: IdleSessionReapOutcome = {
        plan: { reap: [], skipped: [] },
        stoppedSessionIds: [],
        totalStopped: reapedSessionCount,
    };
    const now = args.now ?? Date.now();
    const ttlMs = resolveDelegatedSessionIdleTtlMs(args.policy?.delegatedSessionIdleTtlMinutes);
    // TTL, count cap, and accepted-completion reclamation disable independently.
    const rawCap = args.policy?.maxIdleDelegatedSessionsPerMachine;
    const cap = typeof rawCap === 'number' && Number.isFinite(rawCap) ? Math.max(0, Math.min(100, Math.floor(rawCap))) : 2;
    const stopAccepted = args.policy?.stopDelegatedSessionOnAcceptedCompletion !== false;
    if (ttlMs <= 0 && cap === 0 && !stopAccepted) return empty;

    let records: ReapableSessionRecord[] = [];
    try {
        records = await deps.listSessions();
    } catch (e: any) {
        LOG.warn('MeshIdleSessionReaper', `listSessions failed for mesh ${args.meshId}: ${e?.message || e}`);
        return empty;
    }

    // FAIL-CLOSED on an unreadable active-work enumeration: an unreadable queue is
    // NOT an empty queue. collectSessionIdsWithActiveWork throws (see its contract);
    // abort the whole pass — stop nobody, compute no plan — and emit one bounded
    // diagnostic. The next tick retries, so a transient store failure delays
    // reaping by one interval instead of killing sessions that hold live work.
    let activeWorkSessionIds: Set<string>;
    let acceptedSessionIds = new Set<string>();
    try {
        activeWorkSessionIds = collectSessionIdsWithActiveWork(args.meshId, records);
        // The policy bounds the machine, including idle sessions on sibling worktree
        // nodes/meshes. Their work must be enumerated before they enter the cap count.
        for (const meshId of new Set(records.map(r => readStringValue(r.meta?.meshNodeFor)).filter(Boolean))) {
            if (meshId !== args.meshId) for (const id of collectSessionIdsWithActiveWork(meshId, records)) activeWorkSessionIds.add(id);
        }
        if (stopAccepted) acceptedSessionIds = deps.acceptedSessionIds?.(args.meshId)
            ?? acceptedCompletionSessionIds(args.meshId, records);
    } catch (e: any) {
        reportReapAborted(args.meshId, now, e);
        return { ...empty, abortedReason: 'active_work_unreadable' };
    }

    const plan = planIdleSessionReap({
        meshId: args.meshId,
        records,
        activeWorkSessionIds,
        ttlMs,
        now,
        maxIdleSessions: cap,
        acceptedSessionIds,
    });
    if (!args.dryRun) reportIdlePastTtlHolders({ meshId: args.meshId, plan, ttlMs, now });
    if (plan.reap.length === 0) return { ...empty, plan };

    if (args.dryRun) {
        return { plan, stoppedSessionIds: [], totalStopped: reapedSessionCount };
    }

    const stoppedSessionIds: string[] = [];
    // Stop one session per call so a single failing session cannot suppress the rest
    // (cleanupMeshSessions reports success:false for the whole batch on any error).
    for (const target of plan.reap) {
        const retryKey = `${args.meshId}:${target.sessionId}`;
        if (!sessionStopRetryDue(retryKey, now)) continue;
        try {
            const result = await deps.cleanupMeshSessions({
                meshId: args.meshId,
                nodeId: '',
                node: undefined,
                mode: 'stop',
                sessionIds: [target.sessionId],
                source: 'mesh_cleanup_sessions',
            });
            if (!result.success || !Array.isArray(result.stoppedSessionIds)
                || !result.stoppedSessionIds.some((id: string) => sessionIdsEquivalent(id, target.sessionId))) {
                throw new Error(String(result.error || 'stop_not_confirmed'));
            }
            clearSessionStopRetry(retryKey);
            stoppedSessionIds.push(target.sessionId);
            reapedSessionCount += 1;
            // Requirement 4: one INFO line per stop — session id, idle age, reason.
            // Content-free by construction (id + duration only, never transcript text).
            LOG.info(
                'MeshIdleSessionReaper',
                `Stopped idle delegated session ${target.sessionId} (mesh ${args.meshId}, `
                + `idle ${Math.round(target.idleMs / 60_000)}m, TTL ${Math.round(ttlMs / 60_000)}m, `
                + `reason=${target.reason}, record preserved; total stopped=${reapedSessionCount})`,
            );
        } catch (e: any) {
            const retry = recordSessionStopFailure(retryKey, now);
            LOG.warn(
                'MeshIdleSessionReaper',
                `Stop retry ${retry.attempts} scheduled at ${new Date(retry.nextAt).toISOString()}. Failed to stop idle delegated session ${target.sessionId} (mesh ${args.meshId}): ${e?.message || e}`,
            );
        }
    }
    return { plan, stoppedSessionIds, totalStopped: reapedSessionCount };
}
