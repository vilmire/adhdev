import { sessionClaimFence, reserveSessionStop, releaseSessionStop, sessionStopPending, hasPendingSessionStops, confirmSessionStop } from './mesh-session-stop-fence.js';
/** Local and peer lifetime binding; peer actions use the existing session-coordinator ACL. */
import { canonicalDaemonId, sessionIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { getMachineId } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import { unwrapMeshRelayResult } from '../commands/mesh-relay-result.js';
import { findLocalCliInstance } from './cli-instance-lookup.js';
import { collectSessionIdsWithActiveWork, type IdleSessionReaperDeps, type ReapableSessionRecord } from './mesh-idle-session-reaper.js';
import { includesSession, isSafeIdleTaskSession, sessionCheckpointPending, sessionStopRetryDue, recordSessionStopFailure, clearSessionStopRetry } from './mesh-session-lifetime.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getQueueHeads } from './mesh-work-queue.js';
import { isLocalAutoLaunchNode } from './mesh-candidacy-predicates.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';

export function sessionLifetimeDeps(components: DaemonComponents, mesh: any, now: number): IdleSessionReaperDeps {
    const router = components.router;
    const routes = new Map<string, { daemonId: string; record: ReapableSessionRecord; provider: string }>();
    const localRecords = new Map<string, ReapableSessionRecord>();
    const coordinatorDaemonId = getMachineId() ?? '';
    const context = { meshId: mesh.id, coordinatorDaemonId };
    return {
        hasPendingStops: () => hasPendingSessionStops(MeshRuntimeStore.getInstance().db, mesh.id),
        listSessions: async () => {
            if (!router?.deps.sessionHostControl) throw new Error('session_host_unavailable');
            const local = await router.deps.sessionHostControl.listSessions();
            const records: ReapableSessionRecord[] = local.map(record => ({ ...record,
                state: findLocalCliInstance(components, record.sessionId)?.getState(),
                stopping: sessionStopPending(MeshRuntimeStore.getInstance().db, record.sessionId),
                claimFence: sessionClaimFence(findLocalCliInstance(components, record.sessionId)?.getState()),
                checkpointPending: sessionCheckpointPending(record.sessionId),
                machineId: canonicalDaemonId(coordinatorDaemonId),
            }));
            for (const r of records) localRecords.set(r.sessionId, r);
            // One authenticated inventory request per peer, anchored to a known worker.
            // Completed queue rows retain the anchor when agent:ready expires during P2P loss.
            const candidates = [...MeshRuntimeStore.getInstance().getRemoteIdleSessions(mesh.id),
                ...getQueueHeads(mesh.id, { status: ['assigned', 'completed', 'blocked', 'failed', 'cancelled'] }).reverse().filter(t => t.assignedSessionId).map(t => ({
                    nodeId: t.assignedNodeId ?? '', sessionId: t.assignedSessionId!, providerType: 'mesh',
                }))];
            const peers = new Map<string, typeof candidates>();
            for (const c of candidates) {
                const node = mesh.nodes?.find((n: any) => meshNodeIdMatches(n, c.nodeId));
                if (!node || isLocalAutoLaunchNode(node)) continue;
                const daemonId = readMeshNodeDaemonId(node);
                if (!daemonId) continue;
                const peer = canonicalDaemonId(daemonId) ?? daemonId;
                const anchors = peers.get(peer) ?? [];
                if (!anchors.some(a => sessionIdsEquivalent(a.sessionId, c.sessionId))) anchors.push(c);
                peers.set(peer, anchors);
            }
            for (const [daemonId, anchors] of peers) {
                const retryKey = `lifetime_inventory:${mesh.id}:${daemonId}`;
                if (!sessionStopRetryDue(retryKey, now)) continue;
                let failure: unknown;
                for (const c of anchors) {
                    try {
                        if (!components.dispatchMeshCommand) throw new Error('P2P_unavailable');
                        const result = unwrapMeshRelayResult(await components.dispatchMeshCommand(daemonId, 'agent_command', {
                            action: 'mesh_idle_session_inventory', agentType: c.providerType || 'mesh', targetSessionId: c.sessionId,
                            meshContext: context,
                        }), { command: 'agent_command', peerDaemonId: daemonId });
                        if (!result.success || !Array.isArray(result.sessions)) {
                            failure = result.error || 'inventory_unconfirmed';
                            // A stopped historical anchor is not proof the peer is down.
                            if (result.error === 'mesh_session_not_mesh_owned') continue;
                            throw new Error(String(failure));
                        }
                        clearSessionStopRetry(retryKey);
                        failure = undefined;
                        for (const r of result.sessions as ReapableSessionRecord[]) {
                            if (r.meta?.meshNodeFor !== mesh.id) continue;
                            const record = { ...r, machineId: daemonId, stopping: r.stopping || sessionStopPending(MeshRuntimeStore.getInstance().db, r.sessionId), checkpointPending: r.checkpointPending || sessionCheckpointPending(r.sessionId) };
                            routes.set(record.sessionId, { daemonId, record, provider: c.providerType || 'mesh' });
                            records.push(record);
                        }
                        break;
                    } catch (error) { failure = error; break; }
                }
                if (failure !== undefined) {
                    const retry = recordSessionStopFailure(retryKey, now);
                    LOG.warn('MeshSessionLifetime', `Peer ${daemonId} inventory unavailable: ${String(failure)}; retry ${retry.attempts} at ${new Date(retry.nextAt).toISOString()}`);
                }
            }
            return records;
        },
        cleanupMeshSessions: async args => {
            const sessionId = args.sessionIds[0];
            const knownRecords = [...localRecords.values(), ...[...routes.values()].map(r => r.record)];
            // Owner queue/checkpoint must be re-read after inventory awaits.
            if (sessionCheckpointPending(sessionId) || includesSession(collectSessionIdsWithActiveWork(args.meshId, knownRecords), sessionId)) {
                return { success: false, error: 'session_lifetime_safety_changed' };
            }
            if (!router) return { success: false, error: 'router_unavailable' };
            const db = MeshRuntimeStore.getInstance().db;
            const stopId = reserveSessionStop(db, args.meshId, sessionId);
            await router.recordIntentionalMeshSessionStop({ ...args, sessionId, action: 'stop_session' });
            if (includesSession(collectSessionIdsWithActiveWork(args.meshId, knownRecords), sessionId) || sessionCheckpointPending(sessionId)) {
                releaseSessionStop(db, sessionId, stopId);
                return { success: false, error: 'session_lifetime_safety_changed' };
            }
            const acknowledged = (result: { success: boolean; [key: string]: unknown }) => {
                if (result.success && Array.isArray(result.stoppedSessionIds) && result.stoppedSessionIds.some(id => sessionIdsEquivalent(id, sessionId))) {
                    confirmSessionStop(db, sessionId, stopId);
                }
                return result;
            };
            const route = [...routes.entries()].find(([id]) => sessionIdsEquivalent(id, sessionId))?.[1];
            if (route) {
                if (!route.record.claimFence) return { success: false, error: 'lifetime_claim_fence_unsupported' };
                if (!components.dispatchMeshCommand) return { success: false, error: 'P2P_unavailable' };
                return acknowledged(unwrapMeshRelayResult(await components.dispatchMeshCommand(route.daemonId, 'agent_command', {
                    action: 'mesh_idle_session_stop', agentType: route.provider, targetSessionId: sessionId,
                    idleSessionLifetime: { lastActivityAt: route.record.lastActivityAt, stopId, claimFence: route.record.claimFence }, meshContext: context,
                }), { command: 'agent_command', peerDaemonId: route.daemonId }));
            }
            const state = findLocalCliInstance(components, sessionId)?.getState();
            if (!isSafeIdleTaskSession(state) || !router) return { success: false, error: 'session_lifetime_safety_changed' };
            const record = [...localRecords.entries()].find(([id]) => sessionIdsEquivalent(id, sessionId))?.[1];
            if (!record || !components.cliManager) return { success: false, error: 'lifetime_runtime_unavailable' };
            return acknowledged(await components.cliManager.agentCommand({ action: 'mesh_idle_session_stop', agentType: 'mesh', targetSessionId: sessionId,
                idleSessionLifetime: { lastActivityAt: record.lastActivityAt!, stopId, claimFence: record.claimFence! }, meshContext: context }));
        },
    };
}
