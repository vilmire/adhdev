/**
 * DaemonStatusReporter — status collect & transmit (StatusReport / P2P / StatusEvent)
 *
 * Collect status from ProviderInstanceManager → assemble payload → transmit
 * Each Instance manages its own status/transition. This module only assembles + transmits.
 */

import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../config/config.js';
import { getWorkspaceState } from '../config/workspaces.js';
import { getHostMemorySnapshot } from '../system/host-memory.js';
import { getWorkspaceActivity } from '../config/workspace-activity.js';
import { LOG } from '../logging/logger.js';
import { buildAllManagedEntries } from './builders.js';
import type {
    ProviderState,
    IdeProviderState,
    CliProviderState,
    AcpProviderState,
} from '../providers/provider-instance.js';

// ─── Daemon dependency interface ──────────────────────

export interface StatusReporterDeps {
    serverConn: { isConnected(): boolean; sendMessage(type: string, data: any): void; getUserPlan(): string } | null;
    cdpManagers: Map<string, { isConnected: boolean }>;
    p2p: { isConnected: boolean; isAvailable: boolean; connectionState: string; connectedPeerCount: number; screenshotActive: boolean; sendStatus(data: any): void } | null;
    providerLoader: { resolve(type: string): any; getAll(): any[] };
    adapters: Map<string, { cliType: string; cliName: string; workingDir: string; getStatus(): any; getPartialResponse(): string }>;
    detectedIdes: any[];
    ideType: string;
    daemonVersion?: string;
    instanceManager: { collectAllStates(): ProviderState[]; collectStatesByCategory(cat: string): ProviderState[] };
    getScreenshotUsage?: () => { dailyUsedMinutes: number; dailyBudgetMinutes: number; budgetExhausted: boolean } | null;
}

export class DaemonStatusReporter {
    private deps: StatusReporterDeps;
    private log: (msg: string) => void;

    private lastStatusSentAt = 0;
    private statusPendingThrottle = false;
    private lastP2PStatusHash = '';
    private lastStatusSummary = '';

    private statusTimer: NodeJS.Timeout | null = null;
    private p2pTimer: NodeJS.Timeout | null = null;

    constructor(deps: StatusReporterDeps, opts?: { logFn?: (msg: string) => void }) {
        this.deps = deps;
        this.log = opts?.logFn || LOG.forComponent('Status').asLogFn();
    }

 // ─── Lifecycle ───────────────────────────────────

    startReporting(): void {
        setTimeout(() => {
            this.sendUnifiedStatusReport().catch(e => LOG.warn('Status', `Initial report failed: ${e?.message}`));
        }, 2000);

        const scheduleServerReport = () => {
            this.statusTimer = setTimeout(() => {
                this.sendUnifiedStatusReport().catch(e => LOG.warn('Status', `Periodic report failed: ${e?.message}`));
                scheduleServerReport();
            }, 30_000);
        };
        scheduleServerReport();

        this.p2pTimer = setInterval(() => {
            if (this.deps.p2p?.isConnected) {
                this.sendUnifiedStatusReport({ p2pOnly: true }).catch(e => LOG.warn('Status', `P2P status send failed: ${e?.message}`));
            }
        }, 5_000) as any;
    }

    stopReporting(): void {
        if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
        if (this.p2pTimer) { clearInterval(this.p2pTimer); this.p2pTimer = null; }
    }

    onStatusChange(): void {
        this.throttledReport();
    }

    throttledReport(): void {
        const now = Date.now();
        const elapsed = now - this.lastStatusSentAt;
        if (elapsed >= 5_000) {
            this.sendUnifiedStatusReport().catch(e => LOG.warn('Status', `Throttled report failed: ${e?.message}`));
        } else if (!this.statusPendingThrottle) {
            this.statusPendingThrottle = true;
            setTimeout(() => {
                this.statusPendingThrottle = false;
                this.sendUnifiedStatusReport().catch(e => LOG.warn('Status', `Deferred report failed: ${e?.message}`));
            }, 5_000 - elapsed);
        }
    }

    emitStatusEvent(event: Record<string, unknown>): void {
        LOG.info('StatusEvent', `${event.event} (${event.providerType || event.ideType || ''})`);
        // Send via WS (server relay → dashboard + push notifications)
        this.deps.serverConn?.sendMessage('status_event', event);
    }

    removeAgentTracking(_key: string): void { /* Managed by Instance itself */ }

 // (agent-stream polling backward compat)
    updateAgentStreams(_ideType: string, _streams: any[]): void { /* Managed by Instance itself */ }

    /** Reset P2P dedup hash — forces next send to transmit even if content unchanged */
    resetP2PHash(): void {
        this.lastP2PStatusHash = '';
    }

 // ─── Core ────────────────────────────────────────

    private ts(): string {
        return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    }

    async sendUnifiedStatusReport(opts?: { p2pOnly?: boolean }): Promise<void> {
        const { serverConn, p2p } = this.deps;
        if (!serverConn?.isConnected()) return;
        this.lastStatusSentAt = Date.now();
        const now = this.lastStatusSentAt;
        const target = opts?.p2pOnly ? 'P2P' : 'P2P+Server';

        const allStates = this.deps.instanceManager.collectAllStates();
        const ideStates = allStates.filter((s): s is IdeProviderState => s.category === 'ide');
        const cliStates = allStates.filter((s): s is CliProviderState => s.category === 'cli');
        const acpStates = allStates.filter((s): s is AcpProviderState => s.category === 'acp');

 // IDE summary
        const ideSummary = ideStates.map((s) => {
            const msgs = s.activeChat?.messages?.length || 0;
            const exts = s.extensions.length;
            return `${s.type}(${s.status},${msgs}msg,${exts}ext${s.currentModel ? ',model=' + s.currentModel : ''})`;
        }).join(', ');

 // CLI summary
        const cliSummary = cliStates.map((s) => `${s.type}(${s.status})`).join(', ');
 // ACP summary
        const acpSummary = acpStates.map((s) => `${s.type}(${s.status})`).join(', ');

 // P2P-only = 5s heartbeat → DEBUG, P2P+Server = 30s interval → INFO
        const logLevel = opts?.p2pOnly ? 'debug' : 'info';
        const baseSummary = `IDE: ${ideStates.length} [${ideSummary}] CLI: ${cliStates.length} [${cliSummary}] ACP: ${acpStates.length} [${acpSummary}]`;
 // Skip identical repeats at any level to reduce log noise
        const summaryChanged = baseSummary !== this.lastStatusSummary;
        if (summaryChanged) {
            this.lastStatusSummary = baseSummary;
            if (logLevel === 'debug') {
                LOG.debug('StatusReport', `→${target} ${baseSummary}`);
            } else {
                LOG.info('StatusReport', `→${target} ${baseSummary}`);
            }
        }

 // IDE/CLI/ACP states → managed entries (shared builder)
        const { managedIdes, managedClis, managedAcps } = buildAllManagedEntries(
            allStates,
            this.deps.cdpManagers as Map<string, any>,
        );





        const cfg = loadConfig();
        const wsState = getWorkspaceState(cfg);
        const memSnap = getHostMemorySnapshot();

 // ═══ Assemble payload (P2P — required data only) ═══
        const payload: Record<string, any> = {
            daemonMode: true,
            version: this.deps.daemonVersion || 'unknown',
            workspaces: wsState.workspaces,
            defaultWorkspaceId: wsState.defaultWorkspaceId,
            defaultWorkspacePath: wsState.defaultWorkspacePath,
            workspaceActivity: getWorkspaceActivity(cfg, 15),
            machine: {
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length,
                totalMem: memSnap.totalMem,
                freeMem: memSnap.freeMem,
                availableMem: memSnap.availableMem,
                loadavg: os.loadavg(),
                uptime: os.uptime(),
            },
            managedIdes,
            managedClis,
            managedAcps,
            p2p: {
                available: p2p?.isAvailable || false,
                state: p2p?.connectionState || 'unavailable',
                peers: p2p?.connectedPeerCount || 0,
                screenshotActive: p2p?.screenshotActive || false,
            },
            screenshotUsage: this.deps.getScreenshotUsage?.() || null,
            connectedExtensions: [],
            detectedIdes: this.deps.detectedIdes || [],
            availableProviders: this.deps.providerLoader.getAll().map((p: any) => ({
                type: p.type, icon: p.icon || '💻', displayName: p.displayName || p.type,
                category: p.category,
            })),
            timestamp: now,
        };

 // ═══ P2P transmit ═══
        const p2pSent = this.sendP2PPayload(payload);
        if (p2pSent) {
            LOG.debug('P2P', `sent (${JSON.stringify(payload).length} bytes)`);
        }

 // ═══ Server transmit (minimal routing meta only) ═══
        if (opts?.p2pOnly) return;
        const wsPayload = {
            daemonMode: true,
 // managedIdes: server only saves id, type, cdpConnected
            managedIdes: managedIdes.map(ide => ({
                ideType: ide.ideType,
                instanceId: ide.instanceId,
                cdpConnected: ide.cdpConnected,
            })),
 // managedClis: server only saves id, type, name
            managedClis: managedClis.map(c => ({
                id: c.id, cliType: c.cliType, cliName: c.cliName,
            })),
 // managedAcps: server only saves id, type, name
            managedAcps: managedAcps?.map((a: any) => ({
                id: a.id, acpType: a.acpType, acpName: a.acpName,
            })),
            p2p: payload.p2p,
            timestamp: now,
        };
        serverConn.sendMessage('status_report', wsPayload);
        LOG.debug('Server', `sent status_report (${JSON.stringify(wsPayload).length} bytes)`);
    }

 // ─── P2P ─────────────────────────────────────────

    private sendP2PPayload(payload: Record<string, any>): boolean {
        const { timestamp: _ts, system: _sys, ...hashTarget } = payload;
        if (hashTarget.machine) {
            const { freeMem: _f, availableMem: _a, loadavg: _l, uptime: _u, ...stableMachine } = hashTarget.machine as any;
            hashTarget.machine = stableMachine;
        }
        const h = this.simpleHash(JSON.stringify(hashTarget));
        if (h !== this.lastP2PStatusHash) {
            this.lastP2PStatusHash = h;
            this.deps.p2p?.sendStatus(payload);
            return true;
        }
        return false;
    }

    private simpleHash(s: string): string {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(36);
    }
}
