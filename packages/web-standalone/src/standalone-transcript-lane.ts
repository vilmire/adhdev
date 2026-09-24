/**
 * Standalone dashboard — seqscribe transcript replica lane (wiring-unification
 * G6 prerequisite, design `docs/design/2026-09-23-wiring-unification.md` §7e).
 *
 * The standalone counterpart of web-cloud's `onSeqscribeTransport` wiring in
 * `p2p-manager.ts` + `transcript-worker-transport.ts`. Everything that is not
 * transport lives in web-core and is reused unchanged: the worker host
 * (`startTranscriptWorkerHost`), the worker itself (node + OPFS + reject-all
 * browser authority + `view:'tail'` SUB), and the chat-tail controller registry
 * that arbitrates replica vs legacy. This module only:
 *
 *   1. opens `ws(s)://<host>/ws/seqscribe` (same token/cookie as `/ws`) — a
 *      real `WebSocket` is already the `WebSocketLike` the host takes, so there
 *      is no adapter;
 *   2. starts ONE worker host per open lane and tells it which sessions to
 *      subscribe (the retained controller registry — same derivation as
 *      web-cloud's `bindTranscriptSessionInterest`);
 *   3. feeds each verified snapshot to the controllers
 *      (`applyTranscriptReplicaSnapshotToControllers`), which is what flips
 *      `replicaHealthy` and makes the controller report `replica` via
 *      `report_transcript_transport`;
 *   4. on lane close: stops the host (the worker never resumes across a gap),
 *      labels the affected sessions `no_node` so they fall back to legacy, and
 *      reopens with backoff.
 *
 * Everything web-core-valued is INJECTED (`StandaloneTranscriptLaneDeps`) so
 * this file imports types only and is unit-testable under node:test; the real
 * assembly is `standalone-transcript-lane-wiring.ts`.
 *
 * Legacy `session.chat_tail` is NOT touched here — the controller keeps it
 * running until a verified replica snapshot lands (G6 proper deletes it later).
 */
import type { TranscriptBridgeSnapshotMessage, TranscriptWorkerHostHandle } from '@adhdev/web-core/transcript-transport'

/** Must equal daemon-core `STANDALONE_SEQSCRIBE_WS_PATH` (pinned by tests on both sides). */
export const STANDALONE_SEQSCRIBE_WS_PATH = '/ws/seqscribe'

/**
 * OPFS directory / browser writer id for this origin's replica. Stable (not
 * per tab) for the same reason web-cloud keys it per daemon: a reconnect must
 * reuse the database instead of accumulating orphans. One standalone origin is
 * one daemon.
 */
export const STANDALONE_TRANSCRIPT_WRITER_ID = 'standalone_dashboard'

export const LANE_RECONNECT_INITIAL_MS = 3_000
export const LANE_RECONNECT_MAX_MS = 30_000
/** A lane that stayed open at least this long resets the backoff on close. */
export const LANE_HEALTHY_OPEN_MS = 30_000
/**
 * Re-SUB cadence for sessions that have not delivered a snapshot yet on the
 * current host (doubling, capped). See `rearmUndelivered`.
 */
export const SUB_RETRY_INITIAL_MS = 3_000
export const SUB_RETRY_MAX_MS = 60_000

/**
 * Build-time switch. Unlike web-cloud (default OFF, preview-only opt-in) the
 * standalone lane defaults ON: the daemon and the page are the same local
 * install, the controller keeps legacy running until a verified snapshot
 * applies, and G6 needs the standalone replica live to retire chat-tail at
 * all. `VITE_ADHDEV_TRANSCRIPT_WORKER=off` is the one opt-out spelling (the
 * daemon has its own: `ADHDEV_STANDALONE_TRANSCRIPT_LANE=off`).
 */
export function isStandaloneTranscriptLaneEnabled(env: Record<string, unknown> | undefined): boolean {
    const raw = env?.VITE_ADHDEV_TRANSCRIPT_WORKER
    return !(typeof raw === 'string' && raw.trim().toLowerCase() === 'off')
}

export function buildStandaloneSeqscribeWsUrl(
    location: { readonly protocol: string; readonly host: string },
    token: string | null,
): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const base = `${proto}://${location.host}${STANDALONE_SEQSCRIBE_WS_PATH}`
    return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * What `sendDataViaWs` may put on the `/ws` JSON lane. Legacy topic
 * subscribe/unsubscribe, plus exactly ONE command: the controller's
 * fire-and-forget `report_transcript_transport` (closed two-value enum, see
 * `SessionChatTailController.reportTransportSelection`). Before this, the
 * report was silently dropped by a subscribe-only filter, which is half of why
 * standalone read `transcriptTransportSelection = {0,0}`.
 */
export function isStandaloneWsDataFrame(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false
    const frame = data as { type?: unknown; commandType?: unknown }
    if (frame.type === 'subscribe' || frame.type === 'unsubscribe') return true
    return frame.type === 'command' && frame.commandType === 'report_transcript_transport'
}

/** The `WebSocket` surface this lane uses (a real DOM `WebSocket` satisfies it). */
export interface LaneSocket {
    readonly readyState: number
    send(data: string): void
    close(): void
    addEventListener(type: 'open', cb: () => void): void
    addEventListener(type: 'close', cb: () => void): void
    addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void
}

export interface StandaloneTranscriptLaneDeps {
    createSocket(): LaneSocket
    /** Start the shared worker host on an OPEN lane; null = worker unavailable (lane stays off). */
    startHost(
        transport: LaneSocket,
        onSnapshot: (message: TranscriptBridgeSnapshotMessage) => void,
    ): TranscriptWorkerHostHandle | null
    /** web-core `collectRetainedTranscriptSessionInterest`. */
    collectInterest(): Map<string, string[]>
    /** web-core `subscribeTranscriptSessionInterest`. */
    subscribeInterest(listener: () => void): () => void
    /** web-core `applyTranscriptReplicaSnapshotToControllers`. */
    applySnapshot(
        daemonId: string,
        sessionId: string,
        snapshot: TranscriptBridgeSnapshotMessage['snapshot'],
        options: { omittedBefore: boolean },
    ): number
    /** web-core `reportTranscriptReplicaFallbackForSession`. */
    reportFallback(daemonId: string, sessionId: string, reason: string): void
    /** `purpose` is diagnostic only (tests tell the two timers apart by it). */
    setTimer(cb: () => void, ms: number, purpose: 'reconnect' | 'sub-retry'): unknown
    clearTimer(handle: unknown): void
    now(): number
    log?(message: string): void
}

export class StandaloneTranscriptLaneClient {
    private socket: LaneSocket | null = null
    private host: TranscriptWorkerHostHandle | null = null
    private openedAt: number | null = null
    private reconnectTimer: unknown = null
    private reconnectDelay = LANE_RECONNECT_INITIAL_MS
    private unsubscribeInterest: (() => void) | null = null
    /** sessionId → daemonIds that are reading it (retained controllers). */
    private sessionDaemons = new Map<string, string[]>()
    private activeSessions: string[] = []
    /** Sessions that delivered at least one verified snapshot on the CURRENT host. */
    private delivered = new Set<string>()
    private subRetryTimer: unknown = null
    private subRetryDelay = SUB_RETRY_INITIAL_MS
    private started = false
    private stopped = false

    constructor(private readonly deps: StandaloneTranscriptLaneDeps) {}

    start(): void {
        if (this.started || this.stopped) return
        this.started = true
        this.unsubscribeInterest = this.deps.subscribeInterest(() => this.syncInterest())
        this.syncInterest()
        this.connect()
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        this.unsubscribeInterest?.()
        this.unsubscribeInterest = null
        if (this.reconnectTimer !== null) this.deps.clearTimer(this.reconnectTimer)
        this.reconnectTimer = null
        const socket = this.socket
        this.socket = null
        this.stopHost(false)
        try { socket?.close() } catch { /* already closing */ }
    }

    /** Diagnostics / tests. */
    isHostRunning(): boolean {
        return this.host !== null
    }

    /** Diagnostics / tests. */
    currentReconnectDelay(): number {
        return this.reconnectDelay
    }

    private connect(): void {
        if (this.stopped) return
        let socket: LaneSocket
        try {
            socket = this.deps.createSocket()
        } catch (error) {
            this.deps.log?.(`[Transcript] standalone lane socket failed: ${error instanceof Error ? error.message : String(error)}`)
            this.scheduleReconnect()
            return
        }
        this.socket = socket
        socket.addEventListener('open', () => this.handleOpen(socket))
        socket.addEventListener('close', () => this.handleClose(socket))
    }

    private handleOpen(socket: LaneSocket): void {
        if (this.stopped || socket !== this.socket) return
        this.openedAt = this.deps.now()
        this.stopHost(false)
        const host = this.deps.startHost(socket, (message) => this.deliver(message))
        if (!host) {
            // No Worker / OPFS in this browser: the lane can never carry a
            // replica here. Stop trying rather than reconnect-loop.
            this.deps.log?.('[Transcript] standalone lane: transcript worker unavailable — staying on legacy chat-tail')
            this.stopped = true
            this.socket = null
            try { socket.close() } catch { /* noop */ }
            return
        }
        this.host = host
        if (this.activeSessions.length > 0) host.activateSessions(this.activeSessions)
        this.armSubRetry(true)
    }

    private handleClose(socket: LaneSocket): void {
        if (socket !== this.socket) return
        this.socket = null
        const openedFor = this.openedAt === null ? 0 : this.deps.now() - this.openedAt
        this.openedAt = null
        if (openedFor >= LANE_HEALTHY_OPEN_MS) this.reconnectDelay = LANE_RECONNECT_INITIAL_MS
        this.stopHost(true)
        this.scheduleReconnect()
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer !== null) return
        const delay = this.reconnectDelay
        this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.5), LANE_RECONNECT_MAX_MS)
        this.reconnectTimer = this.deps.setTimer(() => {
            this.reconnectTimer = null
            this.connect()
        }, delay, 'reconnect')
    }

    private stopHost(reportFallback: boolean): void {
        const host = this.host
        if (!host) return
        this.host = null
        this.delivered.clear()
        if (this.subRetryTimer !== null) this.deps.clearTimer(this.subRetryTimer)
        this.subRetryTimer = null
        host.stop()
        if (!reportFallback) return
        // The lane is gone, so whatever it fed is stale: label those panes
        // `legacy` (`no_node`, the closed-union reason web-cloud uses). The
        // legacy subscription the controller re-arms is what renders next.
        for (const [sessionId, daemonIds] of this.sessionDaemons) {
            for (const daemonId of daemonIds) {
                console.warn(`[Transcript] standalone replica fallback — session=${sessionId} reason=no_node`)
                this.deps.reportFallback(daemonId, sessionId, 'no_node')
            }
        }
    }

    /** Recompute the absolute session set from the retained controller registry. */
    private syncInterest(): void {
        const next = new Map<string, string[]>()
        for (const [daemonId, sessionIds] of this.deps.collectInterest()) {
            for (const sessionId of sessionIds) {
                const daemons = next.get(sessionId)
                if (daemons) {
                    if (!daemons.includes(daemonId)) daemons.push(daemonId)
                } else {
                    next.set(sessionId, [daemonId])
                }
            }
        }
        this.sessionDaemons = next
        const sessions = [...next.keys()].sort()
        if (sessions.length === this.activeSessions.length && sessions.every((id, i) => id === this.activeSessions[i])) return
        this.activeSessions = sessions
        for (const sessionId of [...this.delivered]) {
            if (!next.has(sessionId)) this.delivered.delete(sessionId)
        }
        this.host?.activateSessions(sessions)
        this.armSubRetry(true)
    }

    /**
     * ★ Why re-SUB at all: a seqscribe SUB for a topic the daemon has not
     * DEFINED yet is refused (`ERR_ACL_DENIED` — nothing to grant) and the
     * library does not retry it. The daemon defines `session.<id>.transcript`
     * lazily, on that session's first publish after (re)start, so a pane opened
     * on a brand-new session — or on any idle session right after a daemon
     * restart — would otherwise sit on legacy until the lane happened to
     * reconnect. The grant does reach the lane once the topic appears
     * (daemon-side `onTopicActivated` → `updateGrants`); only the dead SUB
     * needs replacing.
     *
     * The worker's activation is absolute and idempotent, so the re-SUB is
     * "activate without the undelivered sessions, then with them" — which
     * closes and reopens exactly those subscriptions. Delivered sessions are
     * never touched. Doubling cadence capped at `SUB_RETRY_MAX_MS` keeps a
     * session whose topic has rows but no verifiable revision from costing
     * more than one SNAP a minute.
     */
    private armSubRetry(reset: boolean): void {
        if (reset) this.subRetryDelay = SUB_RETRY_INITIAL_MS
        if (!this.host || this.subRetryTimer !== null) return
        if (!this.activeSessions.some((id) => !this.delivered.has(id))) return
        const delay = this.subRetryDelay
        this.subRetryTimer = this.deps.setTimer(() => {
            this.subRetryTimer = null
            this.rearmUndelivered()
        }, delay, 'sub-retry')
    }

    private rearmUndelivered(): void {
        const host = this.host
        if (!host || this.stopped) return
        const pending = this.activeSessions.filter((id) => !this.delivered.has(id))
        if (pending.length === 0) return
        host.activateSessions(this.activeSessions.filter((id) => this.delivered.has(id)))
        host.activateSessions(this.activeSessions)
        this.subRetryDelay = Math.min(this.subRetryDelay * 2, SUB_RETRY_MAX_MS)
        this.armSubRetry(false)
    }

    private deliver(message: TranscriptBridgeSnapshotMessage): void {
        const daemonIds = this.sessionDaemons.get(message.sessionId)
        if (!daemonIds) return
        this.delivered.add(message.sessionId)
        for (const daemonId of daemonIds) {
            this.deps.applySnapshot(daemonId, message.sessionId, message.snapshot, {
                omittedBefore: message.omittedBefore,
            })
        }
    }
}
