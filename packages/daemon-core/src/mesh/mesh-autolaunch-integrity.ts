// AUTOLAUNCH-TASK-RACE — the defect this module exists for, and the rationale for the
// per-task lock that lives in mesh-queue-assignment (`autoLaunchTaskInProgress`).
//
// `triggerMeshQueue` has NO mesh-level mutex and is called from five non-cooperating sites
// (the 4s reconcile timer, three fire-and-forget event triggers, and the MCP tool). Its
// per-task body is `await`-interruptible at `resolveUsableProvider` and at the `launch_cli`
// dispatch, and every duplicate-suppression gate ahead of those awaits reads state that the
// in-flight racer has not written yet:
//   - the per-task await-claim guard reads `task.autoLaunch.status === 'completed'`, which is
//     only stamped AFTER the launch returns;
//   - `nodeHasLiveSessionPendingClaim` / `liveSessionCountForNode` scan the instanceManager,
//     which the not-yet-spawned session is absent from;
//   - the per-NODE lock (`autoLaunchInProgress`) is keyed by node, so two racers that pick
//     DIFFERENT candidate nodes never collide on it.
// So two concurrent calls scanning the same pending task each ran a full launch. Both locks
// are required and neither subsumes the other (node concurrency ≠ task duplication).
//
// The symptom split on whether the task carried a `targetNodeId`:
//   - pinned   → the racers converge on the one candidate node, one claim wins and the loser's
//                session is a silent orphan: the task stays `pending` while a session sits at
//                totalMessages 0 (observed live: tasks 912c337f, 7d47d11a);
//   - unpinned → the racers pick different nodes and BOTH sessions spawn (observed: dc9f9dd3).
// Ledger proof of the overlap: one call observed node_37e5fee8 already node-locked at
// 11:22:26.133Z — before that same call had begun its own launch — which only a second
// concurrent call already inside the launch can produce.
//
// This module holds the two state-level defences behind that lock. The lock is what PREVENTS
// a duplicate launch; these two deal with what a duplicate leaves behind —
//   - sweepAutoLaunchOrphanSessions   surfaces a race-loser session nothing else reclaims;
//   - autoLaunchWriteWouldClobberWinner keeps task.autoLaunch pointing at the session that
//     actually got the work, instead of whichever racer wrote last.
// Split out of mesh-queue-assignment (a frozen file-size baseline entry) rather than grown
// inside it. It must NOT import back from mesh-queue-assignment — that module calls into this
// one, so the pair would cycle; see the local isIdleSessionState copy below.
import type { DaemonComponents } from '../boot/daemon-lifecycle.js';
import { loadConfig } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import { canonicalDaemonId, daemonIdsEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getQueue } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { AUTO_LAUNCH_LEDGER_DEDUP_MAX, recordAutoLaunchEvent } from './mesh-queue-observability.js';
import { sessionHasActiveAssignment } from './mesh-scheduling-fitness.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

// See the AUTOLAUNCH-CLAIM-CHURN block in mesh-queue-assignment for why the await-claim window
// exists. Defined here (not imported) so this module stays free of a back-import cycle;
// mesh-queue-assignment re-exports it, which is the name the rest of the codebase uses.
export const AUTO_LAUNCH_AWAIT_CLAIM_MS = 90_000;
const AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES = 2;
// Local mirror of REMOTE_IDLE_SESSION_TTL_MS (mesh-event-forwarding) — kept as a copy to avoid
// a cross-module import cycle. Used when (re)registering a launched remote session as an idle
// claim candidate during the await-claim re-drive.
export const AUTO_LAUNCH_REMOTE_IDLE_TTL_MS = 5 * 60 * 1000;

function localCoordinatorDaemonId(): string | undefined {
    return canonicalDaemonId(readNonEmptyString(loadConfig().machineId));
}

// Local copy of mesh-queue-assignment's isIdleSessionState. Deliberately NOT imported: this
// module is called BY mesh-queue-assignment, and importing back would make the pair a cycle.
// It is a pure two-field predicate over session state with no dependencies of its own, so the
// duplication is a few lines rather than a shared-module round trip. Keep the two in step —
// they must agree on what "idle" means or the sweep and the launch gate disagree about which
// sessions are candidates.
const TERMINAL_SESSION_STATUSES = ['stopped', 'failed', 'terminated', 'exited', 'closed'];
function isIdleSessionState(state: any): boolean {
    const status = readNonEmptyString(state?.status).toLowerCase();
    if (TERMINAL_SESSION_STATUSES.includes(status)) return false;
    return status === 'idle' || state?.activeChat?.status === 'waiting_input';
}

// AUTOLAUNCH-ORPHAN-SWEEP. Per-(mesh,session) de-dup so a still-unclaimed orphan is reported
// ONCE, not on every 4s reconcile tick.
const autoLaunchOrphanNotified = new Set<string>();
// First tick at which a session was seen in the orphan condition, per (mesh,session). The
// report waits for the condition to PERSIST past the grace window below; cleared the moment
// the session stops looking orphaned.
const autoLaunchOrphanFirstSeenAtMs = new Map<string, number>();
// Grace before an orphan is reported. The sweep can otherwise fire in the very tick a task was
// legitimately assigned elsewhere: an idle session that the drain simply did not pick this pass
// momentarily matches the orphan shape, and it is a perfectly healthy worker that the next
// drain can still use. One reconcile tick is 4s, so this spans several ticks — long enough that
// only a session nothing is going to touch survives it, short enough to beat the 3-minute
// PTY-stall monitor that was the accidental discovery path live.
const AUTO_LAUNCH_ORPHAN_GRACE_MS = 30_000;

/** @internal Test-only: clear the orphan-report de-dup and grace tracking between cases. */
export function __resetAutoLaunchOrphanNotifiedForTests(): void {
    autoLaunchOrphanNotified.clear();
    autoLaunchOrphanFirstSeenAtMs.clear();
}

/** @internal Test-only: backdate a session's first-seen-orphan stamp so a case can exercise
 *  the post-grace report without sleeping out AUTO_LAUNCH_ORPHAN_GRACE_MS. */
export function __seedAutoLaunchOrphanFirstSeenForTests(meshId: string, sessionId: string, atMs: number): void {
    autoLaunchOrphanFirstSeenAtMs.set(`${meshId}::${sessionId}`, atMs);
}

// AUTOLAUNCH-ORPHAN-SWEEP. Defence layer behind the per-task lock. The lock is what STOPS a
// race-loser session from being created; this is what surfaces the ones that already exist
// (from a pre-fix daemon, or any future path that still produces one).
//
// A race-loser session is invisible to every existing recovery path: it holds no assigned task
// (so the reclaim watchdog ignores it), it is `idle` (so no stall/no-progress monitor fires),
// and nothing links it back to the task it lost. Observed live, the only thing that eventually
// noticed was an UNRELATED PTY-stall monitor three minutes later, and clearing it needed a
// manual `mesh_remove_node`.
//
// Detection: a local session stamped `autoLaunchedForQueueTaskId` that is idle, holds no
// assigned task, and whose originating task is either (a) already assigned to a DIFFERENT
// session, or (b) no longer active at all. Either way this session can never receive the work
// it was spawned for.
//
// Deliberately NOTIFY-only, never auto-stop: an idle mesh session is a reusable worker (a
// later pending task can legitimately claim it through the normal idle drain), and killing a
// session on an inference about a race would be a destructive action taken on incomplete
// evidence. The coordinator gets the ids and decides.
export function sweepAutoLaunchOrphanSessions(components: DaemonComponents, meshId: string): void {
    let sessions: any[];
    try {
        sessions = components.instanceManager?.getByCategory?.('cli') || [];
    } catch {
        return; // best-effort: the sweep must never break the dispatch pass
    }
    if (!sessions.length) return;
    let queue: MeshWorkQueueEntry[];
    try {
        queue = getQueue(meshId);
    } catch {
        return;
    }
    const byId = new Map(queue.map(t => [t.id, t] as const));
    for (const inst of sessions) {
        let state: any;
        try { state = inst.getState(); } catch { continue; }
        const settings = (state?.settings as Record<string, unknown>) || {};
        if (readNonEmptyString(settings.meshNodeFor) !== meshId) continue;
        const originTaskId = readNonEmptyString(settings.autoLaunchedForQueueTaskId);
        if (!originTaskId) continue;
        const sessionId = readNonEmptyString(state?.instanceId);
        if (!sessionId) continue;
        // Only an IDLE session can be an orphan: one that is generating/starting/awaiting
        // approval is doing something, and one that already holds an assigned task won.
        if (!isIdleSessionState(state)) continue;
        if (sessionHasActiveAssignment(meshId, sessionId)) continue;
        const originTask = byId.get(originTaskId);
        const assignedElsewhere = !!originTask
            && originTask.status === 'assigned'
            && !!readNonEmptyString(originTask.assignedSessionId)
            && !sessionIdsEquivalent(readNonEmptyString(originTask.assignedSessionId), sessionId);
        const originGone = !originTask
            || (originTask.status !== 'pending' && originTask.status !== 'assigned');
        const dedupKey = `${meshId}::${sessionId}`;
        // A still-pending origin task is NOT an orphan signal: this session is very likely the
        // launched worker on its way to claim it, which is the normal path.
        if (!assignedElsewhere && !originGone) {
            autoLaunchOrphanFirstSeenAtMs.delete(dedupKey);
            continue;
        }
        // GRACE: require the orphan condition to PERSIST. A single matching tick is not
        // evidence — a healthy idle worker the drain merely did not pick this pass looks
        // identical, and reporting it would page the coordinator about a session that is
        // about to be reused. Only a session still stranded after the window is a real orphan.
        const nowMs = Date.now();
        const firstSeenAtMs = autoLaunchOrphanFirstSeenAtMs.get(dedupKey);
        if (firstSeenAtMs === undefined) {
            autoLaunchOrphanFirstSeenAtMs.set(dedupKey, nowMs);
            // Bound memory: drop the oldest insertion (Map preserves insertion order). A
            // dropped stamp only restarts one session's grace, which is harmless.
            if (autoLaunchOrphanFirstSeenAtMs.size > AUTO_LAUNCH_LEDGER_DEDUP_MAX) {
                const oldest = autoLaunchOrphanFirstSeenAtMs.keys().next().value;
                if (oldest !== undefined) autoLaunchOrphanFirstSeenAtMs.delete(oldest);
            }
            continue;
        }
        if (nowMs - firstSeenAtMs < AUTO_LAUNCH_ORPHAN_GRACE_MS) continue;
        if (autoLaunchOrphanNotified.has(dedupKey)) continue;
        autoLaunchOrphanNotified.add(dedupKey);
        if (autoLaunchOrphanNotified.size > AUTO_LAUNCH_LEDGER_DEDUP_MAX) {
            const oldest = autoLaunchOrphanNotified.values().next().value;
            if (oldest !== undefined) autoLaunchOrphanNotified.delete(oldest);
        }
        const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.nodeId);
        const detail = assignedElsewhere
            ? `task ${originTaskId} is assigned to a different session (${readNonEmptyString(originTask!.assignedSessionId)})`
            : `task ${originTaskId} is no longer active (${originTask ? originTask.status : 'absent from the queue'})`;
        recordAutoLaunchEvent(meshId, {
            phase: 'skipped',
            taskId: originTaskId,
            reason: 'auto_launch_orphan_session_detected',
            nodeId,
            sessionId,
        });
        LOG.warn('MeshQueue', `AUTOLAUNCH-ORPHAN-SWEEP: session ${sessionId}${nodeId ? ` on node ${nodeId}` : ''} (mesh ${meshId}) was auto-launched for task ${originTaskId} but ${detail}; it is idle with no work and will not self-recover.`);
        try {
            queuePendingMeshCoordinatorEvent({
                event: 'mesh:dispatch_blocked',
                meshId,
                nodeLabel: nodeId || meshId,
                ...(nodeId ? { nodeId } : {}),
                metadataEvent: {
                    source: 'mesh_auto_launch_orphan_session',
                    taskId: originTaskId,
                    sessionId,
                    reason: 'auto_launch_orphan_session_detected',
                },
                coordinatorMessage: `[System] Mesh session ${sessionId}${nodeId ? ` on node ${nodeId}` : ''} was auto-launched for task ${originTaskId}, but ${detail}. The session is idle with no work assigned and nothing reclaims it on its own. Reuse it for other queued work or stop it.`,
                queuedAt: Date.now(),
                ...(readNonEmptyString(originTask?.sourceCoordinatorSessionId)
                    ? { targetCoordinatorSessionId: readNonEmptyString(originTask!.sourceCoordinatorSessionId) }
                    : {}),
                ...(localCoordinatorDaemonId() ? { targetCoordinatorDaemonId: localCoordinatorDaemonId() } : {}),
            });
        } catch (e: any) {
            LOG.warn('MeshQueue', `AUTOLAUNCH-ORPHAN-SWEEP: failed to queue the coordinator notification for session ${sessionId}: ${e?.message || e}`);
        }
    }
}

// AUTOLAUNCH-WINNER-CLOBBER. `recordTaskAutoLaunch` replaces `entry.autoLaunch` WHOLESALE, so
// whichever racer finishes LAST owns the field regardless of which one actually won the claim.
// Live consequence: the task was assigned to the winning session while `autoLaunch` named the
// ORPHAN loser — a ledger-based diagnosis reading that field is pointed at the wrong session,
// and the coordinator was in fact misled by it while diagnosing this very defect.
//
// The per-task lock above makes overlapping racers impossible going forward; this is the
// second, state-level guard for the records that still arrive out of order (a late `failed`
// from a remote dispatch whose reply lands after another path already completed, a `skipped`
// emitted by a subsequent reconcile tick before the claim flips the row out of `pending`).
//
// Rule: a non-winning write (skipped / failed, or a started/completed naming a DIFFERENT
// session) must not overwrite an in-window `completed` record that names a session. Returns
// true when the write is suppressed. The ledger event is still emitted by the caller either
// way, so nothing is lost for diagnosis — only the authoritative field is protected.
export function autoLaunchWriteWouldClobberWinner(meshId: string, taskId: string, args: {
    status: 'skipped' | 'started' | 'failed' | 'completed';
    sessionId?: string;
    nodeId?: string;
}, awaitClaimWindowMs: number): boolean {
    // A completed record naming a session IS the winner claim — always let it land.
    if (args.status === 'completed' && readNonEmptyString(args.sessionId)) return false;
    let existing: MeshWorkQueueEntry['autoLaunch'] | undefined;
    try {
        existing = getQueue(meshId).find(t => t.id === taskId)?.autoLaunch;
    } catch {
        return false; // never let the guard itself break the write path
    }
    const heldSessionId = existing ? readNonEmptyString(existing.sessionId) : '';
    if (!existing || existing.status !== 'completed' || !heldSessionId) return false;
    // Only protect the record while its await-claim window is open. Past that the launch is no
    // longer authoritative (driveExpiredAwaitClaim owns it) and normal recording must resume,
    // otherwise a stale winner would freeze the field forever.
    const heldAtMs = Date.parse(existing.updatedAt);
    if (!Number.isFinite(heldAtMs) || Date.now() - heldAtMs >= awaitClaimWindowMs) return false;
    // A started/completed for the SAME session is that session's own progression — allow it.
    if (sessionIdsEquivalent(readNonEmptyString(args.sessionId), heldSessionId)) return false;
    LOG.info('MeshQueue', `AUTOLAUNCH-WINNER-CLOBBER: suppressed a '${args.status}' autoLaunch write for task ${taskId} (mesh ${meshId}) that would have overwritten the in-window launch record for session ${heldSessionId}; the field keeps pointing at the actually-launched session.`);
    return true;
}


// ── await-claim window state ───────────────────────────────────────────────────────────
// Moved out of mesh-queue-assignment (frozen file-size baseline) as a pure, self-contained
// cluster: the per-task await-claim backoff map and the three read-only helpers over it.
// driveExpiredAwaitClaim itself stays in mesh-queue-assignment because it calls
// tryAssignQueueTask, which lives there — moving it would cycle the two modules.
// Per-task await-claim backoff state, keyed `${meshId}::${taskId}`. `cycles` counts how many
// times the window has been extended; `nextAttemptAtMs` rate-limits the re-drive to the backoff
// cadence so the 4s reconcile tick does not hammer it. Cleared once the task claims, the direct
// dispatch fires, or a respawn is authorized. In-memory (per process); a stale entry is harmless
// (it only defers a respawn) and self-clears on the next resolution.
export interface AwaitClaimBackoffState { cycles: number; nextAttemptAtMs: number; }
// Exported as the map itself rather than behind get/set/delete accessors: its sole mutator is
// driveExpiredAwaitClaim, which must stay in mesh-queue-assignment (it calls tryAssignQueueTask
// from there), and six one-line accessors would be more surface than the map.
export const autoLaunchAwaitClaimBackoff = new Map<string, AwaitClaimBackoffState>();
export function __seedAutoLaunchAwaitClaimBackoffForTests(meshId: string, taskId: string, state: AwaitClaimBackoffState): void {
    autoLaunchAwaitClaimBackoff.set(`${meshId}::${taskId}`, { ...state });
}

// Backoff window for a given cycle count: 90 → 180 → 360s (capped at the cap-cycle multiplier).
export function awaitClaimWindowMs(cycles: number): number {
    return AUTO_LAUNCH_AWAIT_CLAIM_MS * Math.pow(2, Math.min(cycles, AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES));
}

// Does the coordinator's remote-session view (MeshRuntimeStore remote idle sessions, populated by
// mesh event forwarding) currently show this session as a live idle claim candidate? Positive
// evidence the launched remote session is reachable — used to re-drive its claim directly instead
// of respawning. Absence is NOT proof the session is gone (the agent:ready pull may simply have
// been lost), so callers treat a false here as UNKNOWN liveness, never a definitive terminal.
export function remoteSessionAppearsLive(meshId: string, sessionId: string): boolean {
    if (!sessionId) return false;
    try {
        return MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
            .some(s => sessionIdsEquivalent(s.sessionId, sessionId));
    } catch {
        return false;
    }
}

// (A) Respawn-guard remote-awareness. The session ids of pending tasks whose auto-launch record
// targets `nodeId` (status started/completed with a sessionId) and is still inside its await-claim
// window — the base 90s window OR an active backoff extension. Such a session is ALREADY on its way
// to claim even when it is REMOTE (invisible to this daemon's instanceManager), so counting it
// suppresses a duplicate launch that would otherwise spawn a ghost.
export function inWindowAutoLaunchSessionIdsForNode(meshId: string, nodeId: string): string[] {
    const nowMs = Date.now();
    const out: string[] = [];
    for (const task of getQueue(meshId, { status: ['pending'] as any })) {
        const al = task.autoLaunch;
        const sid = al ? readNonEmptyString(al.sessionId) : '';
        if (!al || (al.status !== 'started' && al.status !== 'completed') || !sid) continue;
        if (!daemonIdsEquivalent(al.nodeId, nodeId)) continue;
        const launchedAtMs = Date.parse(al.updatedAt);
        const inBaseWindow = Number.isFinite(launchedAtMs) && nowMs - launchedAtMs < AUTO_LAUNCH_AWAIT_CLAIM_MS;
        const inBackoff = autoLaunchAwaitClaimBackoff.has(`${meshId}::${task.id}`);
        if (inBaseWindow || inBackoff) out.push(sid);
    }
    return out;
}

/** @internal Reset hook shared with mesh-queue-assignment's __resetAutoLaunchAwaitClaimBackoffForTests. */
export function __clearAwaitClaimBackoffForTests(): void {
    autoLaunchAwaitClaimBackoff.clear();
}

// AUTOLAUNCH-CLAIM-CHURN. The await-claim window for a launched (remote) session has expired
// without a claim. Instead of a blind respawn, re-drive the claim for the EXISTING session,
// backing off when its liveness is unknown, and only respawning when it is provably unclaimable.
// Returns a directive for the caller:
//   - 'claimed'  — the re-drive claimed/dispatched the task into the existing session (progress).
//   - 'fallback' — the post-cap direct dispatch delivered the task into the existing session.
//   - 'backoff'  — liveness unknown; the window was extended (or is still cooling down). No launch.
//   - 'respawn'  — the session is provably gone/unclaimable; the caller may launch a fresh one.
// Moved here from mesh-queue-assignment (a frozen file-size baseline entry). It mutates the
// await-claim backoff state that already lives in THIS module, so this is its natural home; the
// only reason it lived there was its call to tryAssignQueueTask. That call is now INJECTED
// (`assignQueueTask`), which keeps the dependency pointing one way — mesh-queue-assignment
// imports this module, never the reverse — and leaves the behavior identical.
export function driveExpiredAwaitClaim(
    components: DaemonComponents,
    meshId: string,
    task: MeshWorkQueueEntry,
    ctx: { sessionId: string; nodeId: string; providerType: string },
    assignQueueTask: (components: DaemonComponents, meshId: string, nodeId: string, sessionId: string, providerType: string) => boolean,
): 'claimed' | 'fallback' | 'backoff' | 'respawn' {
    const { sessionId, nodeId, providerType } = ctx;
    const backoffKey = `${meshId}::${task.id}`;
    const nowMs = Date.now();
    const state = autoLaunchAwaitClaimBackoff.get(backoffKey) || { cycles: 0, nextAttemptAtMs: 0 };
    // Rate-limit re-drive attempts to the backoff cadence so the 4s reconcile tick does not hammer
    // a still-cooling-down window. The initial (no-state) expiry proceeds immediately.
    if (state.nextAttemptAtMs && nowMs < state.nextAttemptAtMs) return 'backoff';

    const atCap = state.cycles >= AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES;
    const live = remoteSessionAppearsLive(meshId, sessionId);

    // (B) Re-drive when the remote view shows the session live; (C) after the backoff cap, force the
    // same direct dispatch unconditionally. Both funnel through tryAssignQueueTask, which
    // idempotently (re)registers the session, delivers the task message (send_chat), and marks the
    // row assigned — the exact operation a coordinator performs manually via mesh_send_task. (D)
    // The setRemoteIdleSession re-register makes this robust to a dropped agent:ready.
    if ((live || atCap) && nodeId && providerType) {
        try {
            MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, nodeId, sessionId, providerType, nowMs + AUTO_LAUNCH_REMOTE_IDLE_TTL_MS);
        } catch { /* best-effort re-register */ }
        const assigned = assignQueueTask(components, meshId, nodeId, sessionId, providerType);
        if (assigned) {
            autoLaunchAwaitClaimBackoff.delete(backoffKey);
            const isFallback = atCap && !live;
            recordAutoLaunchEvent(meshId, {
                phase: 'completed',
                taskId: task.id,
                reason: isFallback ? 'await_claim_direct_dispatch_fallback' : 'await_claim_redriven',
                nodeId,
                sessionId,
            });
            // Content-free progress line (ids only).
            LOG.info('MeshQueue', `Auto-launch await-claim ${isFallback ? 'direct-dispatch fallback' : 're-drive'} claimed task ${task.id} into existing session ${sessionId} on node ${nodeId} (mesh ${meshId})`);
            return isFallback ? 'fallback' : 'claimed';
        }
        if (atCap) {
            // The forced dispatch could not claim — the session is genuinely gone/unclaimable.
            // Authorize a fresh respawn (ghosts were already prevented through the backoff window).
            autoLaunchAwaitClaimBackoff.delete(backoffKey);
            return 'respawn';
        }
    }
    // Liveness unknown (or live-but-not-claimable) and not at cap → extend the window with backoff.
    const cycles = Math.min(state.cycles + 1, AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES);
    autoLaunchAwaitClaimBackoff.set(backoffKey, { cycles, nextAttemptAtMs: nowMs + awaitClaimWindowMs(cycles) });
    recordAutoLaunchEvent(meshId, { phase: 'skipped', taskId: task.id, reason: 'awaiting_launched_session_claim_backoff', nodeId, sessionId });
    return 'backoff';
}
