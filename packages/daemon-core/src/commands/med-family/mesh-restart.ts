/**
 * RF-ROUTER MED family — coordinator-triggered daemon restart.
 *
 * restart_daemon_node exposes the existing dashboard "preview update" path
 * (low-family daemon_upgrade: update-to-latest-on-channel + detached restart) as
 * a mesh command, so a coordinator can roll a worker daemon onto a freshly
 * deployed version without a manual restart round-trip. It mirrors
 * fast_forward_mesh_node's remote-forward shape — resolve the target node, and
 * if it belongs to a remote daemon forward the command there so the owning
 * daemon (not the coordinator) restarts itself — and adds an idle-gate: a node
 * with a generating / waiting_approval / starting session is refused so an
 * in-flight turn is never killed mid-restart.
 *
 * v1 reuses daemon_upgrade verbatim rather than adding a restart-only path:
 * the goal is "pick up a just-deployed version", which inherently needs the
 * npm reinstall the upgrade helper already performs. Already-latest is a no-op
 * (no restart), matching the dashboard button.
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { daemonLifecycleHandlers } from '../low-family/daemon-lifecycle.js';
import type { CommandRouterResult } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

// Session states that must block a restart: an in-flight turn or a pending
// approval would be lost when the daemon exits to re-spawn. Mirrors the
// daemon-cloud mandatory-update idle-gate (hasBlockingSessionsForMandatoryUpdate).
const RESTART_BLOCKING_STATES = new Set(['generating', 'waiting_approval', 'starting']);

function hasBlockingSessions(ctx: MedFamilyContext): boolean {
    const states = ctx.deps.instanceManager.collectAllStates();
    for (const state of states) {
        if (RESTART_BLOCKING_STATES.has(String(state.status || ''))) return true;
        const childStates = 'extensions' in state && Array.isArray((state as any).extensions)
            ? (state as any).extensions
            : [];
        for (const child of childStates) {
            if (RESTART_BLOCKING_STATES.has(String(child?.status || ''))) return true;
        }
    }
    return false;
}

export const meshRestartHandlers: Record<string, MedFamilyHandler> = {
    restart_daemon_node: async (ctx: MedFamilyContext, args: any): Promise<CommandRouterResult> => {
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';

        // Resolve the target node's owning daemon so a command that lands on a
        // non-owner daemon is forwarded rather than restarting the wrong daemon.
        // preferInline so inline-cache-only worktree nodes still resolve.
        let nodeDaemonId: string | undefined;
        if (meshId && nodeId) {
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const node = meshRecord?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            nodeDaemonId = typeof node?.daemonId === 'string' ? node.daemonId.trim() : undefined;
        }

        const selfDaemonId = ctx.deps.statusInstanceId;
        // daemonIdsEquivalent: a legacy-form daemonId resolving to this machine's
        // core is local — execute here instead of forwarding (and P2P self-dial).
        // Equivalent → local. _meshDirectDispatch prevents re-forwarding once the
        // call has landed on the owning daemon.
        const isRemote = nodeDaemonId && selfDaemonId && !daemonIdsEquivalent(nodeDaemonId, selfDaemonId);
        if (isRemote && ctx.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
            const forwarded = await ctx.deps.dispatchMeshCommand(nodeDaemonId!, 'restart_daemon_node', {
                ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                _meshDirectDispatch: true,
            });
            return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
        }

        // Idle-gate: refuse if any session on THIS daemon is mid-turn / awaiting
        // approval / starting. The coordinator restarts other (idle) nodes freely;
        // restarting the coordinator's OWN daemon is naturally refused while its
        // calling turn is 'generating' (accepted v1 limitation — call other nodes
        // first, the coordinator last when it has gone idle).
        if (hasBlockingSessions(ctx)) {
            return {
                success: false,
                restarted: false,
                code: 'blocking_sessions',
                reason: 'Daemon has an active session (generating / waiting_approval / starting); restart refused to avoid interrupting in-flight work. Retry when the node is idle.',
            };
        }

        // Reuse the battle-tested dashboard "preview update" path: update to the
        // latest published version on the resolved channel, then detached-restart.
        // Already-latest is a no-op (no restart), matching the dashboard button.
        const result = await daemonLifecycleHandlers.daemon_upgrade({ deps: ctx.deps }, args);
        return { ...result, restarted: (result as any)?.restarting === true };
    },
};
