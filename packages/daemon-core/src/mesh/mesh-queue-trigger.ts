// triggerMeshQueue — one drain pass over a mesh's queue: claim for every idle
// session (local + remote), then the auto-launch scan, reporting before/after
// counts. Split out of mesh-queue-assignment.ts (re-exported there).

import { meshNodeIdMatches, readText } from '@adhdev/mesh-shared';
import { getQueueHeads, getQueue } from './mesh-work-queue.js';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { getMeshWithCache } from './mesh-queue-mesh-view.js';
import { tryAssignQueueTask } from './mesh-queue-assignment.js';
import {
    resolveSchedulingStrategy,
    type IdleCandidate,
    buildSchedulingPool,
    orderEligibleNodes,
    nodeActiveLoad,
} from './mesh-scheduling-fitness.js';
import { isIdleSessionState, isTerminalSessionStatus } from './mesh-candidacy-predicates.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { type QuotaClaimDrainTrace, logAllQuotaClaimCandidatesBlocked, clearAllQuotaClaimCandidatesBlockedState } from './mesh-queue-observability.js';
import { resolveNodeSchedulingPriority, resolveDelegatedSessionIdleTtlMinutes, resolveMeshPolicy } from '../repo-mesh-types.js';
import { maybeAutoLaunchOneQueueSession } from './mesh-queue-autolaunch.js';
import { LOG } from '../logging/logger.js';
import { sweepAutoLaunchOrphanSessions, isAutoLaunchWithinAwaitClaimWindow } from './mesh-autolaunch-integrity.js';
import { maybeAutoFastForwardIdleNode } from './mesh-auto-fast-forward.js';
import { collectPinnedRemoteIdleCandidates } from './mesh-pinned-remote-idle.js';

export interface MeshQueueTriggerResult {
    success: true;
    meshId: string;
    pendingBefore: number;
    assignedBefore: number;
    pendingAfter: number;
    assignedAfter: number;
    claimed: boolean;
    newlyAssignedTasks: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
    }>;
    localIdleSessionsChecked: number;
    remoteIdleSessionsChecked: number;
    skippedSessions: Array<{
        nodeId?: string;
        sessionId?: string;
        reason: string;
        status?: string;
    }>;
    autoLaunchStarted: boolean;
    /**
     * True when a worker session is already on its way to claim a still-pending task —
     * either launched this tick (autoLaunchStarted) or launched on a prior tick and still
     * booting/awaiting-claim. Callers MUST treat this as "wait, do not launch another
     * session": a second launch double-edits the worktree. Mutually informative with
     * `noIdleMeshSessionAvailable`, which is suppressed whenever this is true.
     */
    autoLaunchPending?: boolean;
    noIdleMeshSessionAvailable?: boolean;
}

function countQueueStatus(meshId: string, status: 'pending' | 'assigned'): number {
    return getQueueHeads(meshId, { status: [status] as any }).length;
}

function getQueueStatusById(meshId: string): Map<string, string> {
    return new Map(getQueueHeads(meshId).map(t => [t.id, t.status]));
}

// IPC-ACCEPT-ASYNC-BOUNDARY: in-flight backgrounded auto-launch scans, per mesh. The
// launch is deliberately NOT awaited by triggerMeshQueue (see the call site), so this is
// the only handle on work that outlives the call. Production uses it to drain in-flight
// launches on shutdown; tests use awaitInFlightAutoLaunches() to observe post-spawn state
// deterministically instead of sleeping.
const inFlightAutoLaunches = new Map<string, Set<Promise<boolean>>>();

function trackInFlightAutoLaunch(meshId: string, promise: Promise<boolean>): void {
    let set = inFlightAutoLaunches.get(meshId);
    if (!set) { set = new Set(); inFlightAutoLaunches.set(meshId, set); }
    set.add(promise);
    void promise.finally(() => {
        set!.delete(promise);
        if (set!.size === 0) inFlightAutoLaunches.delete(meshId);
    });
}

/**
 * Await every auto-launch scan currently in flight for `meshId` (all meshes when omitted).
 * Resolves immediately when none are pending. Settles repeatedly until quiet, because one
 * scan can enqueue follow-on work that starts another.
 */
export async function awaitInFlightAutoLaunches(meshId?: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
        const pending = meshId
            ? [...(inFlightAutoLaunches.get(meshId) ?? [])]
            : [...inFlightAutoLaunches.values()].flatMap(set => [...set]);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
    }
}

export async function triggerMeshQueue(components: DaemonComponents, meshId: string): Promise<MeshQueueTriggerResult> {
    const mesh = getMeshWithCache(components, meshId);
    const pendingBefore = countQueueStatus(meshId, 'pending');
    const assignedBefore = countQueueStatus(meshId, 'assigned');
    const beforeStatus = getQueueStatusById(meshId);
    const skippedSessions: MeshQueueTriggerResult['skippedSessions'] = [];
    let localIdleSessionsChecked = 0;
    let remoteIdleSessionsChecked = 0;
    let autoLaunchStarted = false;
    if (!mesh) {
        return {
            success: true,
            meshId,
            pendingBefore,
            assignedBefore,
            pendingAfter: pendingBefore,
            assignedAfter: assignedBefore,
            claimed: false,
            newlyAssignedTasks: [],
            localIdleSessionsChecked,
            remoteIdleSessionsChecked,
            skippedSessions: [{ reason: 'mesh_not_found' }],
            autoLaunchStarted,
            noIdleMeshSessionAvailable: true,
        };
    }

    // Collect every idle mesh session (local CLI instances + remote idle records)
    // as drain candidates. The drain ORDER depends on the scheduling strategy:
    //   - 'first_eligible' (default): local-first, then remote, exactly as before.
    //   - otherwise: local + remote merged into one pool and drained in scheduling
    //     order (priority → load → tie-break). This local-first debias is required
    //     because without it the coordinator's own local node is always visited
    //     first and greedily absorbs all untargeted work before any remote idle
    //     session is even considered — the comparator alone can't spread work if
    //     local is always tried first.
    const strategy = resolveSchedulingStrategy(mesh);
    const localCandidates: IdleCandidate[] = [];

    const cliInstances = components.instanceManager.getByCategory('cli');
    for (const inst of cliInstances) {
        const state = inst.getState();
        const settings = state.settings as Record<string, unknown> || {};

        const instMeshId = readText(settings.meshNodeFor);
        if (instMeshId !== meshId) continue;

        const nodeId = readText(settings.meshNodeId) || readText(settings.nodeId);
        if (!nodeId) continue;

        if (!isIdleSessionState(state)) {
            const status = readText(state.status).toLowerCase();
            skippedSessions.push({
                nodeId,
                sessionId: readText(state.instanceId),
                reason: isTerminalSessionStatus(status) ? 'terminal_session' : 'session_not_idle',
                status: status || undefined,
            });
            continue;
        }

        const sessionId = state.instanceId;
        const providerType = state.type || readText(settings.providerType);

        if (providerType) {
            localIdleSessionsChecked += 1;
            localCandidates.push({ nodeId, sessionId, providerType, origin: 'local', node: mesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId)) });
        } else {
            skippedSessions.push({
                nodeId,
                sessionId,
                reason: 'provider_type_missing',
            });
        }
    }

    let remoteSessions: Array<{ nodeId: string; sessionId: string; providerType: string }> = [];
    try {
        remoteSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId);
    } catch { /* best-effort */ }

    const remoteCandidates: IdleCandidate[] = [];
    for (const idle of remoteSessions) {
        // Match with the shared 3-form normalizer (id / nodeId / node_id), not raw
        // `n.id`, so an inline-cached worktree node whose identity arrived under a
        // different form is not silently dropped — leaving a remote idle session
        // unable to claim its pending queue task.
        const node = mesh.nodes.find((n: any) => meshNodeIdMatches(n, idle.nodeId));
        if (node) {
            remoteIdleSessionsChecked += 1;
            remoteCandidates.push({ nodeId: idle.nodeId, sessionId: idle.sessionId, providerType: idle.providerType, origin: 'remote', node });
        }
    }

    // A task pinned to a remote session that the member's pushed runtime reports idle —
    // its own agent:ready edge is processed on the member, not here (mesh-pinned-remote-idle.ts).
    for (const candidate of collectPinnedRemoteIdleCandidates(components, meshId, mesh, [...localCandidates, ...remoteCandidates])) {
        remoteIdleSessionsChecked += 1;
        remoteCandidates.push(candidate);
    }

    const quotaClaimTrace: QuotaClaimDrainTrace = { blocked: [], evaluated: 0, clear: 0 };
    const assignIdleCandidate = (candidate: IdleCandidate): void => {
        const assigned = tryAssignQueueTask(components, meshId, candidate.nodeId, candidate.sessionId, candidate.providerType, undefined, quotaClaimTrace, 'idle_claim_scan');
        if (assigned && candidate.origin === 'remote') {
            try {
                MeshRuntimeStore.getInstance().deleteRemoteIdleSession(meshId, candidate.nodeId, candidate.sessionId);
            } catch { /* best-effort */ }
        }
    };

    if (strategy === 'first_eligible') {
        // Strict no-change: drain local idle sessions first (original order), then
        // remote idle sessions. tryAssignQueueTask is a no-op when nothing matches.
        for (const candidate of localCandidates) assignIdleCandidate(candidate);
        for (const candidate of remoteCandidates) assignIdleCandidate(candidate);
    } else {
        // Merge local + remote into one pool and drain in scheduling order. Each
        // assignment mutates a node's active load, and the next pick re-reads it,
        // so re-ranking after every assignment keeps the spread fair as load shifts.
        // buildSchedulingPool canonicalizes every candidate's nodeId so the Set
        // dedup, baseIndex, rankIndex, and nodeActiveLoad keying below all agree on
        // one form (see the invariant on that helper).
        const { pool, uniqueNodes } = buildSchedulingPool(localCandidates, remoteCandidates);
        const baseIndex = new Map<string, number>();
        pool.forEach((c, i) => { if (!baseIndex.has(c.nodeId)) baseIndex.set(c.nodeId, i); });
        // Bump the round-robin cursor once for this whole drain pass.
        const ranked = orderEligibleNodes(meshId, strategy, uniqueNodes, { bumpCursor: true });
        const rankIndex = new Map<string, number>(ranked.map((r, i) => [r.nodeId, i]));
        const remaining = [...pool];
        while (remaining.length > 0) {
            // Re-rank each pass so a node that just took work defers its next session.
            remaining.sort((a, b) => {
                const aPrio = resolveNodeSchedulingPriority(a.node?.policy);
                const bPrio = resolveNodeSchedulingPriority(b.node?.policy);
                if (aPrio !== bPrio) return bPrio - aPrio;
                // The idle-session drain ranks task-independently (a session pulls
                // whatever task matches), so 'fitness' here reduces to load-aware
                // ordering — the former least_loaded/round_robin tiebreak, which
                // normalize has already folded into 'fitness'.
                if (strategy === 'fitness') {
                    const loadDelta = nodeActiveLoad(meshId, a.nodeId) - nodeActiveLoad(meshId, b.nodeId);
                    if (loadDelta !== 0) return loadDelta;
                }
                return (rankIndex.get(a.nodeId) ?? 0) - (rankIndex.get(b.nodeId) ?? 0);
            });
            assignIdleCandidate(remaining.shift()!);
        }
    }

    // IPC-ACCEPT-ASYNC-BOUNDARY (2026-09-13): the auto-launch is NOT awaited. Spawning a
    // worker session is the single heaviest thing this function can do — detectCLI's
    // per-provider sequential --version chain, a remote `launch_cli` dispatch, and then
    // waitForRemote/LocalSessionReady — which pushed trigger_mesh_queue past its caller's
    // IPC deadline even though the assignment work below was already finished. The caller
    // needs the ASSIGNMENT result; the spawn's outcome reaches it through queue state on a
    // later tick, which is how a launch started on a prior tick was always reported anyway.
    //
    // `autoLaunchStarted` therefore reports only that a launch was INITIATED this tick, not
    // that it completed. The duplicate-launch protection does not depend on the await:
    // maybeAutoLaunchOneQueueSession takes its per-task lock (autoLaunchTaskInProgress) and
    // writes markAutoLaunch SYNCHRONOUSLY-ish before any spawn await, and `autoLaunchPending`
    // below independently re-reads task.autoLaunch from the queue, so a launch still
    // converging is seen by the next tick exactly as before.
    const autoLaunchPromise = maybeAutoLaunchOneQueueSession(components, meshId, mesh)
        .catch(e => {
            LOG.warn('MeshQueue', `Auto-launch scan failed for mesh ${meshId}: ${e?.message || e}`);
            return false;
        });
    trackInFlightAutoLaunch(meshId, autoLaunchPromise);
    // Give the launch scan its synchronous prologue (gates + per-task lock + markAutoLaunch)
    // a chance to land before we snapshot the queue, without waiting on any spawn I/O. If it
    // settles within this turn we report it exactly as the old await did.
    autoLaunchStarted = await Promise.race([
        autoLaunchPromise,
        new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ]);
    // AUTOLAUNCH-ORPHAN-SWEEP: run AFTER the drain + auto-launch so it reads post-claim
    // assignment state (a session that just won its claim must not be reported as an orphan).
    sweepAutoLaunchOrphanSessions(components, meshId, {
        idleTtlMinutes: resolveDelegatedSessionIdleTtlMinutes(resolveMeshPolicy(mesh.policy).delegatedSessionIdleTtlMinutes),
    });
    // IPC load audit #10: heads-only read (id/status/assignedNodeId/assignedSessionId) — this
    // block never needs payload fields off the full queue entries.
    const afterHeads = getQueueHeads(meshId, { status: ['pending', 'assigned'] });
    const pendingAfter = afterHeads.filter(task => task.status === 'pending').length;
    const assignedAfter = afterHeads.filter(task => task.status === 'assigned').length;
    const newlyAssignedTasks = afterHeads
        .filter(task => task.status === 'assigned' && beforeStatus.get(task.id) !== 'assigned')
        .map(task => ({
            id: task.id,
            nodeId: task.assignedNodeId,
            sessionId: task.assignedSessionId,
        }));

    // A successful claim logs its blocked→winner transition at the atomic claim point.
    // If no candidate cleared the quota gate and auto-launch also made no progress, emit
    // a distinct all-gated conclusion once for this pending-task/gate-state fingerprint.
    if (newlyAssignedTasks.length === 0 && !autoLaunchStarted) {
        logAllQuotaClaimCandidatesBlocked(meshId, quotaClaimTrace, afterHeads.filter(task => task.status === 'pending').map(task => task.id));
    } else {
        clearAllQuotaClaimCandidatesBlockedState(meshId);
    }

    // An auto-launch is "pending" when the coordinator has already spun a session up
    // for a still-pending task and is waiting on that session's idle→claim. This covers
    // two ticks:
    //   - THIS tick fired the launch (autoLaunchStarted), or
    //   - a PRIOR tick launched a session that is still booting/awaiting-claim — the
    //     per-task await-claim guard (maybeAutoLaunchOneQueueSession) deliberately
    //     declines to launch again, so autoLaunchStarted is false even though a session
    //     is on its way to claim this task.
    // Without this signal, the second tick reports `noIdleMeshSessionAvailable` and the
    // MCP guidance tells the coordinator to launch ANOTHER worker — producing a duplicate
    // session that double-edits the worktree. The claim itself is fine; only the wording
    // was wrong, so we surface `autoLaunchPending` to suppress the bad "launch one more"
    // advice while the just-launched session converges.
    // `autoLaunch` is a payload field, not a head field, so only the still-pending rows are
    // read in full here (IPC load audit #10) — assigned/other-status rows never need it.
    const autoLaunchPending = autoLaunchStarted || getQueue(meshId, { status: ['pending'] }).some(task => {
        const al = task.autoLaunch;
        if (!al || (al.status !== 'started' && al.status !== 'completed')) return false;
        // CLOCK-LOWER-BOUND: `al.updatedAt` is foreign; a future stamp must not report
        // autoLaunchPending forever — see isWithinForeignFreshnessWindow.
        const launchedAtMs = Date.parse(al.updatedAt);
        return isAutoLaunchWithinAwaitClaimWindow(launchedAtMs);
    });

    return {
        success: true,
        meshId,
        pendingBefore,
        assignedBefore,
        pendingAfter,
        assignedAfter,
        claimed: newlyAssignedTasks.length > 0,
        newlyAssignedTasks,
        localIdleSessionsChecked,
        remoteIdleSessionsChecked,
        skippedSessions,
        autoLaunchStarted,
        ...(autoLaunchPending ? { autoLaunchPending: true } : {}),
        // Only report "no idle session, go launch one" when nothing is already on its way.
        // A pending auto-launch (this tick or a prior still-converging one) means a session
        // WILL claim shortly, so it is not a no-session-available situation.
        ...(pendingAfter > 0 && newlyAssignedTasks.length === 0 && localIdleSessionsChecked === 0 && remoteIdleSessionsChecked === 0 && !autoLaunchPending
            ? { noIdleMeshSessionAvailable: true }
            : {}),
    };
}

/** Passed dry-run result satisfies the policy gates (maxBehind + clean submodules).
 *  Shared by the local execute path and the remote preflight re-verification so both
 *  apply exactly the same policy gate. */

export function runIdleMaintenanceThenAssignQueue(components: DaemonComponents, args: {
    meshId: string;
    nodeId: string;
    sessionId: string;
    providerType: string;
}): void {
    setImmediate(() => {
        maybeAutoFastForwardIdleNode(components, args)
            .finally(() => {
                try {
                    tryAssignQueueTask(components, args.meshId, args.nodeId, args.sessionId, args.providerType, undefined, undefined, 'idle_maintenance');
                } catch (e: any) {
                    LOG.warn('MeshQueue', `Failed to assign idle queue task after maintenance for ${args.nodeId}: ${e?.message || e}`);
                }
            });
    });
}
