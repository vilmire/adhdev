/**
 * DaemonStatusReporter — status collect & transmit (StatusReport / P2P / StatusEvent)
 *
 * Collect status from ProviderInstanceManager → assemble payload → transmit
 * Each Instance manages its own status/transition. This module only assembles + transmits.
 */

import { LOG } from '../logging/logger.js';
import {
    DEFAULT_STATUS_INITIAL_REPORT_DELAY_MS,
    DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS,
    DEFAULT_STATUS_SERVER_REPORT_INTERVAL_MS,
} from '../runtime-defaults.js';
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { MachineInfo } from '../shared-types.js';
import type { CloudStatusReportPayload, DaemonStatusEventPayload, P2PStatusSummary, RoutingSessionEntry, SeqscribeStatusSummary, StatusReportPayload } from '../shared-types.js';
import { buildStatusSnapshot } from './snapshot.js';
import { resolveMuted, resolveSurfaceHidden } from './builders.js';
// Shared WS message-type union (mesh-shared/ws-protocol) — this sink was typed
// `type: string`, leaving the primary status_report producer outside the only
// typed protocol surface (which lived in the proprietary consumer package).
import type { DaemonToServerWsMsg } from '@adhdev/mesh-shared';
import type {
    ProviderState,
    IdeProviderState,
    CliProviderState,
    AcpProviderState,
} from '../providers/provider-instance.js';

// ─── Server WS content boundary ───────────────────────

/**
 * Project a full session snapshot down to the routing-only metadata the cloud
 * server is allowed to see.
 *
 * ADHDev is P2P-first: chat, commands, screenshots and file ops travel over the
 * WebRTC DataChannel, and the server WS carries auth + signaling + lightweight
 * routing metadata only. This function IS that boundary for the status path.
 *
 * It copies an explicit allow-list of non-content fields. Do not rewrite it as a
 * `delete`/`Omit` of known-bad keys — a deny-list silently leaks every new field
 * added upstream. Anything free-text (titles, message previews, provider summary
 * strings) stays on the P2P payload, which is assembled and sent separately and
 * is untouched by this projection.
 */
/**
 * Project the P2P summary down to the non-content fields the server may see.
 *
 * Like the session projection above this is an explicit allow-list, not a
 * pass-through: the daemon's in-memory p2p view may grow peer-identifying
 * detail over time, and only these counters/enums are cleared for the server.
 *
 * Numeric fields are omitted (rather than sent as 0) when the daemon has no
 * value for them, so an older payload shape stays distinguishable from a real
 * zero — a genuine "0 relay connections" is a meaningful measurement.
 */
function buildCloudP2PSummary(p2p: StatusReportPayload['p2p'] | undefined): P2PStatusSummary | undefined {
    if (!p2p) return undefined;
    const counter = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

    const summary: P2PStatusSummary = {
        available: p2p.available,
        state: p2p.state,
        peers: p2p.peers,
    };
    if (p2p.screenshotActive !== undefined) summary.screenshotActive = p2p.screenshotActive;

    const direct = counter(p2p.direct);
    const relay = counter(p2p.relay);
    const unknownTransport = counter(p2p.unknownTransport);
    const directTotal = counter(p2p.directTotal);
    const relayTotal = counter(p2p.relayTotal);
    if (direct !== undefined) summary.direct = direct;
    if (relay !== undefined) summary.relay = relay;
    if (unknownTransport !== undefined) summary.unknownTransport = unknownTransport;
    if (directTotal !== undefined) summary.directTotal = directTotal;
    if (relayTotal !== undefined) summary.relayTotal = relayTotal;

    return summary;
}

/**
 * Project the seqscribe health summary down to the fields the server may see.
 *
 * Third allow-list in this file, same discipline as the two above: copy known
 * non-content fields by name, never spread the source. The daemon-side summary
 * is already aggregate-only (see seqscribe/stats.ts — no topic names, no peer
 * or writer ids), and re-applying the projection here means a future field
 * added upstream cannot reach the server without an edit to this list.
 *
 * Numbers are coerced defensively: this input crosses a package boundary and a
 * malformed value must not land as `NaN` in a payload the server parses.
 */
function buildCloudSeqscribeSummary(
    seqscribe: SeqscribeStatusSummary | undefined,
): SeqscribeStatusSummary | undefined {
    if (!seqscribe) return undefined;
    const count = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

    return {
        topics: count(seqscribe.topics),
        peers: count(seqscribe.peers),
        peersReady: count(seqscribe.peersReady),
        pendingBucket: count(seqscribe.pendingBucket),
        consumerLagBucket: count(seqscribe.consumerLagBucket),
        queueBucket: count(seqscribe.queueBucket),
        fgenAgeBucket: count(seqscribe.fgenAgeBucket),
        quarantined: seqscribe.quarantined === true,
        authority: seqscribe.authority === true,
        dualWrite: seqscribe.dualWrite === true,
        dualWriteFailedBucket: count(seqscribe.dualWriteFailedBucket),
        dualWriteDroppedBucket: count(seqscribe.dualWriteDroppedBucket),
        dualWriteBackfilledBucket: count(seqscribe.dualWriteBackfilledBucket),
        parityMismatchBucket: count(seqscribe.parityMismatchBucket),
        parityRan: seqscribe.parityRan === true,
        parityMissingInShadowBucket: count(seqscribe.parityMissingInShadowBucket),
        parityExtraInShadowBucket: count(seqscribe.parityExtraInShadowBucket),
        parityFieldMismatchBucket: count(seqscribe.parityFieldMismatchBucket),
    };
}

export function buildCloudStatusReportPayload(
    sessions: unknown,
    p2p: StatusReportPayload['p2p'] | undefined,
    timestamp: number,
    seqscribe?: SeqscribeStatusSummary,
): CloudStatusReportPayload {
    const list = Array.isArray(sessions) ? sessions : [];
    const seqscribeSummary = buildCloudSeqscribeSummary(seqscribe);
    return {
        sessions: list.map((raw): RoutingSessionEntry => {
            const session = (raw || {}) as Record<string, any>;
            return {
                id: session.id,
                parentId: session.parentId ?? null,
                providerType: session.providerType,
                providerName: session.providerName || session.providerType,
                kind: session.kind,
                transport: session.transport,
                status: session.status,
                workspace: session.workspace ?? null,
                cdpConnected: session.cdpConnected,
                // Forward surfaceHidden/muted so the server can gate push notifications
                // for coordinator-hidden and user-muted sessions (the WS path is the
                // only one the server sees). Both are plain booleans, not content.
                surfaceHidden: session.surfaceHidden,
                muted: session.muted,
            };
        }),
        p2p: buildCloudP2PSummary(p2p),
        ...(seqscribeSummary ? { seqscribe: seqscribeSummary } : {}),
        timestamp,
    };
}

// ─── Daemon dependency interface ──────────────────────

export interface StatusReporterDeps {
    // sendMessage reports delivery by return value: the cloud ServerConnection
    // returns false when the socket is not in a sendable state (mid-reconnect) or
    // when serialization throws — it never throws. The status dedup below must
    // honor that, or a dropped frame is recorded as delivered. Typed as
    // `void | boolean` so implementations that return nothing still satisfy it.
    serverConn: { isConnected(): boolean; sendMessage(type: DaemonToServerWsMsg, data: any): void | boolean; getUserPlan(): string } | null;
    cdpManagers: Map<string, DaemonCdpManager>;
    p2p: {
        isConnected: boolean;
        isAvailable: boolean;
        connectionState: string;
        connectedPeerCount: number;
        screenshotActive: boolean;
        /**
         * Direct/relay transport telemetry. Optional so a P2P implementation that
         * cannot observe candidate pairs (or a test double) still satisfies the
         * interface — the counters are simply omitted from the report.
         */
        transportStats?: {
            direct: number;
            relay: number;
            unknownTransport: number;
            directTotal: number;
            relayTotal: number;
        };
        sendStatus(data: any): void;
        sendStatusEvent(event: DaemonStatusEventPayload): void;
    } | null;
    providerLoader: { resolve(type: string): any; getAll(): any[] };
    detectedIdes: any[];
    instanceId: string;
    daemonVersion?: string;
    instanceManager: {
        collectAllStates(): ProviderState[];
        collectStatesByCategory(cat: string): ProviderState[];
        /**
         * Optional: live instance lookup used to stamp `surfaceHidden`/`muted` onto
         * outgoing status events (see buildServerStatusEvent). Optional so existing
         * test doubles and any alternate manager still satisfy the interface — when
         * absent the event simply omits the flags and the server falls back to its
         * snapshot join, i.e. exactly the pre-existing behavior.
         */
        getInstance?(sessionId: string): { getState?(): ProviderState | undefined } | undefined;
    };
    getScreenshotUsage?: () => { dailyUsedMinutes: number; dailyBudgetMinutes: number; budgetExhausted: boolean } | null;
    /**
     * seqscribe replication health, if a node is running (design §1.5).
     *
     * Optional and absent-by-default: daemons without seqscribe wired up omit
     * the field entirely rather than reporting zeros, so "no node" stays
     * distinguishable from "a healthy idle node". Returns pre-bucketed
     * aggregates — see seqscribe/stats.ts for why the values are coarse.
     */
    getSeqscribeStats?: () => SeqscribeStatusSummary | null;
}

/**
 * How many consecutive byte-identical periodic reports may be suppressed before
 * one is sent anyway.
 *
 * The periodic path used to pass `forceServer: true`, which bypassed the dedup
 * hash below unconditionally — a fully idle machine still re-sent the same
 * routing payload every 30s forever. That is pure waste on the single busiest
 * axis we have (UserSessionDO request count), so periodic now respects the hash.
 *
 * The keepalive stops that from becoming *silence*. At the 30s server interval
 * this floors an idle daemon at one report per ~5 minutes, which is three orders
 * of magnitude inside the server's 24h stale threshold for restoring a stored
 * entry (`UserSession.ts` migrate()) and well inside its 1h in-memory eviction
 * sweep, so a quiet-but-alive daemon can never be aged out. State transitions do
 * not wait for it: they change the hash and therefore send immediately.
 */
export const SERVER_DEDUP_KEEPALIVE_REPORTS = 10;

export class DaemonStatusReporter {
    private deps: StatusReporterDeps;
    private log: (msg: string) => void;

    private lastStatusSentAt = 0;
    private statusPendingThrottle = false;
    private lastP2PStatusHash = '';
    private lastP2PStatusSentAt: number = 0;
    private p2pDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastServerStatusHash = '';
    private lastStatusSummary = '';
    /**
     * Consecutive periodic reports suppressed by the server-side dedup hash.
     * Reset on every actual send; see SERVER_DEDUP_KEEPALIVE_REPORTS.
     */
    private serverDedupSkipCount = 0;

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
        }, DEFAULT_STATUS_INITIAL_REPORT_DELAY_MS);

        const scheduleServerReport = () => {
            this.statusTimer = setTimeout(() => {
                // No forceServer: an unchanged idle payload is deduped by the hash
                // below, bounded by SERVER_DEDUP_KEEPALIVE_REPORTS.
                this.sendUnifiedStatusReport({ reason: 'periodic' }).catch(e => LOG.warn('Status', `Periodic report failed: ${e?.message}`));
                scheduleServerReport();
            }, DEFAULT_STATUS_SERVER_REPORT_INTERVAL_MS);
        };
        scheduleServerReport();

        this.p2pTimer = setInterval(() => {
            if (this.deps.p2p?.isConnected) {
                this.sendUnifiedStatusReport({ p2pOnly: true }).catch(e => LOG.warn('Status', `P2P status send failed: ${e?.message}`));
            }
        }, DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS);
    }

    stopReporting(): void {
        if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
        if (this.p2pTimer) { clearInterval(this.p2pTimer); this.p2pTimer = null; }
    }

    onStatusChange(): void {
        if (this.deps.p2p?.isConnected) {
            this.resetP2PHash();
            this.sendUnifiedStatusReport({ p2pOnly: true, reason: 'status-change' })
                .catch(e => LOG.warn('Status', `Immediate P2P status send failed: ${e?.message}`));
        }
        this.throttledReport();
    }

    throttledReport(): void {
        const now = Date.now();
        const elapsed = now - this.lastStatusSentAt;
        if (elapsed >= DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS) {
            this.sendUnifiedStatusReport().catch(e => LOG.warn('Status', `Throttled report failed: ${e?.message}`));
        } else if (!this.statusPendingThrottle) {
            this.statusPendingThrottle = true;
            setTimeout(() => {
                this.statusPendingThrottle = false;
                this.sendUnifiedStatusReport().catch(e => LOG.warn('Status', `Deferred report failed: ${e?.message}`));
            }, DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS - elapsed);
        }
    }

    private toDaemonStatusEventName(value: unknown): DaemonStatusEventPayload['event'] | null {
        switch (value) {
            case 'agent:generating_started':
            case 'agent:waiting_approval':
            case 'agent:waiting_choice':
            case 'agent:generating_completed':
            case 'agent:stopped':
            case 'monitor:no_progress':
                return value;
            default:
                return null;
        }
    }

    /**
     * Resolve the target session's dashboard visibility at event time, straight
     * from the live provider instance's `settings` — the same source of truth
     * `buildSessionEntries` uses for the snapshot path (builders.ts), so an event
     * and a snapshot emitted for the same session always agree.
     *
     * Reading the LIVE instance (rather than a cached projection) is what closes
     * the race: a hide/mute toggle or a coordinator-spawned worker's default is
     * visible here immediately, whereas the derived caches only refresh on the
     * 5s/30s heartbeat.
     *
     * Returns undefined when the session has no local instance (a genuinely remote
     * mesh worker hosted by a different daemon, or an event with no targetSessionId).
     * The event then omits the flags and the server falls back to its snapshot join.
     */
    private resolveEventHideMute(sessionId: string): { surfaceHidden: boolean; muted: boolean } | undefined {
        if (!sessionId) return undefined;
        const getInstance = this.deps.instanceManager?.getInstance;
        if (typeof getInstance !== 'function') return undefined;
        let state: ProviderState | undefined;
        try {
            state = getInstance.call(this.deps.instanceManager, sessionId)?.getState?.();
        } catch {
            return undefined;
        }
        const settings = (state as { settings?: Record<string, any> } | undefined)?.settings;
        if (!settings) return undefined;
        return {
            surfaceHidden: resolveSurfaceHidden(settings),
            // Status-gated exactly as builders.ts does: pass the session's live status so a
            // one-shot silent-idle arm mutes only the idle/completion frame and never an
            // approval/choice frame in the same turn.
            muted: resolveMuted(settings, (state as { status?: string } | undefined)?.status),
        };
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
        if (typeof event.providerSessionId === 'string' && event.providerSessionId.trim()) {
            payload.providerSessionId = event.providerSessionId.trim();
        }
        if (typeof event.workspaceName === 'string' && event.workspaceName.trim()) {
            payload.workspaceName = event.workspaceName.trim();
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

        // Stamp the target session's visibility so the server's push-suppression
        // gate does not have to join against a snapshot that may not have arrived
        // yet. Booleans only — no content. See DaemonStatusEventPayload.
        if (payload.targetSessionId) {
            const hideMute = this.resolveEventHideMute(payload.targetSessionId);
            if (hideMute) {
                payload.surfaceHidden = hideMute.surfaceHidden;
                payload.muted = hideMute.muted;
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
        const serverConnected = !!serverConn?.isConnected();
        const p2pConnected = !!p2p?.isConnected;
        if (!serverConnected && !p2pConnected) return;
        this.lastStatusSentAt = Date.now();
        const now = this.lastStatusSentAt;
        const target = opts?.p2pOnly ? 'P2P' : (serverConnected ? 'P2P+Server' : 'P2P');

        const allStates = this.deps.instanceManager.collectAllStates();
        const ideStates = allStates.filter((s): s is IdeProviderState => s.category === 'ide');
        const cliStates = allStates.filter((s): s is CliProviderState => s.category === 'cli');
        const acpStates = allStates.filter((s): s is AcpProviderState => s.category === 'acp');

 // IDE summary
        const ideSummary = ideStates.map((s) => {
            const msgs = s.activeChat?.messages?.length || 0;
            const exts = s.extensions.length;
            return `${s.type}(${s.status},${msgs}msg,${exts}ext)`;
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
                    // Direct vs TURN-relay tallies. Spread so that a P2P impl without
                    // candidate-pair observability contributes no keys at all rather
                    // than a misleading run of zeros.
                    ...(p2p?.transportStats ?? {}),
                },
                profile: 'live',
            }),
            screenshotUsage: this.deps.getScreenshotUsage?.() || null,
        };

// ═══ P2P transmit ═══
        const p2pSent = this.sendP2PPayload(payload);
        if (p2pSent) {
            const payloadBytes = JSON.stringify(payload).length;
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
        if (!serverConnected || !serverConn) return;
        // Server relay only needs compact session metadata for routing, compact status,
        // initial_state fallback, and lightweight API/session inspection.
        // seqscribe health rides this existing frame — no new endpoint, no new
        // periodic transmission. Its values are bucketed upstream precisely so
        // they participate in the dedup hash below without defeating it: an
        // idle node keeps reporting the same buckets, so identical reports stay
        // identical and only a real state change forces a send.
        const wsPayload = buildCloudStatusReportPayload(
            payload.sessions,
            payload.p2p,
            now,
            this.deps.getSeqscribeStats?.() || undefined,
        );
        const wsHash = this.simpleHash(JSON.stringify({
            ...wsPayload,
            timestamp: undefined,
        }));
        if (!serverConnected || !serverConn) return;
        if (!opts?.forceServer && wsHash === this.lastServerStatusHash) {
            // Unchanged payload. Suppress it, but never indefinitely — after
            // SERVER_DEDUP_KEEPALIVE_REPORTS consecutive skips send one anyway so the
            // server's view of this daemon cannot go stale while it is still alive.
            if (this.serverDedupSkipCount + 1 < SERVER_DEDUP_KEEPALIVE_REPORTS) {
                this.serverDedupSkipCount++;
                LOG.debug('Server', `skip duplicate status_report${opts?.reason ? ` (${opts.reason})` : ''} [${this.serverDedupSkipCount}/${SERVER_DEDUP_KEEPALIVE_REPORTS}]`);
                return;
            }
            LOG.debug('Server', `keepalive status_report after ${this.serverDedupSkipCount} skipped duplicates`);
        }
        const wsPayloadBytes = JSON.stringify(wsPayload).length;
        // Record the dedup state only once the frame is actually handed to a live
        // socket. sendMessage returns false when the WS is mid-reconnect or the
        // send throws; storing the hash first would mark a dropped frame as
        // delivered, and every later report with the same payload would then be
        // deduped away — leaving the server on a stale status until the payload
        // changes again or keepalive expires. Before periodic reports respected
        // the dedup hash this was masked by an unconditional resend every 30s.
        const delivered = serverConn.sendMessage('status_report', wsPayload);
        if (delivered === false) {
            LOG.debug('Server', `status_report not delivered — keeping previous dedup hash for retry${opts?.reason ? ` (${opts.reason})` : ''}`);
            return;
        }
        this.serverDedupSkipCount = 0;
        this.lastServerStatusHash = wsHash;
        LOG.debug('Server', `sent status_report (${wsPayloadBytes} bytes)${opts?.reason ? ` [${opts.reason}]` : ''}`);
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
            const now = Date.now();
            // Rate limit: max 1 per 500ms
            if (this.lastP2PStatusSentAt && now - this.lastP2PStatusSentAt < 500) {
                if (!this.p2pDebounceTimer) {
                    this.p2pDebounceTimer = setTimeout(() => {
                        this.p2pDebounceTimer = null;
                        this.sendUnifiedStatusReport({ reason: 'p2p_debounce' });
                    }, 500);
                }
                return false; // Dropped for now, but will trigger later
            }
            
            this.lastP2PStatusHash = h;
            this.lastP2PStatusSentAt = now;
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
