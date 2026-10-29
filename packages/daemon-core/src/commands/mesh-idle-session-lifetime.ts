import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import { collectSessionIdsWithActiveWork } from '../mesh/mesh-idle-session-reaper.js';
import { includesSession } from '../mesh/mesh-session-lifetime.js';
import {
    sessionClaimFence, claimFenceMatches, captureCleanupExpected, expectedAssignmentUnchanged,
    reserveSessionStop, releaseSessionStop, markSessionStopSent, sessionStopPending, confirmSessionStop,
    abortSessionStopAfterHostRefusal, readReservedCleanupExpected, CLEANUP_HOST_REFUSAL_CODES,
    type SessionCleanupExpected,
} from '../mesh/mesh-session-stop-fence.js';
/** Host-side lifetime probe/stop, behind agent_command's session-coordinator ACL. */
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { hostBootIdFromStartedAt, resolveHostBootId } from '@adhdev/session-host-core';
import type { CliAgentCommandHost } from './cli-manager-agent-command.js';
import type { AgentCommandArgs } from './command-args.js';
import { isSafeIdleTaskSession, sessionCheckpointPending } from '../mesh/mesh-session-lifetime.js';
import { readMeshContext } from './command-args.js';

async function resolveLifetimeHostBootId(control: NonNullable<CliAgentCommandHost['deps']['idleSessionLifetimeControl']>): Promise<string | null> {
    if (typeof control.resolveHostBootId === 'function') return control.resolveHostBootId();
    if (typeof control.getDiagnostics !== 'function') return null;
    try {
        const diagnostics = await control.getDiagnostics({});
        return resolveHostBootId({ hostStartedAt: diagnostics.hostStartedAt });
    } catch {
        return null;
    }
}

function sanitizeLifetimeError(error: unknown): { code: string; retained: true } {
    const raw = error instanceof Error ? error.message : String(error ?? 'lifetime_stop_failed');
    const code = CLEANUP_HOST_REFUSAL_CODES.has(raw) ? raw
        : (raw.includes('Unsupported') || raw.includes('Unknown request') || raw.includes('stop_session_if_expected')
            ? 'lifetime_expected_stop_unsupported' : 'lifetime_stop_unconfirmed');
    return { code, retained: true };
}

export async function idleSessionLifetimeCommand(host: CliAgentCommandHost, args: AgentCommandArgs) {
    const control = host.deps.idleSessionLifetimeControl;
    const meshId = readMeshContext(args)?.meshId;
    if (!control || !meshId || !args.targetSessionId) return { success: false, error: 'lifetime_host_unavailable' };
    const records = await control.listSessions();
    const stateFor = (id: string) => host.deps.getInstanceManager()?.getByCategory('cli')
        .find(inst => sessionIdsEquivalent(inst.getState().instanceId, id))?.getState();
    if (args.action === 'mesh_idle_session_inventory') {
        const hostBootId = await resolveLifetimeHostBootId(control);
        if (!hostBootId) return { success: false, error: 'lifetime_host_boot_unknown' };
        return { success: true, hostBootId, sessions: records.filter(r => r.meta.meshNodeFor === meshId).map(r => {
            const state = stateFor(r.sessionId);
            // Return no terminal/chat content, only the lifetime decision and host idle clock.
            return { sessionId: r.sessionId, lastActivityAt: r.lastActivityAt, lifecycle: r.lifecycle,
                surfaceKind: r.surfaceKind, runtimeKey: r.runtimeKey, startedAt: r.startedAt,
                hostBootId, stopping: sessionStopPending(MeshRuntimeStore.getInstance().db, r.sessionId),
                claimFence: sessionClaimFence(state),
                meta: { meshNodeFor: r.meta.meshNodeFor, meshNodeId: r.meta.meshNodeId, launchedByCoordinator: r.meta.launchedByCoordinator },
                state: isSafeIdleTaskSession(state, r.meta) ? { status: 'idle' } : undefined,
                checkpointPending: sessionCheckpointPending(r.sessionId) };
        }) };
    }
    const r = records.find(r => sessionIdsEquivalent(r.sessionId, args.targetSessionId!));
    const fence = args.idleSessionLifetime;
    const expected: SessionCleanupExpected | undefined = fence?.expected;
    if (!fence?.stopId || !fence.claimFence || !expected) {
        return { success: false, error: 'lifetime_expected_assignment_required', retained: true };
    }
    const hostBootId = await resolveLifetimeHostBootId(control);
    if (!hostBootId || expected.hostBootId !== hostBootId) {
        return { success: false, error: 'cleanup_host_boot_mismatch', retained: true };
    }
    if (!r || r.meta.meshNodeFor !== meshId || r.meta.launchedByCoordinator !== true
        || r.lastActivityAt !== args.idleSessionLifetime?.lastActivityAt || r.lifecycle !== 'running'
        || !isSafeIdleTaskSession(stateFor(r.sessionId), r.meta) || sessionCheckpointPending(r.sessionId)
        || !claimFenceMatches(fence.claimFence, stateFor(r.sessionId))
        || !expectedAssignmentUnchanged(expected, stateFor(r.sessionId), r)
        || JSON.stringify(captureCleanupExpected({
            sessionId: r.sessionId, hostBootId, runtimeKey: r.runtimeKey, startedAt: r.startedAt!, state: stateFor(r.sessionId),
        })) !== JSON.stringify(expected)) {
        return { success: false, error: 'lifetime_safety_changed', retained: true };
    }
    if (typeof control.stopSessionIfExpected !== 'function') {
        return { success: false, error: 'lifetime_expected_stop_unsupported', retained: true };
    }
    const db = MeshRuntimeStore.getInstance().db;
    reserveSessionStop(db, meshId, r.sessionId, fence.stopId, expected);
    try {
        // Claims share the durable reservation; re-check expected tuple immediately before mark+host stop.
        if (includesSession(collectSessionIdsWithActiveWork(meshId, records), r.sessionId) || sessionCheckpointPending(r.sessionId)
            || !expectedAssignmentUnchanged(expected, stateFor(r.sessionId), r)
            || JSON.stringify(readReservedCleanupExpected(db, r.sessionId, fence.stopId)) !== JSON.stringify(expected)) {
            return { success: false, error: 'lifetime_assignment_changed', retained: true };
        }
        markSessionStopSent(db, r.sessionId, fence.stopId);
        try {
            const stopped = await control.stopSessionIfExpected(r.sessionId, expected);
            if (!stopped || stopped.lifecycle !== 'stopped' && stopped.lifecycle !== 'stopping') {
                return { success: false, error: 'lifetime_stop_unconfirmed', retained: true };
            }
            confirmSessionStop(db, r.sessionId, fence.stopId);
            return { success: true, stoppedSessionIds: [r.sessionId], expected };
        } catch (error) {
            const sanitized = sanitizeLifetimeError(error);
            if (CLEANUP_HOST_REFUSAL_CODES.has(sanitized.code) || sanitized.code === 'lifetime_expected_stop_unsupported') {
                abortSessionStopAfterHostRefusal(db, r.sessionId, fence.stopId);
            }
            return { success: false, error: sanitized.code, retained: true };
        }
    } finally {
        releaseSessionStop(db, r.sessionId, fence.stopId);
    }
}

// Re-export for tests that build expected tuples without importing session-host-daemon paths.
export { hostBootIdFromStartedAt };
