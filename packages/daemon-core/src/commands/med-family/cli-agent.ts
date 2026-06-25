/**
 * RF-ROUTER MED family — CLI/ACP agent + saved-session + restart commands.
 *
 * launch_cli, stop_cli / set_cli_view_mode / record_provider_pty, agent_command,
 * list_saved_sessions and restart_session. launch_cli and agent_command stamp
 * mesh-worker relay metadata and surface worktree-bootstrap-pending hints around a
 * delegation to cliManager. restart_session dispatches IDE restarts (via ctx.stopIde
 * + ctx.launchIde — no executeDaemonCommand recursion) or CLI/ACP restarts.
 * Extracted verbatim from executeDaemonCommand.
 */
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { supportsExplicitSessionResume } from '../cli-manager.js';
import { loadState } from '../../config/state-store.js';
import { getRecentActivity } from '../../config/recent-activity.js';
import { getSavedProviderSessions } from '../../config/saved-sessions.js';
import { listProviderHistorySessions } from '../../config/chat-history.js';
import { buildMeshWorkerRelayStamp } from '../../mesh/mesh-events-utils.js';
import { readStringValue } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

export const cliAgentHandlers: Record<string, MedFamilyHandler> = {
    launch_cli: async (ctx: MedFamilyContext, args: any) => {
        // The coordinator routing anchor (meshCoordinatorDaemonId) is stamped
        // upstream by mesh_launch_session, which resolves
        // coordinatorNode.daemonId || ctx.localDaemonId || ctx.localMachineId and
        // fail-closes for a remote node when none resolve. We deliberately do NOT
        // self-stamp this daemon's own id when the field is missing: for a
        // P2P-relayed remote worker launch, stamping the worker's own id would make
        // the self-forward gate (mesh-events-coordinator: daemonIdsEquivalent) treat the
        // worker as its own coordinator, suppressing the spontaneous completion-event
        // forward and leaving the event in the pending inbox until a read_chat
        // reconcile drains it. If the anchor is genuinely absent here, leave it
        // absent rather than poison the routing.
        const launchResult = await ctx.deps.cliManager.handleCliCommand('launch_cli', args);
        // Bug C fix (part 1): when launching a mesh node worker session, surface
        // bootstrapPending:true if the node's worktree bootstrap is still running.
        // This is informational — the launch is NOT blocked here (blocking is done
        // upstream by getWorktreeBootstrapLaunchBlock in the MCP layer).
        const meshNodeId = readStringValue((args?.settings as any)?.meshNodeId);
        const meshId = readStringValue((args?.settings as any)?.meshNodeFor);
        if (meshNodeId && meshId && launchResult?.success !== false) {
            try {
                const { getMesh } = await import('../../config/mesh-config.js');
                const meshObj = getMesh(meshId) ?? ctx.getCachedInlineMesh(meshId);
                const nodeObj = Array.isArray(meshObj?.nodes)
                    ? meshObj.nodes.find((n: any) => meshNodeIdMatches(n, meshNodeId))
                    : undefined;
                const bootstrapStatus = readStringValue(nodeObj?.worktreeBootstrap?.status);
                if (bootstrapStatus === 'running') {
                    return { success: true, ...launchResult, bootstrapPending: true };
                }
            } catch { /* best-effort — do not fail launch for bootstrap probe errors */ }
        }
        return launchResult;
    },

    stop_cli: async (ctx: MedFamilyContext, args: any) => {
        return ctx.deps.cliManager.handleCliCommand('stop_cli', args);
    },
    set_cli_view_mode: async (ctx: MedFamilyContext, args: any) => {
        return ctx.deps.cliManager.handleCliCommand('set_cli_view_mode', args);
    },
    record_provider_pty: async (ctx: MedFamilyContext, args: any) => {
        return ctx.deps.cliManager.handleCliCommand('record_provider_pty', args);
    },

    agent_command: async (ctx: MedFamilyContext, args: any) => {
        // Relay-safety stamp: a dispatch carrying meshContext.coordinatorDaemonId
        // (mesh_send_task / queue assignment over P2P) is the worker daemon's chance
        // to persist the coordinator routing anchor onto the target session BEFORE the
        // turn runs. Without meshCoordinatorDaemonId on the session, the core forwarder
        // (injectMeshSystemMessage) cannot resolve a remote coordinator target, so the
        // completion event sits in the pending queue until a read_chat reconcile drains
        // it. Stamping here makes a reused/relaunched remote session relay-safe at
        // dispatch time even when it was not launched via mesh_launch_session.
        {
            const dispatchSessionId = readStringValue(args?.targetSessionId, (args as any)?.sessionId, (args as any)?.instanceId);
            const dispatchMeshContext = args?.meshContext as Record<string, unknown> | undefined;
            if (dispatchSessionId && dispatchMeshContext) {
                try {
                    const inst = ctx.deps.instanceManager.getInstance(dispatchSessionId);
                    if (inst && typeof inst.updateSettings === 'function') {
                        const stamp = buildMeshWorkerRelayStamp(
                            inst.getState?.()?.settings as Record<string, unknown> | undefined,
                            {
                                meshId: dispatchMeshContext.meshId,
                                nodeId: dispatchMeshContext.nodeId,
                                coordinatorDaemonId: dispatchMeshContext.coordinatorDaemonId,
                                // Session-level anchor: preserved across the P2P dispatch to a
                                // remote worker so its completion echoes back to the right session.
                                coordinatorSessionId: dispatchMeshContext.coordinatorSessionId,
                            },
                        );
                        if (stamp) inst.updateSettings(stamp);
                    }
                } catch { /* best-effort — dispatch still proceeds without the stamp */ }
            }
        }
        // Bug C fix / bootstrapPending dispatch gap: a task dispatched to a mesh node
        // whose worktree bootstrap is STILL running must NOT be injected yet. Before this
        // gate the dispatch proceeded and the prompt landed in the session's input buffer
        // while the provider (e.g. claude CLI) was not yet ready to consume it — the inject
        // was silently swallowed (the chat bubble showed the text but the session never
        // transitioned to generating and never claimed the task). The prior code only
        // ANNOTATED the already-completed dispatch with 'bootstrap_still_running' after the
        // fact, which did not close the gap. Defer instead: refuse the inject with a
        // recoverable signal so the coordinator re-sends once the node is ready (the
        // confirmed "re-send to a ready session works" path), mirroring the queued-delivery
        // contract for busy sessions. send_chat only — non-task actions still pass through.
        const meshCtx = args?.meshContext as Record<string, unknown> | undefined;
        const dispatchNodeId = readStringValue(meshCtx?.nodeId);
        const dispatchMeshId = readStringValue(meshCtx?.meshId);
        const isSendChat = args?.action === 'send_chat';
        if (isSendChat && dispatchNodeId && dispatchMeshId) {
            try {
                const { getMesh } = await import('../../config/mesh-config.js');
                const meshObj = getMesh(dispatchMeshId) ?? ctx.getCachedInlineMesh(dispatchMeshId);
                const nodeObj = Array.isArray(meshObj?.nodes)
                    ? meshObj.nodes.find((n: any) => meshNodeIdMatches(n, dispatchNodeId))
                    : undefined;
                const bootstrapStatus = readStringValue(nodeObj?.worktreeBootstrap?.status);
                if (bootstrapStatus === 'running') {
                    return {
                        success: false,
                        recoverable: true,
                        dispatched: false,
                        code: 'mesh_node_bootstrap_pending',
                        reason: 'bootstrap_still_running',
                        nodeId: dispatchNodeId,
                        meshId: dispatchMeshId,
                        ...(readStringValue(meshCtx?.taskId) ? { taskId: readStringValue(meshCtx?.taskId) } : {}),
                        error: `Node '${dispatchNodeId}' worktree bootstrap is still running; a task injected now would land in the session input buffer before the provider is ready to consume it and be silently lost. Dispatch deferred.`,
                        nextAction: 'Wait for the worktree_bootstrap_complete event (or poll mesh_status until the node session is ready), then re-send the task with mesh_send_task. Alternatively use mesh_enqueue_task so the queue auto-assigns it once a ready session is available.',
                    };
                }
            } catch { /* best-effort — if the bootstrap probe fails, fall through and dispatch */ }
        }
        return ctx.deps.cliManager.handleCliCommand('agent_command', args);
    },

    // ─── Logs ───
    list_saved_sessions: async (ctx: MedFamilyContext, args: any) => {
        const providerType = typeof args?.providerType === 'string'
            ? args.providerType.trim()
            : typeof args?.agentType === 'string'
                ? args.agentType.trim()
                : '';
        const kind = args?.kind === 'acp' ? 'acp' : 'cli';
        if (!providerType) {
            return { success: false, error: 'providerType required' };
        }

        const wantsAll = args?.all === true;
        const offset = wantsAll ? 0 : Math.max(0, Number(args?.offset) || 0);
        const limit = wantsAll ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(100, Number(args?.limit) || 30));
        const requestedWorkspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
        const requestedProviderSessionId = typeof args?.providerSessionId === 'string'
            ? args.providerSessionId.trim()
            : typeof args?.activeProviderSessionId === 'string'
                ? args.activeProviderSessionId.trim()
                : '';
        const providerMeta = ctx.deps.providerLoader.resolve?.(providerType) || ctx.deps.providerLoader.getMeta(providerType);
        const { sessions: historySessions, hasMore, source } = listProviderHistorySessions(providerType, {
            canonicalHistory: providerMeta?.nativeHistory,
            offset,
            limit,
            historyBehavior: providerMeta?.historyBehavior,
            scripts: providerMeta?.scripts as any,
        });
        const state = loadState();
        const savedSessions = getSavedProviderSessions(state, { providerType, kind });
        const recentSessions = getRecentActivity(state, 200)
            .filter(entry => entry.providerType === providerType && entry.kind === kind && entry.providerSessionId);
        const savedSessionById = new Map(savedSessions.map(entry => [entry.providerSessionId, entry]));
        const recentSessionById = new Map(recentSessions.map(entry => [entry.providerSessionId!, entry]));
        const canResumeById = supportsExplicitSessionResume(providerMeta?.resume);

        return {
            success: true,
            sessions: historySessions.map(session => {
                const saved = savedSessionById.get(session.historySessionId);
                const recent = recentSessionById.get(session.historySessionId);
                const workspace = saved?.workspace
                    || recent?.workspace
                    || session.workspace
                    || (requestedWorkspace && requestedProviderSessionId === session.historySessionId ? requestedWorkspace : undefined);
                return {
                    id: session.historySessionId,
                    providerSessionId: session.historySessionId,
                    providerType,
                    providerName: saved?.providerName || recent?.providerName || providerType,
                    kind: saved?.kind || recent?.kind || kind,
                    title: saved?.title || recent?.title || session.sessionTitle || session.preview || providerType,
                    workspace,
                    summaryMetadata: saved?.summaryMetadata || recent?.summaryMetadata,
                    preview: session.preview,
                    messageCount: session.messageCount,
                    firstMessageAt: session.firstMessageAt,
                    lastMessageAt: session.lastMessageAt,
                    canResume: !!workspace && canResumeById,
                    historySource: session.source,
                    sourcePath: session.sourcePath,
                    sourceMtimeMs: session.sourceMtimeMs,
                };
            }),
            hasMore,
            source,
        };
    },

    // ─── restart_session: IDE / CLI / ACP unified ───
    restart_session: async (ctx: MedFamilyContext, args: any) => {
        const targetType = args?.cliType || args?.agentType || args?.ideType;
        if (!targetType) throw new Error('cliType or ideType required');

        // Check if IDE (in cdpManagers or provider category is ide)
        const isIde = ctx.deps.cdpManagers.has(targetType) ||
            ctx.deps.providerLoader.getMeta(targetType)?.category === 'ide';

        if (isIde) {
            // IDE restart: stop (with process kill) → launch
            await ctx.stopIde(targetType, true);
            const launchResult = await ctx.launchIde({ ideType: targetType, enableCdp: true, workspace: args?.workspace });
            return { success: true, restarted: true, ideType: targetType, launch: launchResult };
        }

        // CLI/ACP restart: delegate to CliManager
        return ctx.deps.cliManager.handleCliCommand('restart_session', args);
    },
};
