import { sessionClaimFence, captureCleanupExpected, reserveSessionStop, releaseSessionStop, markSessionStopSent, sessionStopPending, hasPendingSessionStops, confirmSessionStop, abortSessionStopAfterHostRefusal, CLEANUP_HOST_REFUSAL_CODES } from './mesh-session-stop-fence.js';
/** Local and peer lifetime binding; peer actions use the existing session-coordinator ACL. */
import { canonicalDaemonId, sessionIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { resolveHostBootId } from '@adhdev/session-host-core';
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

async function localHostBootId(control: {
    resolveHostBootId?: () => Promise<string | null> | string | null;
    getDiagnostics?: (payload?: object) => Promise<{ hostStartedAt: number; hostBootId?: string }>;
}): Promise<string | null> {
    if (typeof control.resolveHostBootId === 'function') return control.resolveHostBootId();
    if (typeof control.getDiagnostics !== 'function') return null;
    try {
        const diagnostics = await control.getDiagnostics({});
        if (typeof diagnostics.hostBootId === 'string' && diagnostics.hostBootId) return diagnostics.hostBootId;
        return resolveHostBootId({ hostStartedAt: diagnostics.hostStartedAt });
    } catch {
        return null;
    }
}

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
            const hostBootId = await localHostBootId(router.deps.sessionHostControl);
            if (!hostBootId) throw new Error('lifetime_host_boot_unknown');
            const records: ReapableSessionRecord[] = local.map(record => ({ ...record,
                state: findLocalCliInstance(components, record.sessionId)?.getState(),
                stopping: sessionStopPending(MeshRuntimeStore.getInstance().db, record.sessionId),
                claimFence: sessionClaimFence(findLocalCliInstance(components, record.sessionId)?.getState()),
                hostBootId,
                runtimeKey: record.runtimeKey,
                startedAt: record.startedAt,
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
                        if (!result.success || !Array.isArray(result.sessions) || typeof result.hostBootId !== 'string' || !result.hostBootId) {
                            failure = result.error || (result.success ? 'lifetime_host_boot_unknown' : 'inventory_unconfirmed');
                            // A stopped historical anchor is not proof the peer is down.
                            if (result.error === 'mesh_session_not_mesh_owned') continue;
                            throw new Error(String(failure));
                        }
                        clearSessionStopRetry(retryKey);
                        failure = undefined;
                        for (const r of result.sessions as ReapableSessionRecord[]) {
                            if (r.meta?.meshNodeFor !== mesh.id) continue;
                            const record = {
                                ...r, hostBootId: result.hostBootId as string, machineId: daemonId,
                                stopping: r.stopping || sessionStopPending(MeshRuntimeStore.getInstance().db, r.sessionId),
                                checkpointPending: r.checkpointPending || sessionCheckpointPending(r.sessionId),
                            };
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
            const route = [...routes.entries()].find(([id]) => sessionIdsEquivalent(id, sessionId))?.[1];
            const record = [...localRecords.entries()].find(([id]) => sessionIdsEquivalent(id, sessionId))?.[1];
            const source = route?.record ?? record;
            const expected = source ? captureCleanupExpected({
                sessionId: source.sessionId,
                hostBootId: source.hostBootId ?? '',
                runtimeKey: source.runtimeKey ?? '',
                startedAt: source.startedAt ?? 0,
                state: source.state ?? findLocalCliInstance(components, sessionId)?.getState(),
            }) : null;
            const preflight = () => {
                if (!expected) return 'lifetime_expected_assignment_required';
                if (route) {
                    if (!route.record.claimFence) return 'lifetime_claim_fence_unsupported';
                    if (!components.dispatchMeshCommand) return 'P2P_unavailable';
                } else {
                    if (!record || !components.cliManager) return 'lifetime_runtime_unavailable';
                    if (!isSafeIdleTaskSession(findLocalCliInstance(components, sessionId)?.getState())) return 'session_lifetime_safety_changed';
                }
                return undefined;
            };
            const unavailable = preflight();
            if (unavailable) return { success: false, error: unavailable, retained: true };
            const db = MeshRuntimeStore.getInstance().db;
            const stopId = reserveSessionStop(db, args.meshId, sessionId, undefined, expected!);
            try {
                await router.recordIntentionalMeshSessionStop({ ...args, sessionId, action: 'stop_session' });
                if (includesSession(collectSessionIdsWithActiveWork(args.meshId, knownRecords), sessionId) || sessionCheckpointPending(sessionId)) {
                    return { success: false, error: 'session_lifetime_safety_changed', retained: true };
                }
                const changed = preflight();
                if (changed) return { success: false, error: changed, retained: true };
                const lifetime = { lastActivityAt: source!.lastActivityAt!, stopId, claimFence: source!.claimFence!, expected: expected! };
                const acknowledged = (result: { success: boolean; [key: string]: unknown }) => {
                    if (result.success && Array.isArray(result.stoppedSessionIds) && result.stoppedSessionIds.some(id => sessionIdsEquivalent(id, sessionId))) {
                        confirmSessionStop(db, sessionId, stopId);
                    } else if (!result.success && typeof result.error === 'string'
                        && (CLEANUP_HOST_REFUSAL_CODES.has(result.error) || result.error === 'lifetime_expected_stop_unsupported'
                            || result.error === 'lifetime_safety_changed' || result.error === 'lifetime_assignment_changed'
                            || result.error === 'lifetime_expected_assignment_required' || result.error === 'cleanup_host_boot_mismatch')) {
                        // Host proved it did not mutate; unlock so a replacement claim can proceed.
                        abortSessionStopAfterHostRefusal(db, sessionId, stopId);
                    }
                    return result;
                };
                // From this point even a thrown RPC may have stopped the runtime.
                markSessionStopSent(db, sessionId, stopId);
                if (route) {
                    return acknowledged(unwrapMeshRelayResult(await components.dispatchMeshCommand!(route.daemonId, 'agent_command', {
                        action: 'mesh_idle_session_stop', agentType: route.provider, targetSessionId: sessionId,
                        idleSessionLifetime: lifetime, meshContext: context,
                    }), { command: 'agent_command', peerDaemonId: route.daemonId }));
                }
                return acknowledged(await components.cliManager!.agentCommand({ action: 'mesh_idle_session_stop', agentType: 'mesh', targetSessionId: sessionId,
                    idleSessionLifetime: lifetime, meshContext: context }));
            } finally {
                // Releases every pre-send refusal/exception, but never a prior sent retry.
                releaseSessionStop(db, sessionId, stopId);
            }
        },
    };
}
