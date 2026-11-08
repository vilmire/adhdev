// Pinned task → idle REMOTE addressee, from the coordinator-held runtime.
//
// A task pinned to one remote session (mesh_send_task → queued_delivery while that
// session was busy or still starting) is claimable only by that session, and only
// when the drain offers it as a candidate. The drain's remote candidates came solely
// from the remote-idle registry, which is filled by an `agent:ready` edge processed
// on THIS daemon — but a worker's own provider events are processed on the worker's
// daemon (mesh-event-forwarding.ts setupMeshEventForwarding); only auto-launched
// sessions get an optimistic coordinator-side entry. So a remote session that went
// idle was never offered its pinned task: 2026-10-06 a claude-cli worker on a
// remote Mac was idle 0.3 s BEFORE the task was enqueued (the sender's status
// snapshot still said "starting"), and the task waited out the 15-minute pin TTL
// and parked.
//
// The member pushes its sessions' status to the coordinator (mesh_node_git_report
// runtime summary), so the coordinator already KNOWS the addressee is idle. Offer
// it as a candidate from that held runtime. The atomic claim keeps every guard:
// the pin (only this session), parking, session_already_assigned (a status that
// lags a just-dispatched turn cannot double-assign), difficulty / quota / git gates.

import { meshNodeIdMatches, readText, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import type { IdleCandidate } from './mesh-scheduling-fitness.js';
import { getQueue } from './mesh-work-queue.js';
import { taskIsParked } from './mesh-task-parking.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import { readLiveHeldRuntime } from './mesh-node-git-refresher.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

export function collectPinnedRemoteIdleCandidates(
    components: DaemonComponents,
    meshId: string,
    mesh: { nodes?: any[] } | null | undefined,
    alreadyOffered: ReadonlyArray<Pick<IdleCandidate, 'sessionId'>>,
    now: number = Date.now(),
): IdleCandidate[] {
    const store = components.router?.meshNodeGitState;
    const nodes = Array.isArray(mesh?.nodes) ? mesh!.nodes : [];
    if (!store || nodes.length === 0) return [];
    let pending: ReturnType<typeof getQueue>;
    try {
        pending = getQueue(meshId, { status: ['pending'] as any });
    } catch {
        return [];
    }
    const out: IdleCandidate[] = [];
    for (const task of pending) {
        const targetSessionId = readText(task.targetSessionId);
        const targetNodeId = readText(task.targetNodeId);
        if (!targetSessionId || !targetNodeId || taskIsParked(task)) continue;
        if (alreadyOffered.some(c => sessionIdsEquivalent(c.sessionId, targetSessionId))) continue;
        if (out.some(c => sessionIdsEquivalent(c.sessionId, targetSessionId))) continue;
        // A session hosted by THIS daemon is a local candidate, read from its live instance.
        if (components.instanceManager?.getInstance?.(targetSessionId)) continue;
        const node = nodes.find((n: any) => meshNodeIdMatches(n, targetNodeId));
        if (!node) continue;
        const daemonId = readMeshNodeDaemonId(node) ?? '';
        const held = readLiveHeldRuntime(store, { meshId, nodeId: readText(node.id) || targetNodeId, daemonId }, now);
        const session = held?.runtime.sessions.find((s: any) =>
            sessionIdsEquivalent(readText(s.id) || readText(s.instanceId) || readText(s.sessionId), targetSessionId));
        if (!session || readText(session.status).toLowerCase() !== 'idle') continue;
        const providerType = readText(session.providerType);
        if (!providerType) continue;
        out.push({ nodeId: readText(node.id) || targetNodeId, sessionId: targetSessionId, providerType, origin: 'remote', node });
    }
    // UNPINNED-REMOTE-IDLE (2026-11-08): the same blind spot for tasks WITHOUT a pinned
    // session. A remote idle session is offered to the drain only through the TTL'd
    // remote-idle registry (agent:ready / generating_completed edges); a task that turns
    // pending LATER (requeue / revise / unpark) for a node whose only sessions are already
    // idle was never claimed — auto-launch skips (a live session exists) and no edge fires.
    // Offer idle, mesh-bound sessions from the member's pushed runtime for the target node
    // (or every node when an unpinned task is untargeted). The atomic claim keeps every guard.
    const wantedNodes = new Set<string>();
    let anyUntargeted = false;
    for (const task of pending) {
        if (readText(task.targetSessionId) || taskIsParked(task)) continue;
        const targetNodeId = readText(task.targetNodeId);
        if (!targetNodeId) { anyUntargeted = true; continue; }
        wantedNodes.add(targetNodeId);
    }
    if (!anyUntargeted && wantedNodes.size === 0) return out;
    for (const node of nodes) {
        const nodeId = readText(node.id) || readText(node.nodeId) || readText(node.node_id);
        if (!nodeId) continue;
        if (!anyUntargeted && ![...wantedNodes].some(t => meshNodeIdMatches(node, t))) continue;
        const daemonId = readMeshNodeDaemonId(node) ?? '';
        const held = readLiveHeldRuntime(store, { meshId, nodeId, daemonId }, now);
        if (!held) continue;
        for (const session of held.runtime.sessions) {
            if (readText(session.status).toLowerCase() !== 'idle') continue;
            const sessionId = readText(session.id) || readText(session.instanceId) || readText(session.sessionId);
            const providerType = readText(session.providerType);
            if (!sessionId || !providerType) continue;
            if (readText(session.settings?.meshNodeFor) !== meshId) continue;
            const sessionNode = readText(session.settings?.meshNodeId) || readText(session.settings?.meshLastNodeId);
            if (!sessionNode || !meshNodeIdMatches(node, sessionNode)) continue;
            if (components.instanceManager?.getInstance?.(sessionId)) continue;
            if (alreadyOffered.some(c => sessionIdsEquivalent(c.sessionId, sessionId))) continue;
            if (out.some(c => sessionIdsEquivalent(c.sessionId, sessionId))) continue;
            out.push({ nodeId, sessionId, providerType, origin: 'remote', node });
        }
    }
    return out;
}

/**
 * STALE-AUTOLAUNCH-MARKER: is the session a pending row's `autoLaunch` record points at provably
 * gone (stopped / never claimed)? A coordinator revise or a claim leaves the old `completed`
 * marker on the row, and the await-claim guard then waits (with backoff) on a dead session.
 * Proof only — local: no instance here; remote: absent from the coordinator's remote-idle
 * registry AND from a live pushed runtime that was observed AFTER the launch. Unknown → false.
 */
export function launchedSessionProvablyGone(
    components: DaemonComponents,
    meshId: string,
    mesh: { nodes?: any[] } | null | undefined,
    launched: { nodeId: string; sessionId: string; launchedAtMs: number },
    now: number = Date.now(),
): boolean {
    const { nodeId, sessionId, launchedAtMs } = launched;
    if (!sessionId || !nodeId || !Number.isFinite(launchedAtMs)) return false;
    try {
        if (components.instanceManager?.getInstance?.(sessionId)) return false;
        if (MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId).some(r => sessionIdsEquivalent(r.sessionId, sessionId))) return false;
        const node = (mesh?.nodes ?? []).find((n: any) => meshNodeIdMatches(n, nodeId));
        const store = components.router?.meshNodeGitState;
        if (!node || !store) return false;
        const held = readLiveHeldRuntime(store, { meshId, nodeId: readText(node.id) || nodeId, daemonId: readMeshNodeDaemonId(node) ?? '' }, now);
        if (!held || held.observedAt <= launchedAtMs) return false;
        return !held.runtime.sessions.some((s: any) => sessionIdsEquivalent(readText(s.id) || readText(s.instanceId) || readText(s.sessionId), sessionId));
    } catch {
        return false;
    }
}
