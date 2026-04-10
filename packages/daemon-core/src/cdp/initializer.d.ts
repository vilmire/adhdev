/**
 * DaemonCdpInitializer — Unified CDP initialization + periodic scanning
 *
 * Unified CDP initialization + periodic scanning.
 *
 * Features:
 *   1. Initial connection: connectAll() — multi-window aware
 *   2. Periodic scan: startPeriodicScan() — auto-detect newly opened IDEs
 *   3. Discovery: startDiscovery() — periodic agent webview discovery
 */
import { DaemonCdpManager } from './manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
export interface CdpInitializerConfig {
    providerLoader: ProviderLoader;
    cdpManagers: Map<string, DaemonCdpManager>;
    /** Filter: only connect these IDEs (empty/undefined = all) */
    enabledIdes?: string[];
    /** Callback when a new CDP manager is connected */
    onConnected?: (ideType: string, manager: DaemonCdpManager, managerKey: string) => void | Promise<void>;
    /** Callback when a stale/disconnected CDP manager is removed */
    onDisconnected?: (ideType: string, manager: DaemonCdpManager, managerKey: string, reason: 'ide_closed' | 'target_closed' | 'target_rekeyed') => void | Promise<void>;
}
export declare class DaemonCdpInitializer {
    private config;
    private scanTimer;
    private discoveryTimer;
    constructor(config: CdpInitializerConfig);
    /**
     * Connect to all detected IDEs.
     * Multi-window aware: creates separate CdpManager per workbench page.
     */
    connectAll(detectedIdes: any[]): Promise<void>;
    /**
     * Connect to a single IDE port.
     * Tries multi-window first (listAllTargets), falls back to direct connect.
     */
    private connectIdePort;
    private pruneStaleManagers;
    /**
     * Start periodic scanning for newly opened IDEs.
     * Idempotent — ignored if already started.
     */
    startPeriodicScan(intervalMs?: number): void;
    /**
     * Start periodic agent webview discovery.
     */
    startDiscovery(intervalMs?: number): void;
    /** Stop all timers */
    stop(): void;
}
