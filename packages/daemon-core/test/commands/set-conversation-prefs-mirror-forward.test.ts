import { describe, expect, it, vi } from 'vitest';

import { cliAgentHandlers } from '../../src/commands/med-family/cli-agent.js';
import type { MedFamilyContext } from '../../src/commands/med-family/types.js';

/**
 * MESH-WORKER-PREFS Fix B (mission 6938892f): a mesh WORKER session's set_conversation_prefs
 * (forwarded from the coordinator by MESH_FORWARDABLE_SESSION_COMMANDS) updates the worker's
 * own live-session userHidden/userMuted, but the COORDINATOR's meshOwnedSessions mirror is only
 * refreshed by a `mesh_forward_event` carrying `sessionSettings`. Without one the mirror stays
 * stale, so the coordinator re-emits the OLD surfaceHidden/muted and the dashboard toggle reverts
 * after the 8s optimistic overlay. The handler must push a mesh_forward_event to the coordinator
 * daemon with the fresh prefs. A non-mesh (no coordinator anchor) session must NOT.
 *
 * Fix (4) — atomicity: the mirror forward is now AWAITED (with one retry) and its outcome is
 * reported on the result (`mirrorRefreshed` / `mirrorStale`) so a dropped refresh no longer
 * silently strands the coordinator's stale copy (the "restore does nothing" revert). The local
 * write still returns success; only the mirror status is surfaced.
 */

const SESSION_ID = 'sess_worker_1';
const COORDINATOR_DAEMON = 'daemon-coordinator';
const MESH_ID = 'mesh-abc';
const NODE_ID = 'node-worker';

function makeCtx(opts: {
    settings: Record<string, unknown>;
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    onStatusChange?: () => void;
    statusInstanceId?: string;
    updateLocalMeshOwnedSession?: (payload: Record<string, unknown>) => void;
}): MedFamilyContext {
    const updateSettings = vi.fn();
    const instance = {
        updateSettings,
        getState: () => ({ settings: opts.settings }),
    };
    return {
        deps: {
            instanceManager: {
                getInstance: (id: string) => (id === SESSION_ID ? instance : null),
            },
            dispatchMeshCommand: opts.dispatchMeshCommand,
            onStatusChange: opts.onStatusChange,
            statusInstanceId: opts.statusInstanceId,
            updateLocalMeshOwnedSession: opts.updateLocalMeshOwnedSession,
        },
    } as unknown as MedFamilyContext;
}

// A worker session carries its mesh routing anchors at the SESSION settings level
// (buildMeshWorkerRelayStamp / cli-provider-instance markMeshAssignment).
const WORKER_SETTINGS = {
    meshNodeFor: MESH_ID,
    meshNodeId: NODE_ID,
    meshCoordinatorDaemonId: COORDINATOR_DAEMON,
};

describe('set_conversation_prefs — coordinator mirror forward (Fix B)', () => {
    it('pushes a mesh_forward_event carrying sessionSettings{userHidden,userMuted} to the coordinator', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const ctx = makeCtx({ settings: WORKER_SETTINGS, dispatchMeshCommand: dispatch });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            hidden: true,
            muted: true,
        });

        // Fix (4): awaited forward succeeded → mirrorRefreshed marker, no mirrorStale.
        expect(result).toMatchObject({ success: true, sessionId: SESSION_ID, userHidden: true, userMuted: true, mirrorRefreshed: true });
        expect(result.mirrorStale).toBeUndefined();

        expect(dispatch).toHaveBeenCalledTimes(1);
        const [daemonId, cmd, payload] = dispatch.mock.calls[0];
        expect(daemonId).toBe(COORDINATOR_DAEMON);
        expect(cmd).toBe('mesh_forward_event');
        expect(payload).toMatchObject({
            meshId: MESH_ID,
            targetSessionId: SESSION_ID,
            nodeId: NODE_ID,
            sessionSettings: { userHidden: true, userMuted: true },
        });
    });

    it('forwards a RESTORE (hidden:false) so the mirror clears surfaceHidden', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const ctx = makeCtx({ settings: WORKER_SETTINGS, dispatchMeshCommand: dispatch });

        await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            hidden: false,
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
        const [, , payload] = dispatch.mock.calls[0];
        expect(payload.sessionSettings).toEqual({ userHidden: false });
    });

    it('does NOT forward for a non-mesh session (no coordinator anchor) — regression guard', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const ctx = makeCtx({ settings: { autoApprove: true }, dispatchMeshCommand: dispatch });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            muted: true,
        });

        // 'skipped' outcome for a non-mesh session → no mirror marker at all.
        expect(result).toMatchObject({ success: true, userMuted: true });
        expect(result.mirrorRefreshed).toBeUndefined();
        expect(result.mirrorStale).toBeUndefined();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does NOT forward when no mesh transport exists (standalone)', async () => {
        const ctx = makeCtx({ settings: WORKER_SETTINGS, dispatchMeshCommand: undefined });
        // Must still succeed locally without throwing.
        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            hidden: true,
        });
        expect(result).toMatchObject({ success: true, userHidden: true });
    });

    it('still fires the local status snapshot AND flags mirrorStale when the coordinator forward rejects (Fix 4)', async () => {
        const onStatusChange = vi.fn();
        const dispatch = vi.fn(async () => { throw new Error('coordinator unreachable'); });
        const ctx = makeCtx({ settings: WORKER_SETTINGS, dispatchMeshCommand: dispatch, onStatusChange });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            hidden: true,
        });

        // Local status snapshot fired BEFORE the awaited forward, so the local write is visible.
        expect(onStatusChange).toHaveBeenCalledTimes(1);
        // The local write succeeded, but the mirror could not be refreshed → mirrorStale so the
        // dashboard drops its optimistic overlay instead of trusting a state the coordinator will
        // re-stamp. Must NOT throw (the reject is caught, reported, not propagated).
        expect(result).toMatchObject({ success: true, userHidden: true, mirrorStale: true });
        expect(result.mirrorRefreshed).toBeUndefined();
        // Retried once before giving up.
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('recovers on the retry: a transient first-attempt failure still reports mirrorRefreshed (Fix 4)', async () => {
        let calls = 0;
        const dispatch = vi.fn(async () => {
            calls += 1;
            if (calls === 1) throw new Error('transient blip');
            return { success: true };
        });
        const ctx = makeCtx({ settings: WORKER_SETTINGS, dispatchMeshCommand: dispatch });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            muted: true,
        });

        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ success: true, userMuted: true, mirrorRefreshed: true });
        expect(result.mirrorStale).toBeUndefined();
    });
});

/**
 * SELF-DIAL (mission fix/cloud-local-hide-self-dial): a self-hosted mesh session — coordinated AND
 * hosted by this same daemon — carries meshCoordinatorDaemonId == this daemon's own id. The old
 * code dispatched the mirror refresh over P2P to that id; the mesh manager refuses a self-dial
 * (SELF_DIAL) and the refusal surfaced as mirrorStale → the dashboard dropped its optimistic
 * overlay and the CLOUD hide/mute appeared to do nothing. The self-hosted case must NOT dial and
 * must refresh the local coordinator mirror in-process, reporting mirrorRefreshed (no rollback).
 */
describe('set_conversation_prefs — SELF-DIAL local mirror refresh (self-hosted coordinator)', () => {
    // The coordinator anchor equals THIS daemon's own id — canonicalizes to the same machine core.
    const SELF_DAEMON = 'daemon_mach_selfhost';
    const SELF_HOSTED_SETTINGS = {
        meshNodeFor: MESH_ID,
        meshNodeId: NODE_ID,
        meshCoordinatorDaemonId: SELF_DAEMON,
    };

    it('refreshes the local mirror in-process instead of self-dialing; reports mirrorRefreshed', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const updateLocalMeshOwnedSession = vi.fn();
        const ctx = makeCtx({
            settings: SELF_HOSTED_SETTINGS,
            dispatchMeshCommand: dispatch,
            statusInstanceId: SELF_DAEMON,
            updateLocalMeshOwnedSession,
        });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            hidden: true,
            muted: true,
        });

        // No P2P self-dial — the mirror refresh went through the local hook.
        expect(dispatch).not.toHaveBeenCalled();
        expect(updateLocalMeshOwnedSession).toHaveBeenCalledTimes(1);
        const payload = updateLocalMeshOwnedSession.mock.calls[0][0];
        expect(payload).toMatchObject({
            meshId: MESH_ID,
            targetSessionId: SESSION_ID,
            nodeId: NODE_ID,
            sessionSettings: { userHidden: true, userMuted: true },
        });
        // Reported as fresh so useConversationPrefs keeps the toggle (no rollback).
        expect(result).toMatchObject({ success: true, userHidden: true, userMuted: true, mirrorRefreshed: true });
        expect(result.mirrorStale).toBeUndefined();
    });

    it('treats a form-mismatched coordinator id (bare mach_ vs daemon_mach_) as self — no self-dial', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const updateLocalMeshOwnedSession = vi.fn();
        const ctx = makeCtx({
            // Anchor arrives in the bare `mach_` form; this daemon's id is `daemon_mach_` — the
            // exact daemon-id form-mismatch class that a raw === would miss and then self-dial.
            settings: { ...SELF_HOSTED_SETTINGS, meshCoordinatorDaemonId: 'mach_selfhost' },
            dispatchMeshCommand: dispatch,
            statusInstanceId: 'daemon_mach_selfhost',
            updateLocalMeshOwnedSession,
        });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            hidden: false,
        });

        expect(dispatch).not.toHaveBeenCalled();
        expect(updateLocalMeshOwnedSession).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ success: true, userHidden: false, mirrorRefreshed: true });
        expect(result.mirrorStale).toBeUndefined();
    });

    it('a genuinely REMOTE worker (coordinator != this daemon) still uses the P2P relay — no regression', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const updateLocalMeshOwnedSession = vi.fn();
        const ctx = makeCtx({
            settings: WORKER_SETTINGS, // meshCoordinatorDaemonId = 'daemon-coordinator'
            dispatchMeshCommand: dispatch,
            statusInstanceId: 'daemon_mach_selfhost', // different machine → NOT self
            updateLocalMeshOwnedSession,
        });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            muted: true,
        });

        // Remote path: dispatched over P2P, local mirror hook untouched.
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0]).toBe(COORDINATOR_DAEMON);
        expect(updateLocalMeshOwnedSession).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: true, userMuted: true, mirrorRefreshed: true });
    });

    it('self-hosted with NO local mirror hook (standalone) still reports fresh — never self-dials', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const ctx = makeCtx({
            settings: SELF_HOSTED_SETTINGS,
            dispatchMeshCommand: dispatch,
            statusInstanceId: SELF_DAEMON,
            // updateLocalMeshOwnedSession intentionally absent
        });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            hidden: true,
        });

        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: true, userHidden: true, mirrorRefreshed: true });
        expect(result.mirrorStale).toBeUndefined();
    });

    it('reports mirrorStale (not a false success) when the local mirror hook throws', async () => {
        const dispatch = vi.fn(async () => ({ success: true }));
        const updateLocalMeshOwnedSession = vi.fn(() => { throw new Error('mirror boom'); });
        const ctx = makeCtx({
            settings: SELF_HOSTED_SETTINGS,
            dispatchMeshCommand: dispatch,
            statusInstanceId: SELF_DAEMON,
            updateLocalMeshOwnedSession,
        });

        const result: any = await cliAgentHandlers.set_conversation_prefs(ctx, {
            targetSessionId: SESSION_ID,
            muted: true,
        });

        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: true, userMuted: true, mirrorStale: true });
        expect(result.mirrorRefreshed).toBeUndefined();
    });
});
