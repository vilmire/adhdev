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
import { normalizeActiveChatData, normalizeManagedStatus } from './normalize.js';

// ─── CDP Manager lookup helpers ──────────────────────

/**
 * Find a CDP manager by key, with prefix matching for multi-window support.
 *
 * Lookup order:
 *   1. Exact match: cdpManagers.get(key)
 *   2. Prefix match: key starts with `${ideType}_` (multi-window: "cursor_remote_vs")
 *   3. null
 *
 * This replaces raw `cdpManagers.get(ideType)` calls that broke when
 * multi-window keys like "cursor_remote_vs" were used.
 */
export function findCdpManager(
    cdpManagers: Map<string, DaemonCdpManager>,
    key: string,
): DaemonCdpManager | null {
    // 1. Exact match (single-window: "cursor", or full managerKey: "cursor_remote_vs")
    const exact = cdpManagers.get(key);
    if (exact) return exact;

    // 2. Prefix match (key = ideType like "cursor", managerKey = "cursor_remote_vs")
    const prefix = key + '_';
    for (const [k, m] of cdpManagers.entries()) {
        if (k.startsWith(prefix) && m.isConnected) return m;
    }

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
    const m = findCdpManager(cdpManagers, key);
    return m?.isConnected ?? false;
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
): SessionEntry {
    const activeChat = normalizeActiveChatData(state.activeChat);
    const title = activeChat?.title || state.name;
    return {
        id: state.instanceId || state.type,
        parentId: null,
        providerType: state.type,
        providerName: state.name,
        kind: 'workspace',
        transport: 'cdp-page',
        status: normalizeManagedStatus(activeChat?.status || state.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title,
        workspace: state.workspace || null,
        activeChat,
        capabilities: IDE_SESSION_CAPABILITIES,
        cdpConnected: state.cdpConnected ?? isCdpConnected(cdpManagers, state.type),
        currentModel: state.currentModel,
        currentPlan: state.currentPlan,
        currentAutoApprove: state.currentAutoApprove,
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
    };
}

function buildExtensionAgentSession(
    parent: IdeProviderState,
    ext: ExtensionProviderState,
): SessionEntry {
    const activeChat = normalizeActiveChatData(ext.activeChat);
    return {
        id: ext.instanceId || `${parent.instanceId}:${ext.type}`,
        parentId: parent.instanceId || parent.type,
        providerType: ext.type,
        providerName: ext.name,
        kind: 'agent',
        transport: 'cdp-webview',
        status: normalizeManagedStatus(activeChat?.status || ext.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title: activeChat?.title || ext.name,
        workspace: parent.workspace || null,
        activeChat,
        capabilities: EXTENSION_SESSION_CAPABILITIES,
        currentModel: ext.currentModel,
        currentPlan: ext.currentPlan,
        errorMessage: ext.errorMessage,
        errorReason: ext.errorReason,
    };
}

function buildCliSession(state: CliProviderState): SessionEntry {
    const activeChat = normalizeActiveChatData(state.activeChat);
    return {
        id: state.instanceId,
        parentId: null,
        providerType: state.type,
        providerName: state.name,
        kind: 'agent',
        transport: 'pty',
        status: normalizeManagedStatus(activeChat?.status || state.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title: activeChat?.title || state.name,
        workspace: state.workspace || null,
        activeChat,
        capabilities: PTY_SESSION_CAPABILITIES,
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
    };
}

function buildAcpSession(state: AcpProviderState): SessionEntry {
    const activeChat = normalizeActiveChatData(state.activeChat);
    return {
        id: state.instanceId,
        parentId: null,
        providerType: state.type,
        providerName: state.name,
        kind: 'agent',
        transport: 'acp',
        status: normalizeManagedStatus(activeChat?.status || state.status, {
            activeModal: activeChat?.activeModal || null,
        }),
        title: activeChat?.title || state.name,
        workspace: state.workspace || null,
        activeChat,
        capabilities: ACP_SESSION_CAPABILITIES,
        currentModel: state.currentModel,
        currentPlan: state.currentPlan,
        acpConfigOptions: state.acpConfigOptions,
        acpModes: state.acpModes,
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
    };
}

export function buildSessionEntries(
    allStates: ProviderState[],
    cdpManagers: Map<string, DaemonCdpManager>,
): SessionEntry[] {
    const sessions: SessionEntry[] = [];

    const ideStates = allStates.filter((s): s is IdeProviderState => s.category === 'ide');
    const cliStates = allStates.filter((s): s is CliProviderState => s.category === 'cli');
    const acpStates = allStates.filter((s): s is AcpProviderState => s.category === 'acp');

    for (const state of ideStates) {
        sessions.push(buildIdeWorkspaceSession(state, cdpManagers));
        for (const ext of state.extensions as ExtensionProviderState[]) {
            sessions.push(buildExtensionAgentSession(state, ext));
        }
    }

    for (const state of cliStates) {
        sessions.push(buildCliSession(state));
    }

    for (const state of acpStates) {
        sessions.push(buildAcpSession(state));
    }

    return sessions;
}
