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
import type { ManagedIdeEntry, ManagedCliEntry, ManagedAcpEntry } from '../shared-types.js';
import type {
    IdeProviderState,
    CliProviderState,
    AcpProviderState,
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

// ─── ProviderState → ManagedEntry builders ───────────

/**
 * Convert IdeProviderState[] → ManagedIdeEntry[]
 *
 * @param ideStates - from instanceManager.collectAllStates() filtered to ide
 * @param cdpManagers - for cdpConnected lookup
 * @param opts.detectedIdes - include CDPs that have no instance yet
 */
export function buildManagedIdes(
    ideStates: IdeProviderState[],
    cdpManagers: Map<string, DaemonCdpManager>,
    opts?: { detectedIdes?: { id: string; installed: boolean }[] },
): ManagedIdeEntry[] {
    const result: ManagedIdeEntry[] = [];

    for (const state of ideStates) {
        // Use cdpConnected from IdeProviderState if available (it checks internally),
        // otherwise fall back to CDP manager lookup
        const cdpConnected = state.cdpConnected ?? isCdpConnected(cdpManagers, state.type);
        result.push({
            ideType: state.type,
            ideVersion: '',
            instanceId: state.instanceId || state.type,
            workspace: state.workspace || null,
            terminals: 0,
            aiAgents: [],
            activeChat: normalizeActiveChatData(state.activeChat),
            chats: [],
            agentStreams: state.extensions.map((ext) => ({
                agentType: ext.type,
                agentName: ext.name,
                extensionId: ext.type,
                status: normalizeManagedStatus(ext.status, { activeModal: ext.activeChat?.activeModal || null }),
                messages: ext.activeChat?.messages || [],
                inputContent: ext.activeChat?.inputContent || '',
                activeModal: ext.activeChat?.activeModal || null,
            })),
            cdpConnected,
            currentModel: state.currentModel,
            currentPlan: state.currentPlan,
            currentAutoApprove: state.currentAutoApprove,
        });
    }

    // Include CDPs with no ProviderInstance yet (newly detected IDEs)
    if (opts?.detectedIdes) {
        const coveredTypes = new Set(ideStates.map((s) => s.type));
        for (const ide of opts.detectedIdes) {
            if (!ide.installed || coveredTypes.has(ide.id)) continue;
            if (!isCdpConnected(cdpManagers, ide.id)) continue;
            result.push({
                ideType: ide.id,
                ideVersion: '',
                instanceId: ide.id,
                workspace: null,
                terminals: 0,
                aiAgents: [],
                activeChat: null,
                chats: [],
                agentStreams: [],
                cdpConnected: true,
                currentModel: undefined,
                currentPlan: undefined,
            });
        }
    }

    return result;
}

/**
 * Convert CliProviderState[] → ManagedCliEntry[]
 */
export function buildManagedClis(
    cliStates: CliProviderState[],
): ManagedCliEntry[] {
    return cliStates.map((s) => ({
        id: s.instanceId,
        instanceId: s.instanceId,
        cliType: s.type,
        cliName: s.name,
        status: normalizeManagedStatus(s.status, { activeModal: s.activeChat?.activeModal || null }),
        mode: 'terminal' as const,
        workspace: s.workspace || '',
        activeChat: normalizeActiveChatData(s.activeChat),
    }));
}

/**
 * Convert AcpProviderState[] → ManagedAcpEntry[]
 */
export function buildManagedAcps(
    acpStates: AcpProviderState[],
): ManagedAcpEntry[] {
    return acpStates.map((s) => ({
        id: s.instanceId,
        acpType: s.type,
        acpName: s.name,
        status: normalizeManagedStatus(s.status, { activeModal: s.activeChat?.activeModal || null }),
        mode: 'chat' as const,
        workspace: s.workspace || '',
        activeChat: normalizeActiveChatData(s.activeChat),
        currentModel: s.currentModel,
        currentPlan: s.currentPlan,
        acpConfigOptions: s.acpConfigOptions,
        acpModes: s.acpModes,
        errorMessage: s.errorMessage,
        errorReason: s.errorReason,
    }));
}

/**
 * Convenience: collect & build all managed entries from instanceManager
 */
export function buildAllManagedEntries(
    allStates: ProviderState[],
    cdpManagers: Map<string, DaemonCdpManager>,
    opts?: { detectedIdes?: { id: string; installed: boolean }[] },
): {
    managedIdes: ManagedIdeEntry[];
    managedClis: ManagedCliEntry[];
    managedAcps: ManagedAcpEntry[];
} {
    const ideStates = allStates.filter((s): s is IdeProviderState => s.category === 'ide');
    const cliStates = allStates.filter((s): s is CliProviderState => s.category === 'cli');
    const acpStates = allStates.filter((s): s is AcpProviderState => s.category === 'acp');

    return {
        managedIdes: buildManagedIdes(ideStates, cdpManagers, opts),
        managedClis: buildManagedClis(cliStates),
        managedAcps: buildManagedAcps(acpStates),
    };
}
