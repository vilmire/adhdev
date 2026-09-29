/**
 * DaemonStatusReporter — the SERVER `status_report` (routing metadata only).
 *
 * Collect status from ProviderInstanceManager → project to the allow-listed
 * routing payload → transmit over the server WS. The dashboard's state lane is
 * the keyed `daemon.metadata` topic (subscriptions/topic-registry.ts); the old
 * P2P `status_report` full-snapshot push is gone (data-path audit 2026-09-29
 * P0-3), as is the `fleet.status` shadow ring this reporter used to feed (P0-4).
 */

import { LOG } from '../logging/logger.js';
import {
    DEFAULT_STATUS_INITIAL_REPORT_DELAY_MS,
    DEFAULT_STATUS_P2P_REPORT_INTERVAL_MS,
    DEFAULT_STATUS_SERVER_REPORT_INTERVAL_MS,
} from '../runtime-defaults.js';
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { CloudStatusReportPayload, P2PStatusSummary, RoutingSessionEntry, SeqscribeStatusSummary, StatusReportPayload } from '../shared-types.js';
import { buildStatusSnapshot } from './snapshot.js';
// Shared WS message-type union (mesh-shared/ws-protocol) — this sink was typed
// `type: string`, leaving the primary status_report producer outside the only
// typed protocol surface (which lived in the proprietary consumer package).
import type { DaemonToServerWsMsg } from '@adhdev/mesh-shared';
import { isModelAxisSource, sanitizeModelIdentifier } from '@adhdev/mesh-shared';
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
        // §8 unit 2. transcriptParityPersistentMismatchBucket stays LOCAL-ONLY.
        transcriptPublish: seqscribe.transcriptPublish === true,
        transcriptPublishedBucket: count(seqscribe.transcriptPublishedBucket),
        transcriptPublishFailedBucket: count(seqscribe.transcriptPublishFailedBucket),
        transcriptDedupedBucket: count(seqscribe.transcriptDedupedBucket),
        transcriptOversizedBucket: count(seqscribe.transcriptOversizedBucket),
        transcriptDroppedBucket: count(seqscribe.transcriptDroppedBucket),
        transcriptParityRan: seqscribe.transcriptParityRan === true,
        transcriptParityMismatchBucket: count(seqscribe.transcriptParityMismatchBucket),
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
                // Phase E launch provenance — exactly two derived fields, each
                // re-checked at runtime: an identifier (a label or free text is
                // dropped) and an enum (MODEL_AXIS_SOURCES). The full `launch`
                // record and the thinking level stay on P2P.
                model: sanitizeModelIdentifier(session.model),
                modelSource: isModelAxisSource(session.modelSource) ? session.modelSource : undefined,
            };
        }),
        p2p: buildCloudP2PSummary(p2p),
        ...(seqscribeSummary ? { seqscribe: seqscribeSummary } : {}),
        timestamp,
    };
}

export interface StatusReporterDeps {
    // sendMessage reports delivery by return value: the cloud ServerConnection
    // returns false when the socket is not in a sendable state (mid-reconnect) or
    // when serialization throws — it never throws. The status dedup below must
    // honor that, or a dropped frame is recorded as delivered. Typed as
    // `void | boolean` so implementations that return nothing still satisfy it.
    serverConn: { isConnected(): boolean; sendMessage(type: DaemonToServerWsMsg, data: any): void | boolean; getUserPlan(): string } | null;
    cdpManagers: Map<string, DaemonCdpManager>;
    /** P2P link state, projected into the server frame's allow-listed `p2p` summary. */
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
    } | null;
    providerLoader: { resolve(type: string): any; getAll(): any[] };
    detectedIdes: any[];
    instanceId: string;
    daemonVersion?: string;
    instanceManager: {
        collectAllStates(): ProviderState[];
        collectStatesByCategory(cat: string): ProviderState[];
    };
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

/** The P2P link summary as the reporter observes it (the server frame's `p2p` input). */
export function observeP2PStatusSummary(p2p: StatusReporterDeps['p2p']): P2PStatusSummary {
    return {
        available: p2p?.isAvailable || false,
        state: p2p?.connectionState || 'unavailable',
        peers: p2p?.connectedPeerCount || 0,
        screenshotActive: p2p?.screenshotActive || false,
        // Direct vs TURN-relay tallies. Spread so that a P2P impl without
        // candidate-pair observability contributes no keys at all rather
        // than a misleading run of zeros.
        ...(p2p?.transportStats ?? {}),
    };
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
    private lastServerStatusHash = '';
    private lastStatusSummary = '';
    /**
     * Consecutive periodic reports suppressed by the server-side dedup hash.
     * Reset on every actual send; see SERVER_DEDUP_KEEPALIVE_REPORTS.
     */
    private serverDedupSkipCount = 0;

    private statusTimer: NodeJS.Timeout | null = null;

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
    }

    stopReporting(): void {
        if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
    }

    /** A status fact changed — report to the server, throttled. */
    onStatusChange(): void {
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

    // toDaemonStatusEventName / resolveEventHideMute / buildServerStatusEvent /
    // buildP2PStatusEvent / emitStatusEvent moved to status/status-event.ts as
    // projectServerStatusEvent / projectP2PStatusEvent / createStatusEventEmitter
    // (wiring-unification B5, shared by both hosts).

 // ─── Core ────────────────────────────────────────

    async sendUnifiedStatusReport(opts?: { forceServer?: boolean; reason?: string }): Promise<void> {
        const { serverConn, p2p } = this.deps;
        if (!serverConn?.isConnected()) return;
        this.lastStatusSentAt = Date.now();
        const now = this.lastStatusSentAt;

        const allStates = this.deps.instanceManager.collectAllStates();

        // The per-category summary exists ONLY to build one INFO log line;
        // identical repeats are skipped. Built in one pass over allStates.
        {
            let ideCount = 0;
            let cliCount = 0;
            let acpCount = 0;
            const ideParts: string[] = [];
            const cliParts: string[] = [];
            const acpParts: string[] = [];
            for (const s of allStates) {
                if (s.category === 'ide') {
                    const ide = s as IdeProviderState;
                    ideCount++;
                    ideParts.push(`${ide.type}(${ide.status},${ide.activeChat?.messages?.length || 0}msg,${ide.extensions.length}ext)`);
                } else if (s.category === 'cli') {
                    const cli = s as CliProviderState;
                    cliCount++;
                    cliParts.push(`${cli.type}(${cli.status})`);
                } else if (s.category === 'acp') {
                    const acp = s as AcpProviderState;
                    acpCount++;
                    acpParts.push(`${acp.type}(${acp.status})`);
                }
            }
            const baseSummary = `IDE: ${ideCount} [${ideParts.join(', ')}] CLI: ${cliCount} [${cliParts.join(', ')}] ACP: ${acpCount} [${acpParts.join(', ')}]`;
            if (baseSummary !== this.lastStatusSummary) {
                this.lastStatusSummary = baseSummary;
                LOG.info('StatusReport', `→Server ${baseSummary}`);
            }
        }

        // Server relay only needs compact session metadata for routing, compact
        // status, initial_state fallback, and lightweight API/session
        // inspection. seqscribe health rides this existing frame; its values are
        // bucketed upstream precisely so they participate in the dedup hash
        // below without defeating it.
        const snapshot = buildStatusSnapshot({
            allStates,
            cdpManagers: this.deps.cdpManagers,
            providerLoader: this.deps.providerLoader,
            detectedIdes: this.deps.detectedIdes || [],
            instanceId: this.deps.instanceId,
            version: this.deps.daemonVersion || 'unknown',
            timestamp: now,
            profile: 'live',
        });
        const wsPayload = buildCloudStatusReportPayload(
            snapshot.sessions,
            observeP2PStatusSummary(p2p),
            now,
            this.deps.getSeqscribeStats?.() || undefined,
        );
        const wsHash = this.simpleHash(JSON.stringify({
            ...wsPayload,
            timestamp: undefined,
        }));
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
        // changes again or keepalive expires.
        const delivered = serverConn.sendMessage('status_report', wsPayload);
        if (delivered === false) {
            LOG.debug('Server', `status_report not delivered — keeping previous dedup hash for retry${opts?.reason ? ` (${opts.reason})` : ''}`);
            return;
        }
        this.serverDedupSkipCount = 0;
        this.lastServerStatusHash = wsHash;
        LOG.debug('Server', `sent status_report (${wsPayloadBytes} bytes)${opts?.reason ? ` [${opts.reason}]` : ''}`);
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
