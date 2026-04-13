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
    type NormalizeActiveChatOptions,
} from './normalize.js';

export type SessionEntryProfile = 'full' | 'live' | 'metadata';

export interface SessionEntryBuildOptions {
    profile?: SessionEntryProfile;
}

function getActiveChatOptions(profile: SessionEntryProfile): NormalizeActiveChatOptions {
    if (profile === 'full') return {};
    return LIVE_STATUS_ACTIVE_CHAT_OPTIONS;
}

function shouldIncludeSessionControls(profile: SessionEntryProfile): boolean {
    return profile !== 'live';
}

function shouldIncludeSessionMetadata(profile: SessionEntryProfile): boolean {
    return profile !== 'live';
}

function shouldIncludeRuntimeMetadata(profile: SessionEntryProfile): boolean {
    return profile !== 'live';
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


const IDE_SESSION_CAPABILITIES: SessionCapability[] = [
    'read_chat',
    'send_message',
    'new_session',
    'list_sessions',
    'switch_session',
    'resolve_action',
    'change_model',
    'set_mode',
    'set_thought_level',
];

const EXTENSION_SESSION_CAPABILITIES: SessionCapability[] = [
    'read_chat',
    'send_message',
    'new_session',
    'list_sessions',
    'switch_session',
    'resolve_action',
    'change_model',
    'set_mode',
];

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

function buildIdeWorkspaceSession(
    state: IdeProviderState,
    cdpManagers: Map<string, DaemonCdpManager>,
    options: SessionEntryBuildOptions,
): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(state.activeChat, getActiveChatOptions(profile));
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    const title = activeChat?.title || state.name;
    return {
        id: state.instanceId || state.type,
        parentId: null,
        providerType: state.type,
        ...(includeSessionMetadata && { providerName: state.name }),
        kind: 'workspace',
        transport: 'cdp-page',
        status: normalizeManagedStatus(activeChat?.status || state.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title,
        ...(includeSessionMetadata && { workspace: state.workspace || null }),
        activeChat,
        ...(includeSessionMetadata && { capabilities: IDE_SESSION_CAPABILITIES }),
        cdpConnected: state.cdpConnected ?? isCdpConnected(cdpManagers, state.type),
        currentModel: state.currentModel,
        currentPlan: state.currentPlan,
        currentAutoApprove: state.currentAutoApprove,
        ...(includeSessionControls && {
            controlValues: state.controlValues,
            providerControls: state.providerControls,
        }),
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        lastUpdated: state.lastUpdated,
    };
}

function buildExtensionAgentSession(
    parent: IdeProviderState,
    ext: ExtensionProviderState,
    options: SessionEntryBuildOptions,
): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(ext.activeChat, getActiveChatOptions(profile));
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    return {
        id: ext.instanceId || `${parent.instanceId}:${ext.type}`,
        parentId: parent.instanceId || parent.type,
        providerType: ext.type,
        ...(includeSessionMetadata && { providerName: ext.name }),
        kind: 'agent',
        transport: 'cdp-webview',
        status: normalizeManagedStatus(activeChat?.status || ext.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title: activeChat?.title || ext.name,
        ...(includeSessionMetadata && { workspace: parent.workspace || null }),
        activeChat,
        ...(includeSessionMetadata && { capabilities: EXTENSION_SESSION_CAPABILITIES }),
        currentModel: ext.currentModel,
        currentPlan: ext.currentPlan,
        ...(includeSessionControls && {
            controlValues: ext.controlValues,
            providerControls: ext.providerControls,
        }),
        errorMessage: ext.errorMessage,
        errorReason: ext.errorReason,
        lastUpdated: ext.lastUpdated,
    };
}

function buildCliSession(state: CliProviderState, options: SessionEntryBuildOptions): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(state.activeChat, getActiveChatOptions(profile));
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeRuntimeMetadata = shouldIncludeRuntimeMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    return {
        id: state.instanceId,
        parentId: null,
        providerType: state.type,
        ...(includeSessionMetadata && { providerName: state.name }),
        providerSessionId: state.providerSessionId,
        kind: 'agent',
        transport: 'pty',
        status: normalizeManagedStatus(activeChat?.status || state.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title: activeChat?.title || state.name,
        ...(includeSessionMetadata && { workspace: state.workspace || null }),
        ...(includeRuntimeMetadata && {
            runtimeKey: state.runtime?.runtimeKey,
            runtimeDisplayName: state.runtime?.displayName,
            runtimeWorkspaceLabel: state.runtime?.workspaceLabel,
            runtimeWriteOwner: state.runtime?.writeOwner || null,
            runtimeAttachedClients: state.runtime?.attachedClients || [],
        }),
        mode: state.mode,
        resume: state.resume,
        activeChat,
        ...(includeSessionMetadata && {
            capabilities: state.mode === 'terminal' ? PTY_SESSION_CAPABILITIES : CLI_CHAT_SESSION_CAPABILITIES,
        }),
        ...(includeSessionControls && {
            controlValues: state.controlValues,
            providerControls: state.providerControls,
        }),
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        lastUpdated: state.lastUpdated,
    };
}

function buildAcpSession(state: AcpProviderState, options: SessionEntryBuildOptions): SessionEntry {
    const profile = options.profile || 'full';
    const activeChat = normalizeActiveChatData(state.activeChat, getActiveChatOptions(profile));
    const includeSessionMetadata = shouldIncludeSessionMetadata(profile);
    const includeSessionControls = shouldIncludeSessionControls(profile);
    return {
        id: state.instanceId,
        parentId: null,
        providerType: state.type,
        ...(includeSessionMetadata && { providerName: state.name }),
        kind: 'agent',
        transport: 'acp',
        status: normalizeManagedStatus(activeChat?.status || state.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title: activeChat?.title || state.name,
        ...(includeSessionMetadata && { workspace: state.workspace || null }),
        activeChat,
        ...(includeSessionMetadata && { capabilities: ACP_SESSION_CAPABILITIES }),
        currentModel: state.currentModel,
        currentPlan: state.currentPlan,
        ...(includeSessionControls && {
            acpConfigOptions: state.acpConfigOptions,
            acpModes: state.acpModes,
            controlValues: state.controlValues,
            providerControls: state.providerControls,
        }),
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        lastUpdated: state.lastUpdated,
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
        sessions.push(buildIdeWorkspaceSession(state, cdpManagers, options));
        for (const ext of state.extensions as ExtensionProviderState[]) {
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
