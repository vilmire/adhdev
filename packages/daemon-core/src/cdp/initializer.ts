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
import { registerExtensionProviders } from './setup.js';
import { probeCdpPort } from './setup.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import { LOG } from '../logging/logger.js';

// ─── Config ───

export interface CdpInitializerConfig {
    providerLoader: ProviderLoader;
    cdpManagers: Map<string, DaemonCdpManager>;
    /** Filter: only connect these IDEs (empty/undefined = all) */
    enabledIdes?: string[];
    /** Callback when a new CDP manager is connected */
    onConnected?: (ideType: string, manager: DaemonCdpManager, managerKey: string) => void | Promise<void>;
    /** Callback when a stale/disconnected CDP manager is removed */
    onDisconnected?: (
        ideType: string,
        manager: DaemonCdpManager,
        managerKey: string,
        reason: 'ide_closed' | 'target_closed' | 'target_rekeyed',
    ) => void | Promise<void>;
}

export class DaemonCdpInitializer {
    private config: CdpInitializerConfig;
    private scanTimer: NodeJS.Timeout | null = null;
    private discoveryTimer: NodeJS.Timeout | null = null;

    constructor(config: CdpInitializerConfig) {
        this.config = config;
    }

    // ─── Initial connection ───

    /**
     * Connect to all detected IDEs.
     * Multi-window aware: creates separate CdpManager per workbench page.
     */
    async connectAll(detectedIdes: any[]): Promise<void> {
        const { providerLoader, cdpManagers, enabledIdes } = this.config;
        const providerCdpMap = providerLoader.getCdpPortMap();

        // Build port list sorted by detected IDE order
        const portsToTry: { port: number; ide: string }[] = [];
        for (const ide of detectedIdes) {
            if (!ide.installed) continue;
            const ideKey = ide.id || ide.name?.toLowerCase();
            const ports = providerCdpMap[ideKey];
            if (ports) portsToTry.push({ port: ports[0], ide: ideKey });
        }
        // Add undetected IDE ports (provider-based)
        for (const [ide, ports] of Object.entries(providerCdpMap)) {
            if (!portsToTry.find(p => p.port === ports[0])) {
                portsToTry.push({ port: ports[0], ide });
            }
        }

        // Filter by enabledIdes
        const filtered = enabledIdes?.length
            ? portsToTry.filter(p => enabledIdes.includes(p.ide))
            : portsToTry;

        for (const { port, ide } of filtered) {
            await this.connectIdePort(port, ide);
        }

        // Summary
        if (cdpManagers.size > 0) {
            LOG.info('IDE', `${cdpManagers.size} IDE window(s) attached: ${[...cdpManagers.entries()].map(([k, m]) => `${k}:${m.getPort()}`).join(', ')}`);
        } else {
            LOG.warn('IDE', `No IDE windows attached — tried: ${filtered.map(p => `${p.ide}:${p.port}`).join(', ')}`);
        }
    }

    // ─── Per-port connection (multi-window aware) ───

    /**
     * Connect to a single IDE port.
     * Tries multi-window first (listAllTargets), falls back to direct connect.
     */
    private async connectIdePort(port: number, ide: string): Promise<void> {
        const { providerLoader, cdpManagers } = this.config;

        // 1. Try multi-window: list all workbench pages on this port
        const targets = await DaemonCdpManager.listAllTargets(port);
        await this.pruneStaleManagers(port, ide, targets);

        if (targets.length === 0) {
            // Prevent duplicate fallback connection
            if (cdpManagers.has(ide)) return;
            // Fallback: direct single connection (probeCdpPort first)
            if (!await probeCdpPort(port)) return;
            const provider = providerLoader.getMeta(ide);
            const manager = new DaemonCdpManager(
                port,
                LOG.forComponent(`CDP:${ide}`).asLogFn(),
                undefined,
                provider?.targetFilter,
            );
            const connected = await manager.connect();
            if (connected) {
                registerExtensionProviders(providerLoader, manager, ide);
                cdpManagers.set(ide, manager);
                LOG.info('IDE', `Attached: ${ide} (port ${port})`);
                await this.config.onConnected?.(ide, manager, ide);
            }
            return;
        }

        // 2. Multi-window: create separate CdpManager per page
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            
            // Check if ANY existing manager for this IDE is already tracking this target.id
            let alreadyTracked = false;
            for (const [key, m] of cdpManagers.entries()) {
                if ((key === ide || key.startsWith(`${ide}_`)) && m.targetId === target.id) {
                    alreadyTracked = true;
                    break;
                }
            }
            if (alreadyTracked) continue;

            // Stable key using target.id instead of fluctuating window title
            let managerKey: string;
            if (targets.length === 1 && !cdpManagers.has(ide)) {
                managerKey = ide;
            } else {
                managerKey = `${ide}_${target.id}`;
            }

            if (cdpManagers.has(managerKey)) continue;

            const provider = providerLoader.getMeta(ide);
            const manager = new DaemonCdpManager(
                port,
                LOG.forComponent(`CDP:${managerKey}`).asLogFn(),
                target.id,
                provider?.targetFilter,
            );

            const connected = await manager.connect();
            if (connected) {
                registerExtensionProviders(providerLoader, manager, ide);
                cdpManagers.set(managerKey, manager);
                LOG.info('IDE', `Attached window: ${managerKey} (port ${port}${targets.length > 1 ? `, page "${target.title}"` : ''})`);
                await this.config.onConnected?.(ide, manager, managerKey);
            }
        }
    }

    private async pruneStaleManagers(
        port: number,
        ide: string,
        targets: Array<{ id: string }>,
    ): Promise<void> {
        const trackedTargetIds = new Set(targets.map((target) => target.id));
        const removals: Array<{
            key: string;
            manager: DaemonCdpManager;
            reason: 'ide_closed' | 'target_closed' | 'target_rekeyed';
        }> = [];

        for (const [key, manager] of this.config.cdpManagers.entries()) {
            if (!(key === ide || key.startsWith(`${ide}_`))) continue;
            if (manager.getPort() !== port) continue;

            if (targets.length === 0) {
                removals.push({ key, manager, reason: 'ide_closed' });
                continue;
            }

            if (manager.targetId && !trackedTargetIds.has(manager.targetId)) {
                removals.push({ key, manager, reason: 'target_closed' });
                continue;
            }

            if (key === ide && !manager.targetId && targets.length > 1) {
                removals.push({ key, manager, reason: 'target_rekeyed' });
            }
        }

        for (const { key, manager, reason } of removals) {
            try { manager.disconnect(); } catch { /* noop */ }
            this.config.cdpManagers.delete(key);
            LOG.info('IDE', `Detached window: ${key} (${reason})`);
            await this.config.onDisconnected?.(ide, manager, key, reason);
        }
    }

    // ─── Periodic scanning ───

    /**
     * Start periodic scanning for newly opened IDEs.
     * Idempotent — ignored if already started.
     */
    startPeriodicScan(intervalMs = 30_000): void {
        if (this.scanTimer) return;

        this.scanTimer = setInterval(async () => {
            const { providerLoader, cdpManagers } = this.config;
            const portMap = providerLoader.getCdpPortMap();

            for (const [ide, ports] of Object.entries(portMap)) {
                const primaryPort = ports[0];
                // Always try to connect to find new windows
                await this.connectIdePort(primaryPort, ide);
            }
        }, intervalMs);
    }

    /**
     * Start periodic agent webview discovery.
     */
    startDiscovery(intervalMs = 30_000): void {
        if (this.discoveryTimer) return;

        this.discoveryTimer = setInterval(async () => {
            for (const m of this.config.cdpManagers.values()) {
                if (m.isConnected) {
                    await m.discoverAgentWebviews();
                }
            }
        }, intervalMs);
    }

    /** Stop all timers */
    stop(): void {
        if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
        if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    }
}
