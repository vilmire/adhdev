/**
 * Status Builders — shared conversion functions for ProviderState → ManagedEntry
 *
 * Used by:
 *   - daemon-standalone (StandaloneServer.getStatus)
 *   - DaemonStatusReporter
 *
 * Consolidates ProviderState→ManagedEntry mapping logic.
 */

import type { DaemonCdpManager } from '../cdp/manager.js';
import type { GitCompactSummary } from '../git/git-types.js';
import type { SessionEntry, SessionCapability } from '../shared-types.js';
import type {
    IdeProviderState,
    CliProviderState,
    AcpProviderState,
    ExtensionProviderState,
    ProviderState,
} from '../providers/provider-instance.js';
import {
    LIVE_STATUS_ACTIVE_CHAT_OPTIONS,
    normalizeActiveChatData,
    normalizeManagedStatus,
    type ManagedStatus,
    type NormalizeActiveChatOptions,
} from './normalize.js';
import {
    resolveSessionTurnPresentation,
    type SessionTurnPresentation,
} from '../mesh/mesh-turn-presentation.js';
import { getMeshQueueStats } from '../mesh/mesh-work-queue.js';
import { SILENT_IDLE_PUSH_TTL_MS } from '../repo-mesh-types.js';
import { getCoordinatorForSession } from '../mesh/coordinator-registry.js';
import { normalizeProviderStateControlValues } from '../providers/provider-patch-state.js';
import { normalizeProviderSummaryMetadata } from '../providers/summary-metadata.js';
import {
    IDE_PROVIDER_SESSION_CAPABILITIES_BASE,
    EXTENSION_PROVIDER_SESSION_CAPABILITIES_BASE,
} from '../providers/open-panel-support.js';
import { TEXT_ONLY_MESSAGE_INPUT_SUPPORT } from '../providers/provider-input-support.js';

/**
 * A coordinator-spawned worker session that mesh policy launched hidden. This is
 * the daemon-side equivalent of the web `shouldAutoHideMeshConversation` predicate:
 * these sessions should default to muted+hidden in the user dashboard (the user
 * interacts through the ONE coordinator session, not each worker), while the
 * coordinator↔worker mesh data/completion path (mesh-event-forwarding) is
 * unaffected.
 */
export function isCoordinatorSpawnedHiddenWorker(settings: Record<string, any> | undefined): boolean {
    if (!settings) return false;
    return settings.launchedByCoordinator === true
        && typeof settings.meshNodeFor === 'string'
        && settings.meshNodeFor.trim().length > 0
        && settings.spawnedSessionVisibility === 'hidden';
}

/**
 * A session is surface-hidden (collapsed from the user's inbox/notifications) when
 * mesh policy spawned it hidden, OR when a coordinator-spawned worker defaults
 * hidden, OR when the user manually hid it (userHidden). userHidden === false is an
 * explicit un-hide that overrides the policy/worker default until daemon restart.
 */
export function resolveSurfaceHidden(settings: Record<string, any> | undefined): boolean {
    if (!settings) return false;
    if (settings.userHidden === true) return true;
    if (settings.userHidden === false) return false;
    return settings.spawnedSessionVisibility === 'hidden' || isCoordinatorSpawnedHiddenWorker(settings);
}

/**
 * Whether a one-shot silent-idle-push arm is currently ACTIVE for this session's
 * completion snapshot. Set on a coordinator-dispatched worker when the mesh policy
 * is `coordinatorIdlePushPolicy: 'auto_silent_on_dispatch'` (see arm sites in
 * mesh-queue-assignment). Guardrails baked in here:
 *  - status-gated to `idle`: the arm mutes ONLY the routine completion snapshot, so
 *    an approval-needed / failure / long-running notification in the SAME turn (which
 *    the worker emits with a non-idle status) is NEVER suppressed.
 *  - TTL leak-guard: an arm older than SILENT_IDLE_PUSH_TTL_MS is treated as expired,
 *    so a worker whose completion never arrives cannot strand its session muted.
 * The arm itself is one-shot: emitGeneratingCompleted clears it after the completion
 * so the following turn notifies normally.
 */
function isSilentIdlePushArmActive(
    settings: Record<string, any> | undefined,
    status: string | undefined,
): boolean {
    if (!settings || settings.silentNextIdlePush !== true) return false;
    if (status !== 'idle') return false;
    const armedAt = Number(settings.silentNextIdlePushArmedAt);
    if (!Number.isFinite(armedAt) || armedAt <= 0) {
        // No/invalid arm timestamp: honor the flag (fail-safe toward the explicit
        // arm) but it will be one-shot-cleared at the completion emission.
        return true;
    }
    return (Date.now() - armedAt) <= SILENT_IDLE_PUSH_TTL_MS;
}

/**
 * A session is muted (attention side-effects suppressed, but still shown in the
 * list) when the user muted it, OR a coordinator-spawned worker defaults muted, OR
 * a one-shot silent-idle-push arm is active for this completion snapshot (see
 * isSilentIdlePushArmActive — status-gated + TTL-bounded so approval/failure pushes
 * and never-completing workers are unaffected). userMuted === false is an explicit
 * un-mute overriding the worker/policy default — but NOT the one-shot arm, which is a
 * coordinator-driven per-completion decision that a stale manual un-mute must not
 * defeat.
 *
 * `status` is the session's resolved status for the snapshot being built; omit it
 * (undefined) for callers that only have mesh-attribution fields (the cloud mirror),
 * where the one-shot never applies.
 */
export function resolveMuted(settings: Record<string, any> | undefined, status?: string): boolean {
    if (!settings) return false;
    if (isSilentIdlePushArmActive(settings, status)) return true;
    if (settings.userMuted === true) return true;
    if (settings.userMuted === false) return false;
    return isCoordinatorSpawnedHiddenWorker(settings);
}

/**
 * Pure resolver for a mesh-spawned worker session's dashboard hide+mute state,
 * shared by the standalone/local `buildSessionEntries` path (via the wrappers
 * above, which read the values off a full settings object) AND the cloud daemon's
 * synthetic remote-mesh-session mirror path in daemon-cloud
 * (`appendMeshOwnedSessionsToSnapshot`), which has no full ProviderState — only
 * the mesh attribution fields. Keeping both paths on this ONE helper guarantees a
 * remote worker surfaced on the cloud dashboard hides+mutes identically to a local
 * worker on standalone. A valid `userHidden`/`userMuted` boolean is an explicit
 * per-session override and wins over the policy/worker default.
 */
export function resolveSpawnedSessionHideMute(input: {
    launchedByCoordinator?: unknown;
    meshNodeFor?: unknown;
    spawnedSessionVisibility?: unknown;
    userHidden?: unknown;
    userMuted?: unknown;
}): { surfaceHidden: boolean; muted: boolean } {
    return {
        surfaceHidden: resolveSurfaceHidden(input as Record<string, any>),
        muted: resolveMuted(input as Record<string, any>),
    };
}

export type SessionEntryProfile = 'full' | 'live' | 'metadata';

export interface SessionEntryBuildOptions {
    profile?: SessionEntryProfile;
    getGitSummaryForWorkspace?: (workspace: string) => GitCompactSummary | null | undefined;
}

function getActiveChatOptions(profile: SessionEntryProfile): NormalizeActiveChatOptions {
    if (profile === 'full') return {};
    return LIVE_STATUS_ACTIVE_CHAT_OPTIONS;
}

function resolveSessionStatus(
    activeChat: { status?: string | null; activeModal?: { buttons?: unknown[] | null } | null } | null | undefined,
    providerStatus?: string | null,
) {
    const chatStatus = normalizeManagedStatus(activeChat?.status, { activeModal: activeChat?.activeModal || null });
    const topLevelStatus = normalizeManagedStatus(providerStatus, { activeModal: activeChat?.activeModal || null });

    if (chatStatus === 'waiting_approval' || topLevelStatus === 'waiting_approval') return 'waiting_approval';
    if (chatStatus === 'generating' || topLevelStatus === 'generating') return 'generating';
    if (topLevelStatus !== 'idle') return topLevelStatus;
    return chatStatus;
}

/**
 * TURN-PRESENTATION (Stage 6): the single status authority for session entries.
 * The legacy provider-FSM/chat merge above still computes the LEGACY status — it
 * is the shadow-comparison input and the fallback for sessions with no mesh turn
 * attempt. When the session owns a Stage 5 attempt, the reducer projection
 * overrides the presented status (and rides along as `turn`).
 */
function resolveSessionStatusUnified(args: {
    sessionId: string | null | undefined;
    providerType: string | null | undefined;
    activeChat: { status?: string | null; activeModal?: { buttons?: unknown[] | null } | null } | null | undefined;
    providerStatus?: string | null;
}): { status: ManagedStatus; turn: SessionTurnPresentation } {
    const legacyStatus = resolveSessionStatus(args.activeChat, args.providerStatus);
    const turn = resolveSessionTurnPresentation({
        sessionId: args.sessionId,
        legacyStatus,
        providerType: args.providerType,
        surface: 'session_status',
    });
    return { status: turn.status, turn };
}

function shouldIncludeSessionControls(profile: SessionEntryProfile): boolean {
    return profile !== 'live';
}

function shouldIncludeSessionMetadata(profile: SessionEntryProfile): boolean {
    return profile !== 'live';
}

function shouldIncludeRuntimeMetadata(profile: SessionEntryProfile): boolean {
    return true;
}

function getGitSummaryForWorkspace(
    workspace: string | null | undefined,
    options: SessionEntryBuildOptions,
): GitCompactSummary | undefined {
    if (!workspace) return undefined;
    return options.getGitSummaryForWorkspace?.(workspace) || undefined;
}

// ─── CDP Manager lookup helpers ──────────────────────

/**
 * Find a CDP manager by key. Supports single-window (`cursor`) and full multi-window keys (`cursor_<targetId>`).
 *
 * Lookup order:
 *   1. Exact match when connected
 *   2. If key has no multi-window suffix: at most **one** connected manager whose key starts with `key_`
 *   3. If two or more windows share that prefix → **null** (ambiguous — pass full managerKey from `GET /api/cdp/targets`)
 */
export function findCdpManager(
    cdpManagers: Map<string, DaemonCdpManager>,
    key: string,
): DaemonCdpManager | null {
    // 1. Exact match (single-window: "cursor", or full managerKey: "cursor_<targetId>")
    const exact = cdpManagers.get(key);
    if (exact) return exact.isConnected ? exact : null;

    // 2. Prefix match only when it resolves to exactly one connected manager
    const prefix = key + '_';
    const matches = [...cdpManagers.entries()].filter(([k, m]) => m.isConnected && k.startsWith(prefix));
    if (matches.length === 1) return matches[0][1];
    // 0 matches → null; 2+ → ambiguous — caller must pass full managerKey (e.g. from /api/cdp/targets)
    return null;
}

/**
 * Check if any CDP manager matches the given key (exact or prefix).
 */
export function hasCdpManager(
    cdpManagers: Map<string, DaemonCdpManager>,
    key: string,
): boolean {
    if (cdpManagers.has(key)) return true;
    const prefix = key + '_';
    for (const k of cdpManagers.keys()) {
        if (k.startsWith(prefix)) return true;
    }
    return false;
}

/**
 * Check if any CDP manager matching the key is connected.
 */
export function isCdpConnected(
    cdpManagers: Map<string, DaemonCdpManager>,
    key: string,
): boolean {
    const exact = cdpManagers.get(key);
    if (exact?.isConnected) return true;
    const prefix = key + '_';
    for (const [k, m] of cdpManagers.entries()) {
        if (m.isConnected && k.startsWith(prefix)) return true;
    }
    return false;
}


const IDE_SESSION_CAPABILITIES: SessionCapability[] = [...IDE_PROVIDER_SESSION_CAPABILITIES_BASE];

const EXTENSION_SESSION_CAPABILITIES: SessionCapability[] = [...EXTENSION_PROVIDER_SESSION_CAPABILITIES_BASE];

const PTY_SESSION_CAPABILITIES: SessionCapability[] = [
    'read_chat',
    'send_message',
    'resolve_action',
    'terminal_io',
    'resize_terminal',
];

const CLI_CHAT_SESSION_CAPABILITIES: SessionCapability[] = [
    'read_chat',
    'send_message',
    'resolve_action',
];

const ACP_SESSION_CAPABILITIES: SessionCapability[] = [
    'read_chat',
    'send_message',
    'new_session',
    'resolve_action',
    'change_model',
    'set_mode',
    'set_thought_level',
];

function buildWorkspaceSession(
    state: IdeProviderState,
    cdpManagers: Map<string, DaemonCdpManager>,
    options: SessionEntryBuildOptions,
): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(state.activeChat, getActiveChatOptions(profile));
    const summaryMetadata = normalizeProviderSummaryMetadata(state.summaryMetadata);
    const controlValues = normalizeProviderStateControlValues(state.controlValues);
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    const workspace = state.workspace || null;
    const git = getGitSummaryForWorkspace(workspace, options);
    const title = activeChat?.title || state.name;
    const meshCoordinatorFor = state.settings?.meshCoordinatorFor as string | undefined;
    const registryEntry = state.instanceId ? getCoordinatorForSession(state.instanceId) : undefined;
    const effectiveMeshId = meshCoordinatorFor || registryEntry?.meshId;
    const coordinator = effectiveMeshId ? { meshId: effectiveMeshId, role: 'coordinator' as const } : undefined;
    const meshQueueStats = effectiveMeshId ? getMeshQueueStats(effectiveMeshId) : undefined;
    const resolved = resolveSessionStatusUnified({ sessionId: state.instanceId, providerType: state.type, activeChat, providerStatus: state.status });
    return {
        id: state.instanceId || state.type,
        parentId: null,
        providerType: state.type,
        providerName: state.name,
        kind: 'workspace',
        transport: 'cdp-page',
        status: resolved.status,
        ...(resolved.turn.authority === 'turn_reducer' ? { turn: resolved.turn } : {}),
        title,
        workspace,
        ...(git && { git }),
        activeChat,
        ...(summaryMetadata && { summaryMetadata }),
        ...(includeSessionMetadata && { capabilities: state.sessionCapabilities || IDE_SESSION_CAPABILITIES, messageInput: state.messageInput || TEXT_ONLY_MESSAGE_INPUT_SUPPORT }),
        cdpConnected: state.cdpConnected ?? isCdpConnected(cdpManagers, state.type),
        ...(includeSessionControls && {
            ...(controlValues && { controlValues }),
            providerControls: state.providerControls,
        }),
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        lastUpdated: state.lastUpdated,
        settings: state.settings,
        ...(coordinator && { coordinator }),
        ...(meshQueueStats && { meshQueueStats }),
    };
}

function buildExtensionAgentSession(
    parent: IdeProviderState,
    ext: ExtensionProviderState,
    options: SessionEntryBuildOptions,
): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(ext.activeChat, getActiveChatOptions(profile));
    const summaryMetadata = normalizeProviderSummaryMetadata(ext.summaryMetadata);
    const controlValues = normalizeProviderStateControlValues(ext.controlValues);
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    const workspace = parent.workspace || null;
    const git = getGitSummaryForWorkspace(workspace, options);
    const meshCoordinatorFor = ext.settings?.meshCoordinatorFor as string | undefined;
    const registryEntry = ext.instanceId ? getCoordinatorForSession(ext.instanceId) : undefined;
    const effectiveMeshId = meshCoordinatorFor || registryEntry?.meshId;
    const coordinator = effectiveMeshId ? { meshId: effectiveMeshId, role: 'coordinator' as const } : undefined;
    const meshQueueStats = effectiveMeshId ? getMeshQueueStats(effectiveMeshId) : undefined;
    const resolved = resolveSessionStatusUnified({ sessionId: ext.instanceId, providerType: ext.type, activeChat, providerStatus: ext.status });
    return {
        id: ext.instanceId || `${parent.instanceId}:${ext.type}`,
        parentId: parent.instanceId || parent.type,
        providerType: ext.type,
        providerName: ext.name,
        providerSessionId: ext.providerSessionId,
        kind: 'agent',
        transport: 'cdp-webview',
        status: resolved.status,
        ...(resolved.turn.authority === 'turn_reducer' ? { turn: resolved.turn } : {}),
        title: activeChat?.title || ext.name,
        workspace,
        ...(git && { git }),
        activeChat,
        ...(summaryMetadata && { summaryMetadata }),
        ...(includeSessionMetadata && { capabilities: ext.sessionCapabilities || EXTENSION_SESSION_CAPABILITIES, messageInput: ext.messageInput || TEXT_ONLY_MESSAGE_INPUT_SUPPORT }),
        ...(includeSessionControls && {
            ...(controlValues && { controlValues }),
            providerControls: ext.providerControls,
        }),
        errorMessage: ext.errorMessage,
        errorReason: ext.errorReason,
        lastUpdated: ext.lastUpdated,
        settings: ext.settings,
        ...(coordinator && { coordinator }),
        ...(meshQueueStats && { meshQueueStats }),
    };
}

function shouldIncludeExtensionSession(ext: ExtensionProviderState): boolean {
    const status = String(ext.status || '').trim().toLowerCase();
    const hasActiveChat = !!ext.activeChat;
    const hasMessages = Array.isArray(ext.activeChat?.messages) && ext.activeChat!.messages.length > 0;
    const hasModal = !!ext.activeChat?.activeModal;
    const hasStreams = Array.isArray((ext as any).agentStreams) && (ext as any).agentStreams.length > 0;
    const hasProviderSessionId = typeof ext.providerSessionId === 'string' && ext.providerSessionId.trim().length > 0;
    const hasControlValues = !!(ext.controlValues && Object.keys(ext.controlValues).length > 0);
    const hasProviderControls = Array.isArray(ext.providerControls) && ext.providerControls.length > 0;
    const hasOpenPanelCapability = Array.isArray(ext.sessionCapabilities) && ext.sessionCapabilities.includes('open_panel');
    const hasSummaryMetadata = !!ext.summaryMetadata;
    const hasError = typeof ext.errorMessage === 'string' && ext.errorMessage.trim().length > 0;
    const hasInterestingStatus = !!status && !['idle', 'panel_hidden', 'disconnected', 'not_monitored'].includes(status);

    return hasActiveChat
        || hasMessages
        || hasModal
        || hasStreams
        || hasProviderSessionId
        || hasControlValues
        || hasProviderControls
        || hasOpenPanelCapability
        || hasSummaryMetadata
        || hasError
        || hasInterestingStatus;
}

function buildCliSession(state: CliProviderState, options: SessionEntryBuildOptions): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(state.activeChat, getActiveChatOptions(profile));
    const summaryMetadata = normalizeProviderSummaryMetadata(state.summaryMetadata);
    const controlValues = normalizeProviderStateControlValues(state.controlValues);
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeRuntimeMetadata = shouldIncludeRuntimeMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    const workspace = state.workspace || null;
    const git = getGitSummaryForWorkspace(workspace, options);
    const meshCoordinatorFor = state.settings?.meshCoordinatorFor as string | undefined;
    const registryEntry = state.instanceId ? getCoordinatorForSession(state.instanceId) : undefined;
    const effectiveMeshId = meshCoordinatorFor || registryEntry?.meshId;
    const coordinator = effectiveMeshId ? { meshId: effectiveMeshId, role: 'coordinator' as const } : undefined;
    const meshQueueStats = effectiveMeshId ? getMeshQueueStats(effectiveMeshId) : undefined;
    const resolved = resolveSessionStatusUnified({ sessionId: state.instanceId, providerType: state.type, activeChat, providerStatus: state.status });
    const resolvedStatus = resolved.status;
    return {
        id: state.instanceId,
        parentId: null,
        providerType: state.type,
        providerName: state.name,
        providerSessionId: state.providerSessionId,
        kind: 'agent',
        transport: 'pty',
        status: resolvedStatus,
        ...(resolved.turn.authority === 'turn_reducer' ? { turn: resolved.turn } : {}),
        title: activeChat?.title || state.name,
        workspace,
        ...(git && { git }),
        ...(includeRuntimeMetadata && {
            runtimeKey: state.runtime?.runtimeKey,
            runtimeDisplayName: state.runtime?.displayName,
            runtimeWorkspaceLabel: state.runtime?.workspaceLabel,
            runtimeLifecycle: state.runtime?.lifecycle ?? null,
            runtimeSurfaceKind: state.runtime?.surfaceKind,
            runtimeWriteOwner: state.runtime?.writeOwner || null,
            runtimeAttachedClients: state.runtime?.attachedClients || [],
            runtimeRestoredFromStorage: state.runtime?.restoredFromStorage === true,
            runtimeRecoveryState: state.runtime?.recoveryState ?? null,
        }),
        mode: state.mode,
        resume: state.resume,
        activeChat,
        activeInteractivePrompt: state.activeInteractivePrompt ?? null,
        ...(summaryMetadata && { summaryMetadata }),
        ...(includeSessionMetadata && {
            capabilities: state.mode === 'terminal' ? PTY_SESSION_CAPABILITIES : CLI_CHAT_SESSION_CAPABILITIES,
            messageInput: state.messageInput || TEXT_ONLY_MESSAGE_INPUT_SUPPORT,
        }),
        ...(includeSessionControls && {
            ...(controlValues && { controlValues }),
            providerControls: state.providerControls,
        }),
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        lastUpdated: state.lastUpdated,
        settings: state.settings,
        ...(coordinator && { coordinator }),
        ...(meshQueueStats && { meshQueueStats }),
        // Emit these booleans explicitly (including false) so an un-hide/un-mute clears a
        // previously-true value downstream. Consumers merge with `?? existing` and copy only
        // `!== undefined` fields, so an absent field on false never overwrote a prior true —
        // the toggle-off direction silently stuck. See session-entry-merge.ts.
        surfaceHidden: resolveSurfaceHidden(state.settings),
        // status-gated so a one-shot silent-idle arm mutes ONLY the idle/completion
        // snapshot, never an approval/generating frame in the same turn.
        muted: resolveMuted(state.settings, resolvedStatus),
    };
}

function buildAcpSession(state: AcpProviderState, options: SessionEntryBuildOptions): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(state.activeChat, getActiveChatOptions(profile));
    const summaryMetadata = normalizeProviderSummaryMetadata(state.summaryMetadata);
    const controlValues = normalizeProviderStateControlValues(state.controlValues);
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    const workspace = state.workspace || null;
    const git = getGitSummaryForWorkspace(workspace, options);
    const meshCoordinatorFor = state.settings?.meshCoordinatorFor as string | undefined;
    const registryEntry = state.instanceId ? getCoordinatorForSession(state.instanceId) : undefined;
    const effectiveMeshId = meshCoordinatorFor || registryEntry?.meshId;
    const coordinator = effectiveMeshId ? { meshId: effectiveMeshId, role: 'coordinator' as const } : undefined;
    const meshQueueStats = effectiveMeshId ? getMeshQueueStats(effectiveMeshId) : undefined;
    const resolved = resolveSessionStatusUnified({ sessionId: state.instanceId, providerType: state.type, activeChat, providerStatus: state.status });
    const resolvedStatus = resolved.status;
    return {
        id: state.instanceId,
        parentId: null,
        providerType: state.type,
        providerName: state.name,
        kind: 'agent',
        transport: 'acp',
        status: resolvedStatus,
        ...(resolved.turn.authority === 'turn_reducer' ? { turn: resolved.turn } : {}),
        title: activeChat?.title || state.name,
        workspace,
        ...(git && { git }),
        activeChat,
        ...(summaryMetadata && { summaryMetadata }),
        ...(includeSessionMetadata && { capabilities: ACP_SESSION_CAPABILITIES, messageInput: state.messageInput || TEXT_ONLY_MESSAGE_INPUT_SUPPORT }),
        ...(includeSessionControls && {
            ...(controlValues && { controlValues }),
            providerControls: state.providerControls,
        }),
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        lastUpdated: state.lastUpdated,
        settings: state.settings,
        ...(coordinator && { coordinator }),
        ...(meshQueueStats && { meshQueueStats }),
        // Emit explicitly (including false) so un-hide/un-mute clears a prior true downstream —
        // see buildCliSession above and session-entry-merge.ts.
        surfaceHidden: resolveSurfaceHidden(state.settings),
        // status-gated one-shot silent-idle arm — see buildCliSession above.
        muted: resolveMuted(state.settings, resolvedStatus),
    };
}

export function buildSessionEntries(
    allStates: ProviderState[],
    cdpManagers: Map<string, DaemonCdpManager>,
    options: SessionEntryBuildOptions = {},
): SessionEntry[] {
    const sessions: SessionEntry[] = [];

    const ideStates = allStates.filter((s): s is IdeProviderState => s.category === 'ide');
    const cliStates = allStates.filter((s): s is CliProviderState => s.category === 'cli');
    const acpStates = allStates.filter((s): s is AcpProviderState => s.category === 'acp');

    for (const state of ideStates) {
        sessions.push(buildWorkspaceSession(state, cdpManagers, options));
        for (const ext of state.extensions as ExtensionProviderState[]) {
            if (!shouldIncludeExtensionSession(ext)) continue;
            sessions.push(buildExtensionAgentSession(state, ext, options));
        }
    }

    for (const state of cliStates) {
        sessions.push(buildCliSession(state, options));
    }

    for (const state of acpStates) {
        sessions.push(buildAcpSession(state, options));
    }

    // Hide native IDE parent rows from inbox/recent surfaces when extension tabs exist.
    const extensionParentIds = new Set(
        sessions
            .filter((session) => session.transport === 'cdp-webview' && !!session.parentId)
            .map((session) => session.parentId as string)
    );
    for (const session of sessions) {
        if (session.transport === 'cdp-page' && extensionParentIds.has(session.id)) {
            session.surfaceHidden = true;
        }
    }

    return sessions;
}
