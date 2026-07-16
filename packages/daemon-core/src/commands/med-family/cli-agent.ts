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
import { meshNodeIdMatches, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { supportsExplicitSessionResume } from '../cli-manager.js';
import { loadState } from '../../config/state-store.js';
import { getRecentActivity } from '../../config/recent-activity.js';
import { getSavedProviderSessions } from '../../config/saved-sessions.js';
import { listProviderHistorySessions } from '../../config/chat-history.js';
import { buildMeshWorkerRelayStamp, readNonEmptyString } from '../../mesh/mesh-events-utils.js';
import { LOG } from '../../logging/logger.js';
import { readStringValue } from '../router.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';

/**
 * Outcome of the coordinator-mirror refresh: not a mesh worker (no-op), refreshed via the remote
 * relay, refreshed locally (self-hosted coordinator == this daemon — no P2P dial), or failed.
 * 'refreshed-local' and 'refreshed' both mean the mirror is now fresh; the caller reports them
 * identically (mirrorRefreshed, no mirrorStale) so a self-hosted toggle never rolls back.
 */
type MirrorForwardOutcome = 'skipped' | 'refreshed' | 'refreshed-local' | 'failed';

/**
 * MESH-WORKER-PREFS Fix B: when a mesh WORKER session's per-conversation Hide/Mute is toggled
 * (set_conversation_prefs, forwarded to the worker daemon by the coordinator's
 * MESH_FORWARDABLE_SESSION_COMMANDS router), the worker updates its own live-session
 * userHidden/userMuted but the COORDINATOR's mirror of that session (adhdev-daemon
 * meshOwnedSessions) is only refreshed by a `mesh_forward_event` carrying `sessionSettings`.
 * Without one the mirror stays stale, so when the coordinator re-emits the session metadata to
 * the dashboard the old surfaceHidden/muted comes back and the toggle reverts after the 8s
 * optimistic overlay expires. Push a `mesh_forward_event` to the coordinator daemon with the
 * fresh prefs so its mirror updates immediately. The coordinator's mesh_forward_event command
 * consumer calls updateMeshOwnedSession(args) BEFORE routing, so the mirror is refreshed even
 * though the (non coordinator-event) event name is otherwise ignored.
 *
 * Fix (4) — atomicity: the worker's local updateSettings and the coordinator mirror refresh were
 * fire-and-forget, so a dropped/rejected forward left the mirror stale and the dashboard toggle
 * silently reverted (the exact "restore does nothing" defect). This now AWAITS the dispatch, retries
 * once on failure, and reports the outcome so the handler can flag a stale mirror to the caller
 * instead of returning an unqualified success. It never rejects — a failure is reported, not thrown,
 * so the local write (already applied) still returns success with a mirrorStale marker.
 *
 * SELF-DIAL (mission fix/cloud-local-hide-self-dial): a self-hosted mesh session — one this daemon
 * both coordinates AND hosts — carries a meshCoordinatorDaemonId equal to this daemon's own id.
 * Dispatching the mirror refresh over P2P to that id self-dials, which the mesh manager REFUSES
 * (SELF_DIAL) → the old code reported that refusal as 'failed' → mirrorStale → the dashboard
 * dropped its optimistic overlay and the toggle appeared to do nothing (the exact CLOUD-local
 * hide/mute "무반응" defect). The remote-worker relay path (coordinatorDaemonId != this daemon)
 * is unchanged. When the coordinator IS this daemon we skip the dial entirely and refresh the
 * local coordinator mirror directly via updateLocalMeshOwnedSession (the cloud runtime wires it to
 * the same updateMeshOwnedSession + dashboard flush the remote mesh_forward_event consumer runs),
 * reporting 'refreshed-local' so no rollback occurs.
 */
async function forwardConversationPrefsToCoordinator(
    ctx: MedFamilyContext,
    sessionId: string,
    patch: Record<string, unknown>,
): Promise<MirrorForwardOutcome> {
    const dispatch = ctx.deps.dispatchMeshCommand;
    if (!dispatch) return 'skipped';
    let settings: Record<string, unknown> = {};
    try {
        const state = ctx.deps.instanceManager.getInstance(sessionId)?.getState?.();
        if (state?.settings && typeof state.settings === 'object') {
            settings = state.settings as Record<string, unknown>;
        }
    } catch { /* best-effort — no session settings, nothing to forward */ }

    const coordinatorDaemonId = readNonEmptyString(settings.meshCoordinatorDaemonId);
    const meshId = readNonEmptyString(settings.meshNodeFor);
    // A non-delegated (non-mesh) session has no coordinator anchor — nothing to mirror.
    if (!coordinatorDaemonId || !meshId) return 'skipped';
    const nodeId = readNonEmptyString(settings.meshNodeId) || readNonEmptyString(settings.meshLastNodeId);

    // sessionSettings mirrors the exact keys updateMeshOwnedSession merges onto the mirror's
    // settings (userHidden / userMuted). The coordinator's mirror resolver reads these to derive
    // surfaceHidden/muted, so the dashboard sees the fresh value on the next metadata flush.
    const payload: Record<string, unknown> = {
        event: 'session:settings_changed',
        meshId,
        targetSessionId: sessionId,
        ...(nodeId ? { nodeId } : {}),
        sessionSettings: { ...patch },
    };

    // SELF-DIAL guard: the coordinator anchor resolves to THIS daemon. Refresh the local mirror
    // in-process instead of dispatching a P2P command to our own id (which the mesh manager
    // refuses as SELF_DIAL, formerly surfacing as mirrorStale → a false rollback). Uses the
    // machine-core-canonicalizing daemonIdsEquivalent — a raw === would miss a same-machine anchor
    // that arrives in a different id form (daemon_mach_X vs mach_X), the repeatedly-regressed
    // daemon-id form-mismatch class in this repo, and self-dial anyway.
    const selfDaemonId = readNonEmptyString((ctx.deps as any).statusInstanceId);
    if (selfDaemonId && daemonIdsEquivalent(coordinatorDaemonId, selfDaemonId)) {
        const refreshLocal = ctx.deps.updateLocalMeshOwnedSession;
        if (refreshLocal) {
            try {
                refreshLocal(payload);
                return 'refreshed-local';
            } catch (e: any) {
                LOG.warn('Mesh', `[Mesh] set_conversation_prefs local coordinator-mirror refresh failed: ${e?.message || e}`);
                return 'failed';
            }
        }
        // No local mirror hook (e.g. standalone) — the live instance write already applied is the
        // single source of truth, so treat the self-hosted case as refreshed rather than dialing.
        return 'refreshed-local';
    }

    // Await the mirror refresh (Fix 4). One retry: a transient P2P blip on the coordinator
    // channel shouldn't strand the mirror stale when the worker's own state already moved.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await dispatch(coordinatorDaemonId, 'mesh_forward_event', payload);
            return 'refreshed';
        } catch (e: any) {
            if (attempt === 0) continue;
            LOG.warn('Mesh', `[Mesh] set_conversation_prefs mirror forward to coordinator ${coordinatorDaemonId.slice(0, 12)} failed after retry: ${e?.message || e}`);
            return 'failed';
        }
    }
    return 'failed';
}

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

    // Daemon-owned per-session user Mute/Hide. Replaces the old browser-local
    // localStorage layer: the user's manual hide/mute for a conversation is stored
    // in-memory on the live session's settings (userHidden / userMuted) and rides
    // the SAME status snapshot pipeline as the coordinator-policy surfaceHidden
    // flag, so every client of this daemon sees the same state. In-memory only —
    // resets on daemon restart (coordinator-spawned sessions re-derive their hidden
    // default from mesh policy on relaunch). Passing null/undefined for a field
    // leaves it unchanged; pass an explicit boolean to set, or false to clear an
    // earlier hide/mute (e.g. unmute a coordinator-spawned worker overrides the
    // policy default until restart).
    set_conversation_prefs: async (ctx: MedFamilyContext, args: any) => {
        const sessionId = readStringValue(args?.sessionId, (args as any)?.targetSessionId, (args as any)?.instanceId);
        if (!sessionId) return { success: false, error: 'sessionId required' };
        const inst = ctx.deps.instanceManager.getInstance(sessionId);
        if (!inst || typeof inst.updateSettings !== 'function') {
            return { success: false, error: 'Session not found or does not support preferences' };
        }
        const patch: Record<string, unknown> = {};
        if (typeof args?.hidden === 'boolean') patch.userHidden = args.hidden;
        if (typeof args?.muted === 'boolean') patch.userMuted = args.muted;
        if (!Object.keys(patch).length) return { success: false, error: 'Nothing to update (hidden and/or muted required)' };
        inst.updateSettings(patch);
        // Push a fresh status snapshot so all clients see the updated
        // surfaceHidden/muted immediately (cloud path). The standalone server has a
        // parallel broadcast gate keyed on the command name (see daemon-standalone).
        // Fired BEFORE the awaited mirror refresh so the local write is visible even if
        // the coordinator mirror dispatch is slow or fails.
        ctx.deps.onStatusChange?.();
        // MESH-WORKER-PREFS Fix B + Fix (4): if this is a mesh worker session, mirror the fresh
        // prefs onto the coordinator so its stale meshOwnedSessions copy can't revert the toggle
        // when it re-emits the dashboard metadata. AWAITED (with one retry) so a dropped mirror
        // refresh is reported to the caller (mirrorStale) instead of silently leaving the
        // coordinator to re-stamp the old value — the "restore does nothing" revert. No-op for
        // non-mesh sessions. Never throws: the local write already succeeded.
        const mirror = await forwardConversationPrefsToCoordinator(ctx, sessionId, patch);
        return {
            success: true,
            sessionId,
            ...patch,
            // Only surface the mirror status for a genuine mesh session (refreshed/failed);
            // a non-mesh session ('skipped') carries no mirror field, so nothing changes for it.
            // A self-hosted session ('refreshed-local' — coordinator == this daemon) refreshed its
            // own mirror in-process and is reported as fresh so the dashboard never rolls back.
            ...(mirror === 'failed' ? { mirrorStale: true } : {}),
            ...(mirror === 'refreshed' || mirror === 'refreshed-local' ? { mirrorRefreshed: true } : {}),
        };
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
                // COMPLETION-PROPAGATION F6 (C1 SSOT): read the router's synchronous inline mesh
                // cache FIRST, falling back to getMesh only when the inline view has nothing. The
                // inline cache is the authoritative bootstrap-status source — markWorktreeBootstrapTerminalState
                // stamps 'complete'/'failed' into it SYNCHRONOUSLY, then persists to local config
                // (what getMesh reads) via a DETACHED async import chain that lags. Reading getMesh
                // first therefore observed a stale 'running' and deferred a dispatch whose worktree
                // was already bootstrapped — the stale-'running' defer this eliminates. Inline-first
                // makes the freshest single source of truth win for both the running and terminal states.
                const meshObj = ctx.getCachedInlineMesh(dispatchMeshId) ?? getMesh(dispatchMeshId);
                const nodeObj = Array.isArray(meshObj?.nodes)
                    ? meshObj.nodes.find((n: any) => meshNodeIdMatches(n, dispatchNodeId))
                    : undefined;
                // COMPLETION-PROPAGATION F7 (C2): the single shared consume-ready/bootstrap-pending
                // defer predicate (honors the stale-'running' git-clean backstop internally), reused
                // by the local queue-claim gate too so remote and local dispatch agree on when to defer.
                const { shouldDeferDispatchForBootstrap } = await import('../../mesh/worktree-bootstrap-config.js');
                if (shouldDeferDispatchForBootstrap(nodeObj as any)) {
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
