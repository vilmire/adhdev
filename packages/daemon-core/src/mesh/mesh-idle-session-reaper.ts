/**
 * Idle delegated-session reaper.
 *
 * A coordinator-launched delegate session stays idle-LIVE after its task ends —
 * `completed` means the task finished, not that the CLI runtime exited. Existing
 * cleanup is entirely EDGE-triggered (node removal → sessionCleanupOnNodeRemove,
 * MAGI fan-out terminal → magiSessionCleanup, worktree convergence → PHASE 6.5),
 * so a one-off delegate launched on the BASE node — an investigation or docs task,
 * with no node removal, no worktree, and no MAGI marker — is never reclaimed by
 * anything. Measured locally 2026-08-28: 27 live `claude` processes / 2.9GB RSS /
 * 27 session records with no TTL concept anywhere.
 *
 * This adds the missing AGE-triggered pass: a delegate idle past
 * `delegatedSessionIdleTtlMinutes` (default 30) has its CLI runtime STOPPED while
 * its record is PRESERVED, so the transcript stays inspectable.
 *
 * WHY STOP AND NOT DELETE: the value being reclaimed is the live CLI process (RSS,
 * provider quota, PTY); the record costs almost nothing and is the only remaining
 * evidence of what the delegate did. `mode: 'stop'` in cleanupMeshSessions keeps the
 * record; `delete_stopped` is a different contract and is deliberately NOT used here
 * (it also skips live runtimes by contract, so it would no-op on exactly the
 * idle-LIVE sessions this pass targets — the same trap documented on
 * RepoMeshMagiSessionCleanupMode).
 *
 * REUSES, rather than reinventing, three existing mechanisms:
 *  1. EXECUTION — `cleanupMeshSessions({ mode: 'stop', sessionIds })`
 *     (commands/router-worktree-cleanup.ts). It already stamps
 *     `recordIntentionalMeshSessionStop` so the stop is not misread as a crash by
 *     the completion/redrive path, already skips the coordinator unconditionally,
 *     and already supports dryRun. This module only decides WHICH sessions; that
 *     function decides HOW to stop them.
 *  2. COORDINATOR EXCLUSION — `meta.meshCoordinatorFor === meshId`, the same marker
 *     used by cleanupMeshSessions' own guard and by findLiveCoordinators /
 *     mesh-idle-reminder. Checked HERE as well as there (defense in depth): passing
 *     explicit sessionIds sets hasExplicitSessionIds, and this module must never
 *     rely on a downstream guard to protect the coordinator.
 *  3. REUSE-POOL EXCLUSION — none needed. `isIdleSessionState` rejects any status in
 *     `isTerminalSessionStatus` (mesh-candidacy-predicates.ts), which includes
 *     'stopped', so a reaped session drops out of the drain candidate pool in
 *     mesh-queue-assignment.ts by construction. A regression test locks this
 *     (a reaped session must never be picked for dispatch — that class of bug is
 *     what the delivered-not-consumed redrive work already paid for once).
 *
 * IDLE CLOCK: `SessionHostRecord.lastActivityAt` (session-host-core). It is bumped by
 * `appendOutput` on every byte the PTY emits, so a generating session can never age
 * into the TTL; the remaining writers are attach/detach/write-owner/meta/lifecycle
 * transitions, all real activity. It is a REQUIRED field, so there is no
 * missing-timestamp branch to guess at.
 *
 * SAFETY POSTURE — every exclusion is FAIL-CLOSED. A record that does not
 * positively prove it is a reapable delegate is kept. In particular a session
 * missing `launchedByCoordinator` is NOT reaped: that marker is what separates a
 * coordinator-launched delegate from a session the owner opened themselves in the
 * dashboard, and stopping a human's live session is the one failure this pass must
 * never produce. Leaving a stale delegate alive costs memory; killing an owner's
 * session costs their work.
 */

import { LOG } from '../logging/logger.js';
import type { RepoMeshPolicy } from '../repo-mesh-types.js';
import { resolveDelegatedSessionIdleTtlMs } from '../repo-mesh-types.js';
import { getQueue, getActiveDirectDispatches } from './mesh-work-queue.js';
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';

/**
 * The subset of a SessionHostRecord this pass reads. Declared structurally rather
 * than importing SessionHostRecord so the pure selector stays testable with plain
 * object literals and daemon-core keeps no new value dependency on session-host-core.
 */
export interface ReapableSessionRecord {
    sessionId: string;
    lastActivityAt?: number;
    lifecycle?: string;
    surfaceKind?: string;
    meta?: Record<string, unknown> | null;
}

/** Why a candidate was kept. Surfaced in the dry-run plan and the debug log. */
export type IdleSessionReapSkipReason =
    | 'not_live_runtime'
    | 'coordinator_session'
    | 'not_coordinator_launched'
    | 'other_mesh'
    | 'missing_last_activity'
    | 'within_ttl'
    | 'holds_active_task';

export interface IdleSessionReapPlan {
    /** Sessions whose CLI runtime should be stopped (record preserved). */
    reap: Array<{ sessionId: string; idleMs: number }>;
    /** Every non-reaped candidate with the reason it was kept. */
    skipped: Array<{ sessionId: string; reason: IdleSessionReapSkipReason }>;
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
 * Exported for direct testing: this set is the "(b) no assigned/generating/waiting
 * task" condition, and getting it wrong reaps a session mid-task.
 */
export function collectSessionIdsWithActiveWork(meshId: string): Set<string> {
    const ids = new Set<string>();
    try {
        for (const task of getQueue(meshId, { status: ['pending', 'assigned'] as any })) {
            const sessionId = readStringValue((task as any)?.assignedSessionId);
            if (sessionId) ids.add(sessionId);
        }
    } catch { /* best-effort: an unreadable queue must not authorize a reap */ }
    try {
        for (const dispatch of getActiveDirectDispatches(meshId)) {
            const sessionId = readStringValue((dispatch as any)?.sessionId);
            if (sessionId) ids.add(sessionId);
        }
    } catch { /* best-effort — see above */ }
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
}): IdleSessionReapPlan {
    const { meshId, records, activeWorkSessionIds, ttlMs, now } = args;
    const plan: IdleSessionReapPlan = { reap: [], skipped: [] };
    if (!Array.isArray(records) || ttlMs <= 0) return plan;

    for (const record of records) {
        const sessionId = readStringValue(record?.sessionId);
        if (!sessionId) continue;
        const meta = (record?.meta && typeof record.meta === 'object') ? record.meta : {};
        const skip = (reason: IdleSessionReapSkipReason) => plan.skipped.push({ sessionId, reason });

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

        // Scope to THIS mesh. A delegate bound to another mesh sharing this daemon is
        // that mesh's business; reaping across the boundary is the MESH-ISOLATION-LEAK
        // class the remote-idle store was already fixed for.
        const meshNodeFor = readStringValue(meta.meshNodeFor);
        if (meshNodeFor && meshNodeFor !== meshId) {
            skip('other_mesh');
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
        if (idleMs < ttlMs) {
            skip('within_ttl');
            continue;
        }

        // (b) No non-terminal task bound to this session.
        if (heldByActiveWork(sessionId, activeWorkSessionIds)) {
            skip('holds_active_task');
            continue;
        }

        plan.reap.push({ sessionId, idleMs });
    }
    return plan;
}

/** Injected side effects, so the orchestrator is testable without a router. */
export interface IdleSessionReaperDeps {
    listSessions(): Promise<ReapableSessionRecord[]>;
    /** Bound DaemonCommandRouter.cleanupMeshSessions — the shared stop executor. */
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

export interface IdleSessionReapOutcome {
    plan: IdleSessionReapPlan;
    stoppedSessionIds: string[];
    /** Cumulative count of runtimes this daemon has stopped, for observability. */
    totalStopped: number;
}

/** Process-lifetime count of reaped sessions (observability requirement 4). */
let reapedSessionCount = 0;

/** Test-only reset of the cumulative counter. */
export function resetIdleSessionReapCounter(): void {
    reapedSessionCount = 0;
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
    // 0 / false disables the reaper entirely — not even a dry-run plan is computed,
    // so a disabled mesh pays nothing (no listSessions round-trip).
    if (ttlMs <= 0) return empty;

    let records: ReapableSessionRecord[] = [];
    try {
        records = await deps.listSessions();
    } catch (e: any) {
        LOG.warn('MeshIdleSessionReaper', `listSessions failed for mesh ${args.meshId}: ${e?.message || e}`);
        return empty;
    }

    const plan = planIdleSessionReap({
        meshId: args.meshId,
        records,
        activeWorkSessionIds: collectSessionIdsWithActiveWork(args.meshId),
        ttlMs,
        now,
    });
    if (plan.reap.length === 0) return { ...empty, plan };

    if (args.dryRun) {
        return { plan, stoppedSessionIds: [], totalStopped: reapedSessionCount };
    }

    const stoppedSessionIds: string[] = [];
    // Stop one session per call so a single failing session cannot suppress the rest
    // (cleanupMeshSessions reports success:false for the whole batch on any error).
    for (const target of plan.reap) {
        try {
            await deps.cleanupMeshSessions({
                meshId: args.meshId,
                nodeId: '',
                node: undefined,
                mode: 'stop',
                sessionIds: [target.sessionId],
                source: 'mesh_cleanup_sessions',
            });
            stoppedSessionIds.push(target.sessionId);
            reapedSessionCount += 1;
            // Requirement 4: one INFO line per stop — session id, idle age, reason.
            // Content-free by construction (id + duration only, never transcript text).
            LOG.info(
                'MeshIdleSessionReaper',
                `Stopped idle delegated session ${target.sessionId} (mesh ${args.meshId}, `
                + `idle ${Math.round(target.idleMs / 60_000)}m ≥ TTL ${Math.round(ttlMs / 60_000)}m, `
                + `reason=idle_ttl_exceeded, record preserved; total stopped=${reapedSessionCount})`,
            );
        } catch (e: any) {
            LOG.warn(
                'MeshIdleSessionReaper',
                `Failed to stop idle delegated session ${target.sessionId} (mesh ${args.meshId}): ${e?.message || e}`,
            );
        }
    }
    return { plan, stoppedSessionIds, totalStopped: reapedSessionCount };
}
