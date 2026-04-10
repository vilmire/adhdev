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
import type { SessionEntry } from '../shared-types.js';
import type { ProviderState } from '../providers/provider-instance.js';
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
export declare function findCdpManager(cdpManagers: Map<string, DaemonCdpManager>, key: string): DaemonCdpManager | null;
/**
 * Check if any CDP manager matches the given key (exact or prefix).
 */
export declare function hasCdpManager(cdpManagers: Map<string, DaemonCdpManager>, key: string): boolean;
/**
 * Check if any CDP manager matching the key is connected.
 */
export declare function isCdpConnected(cdpManagers: Map<string, DaemonCdpManager>, key: string): boolean;
export declare function buildSessionEntries(allStates: ProviderState[], cdpManagers: Map<string, DaemonCdpManager>): SessionEntry[];
