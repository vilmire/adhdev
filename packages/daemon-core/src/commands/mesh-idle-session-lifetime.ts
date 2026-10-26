/** Host-side lifetime probe/stop, behind agent_command's session-coordinator ACL. */
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { CliAgentCommandHost } from './cli-manager-agent-command.js';
import type { AgentCommandArgs } from './command-args.js';
import { isSafeIdleTaskSession, sessionCheckpointPending } from '../mesh/mesh-session-lifetime.js';
import { readMeshContext } from './command-args.js';

export async function idleSessionLifetimeCommand(host: CliAgentCommandHost, args: AgentCommandArgs) {
    const control = host.deps.idleSessionLifetimeControl;
    const meshId = readMeshContext(args)?.meshId;
    if (!control || !meshId || !args.targetSessionId) return { success: false, error: 'lifetime_host_unavailable' };
    const records = await control.listSessions();
    const stateFor = (id: string) => host.deps.getInstanceManager()?.getByCategory('cli')
        .find(inst => sessionIdsEquivalent(inst.getState().instanceId, id))?.getState();
    if (args.action === 'mesh_idle_session_inventory') {
        return { success: true, sessions: records.filter(r => r.meta.meshNodeFor === meshId).map(r => {
            const state = stateFor(r.sessionId);
            // Return no terminal/chat content, only the lifetime decision and host idle clock.
            return { sessionId: r.sessionId, lastActivityAt: r.lastActivityAt, lifecycle: r.lifecycle,
                surfaceKind: r.surfaceKind, meta: { meshNodeFor: r.meta.meshNodeFor, meshNodeId: r.meta.meshNodeId, launchedByCoordinator: r.meta.launchedByCoordinator },
                state: isSafeIdleTaskSession(state, r.meta) ? { status: 'idle' } : undefined,
                checkpointPending: sessionCheckpointPending(r.sessionId) };
        }) };
    }
    const r = records.find(r => sessionIdsEquivalent(r.sessionId, args.targetSessionId!));
    if (!r || r.meta.meshNodeFor !== meshId || r.meta.launchedByCoordinator !== true
        || r.lastActivityAt !== args.idleSessionLifetime?.lastActivityAt || r.lifecycle !== 'running'
        || !isSafeIdleTaskSession(stateFor(r.sessionId), r.meta) || sessionCheckpointPending(r.sessionId)) {
        return { success: false, error: 'lifetime_safety_changed' };
    }
    // The caller rechecked its authoritative queue immediately before this request;
    // the host rechecks the physical state and checkpoint immediately before stop.
    const stopped = await control.stopSession(r.sessionId);
    if (!stopped || stopped.lifecycle !== 'stopped') return { success: false, error: 'lifetime_stop_unconfirmed' };
    return { success: true, stoppedSessionIds: [r.sessionId] };
}
