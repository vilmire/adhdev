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
import { type CdpSetupContext } from './setup.js';
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
export declare class DaemonCdpScanner {
    private ctx;
    private opts;
    private scanTimer;
    private discoveryTimer;
    constructor(opts: CdpScannerOptions);
    /**
     * Initial CDP discovery — connect to all available IDEs.
     * Supports both single-window and multi-window modes.
     */
    initialScan(enabledIdes?: string[]): Promise<void>;
    /**
     * Start periodic scanning for newly launched IDEs.
     */
    startPeriodicScan(): void;
    /**
     * Start periodic agent webview discovery on all connected CDPs.
     */
    startWebviewDiscovery(intervalMs?: number): void;
    /**
     * Stop all timers.
     */
    stop(): void;
    private getLogFn;
    /**
     * Single-window connection (standalone mode).
     * One CDP manager per IDE, first working port wins.
     */
    private connectSingleWindow;
    /**
     * Multi-window connection.
     * Multiple CDP managers per IDE — one per workbench page.
     */
    private connectMultiWindow;
}
