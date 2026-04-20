/**
 * DaemonCdpScanner — Periodic CDP port scanning & auto-connect
 *
 * Periodic CDP port scanning and auto-connect for IDE discovery.
 * Provides a unified approach to:
 * 1. Initial CDP port discovery
 * 2. Periodic scanning for newly launched IDEs
 * 3. Multi-window support (multiple pages on same port)
 */

import { DaemonCdpManager } from './manager.js';
import { ProviderLoader } from '../providers/provider-loader.js';
import { connectCdpManager, probeCdpPort, registerExtensionProviders, setupIdeInstance, type CdpSetupContext } from './setup.js';
import { LOG } from '../logging/logger.js';
import { DEFAULT_CDP_DISCOVERY_INTERVAL_MS, DEFAULT_CDP_SCAN_INTERVAL_MS } from '../runtime-defaults.js';

export interface CdpScannerOptions {
  /** Context for setup operations */
  ctx: CdpSetupContext;
  /** Log function for per-IDE CDP logs */
  logFn?: (ideType: string) => (msg: string) => void;
  /** Whether to support multi-window (multiple pages per port) */
  multiWindow?: boolean;
  /** Scan interval in ms (default: 30000) */
  scanIntervalMs?: number;
  /** Callback when a new CDP connection is established */
  onConnected?: (ideType: string, managerKey: string, manager: DaemonCdpManager) => void;
}

export class DaemonCdpScanner {
  private ctx: CdpSetupContext;
  private opts: CdpScannerOptions;
  private scanTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(opts: CdpScannerOptions) {
    this.ctx = opts.ctx;
    this.opts = opts;
  }

  /**
   * Initial CDP discovery — connect to all available IDEs.
   * Supports both single-window and multi-window modes.
   */
  async initialScan(enabledIdes?: string[]): Promise<void> {
    const portMap = this.ctx.providerLoader.getCdpPortMap();
    const portsToTry: { port: number; ide: string }[] = [];

    for (const [ide, ports] of Object.entries(portMap)) {
      portsToTry.push({ port: ports[0], ide });
    }

    // Apply enabledIdes filter if provided
    const filtered = enabledIdes?.length
      ? portsToTry.filter(p => enabledIdes.includes(p.ide))
      : portsToTry;

    for (const { port, ide } of filtered) {
      if (this.opts.multiWindow) {
        await this.connectMultiWindow(port, ide);
      } else {
        await this.connectSingleWindow(port, ide);
      }
    }
  }

  /**
   * Start periodic scanning for newly launched IDEs.
   */
  startPeriodicScan(): void {
    if (this.scanTimer) return;
    const interval = this.opts.scanIntervalMs || DEFAULT_CDP_SCAN_INTERVAL_MS;

    this.scanTimer = setInterval(async () => {
      const portMap = this.ctx.providerLoader.getCdpPortMap();
      for (const [ide, ports] of Object.entries(portMap)) {
        const primaryPort = ports[0];
        // Skip if already connected
        const alreadyConnected = [...this.ctx.cdpManagers.entries()].some(([key, m]) =>
          m.isConnected && (key === ide || key.startsWith(ide + '_'))
        );
        if (alreadyConnected) continue;

        if (this.opts.multiWindow) {
          await this.connectMultiWindow(primaryPort, ide);
        } else {
          await this.connectSingleWindow(primaryPort, ide);
        }
      }
    }, interval);
  }

  /**
   * Start periodic agent webview discovery on all connected CDPs.
   */
  startWebviewDiscovery(intervalMs = DEFAULT_CDP_DISCOVERY_INTERVAL_MS): void {
    if (this.discoveryTimer) return;
    this.discoveryTimer = setInterval(async () => {
      for (const m of this.ctx.cdpManagers.values()) {
        if (m.isConnected) {
          await m.discoverAgentWebviews();
        }
      }
    }, intervalMs);
  }

  /**
   * Stop all timers.
   */
  stop(): void {
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
  }

  // ── Internal ────────────────────────────

  private getLogFn(ideType: string): (msg: string) => void {
    if (this.opts.logFn) return this.opts.logFn(ideType);
    return (msg: string) => LOG.info(`CDP:${ideType}`, msg);
  }

  /**
   * Single-window connection (standalone mode).
   * One CDP manager per IDE, first working port wins.
   */
  private async connectSingleWindow(port: number, ide: string): Promise<void> {
    if (this.ctx.cdpManagers.has(ide)) return;
    const available = await probeCdpPort(port);
    if (!available) return;

    const manager = await connectCdpManager(
      port, ide, this.getLogFn(ide), this.ctx.providerLoader,
    );
    if (!manager) return;

    registerExtensionProviders(this.ctx.providerLoader, manager, ide);
    this.ctx.cdpManagers.set(ide, manager);
    LOG.info('IDE', `Attached: ${ide} (port ${port})`);

    // Setup IDE instance
    await setupIdeInstance(this.ctx, { ideType: ide, manager });
    this.opts.onConnected?.(ide, ide, manager);
  }

  /**
   * Multi-window connection.
   * Multiple CDP managers per IDE — one per workbench page.
   */
  private async connectMultiWindow(port: number, ide: string): Promise<void> {
    const allTargets = await DaemonCdpManager.listAllTargets(port);

    if (allTargets.length === 0) {
      // Fallback: single-window approach
      await this.connectSingleWindow(port, ide);
      return;
    }

    for (let i = 0; i < allTargets.length; i++) {
      const target = allTargets[i];
      let managerKey: string;
      if (allTargets.length === 1) {
        managerKey = ide;
      } else {
        const workspaceName = (target.title || '').split(' — ')[0].trim() || `window_${i}`;
        managerKey = `${ide}_${workspaceName}`;
      }

      if (this.ctx.cdpManagers.has(managerKey)) continue;

      const manager = await connectCdpManager(
        port, ide, this.getLogFn(managerKey), this.ctx.providerLoader, target.id,
      );
      if (!manager) continue;

      this.ctx.cdpManagers.set(managerKey, manager);
      LOG.info('IDE', `Attached window: ${managerKey} (port ${port}, page "${target.title}")`);

      await setupIdeInstance(this.ctx, {
        ideType: ide,
        manager,
        managerKey,
      });
      this.opts.onConnected?.(ide, managerKey, manager);
    }
  }
}
