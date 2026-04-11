/**
 * DaemonStatusReporter — status collect & transmit (StatusReport / P2P / StatusEvent)
 *
 * Collect status from ProviderInstanceManager → assemble payload → transmit
 * Each Instance manages its own status/transition. This module only assembles + transmits.
 */

import { LOG } from '../logging/logger.js';
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { MachineInfo } from '../shared-types.js';
import type { CloudStatusReportPayload, DaemonStatusEventPayload } from '../shared-types.js';
import { buildSessionEntries } from './builders.js';
import { buildStatusSnapshot } from './snapshot.js';
import type {
    ProviderState,
    IdeProviderState,
    CliProviderState,
    AcpProviderState,
} from '../providers/provider-instance.js';

// ─── Daemon dependency interface ──────────────────────

export interface StatusReporterDeps {
    serverConn: { isConnected(): boolean; sendMessage(type: string, data: any): void; getUserPlan(): string } | null;
    cdpManagers: Map<string, DaemonCdpManager>;
    p2p: {
        isConnected: boolean;
        isAvailable: boolean;
        connectionState: string;
        connectedPeerCount: number;
        screenshotActive: boolean;
        sendStatus(data: any): void;
        sendStatusEvent(event: DaemonStatusEventPayload): void;
    } | null;
    providerLoader: { resolve(type: string): any; getAll(): any[] };
    detectedIdes: any[];
    instanceId: string;
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
    private lastServerStatusHash = '';
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
            this.sendUnifiedStatusReport({ forceServer: true, reason: 'initial' }).catch(e => LOG.warn('Status', `Initial report failed: ${e?.message}`));
        }, 2000);

        const scheduleServerReport = () => {
            this.statusTimer = setTimeout(() => {
                this.sendUnifiedStatusReport({ forceServer: true, reason: 'periodic' }).catch(e => LOG.warn('Status', `Periodic report failed: ${e?.message}`));
                scheduleServerReport();
            }, 30_000);
        };
        scheduleServerReport();

        this.p2pTimer = setInterval(() => {
            if (this.deps.p2p?.isConnected) {
                this.sendUnifiedStatusReport({ p2pOnly: true }).catch(e => LOG.warn('Status', `P2P status send failed: ${e?.message}`));
            }
        }, 5_000);
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

    private toDaemonStatusEventName(value: unknown): DaemonStatusEventPayload['event'] | null {
        switch (value) {
            case 'agent:generating_started':
            case 'agent:waiting_approval':
            case 'agent:generating_completed':
            case 'agent:stopped':
            case 'monitor:long_generating':
                return value;
            default:
                return null;
        }
    }

    private buildServerStatusEvent(event: Record<string, unknown>): DaemonStatusEventPayload | null {
        const eventName = this.toDaemonStatusEventName(event.event);
        if (!eventName) return null;

        // Provider UI effects can carry arbitrary text content and are not required
        // for server-side routing, push, or dashboard session targeting.
        if (eventName.startsWith('provider:')) {
            return null;
        }

        const payload: DaemonStatusEventPayload = {
            event: eventName,
            timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
                ? event.timestamp
                : Date.now(),
        };

        if (typeof event.targetSessionId === 'string' && event.targetSessionId.trim()) {
            payload.targetSessionId = event.targetSessionId.trim();
        }
        const providerType = typeof event.providerType === 'string' && event.providerType.trim()
            ? event.providerType.trim()
            : (typeof event.ideType === 'string' && event.ideType.trim() ? event.ideType.trim() : '');
        if (providerType) {
            payload.providerType = providerType;
        }
        if (typeof event.duration === 'number' && Number.isFinite(event.duration)) {
            payload.duration = event.duration;
        }
        if (typeof event.elapsedSec === 'number' && Number.isFinite(event.elapsedSec)) {
            payload.elapsedSec = event.elapsedSec;
        }
        if (typeof event.modalMessage === 'string' && event.modalMessage.trim()) {
            payload.modalMessage = event.modalMessage;
        }
        if (Array.isArray(event.modalButtons)) {
            const modalButtons = event.modalButtons
                .filter((button): button is string => typeof button === 'string' && button.trim().length > 0);
            if (modalButtons.length > 0) {
                payload.modalButtons = modalButtons;
            }
        }

        return payload;
    }

    emitStatusEvent(event: Record<string, unknown>): void {
        LOG.info('StatusEvent', `${event.event} (${event.providerType || event.ideType || ''})`);
        const serverEvent = this.buildServerStatusEvent(event);
        if (!serverEvent) return;
        // Dashboard delivery is P2P-only, but the server still receives the event
        // for push notifications, webhook dispatch, and audit-side effects.
        this.deps.p2p?.sendStatusEvent(serverEvent);
        this.deps.serverConn?.sendMessage('status_event', serverEvent);
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

    private summarizeLargePayloadSessions(payload: Record<string, any>): string {
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        return sessions
            .map((session: any) => ({
                id: String(session?.id || ''),
                providerType: String(session?.providerType || ''),
                bytes: (() => {
                    try {
                        return JSON.stringify(session).length;
                    } catch {
                        return 0;
                    }
                })(),
            }))
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 3)
            .map((session) => `${session.providerType || 'unknown'}:${session.id}=${session.bytes}b`)
            .join(', ');
    }

    async sendUnifiedStatusReport(opts?: { p2pOnly?: boolean; forceServer?: boolean; reason?: string }): Promise<void> {
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
        const sessions = buildSessionEntries(
            allStates,
            this.deps.cdpManagers,
        );

 // ═══ Assemble payload (P2P — required data only) ═══
        const payload: Record<string, any> = {
            ...buildStatusSnapshot({
                allStates,
                cdpManagers: this.deps.cdpManagers,
                providerLoader: this.deps.providerLoader,
                detectedIdes: this.deps.detectedIdes || [],
                instanceId: this.deps.instanceId,
                version: this.deps.daemonVersion || 'unknown',
                timestamp: now,
                p2p: {
                    available: p2p?.isAvailable || false,
                    state: p2p?.connectionState || 'unavailable',
                    peers: p2p?.connectedPeerCount || 0,
                    screenshotActive: p2p?.screenshotActive || false,
                },
                profile: 'live',
            }),
            screenshotUsage: this.deps.getScreenshotUsage?.() || null,
        };

// ═══ P2P transmit ═══
        const payloadBytes = JSON.stringify(payload).length;
        const p2pSent = this.sendP2PPayload(payload);
        if (p2pSent) {
            LOG.debug('P2P', `sent (${payloadBytes} bytes)`);
            if (payloadBytes > 256 * 1024) {
                LOG.warn(
                    'P2P',
                    `large status payload (${payloadBytes} bytes) top sessions: ${this.summarizeLargePayloadSessions(payload) || 'n/a'}`,
                );
            }
        }

 // ═══ Server transmit (minimal routing meta only) ═══
        if (opts?.p2pOnly) return;
        // Server relay only needs compact session metadata for routing, compact status,
        // initial_state fallback, and lightweight API/session inspection.
        const wsPayload: CloudStatusReportPayload = {
            sessions: sessions.map((session) => ({
                id: session.id,
                parentId: session.parentId,
                providerType: session.providerType,
                providerName: session.providerName || session.providerType,
                kind: session.kind,
                transport: session.transport,
                status: session.status,
                workspace: session.workspace ?? null,
                title: session.title,
                cdpConnected: session.cdpConnected,
                currentModel: session.currentModel,
                currentPlan: session.currentPlan,
                currentAutoApprove: session.currentAutoApprove,
            })),
            p2p: payload.p2p,
            timestamp: now,
        };
        const wsHash = this.simpleHash(JSON.stringify({
            ...wsPayload,
            timestamp: undefined,
        }));
        if (!opts?.forceServer && wsHash === this.lastServerStatusHash) {
            LOG.debug('Server', `skip duplicate status_report${opts?.reason ? ` (${opts.reason})` : ''}`);
            return;
        }
        this.lastServerStatusHash = wsHash;
        serverConn.sendMessage('status_report', wsPayload);
        LOG.debug('Server', `sent status_report (${JSON.stringify(wsPayload).length} bytes)${opts?.reason ? ` [${opts.reason}]` : ''}`);
    }

 // ─── P2P ─────────────────────────────────────────

    private sendP2PPayload(payload: { timestamp?: number; system?: unknown; machine?: MachineInfo; [key: string]: unknown }): boolean {
        const { timestamp: _ts, system: _sys, ...hashTarget } = payload;
        const sessions = Array.isArray(hashTarget.sessions)
            ? hashTarget.sessions.map((session) => {
                if (!session || typeof session !== 'object') return session;
                const { lastUpdated: _lu, ...stableSession } = session as Record<string, unknown>;
                return stableSession;
            })
            : hashTarget.sessions;
        const hashPayload = hashTarget.machine
            ? (() => {
                const { freeMem: _f, availableMem: _a, loadavg: _l, uptime: _u, ...stableMachine } = hashTarget.machine;
                return { ...hashTarget, sessions, machine: stableMachine };
            })()
            : { ...hashTarget, sessions };
        const h = this.simpleHash(JSON.stringify(hashPayload));
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
