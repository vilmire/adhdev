/**
 * Standalone dashboard — seqscribe transcript replica lane (wiring-unification
 * G6 prerequisite, design `docs/design/2026-09-23-wiring-unification.md` §7e).
 *
 * The standalone counterpart of web-cloud's `onSeqscribeTransport` wiring in
 * `p2p-manager.ts` + `transcript-worker-transport.ts`. Everything that is not
 * transport lives in web-core and is reused unchanged: the worker host
 * (`startTranscriptWorkerHost`), the worker itself (node + OPFS + reject-all
 * browser authority + `view:'tail'` SUB), and the session chat controller
 * registry. This lane is the standalone dashboard's ONLY live chat path
 * (design 2026-09-28 §6.4). This module only:
 *
 *   1. opens `ws(s)://<host>/ws/seqscribe` (same token/cookie as `/ws`) — a
 *      real `WebSocket` is already the `WebSocketLike` the host takes, so there
 *      is no adapter;
 *   2. starts ONE worker host per open lane and tells it which sessions to
 *      subscribe (the retained controller registry — same derivation as
 *      web-cloud's `bindTranscriptSessionInterest`);
 *   3. feeds each verified keyed view to the controllers
 *      (`applyTranscriptViewToControllers`);
 *   4. on lane close: stops the host (the worker never resumes across a gap)
 *      and reopens with backoff — panes keep their last committed view until
 *      the fresh host's reset SNAP lands.
 *
 * Everything web-core-valued is INJECTED (`StandaloneTranscriptLaneDeps`) so
 * this file imports types only and is unit-testable under node:test; the real
 * assembly is `standalone-transcript-lane-wiring.ts`.
 */
import type { TranscriptSessionView, TranscriptWorkerHostHandle } from '@adhdev/web-core/transcript-transport'

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
 *
 * ★ LAST RESORT only. The primary path is the daemon's
 * `transcript_topics_available` push (`handleTopicsAvailable`), which re-SUBs
 * the moment a session's topic becomes grantable. The retry exists for a lost
 * push / an older daemon, so it starts short (the old 3 s first step alone was
 * a visible blank pane) and still backs off to stay cheap for a session whose
 * topic has rows but no verifiable commit.
 */
export const SUB_RETRY_INITIAL_MS = 1_000
export const SUB_RETRY_MAX_MS = 60_000

export function buildStandaloneSeqscribeWsUrl(
    location: { readonly protocol: string; readonly host: string },
    token: string | null,
): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const base = `${proto}://${location.host}${STANDALONE_SEQSCRIBE_WS_PATH}`
    return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * Commands the session chat controller sends on the `/ws` JSON lane
 * (`sendData`). Fire-and-forget and content-free:
 *   - `request_transcript_base` — ask the daemon for one keyed base frame
 *     (design 2026-09-28 §5.2, `SessionChatController.requestTranscriptBase`):
 *     the worker's folder kept rejecting a session's commits, the session has
 *     not delivered a view yet (its topic may not be defined since a daemon
 *     restart), or the status lane contradicts the last committed view.
 *     Carries only the raw session id.
 */
export const STANDALONE_WS_DATA_COMMANDS: readonly string[] = ['request_transcript_base']

/**
 * What `sendDataViaWs` may put on the `/ws` JSON lane: topic
 * subscribe/unsubscribe, plus exactly the `STANDALONE_WS_DATA_COMMANDS`.
 */
export function isStandaloneWsDataFrame(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false
    const frame = data as { type?: unknown; commandType?: unknown }
    if (frame.type === 'subscribe' || frame.type === 'unsubscribe') return true
    return frame.type === 'command'
        && typeof frame.commandType === 'string'
        && STANDALONE_WS_DATA_COMMANDS.includes(frame.commandType)
}

/**
 * Page-wide feed of the daemon's `transcript_topics_available` frames. The
 * frame arrives on the `/ws` JSON lane (StandaloneDaemonContext parses it with
 * web-core `parseTranscriptTopicsAvailable`), while its consumer is this lane
 * — a different socket — so the two meet here rather than threading the
 * lane client through the context.
 */
const topicsAvailableListeners = new Set<(topics: readonly string[]) => void>()

export function publishStandaloneTranscriptTopicsAvailable(topics: readonly string[]): void {
    if (topics.length === 0) return
    for (const listener of [...topicsAvailableListeners]) {
        try { listener(topics) } catch { /* one consumer must not starve the others */ }
    }
}

export function subscribeStandaloneTranscriptTopicsAvailable(listener: (topics: readonly string[]) => void): () => void {
    topicsAvailableListeners.add(listener)
    return () => { topicsAvailableListeners.delete(listener) }
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
        onView: (update: TranscriptSessionView) => void,
        onBaseRequest: (sessionId: string) => void,
    ): TranscriptWorkerHostHandle | null
    /** web-core `collectRetainedTranscriptSessionInterest`. */
    collectInterest(): Map<string, string[]>
    /** web-core `subscribeTranscriptSessionInterest`. */
    subscribeInterest(listener: () => void): () => void
    /** web-core `applyTranscriptViewToControllers`. */
    applyView(daemonId: string, sessionId: string, view: TranscriptSessionView['view']): number
    /** web-core `requestTranscriptBaseForSession`. */
    requestBase(daemonId: string, sessionId: string): boolean
    /**
     * The daemon's `transcript_topics_available` feed (newly SUB-able chat
     * topics, off the `/ws` JSON lane). Optional: without it the lane falls
     * back to the retry timer alone.
     */
    subscribeTopicsAvailable?(listener: (topics: readonly string[]) => void): () => void
    /**
     * web-core `sessionsToResubscribeOnAvailable` — which active, undelivered
     * sessions a set of newly available topics unblocks.
     */
    selectResubscribe?(
        activeSessionIds: readonly string[],
        delivered: { has(sessionId: string): boolean },
        topics: readonly string[],
    ): string[]
    /** `purpose` is diagnostic only (tests tell the two timers apart by it). */
    setTimer(cb: () => void, ms: number, purpose: 'reconnect' | 'sub-retry'): unknown
    clearTimer(handle: unknown): void
    now(): number
    log?(message: string): void
    /**
     * Override of the last-resort re-SUB schedule (`SUB_RETRY_INITIAL_MS` /
     * `SUB_RETRY_MAX_MS`). Tests only — the first-paint measurement replays the
     * pre-push schedule through the same client to report before/after.
     */
    subRetrySchedule?: { readonly initialMs: number; readonly maxMs: number }
}

export class StandaloneTranscriptLaneClient {
    private socket: LaneSocket | null = null
    private host: TranscriptWorkerHostHandle | null = null
    private openedAt: number | null = null
    private reconnectTimer: unknown = null
    private reconnectDelay = LANE_RECONNECT_INITIAL_MS
    private unsubscribeInterest: (() => void) | null = null
    private unsubscribeTopicsAvailable: (() => void) | null = null
    /** sessionId → daemonIds that are reading it (retained controllers). */
    private sessionDaemons = new Map<string, string[]>()
    private activeSessions: string[] = []
    /** Sessions that delivered at least one verified view on the CURRENT host. */
    private delivered = new Set<string>()
    private subRetryTimer: unknown = null
    private subRetryDelay: number
    private readonly subRetryInitialMs: number
    private readonly subRetryMaxMs: number
    private started = false
    private stopped = false

    constructor(private readonly deps: StandaloneTranscriptLaneDeps) {
        this.subRetryInitialMs = deps.subRetrySchedule?.initialMs ?? SUB_RETRY_INITIAL_MS
        this.subRetryMaxMs = deps.subRetrySchedule?.maxMs ?? SUB_RETRY_MAX_MS
        this.subRetryDelay = this.subRetryInitialMs
    }

    start(): void {
        if (this.started || this.stopped) return
        this.started = true
        this.unsubscribeInterest = this.deps.subscribeInterest(() => this.syncInterest())
        this.unsubscribeTopicsAvailable = this.deps.subscribeTopicsAvailable?.((topics) => this.handleTopicsAvailable(topics)) ?? null
        this.syncInterest()
        this.connect()
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        this.unsubscribeInterest?.()
        this.unsubscribeInterest = null
        this.unsubscribeTopicsAvailable?.()
        this.unsubscribeTopicsAvailable = null
        if (this.reconnectTimer !== null) this.deps.clearTimer(this.reconnectTimer)
        this.reconnectTimer = null
        const socket = this.socket
        this.socket = null
        this.stopHost()
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
        this.stopHost()
        const host = this.deps.startHost(
            socket,
            (update) => this.deliver(update),
            (sessionId) => this.requestBase(sessionId),
        )
        if (!host) {
            // No Worker / OPFS in this browser: the lane can never carry a
            // replica here. Stop trying rather than reconnect-loop.
            this.deps.log?.('[Transcript] standalone lane: transcript worker unavailable — live chat cannot be shown')
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
        this.stopHost()
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

    private stopHost(): void {
        const host = this.host
        if (!host) return
        this.host = null
        this.delivered.clear()
        if (this.subRetryTimer !== null) this.deps.clearTimer(this.subRetryTimer)
        this.subRetryTimer = null
        host.stop()
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
     * library does not retry it. The daemon defines `session.<id>.chat`
     * lazily, on that session's first publish after (re)start, so a pane opened
     * on a brand-new session — or on any idle session right after a daemon
     * restart — would otherwise show nothing live until the lane happened to
     * reconnect. Each retry therefore first asks the daemon for one keyed base
     * frame per undelivered session (`request_transcript_base`), which makes it
     * (re)define and publish that session's topic. The grant does reach the lane once the topic appears
     * (daemon-side `onTopicActivated` → `updateGrants`); only the dead SUB
     * needs replacing.
     *
     * The worker's activation is absolute and idempotent, so the re-SUB is
     * "activate without the undelivered sessions, then with them" — which
     * closes and reopens exactly those subscriptions. Delivered sessions are
     * never touched. Doubling cadence capped at `SUB_RETRY_MAX_MS` keeps a
     * session whose topic has rows but no verifiable commit from costing
     * more than one SNAP a minute.
     */
    private armSubRetry(reset: boolean): void {
        if (reset) this.subRetryDelay = this.subRetryInitialMs
        if (!this.host || this.subRetryTimer !== null) return
        if (!this.activeSessions.some((id) => !this.delivered.has(id))) return
        const delay = this.subRetryDelay
        this.subRetryTimer = this.deps.setTimer(() => {
            this.subRetryTimer = null
            this.rearmUndelivered()
        }, delay, 'sub-retry')
    }

    /**
     * The daemon says these chat topics just became SUB-able. Any activated,
     * not-yet-delivered session among them had its SUB refused (or never got
     * one that could succeed) — re-SUB exactly those now. The grant is already
     * in place daemon-side when this frame is sent, so the new SUB is accepted.
     * No base request: a defined topic already holds (or is about to receive)
     * the session's committed frame.
     */
    private handleTopicsAvailable(topics: readonly string[]): void {
        const host = this.host
        if (!host || this.stopped || !this.deps.selectResubscribe) return
        const pending = this.deps.selectResubscribe(this.activeSessions, this.delivered, topics)
        if (pending.length === 0) return
        const unblocked = new Set(pending)
        host.activateSessions(this.activeSessions.filter((id) => !unblocked.has(id)))
        host.activateSessions(this.activeSessions)
    }

    private rearmUndelivered(): void {
        const host = this.host
        if (!host || this.stopped) return
        const pending = this.activeSessions.filter((id) => !this.delivered.has(id))
        if (pending.length === 0) return
        for (const sessionId of pending) this.requestBase(sessionId)
        host.activateSessions(this.activeSessions.filter((id) => this.delivered.has(id)))
        host.activateSessions(this.activeSessions)
        this.subRetryDelay = Math.min(this.subRetryDelay * 2, this.subRetryMaxMs)
        this.armSubRetry(false)
    }

    private deliver(update: TranscriptSessionView): void {
        const daemonIds = this.sessionDaemons.get(update.sessionId)
        if (!daemonIds) return
        this.delivered.add(update.sessionId)
        for (const daemonId of daemonIds) {
            this.deps.applyView(daemonId, update.sessionId, update.view)
        }
    }

    /** One base-frame request per session — the request is per session, not per reader. */
    private requestBase(sessionId: string): void {
        for (const daemonId of this.sessionDaemons.get(sessionId) ?? []) {
            if (this.deps.requestBase(daemonId, sessionId)) return
        }
    }
}
