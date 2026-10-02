/**
 * Session chat controller — the chat pane's (desktop and mobile, cloud and
 * standalone) single source of live transcript content.
 *
 * ── One lane ───────────────────────────────────────────────────────────────
 * Live chat reaches the dashboard ONLY through the keyed seqscribe lane
 * `session.<id>.chat` (design docs/design/2026-09-28-transcript-message-keyed-
 * storage.md §5.4, §6.4): transcript worker → `TranscriptViewMirror` →
 * `applyTranscriptViewToControllers` → this controller. There is no second
 * push lane, no read_chat re-pull merged into the live window, no fallback and
 * no transition switch. Each view is a verified commit of the producer's full
 * live set, so it is applied as-is — last committed frame wins, and bubbles
 * whose `(messageId, rev)` did not move keep their object identity
 * (`TranscriptBubbleCache`), so unchanged rows never remount.
 *
 * ── Older history ──────────────────────────────────────────────────────────
 * The keyed view holds the whole live transcript up to the producer's 16 MiB
 * cap. When it does not reach the start of the conversation (a window source,
 * or bubbles tombstoned by the cap), the view says so (`coverage.omittedBefore`)
 * and "Load older messages" becomes available: it is an explicit, user-driven
 * one-shot `chat_history` page (`loadHistoryPage`), never a live lane. Pages
 * accumulate in `historyMessages`, strictly older than the live window.
 *
 * ── Registry ───────────────────────────────────────────────────────────────
 * Controllers are shared through a module-level registry keyed by
 * `daemonId::sessionId::historySessionId`, refcounted by `retain`/`release`.
 * The RETAINED set is the transcript session interest (which chat topics the
 * daemon grants and the worker subscribes to), so "what we asked the daemon to
 * replicate" and "what we can deliver to" are one derivation.
 */
import type { ReplicatedTranscriptViewV2 } from '@adhdev/daemon-core/seqscribe/transcript-keyed-codec'
import type { ActiveConversation, DashboardMessage } from './types'
import {
    TranscriptBubbleCache,
    isMappableTranscriptView,
    mapTranscriptViewToChatView,
    type TranscriptChatView,
} from './transcript-chat-pane-adapter'
import { getConversationHistorySessionIdForRead } from './conversation-identity'
import { getConversationDaemonRouteId } from './conversation-selectors'
import {
    WARM_SESSION_CHAT_ACTIVE_STATUSES,
    isBusyChatStatus,
    isTerminalChatStatusEvent,
} from './chat-status-classification'

export { isTerminalChatStatusEvent }

export interface SessionChatSnapshot {
    /** The committed keyed view's bubbles, `ord` order. Empty until the first view. */
    liveMessages: DashboardMessage[]
    /** A committed view has been applied (or the pane was explicitly cleared). */
    hasLiveSnapshot: boolean
    /** Explicitly loaded `chat_history` pages, oldest first, all older than `liveMessages`. */
    historyMessages: DashboardMessage[]
    historyOffset: number
    /**
     * Whether "Load older messages" can reach anything. Before the first view it
     * is unknown and reads true; once a view applied (and before any history
     * page loaded) it is the view's `omittedBefore`; after a page it is that
     * page's `hasMore`.
     */
    hasMoreHistory: boolean
    historyError: string | null
    /** The keyed view does not reach the start of the conversation (`coverage.omittedBefore`). */
    omittedBefore: boolean
}

export interface SessionChatHistoryPageRequest {
    offset: number
    excludeRecentCount: number
    /**
     * (SEAM) Identity of the OLDEST message in the live window — the boundary
     * history must page strictly older than. Empty string when that message
     * carries no identity the daemon's history resolver understands (keyed
     * bubbles carry only `messageId`); the daemon then uses `excludeRecentCount`.
     */
    excludeFromIdentity: string
}

/**
 * (SEAM) The identity string the daemon resolves a history boundary against.
 *
 * ★ This MUST stay byte-identical to `buildHistoryMessageIdentity` in
 * daemon-core's `config/chat-history.ts` — same preference order, same prefixes.
 * `_turnKey` is deliberately NOT a candidate: it is turn-grained, so it would
 * resolve the boundary to an arbitrary bubble within the turn.
 */
export function buildHistoryBoundaryIdentity(message?: DashboardMessage): string {
    if (!message) return ''
    const record = message as DashboardMessage & {
        providerUnitKey?: string
        bubbleId?: string
        sequence?: number
    }
    if (record.providerUnitKey) return `unit:${record.providerUnitKey}`
    if (record.bubbleId) return `bubble:${record.bubbleId}`
    if (typeof record.sequence === 'number' && Number.isFinite(record.sequence)) {
        return `seq:${record.sequence}`
    }
    return ''
}

export interface SessionChatControllerOptions {
    /** Command lane to the owning daemon (P2P on cloud, `/ws` on standalone) — used for `request_transcript_base` only. */
    sendData?: (daemonId: string, data: any) => boolean
    daemonId: string
    sessionId: string
    /** Part of the registry key only (`getControllerKey`); the keyed view is session-scoped. */
    historySessionId?: string
    /** Status-meta message count, the history boundary before the first view lands. */
    fallbackRecentCount?: number
    /** Injectable clock (tests). */
    now?: () => number
}

export interface SessionChatControllerHandle extends SessionChatSnapshot {
    loadHistoryPage: () => Promise<void>
}

export interface WarmSessionChatDescriptor {
    daemonId: string
    sessionId: string
    // Read-safe: a REAL distinct provider conv id, or undefined for a coordinator
    // whose providerSessionId isn't surfaced (never the runtime sessionId — that
    // is the read poison).
    historySessionId?: string
}

/**
 * Upper bound on retained history messages from "Load older" paging. The most
 * recent N retained rows (nearest the live window, the array tail) are kept;
 * `historyOffset` still advances by the full fetched page so the next request
 * stays aligned.
 */
const DEFAULT_MAX_RETAINED_HISTORY_MESSAGES = 500
/**
 * Minimum spacing between two `request_transcript_base` sends from one
 * controller on the status-lane contradiction path (see `noteTerminalStatusEvent`).
 */
const TERMINAL_BASE_REQUEST_MIN_INTERVAL_MS = 15_000
export const DEFAULT_WARM_SESSION_CHAT_RECENT_ACTIVITY_MS = 120_000

export const controllerRegistry = new Map<string, SessionChatController>()

// Bumped whenever a controller is added / retained / released, so reactive
// consumers (session interest, useWarmSessionChatSnapshotVersion) re-derive.
let controllerRegistryGeneration = 0
const controllerRegistryListeners = new Set<() => void>()

function notifyControllerRegistryChanged(): void {
    controllerRegistryGeneration += 1
    for (const listener of controllerRegistryListeners) listener()
}

let controllerRegistryNotifyQueued = false

/**
 * Controller CREATION happens inside ChatPane's render-time useMemo; notifying
 * synchronously there made every useSyncExternalStore subscriber (the mobile
 * chat list) update while ChatPane was rendering — React's "Cannot update a
 * component while rendering a different component". Creation notifies on a
 * microtask instead (coalesced); retain/release run in effects and stay sync.
 */
function notifyControllerRegistryChangedDeferred(): void {
    if (controllerRegistryNotifyQueued) return
    controllerRegistryNotifyQueued = true
    queueMicrotask(() => {
        controllerRegistryNotifyQueued = false
        notifyControllerRegistryChanged()
    })
}

export function subscribeControllerRegistry(listener: () => void): () => void {
    controllerRegistryListeners.add(listener)
    return () => {
        controllerRegistryListeners.delete(listener)
    }
}

export function getControllerRegistryGeneration(): number {
    return controllerRegistryGeneration
}

export function getControllerKey(daemonId: string, sessionId: string, historySessionId?: string): string {
    return `${daemonId}::${sessionId}::${historySessionId || sessionId}`
}

export function buildEmptySnapshot(): SessionChatSnapshot {
    return {
        liveMessages: [],
        hasLiveSnapshot: false,
        historyMessages: [],
        historyOffset: 0,
        hasMoreHistory: true,
        historyError: null,
        omittedBefore: false,
    }
}

/** Same rows, same order, reference-equal — the keyed lane's rev-based change test. */
function sameMessageObjects(current: readonly DashboardMessage[], next: readonly DashboardMessage[]): boolean {
    if (current.length !== next.length) return false
    for (let i = 0; i < current.length; i += 1) {
        if (current[i] !== next[i]) return false
    }
    return true
}

export class SessionChatController {
    private sendData?: (daemonId: string, data: any) => boolean
    private readonly daemonId: string
    private readonly sessionId: string
    private fallbackRecentCount: number
    private now: () => number
    private snapshot: SessionChatSnapshot = buildEmptySnapshot()
    private listeners = new Set<(snapshot: SessionChatSnapshot) => void>()
    private retainCount = 0
    private loadHistoryPromise: Promise<void> | null = null
    /** Bubble-identity cache for direct `applyTranscriptView` callers. */
    private readonly bubbleCache = new TranscriptBubbleCache()
    /** Status of the last applied view — the lane's own claim about the session. */
    private lastViewStatus: string | null = null
    private lastTerminalBaseRequestAt = 0

    constructor(options: SessionChatControllerOptions) {
        this.sendData = options.sendData
        this.daemonId = options.daemonId
        this.sessionId = options.sessionId
        this.fallbackRecentCount = Math.max(0, options.fallbackRecentCount ?? 0)
        this.now = options.now ?? (() => Date.now())
    }

    updateOptions(options: Partial<SessionChatControllerOptions>): void {
        if (options.sendData) this.sendData = options.sendData
        if (options.now) this.now = options.now
        if (options.fallbackRecentCount !== undefined) {
            this.fallbackRecentCount = Math.max(0, options.fallbackRecentCount)
        }
    }

    getSnapshot(): SessionChatSnapshot {
        return this.snapshot
    }

    /**
     * Blank the live window (new chat / reset). The next committed view
     * repopulates it; until then the pane shows an empty conversation rather
     * than the stale status-meta list.
     */
    clearLiveSnapshot(): void {
        this.snapshot = {
            ...buildEmptySnapshot(),
            hasLiveSnapshot: true,
        }
        this.emit()
    }

    /**
     * Apply one verified committed keyed view (design 2026-09-28 §5.4).
     *
     * A view missing a required field is refused (not mapped best-effort) —
     * `isMappableTranscriptView`. It does not throw: this runs inside a
     * MessagePort `onmessage` handler with no catch above it.
     */
    applyTranscriptView(
        view: ReplicatedTranscriptViewV2,
        options: { mapped?: TranscriptChatView } = {},
    ): void {
        if (!isMappableTranscriptView(view)) return
        const mapped = options.mapped ?? mapTranscriptViewToChatView(view, { cache: this.bubbleCache })
        this.lastViewStatus = mapped.status
        const current = this.snapshot
        // Once the user paged history, the history lane's own `hasMore` owns the
        // affordance; before that, the view's coverage does.
        const hasMoreHistory = current.historyOffset > 0 ? current.hasMoreHistory : mapped.omittedBefore
        if (
            current.hasLiveSnapshot
            && sameMessageObjects(current.liveMessages, mapped.messages)
            && current.omittedBefore === mapped.omittedBefore
            && current.hasMoreHistory === hasMoreHistory
        ) return
        this.snapshot = {
            ...current,
            liveMessages: mapped.messages,
            hasLiveSnapshot: true,
            omittedBefore: mapped.omittedBefore,
            hasMoreHistory,
        }
        this.emit()
    }

    subscribe(listener: (snapshot: SessionChatSnapshot) => void): () => void {
        this.listeners.add(listener)
        listener(this.snapshot)
        return () => {
            this.listeners.delete(listener)
        }
    }

    retain(): void {
        this.retainCount += 1
        // 0 → 1 is the edge where this session becomes READ, which is exactly
        // when transcript interest must widen to include it.
        if (this.retainCount === 1) notifyControllerRegistryChanged()
    }

    release(): void {
        const wasRetained = this.retainCount > 0
        this.retainCount = Math.max(0, this.retainCount - 1)
        // The 1 → 0 edge NARROWS transcript interest.
        if (wasRetained && this.retainCount === 0) notifyControllerRegistryChanged()
    }

    /**
     * Is some mounted consumer currently reading this controller? The registry is
     * append-only, so membership records every session opened this page load;
     * retention is the least-privilege filter for transcript session interest.
     */
    isRetained(): boolean {
        return this.retainCount > 0
    }

    /**
     * The routing pair this controller reads. Deliberately omits
     * `historySessionId`: the session-interest wire contract is a set of SESSION
     * ids, and two controllers for one session (pane + warm inbox) collapse to one.
     */
    getIdentity(): { daemonId: string; sessionId: string } {
        return { daemonId: this.daemonId, sessionId: this.sessionId }
    }

    /**
     * Load one page of history OLDER than the live window — an explicit user
     * action ("Load older messages"), served by the daemon's `chat_history`.
     */
    async loadHistoryPage(loader: (request: SessionChatHistoryPageRequest) => Promise<{ messages?: DashboardMessage[]; hasMore?: boolean }>): Promise<void> {
        if (this.loadHistoryPromise) return this.loadHistoryPromise
        this.snapshot = { ...this.snapshot, historyError: null }
        this.emit()
        const run = (async () => {
            try {
                const hadLiveSnapshot = this.snapshot.hasLiveSnapshot
                const excludeRecentCount = hadLiveSnapshot
                    ? this.snapshot.liveMessages.length
                    : Math.max(this.snapshot.liveMessages.length, this.fallbackRecentCount)
                const result = await loader({
                    offset: this.snapshot.historyOffset,
                    excludeRecentCount,
                    excludeFromIdentity: buildHistoryBoundaryIdentity(this.snapshot.liveMessages[0]),
                })
                const nextMessages = Array.isArray(result.messages) ? result.messages : []
                const mergedHistory = [...nextMessages, ...this.snapshot.historyMessages]
                const cappedHistory = mergedHistory.length > DEFAULT_MAX_RETAINED_HISTORY_MESSAGES
                    ? mergedHistory.slice(mergedHistory.length - DEFAULT_MAX_RETAINED_HISTORY_MESSAGES)
                    : mergedHistory
                this.snapshot = {
                    ...this.snapshot,
                    historyMessages: cappedHistory,
                    historyOffset: this.snapshot.historyOffset + nextMessages.length,
                    hasMoreHistory: result.hasMore === true,
                    historyError: null,
                }
            } catch (error) {
                this.snapshot = {
                    ...this.snapshot,
                    historyError: error instanceof Error ? error.message : 'Failed to load history',
                }
            }
            this.emit()
        })().finally(() => {
            this.loadHistoryPromise = null
        })
        this.loadHistoryPromise = run
        return run
    }

    /**
     * Ask the owning daemon for one keyed base frame (`request_transcript_base`,
     * design 2026-09-28 §5.2). Rides the `sendData` command lane (P2P on cloud,
     * the local `/ws` on standalone) — never the server — and carries only the
     * raw session id. Also what makes the daemon (re)define a chat topic it has
     * not published since a restart, so a SUB for it can be granted.
     * Best-effort: false when there is no lane to send it on.
     */
    requestTranscriptBase(): boolean {
        if (!this.sendData || !this.daemonId || !this.sessionId) return false
        try {
            return this.sendData(this.daemonId, {
                type: 'command',
                commandType: 'request_transcript_base',
                data: { rawSessionId: this.sessionId },
            }) === true
        } catch {
            return false
        }
    }

    /**
     * A terminal status-lane event arrived for this session. The status lane and
     * the chat lane are independent; if the chat lane's last committed view still
     * says the agent is producing, the chat lane missed the settling frame, so ask
     * the owner for one base frame. Rate-limited per controller. This recovers
     * WITHIN the keyed lane — it never reads chat through another path.
     */
    noteTerminalStatusEvent(event: unknown): boolean {
        if (!isTerminalChatStatusEvent(event)) return false
        if (!this.isRetained() || !isBusyChatStatus(this.lastViewStatus)) return false
        const nowMs = this.now()
        if (this.lastTerminalBaseRequestAt > 0 && nowMs - this.lastTerminalBaseRequestAt < TERMINAL_BASE_REQUEST_MIN_INTERVAL_MS) return false
        this.lastTerminalBaseRequestAt = nowMs
        return this.requestTranscriptBase()
    }

    dispose(): void {
        this.listeners.clear()
        this.retainCount = 0
        this.loadHistoryPromise = null
        this.lastViewStatus = null
        this.lastTerminalBaseRequestAt = 0
    }

    private emit(): void {
        this.listeners.forEach((listener) => listener(this.snapshot))
    }
}

export function getOrCreateSessionChatController(options: SessionChatControllerOptions): SessionChatController {
    const key = getControllerKey(options.daemonId, options.sessionId, options.historySessionId)
    const existing = controllerRegistry.get(key)
    if (existing) {
        existing.updateOptions(options)
        return existing
    }
    const controller = new SessionChatController(options)
    controllerRegistry.set(key, controller)
    notifyControllerRegistryChangedDeferred()
    return controller
}

export function clearSessionChatControllerSnapshot(
    daemonId: string | undefined,
    sessionId: string | undefined,
    historySessionId?: string,
): void {
    if (!daemonId || !sessionId) return
    const prefix = `${daemonId}::${sessionId}::`
    const exactKey = getControllerKey(daemonId, sessionId, historySessionId)
    for (const [key, controller] of controllerRegistry.entries()) {
        if (key === exactKey || key.startsWith(prefix)) controller.clearLiveSnapshot()
    }
}

/**
 * Read the snapshot a warm controller ALREADY holds for a conversation, if any —
 * the mobile inbox builds its row preview from the same authority ChatPane
 * renders, without opening a second subscription. Undefined when nothing is
 * warm (callers fall back to `conversation.messages`).
 */
export function getSessionChatSnapshotForConversation(
    conversation: ActiveConversation,
): SessionChatSnapshot | undefined {
    const daemonId = getConversationDaemonRouteId(conversation)
    const sessionId = conversation.sessionId || ''
    if (!daemonId || !sessionId) return undefined
    const historySessionIdForRead = getConversationHistorySessionIdForRead(conversation)
    const key = getControllerKey(daemonId, sessionId, historySessionIdForRead || sessionId)
    const controller = controllerRegistry.get(key)
    if (!controller) return undefined
    const snapshot = controller.getSnapshot()
    return snapshot.hasLiveSnapshot ? snapshot : undefined
}

/**
 * Mapped-bubble caches for the fan-out, one per `(daemonId, sessionId)` — the
 * mapping is shared by every controller of that pair, so its identity-preserving
 * bubble cache is too. Dropped when a view reaches no controller.
 */
const fanOutBubbleCaches = new Map<string, TranscriptBubbleCache>()

/**
 * Deliver a verified keyed view to every controller for `(daemonId, sessionId)`.
 *
 * Prefix-matched because one session can have several controllers alive at once
 * — the pane's (keyed by `historySessionId`) and the mobile inbox's warm one —
 * and BOTH read the same transcript. Mapped ONCE for the whole fan-out.
 * Returns how many controllers were updated; 0 is normal (nobody is reading).
 */
export function applyTranscriptViewToControllers(
    daemonId: string,
    sessionId: string,
    view: ReplicatedTranscriptViewV2,
): number {
    if (!daemonId || !sessionId) return 0
    const prefix = `${daemonId}::${sessionId}::`
    let mapped: TranscriptChatView | undefined
    let applied = 0
    for (const [key, controller] of controllerRegistry.entries()) {
        if (!key.startsWith(prefix)) continue
        if (!mapped && isMappableTranscriptView(view)) {
            let cache = fanOutBubbleCaches.get(prefix)
            if (!cache) {
                cache = new TranscriptBubbleCache()
                fanOutBubbleCaches.set(prefix, cache)
            }
            mapped = mapTranscriptViewToChatView(view, { cache })
        }
        controller.applyTranscriptView(view, mapped ? { mapped } : {})
        applied += 1
    }
    if (applied === 0) fanOutBubbleCaches.delete(prefix)
    return applied
}

/**
 * Send one `request_transcript_base` for `(daemonId, sessionId)` through the
 * first controller that has a command lane. Per-session, not per-controller.
 */
export function requestTranscriptBaseForSession(daemonId: string, sessionId: string): boolean {
    if (!daemonId || !sessionId) return false
    const prefix = `${daemonId}::${sessionId}::`
    for (const [key, controller] of controllerRegistry.entries()) {
        if (!key.startsWith(prefix)) continue
        if (controller.requestTranscriptBase()) return true
    }
    return false
}

/**
 * Route a daemon status event to the controllers of that session. Non-terminal
 * events are dropped inside `noteTerminalStatusEvent`; at most one base request
 * is sent per session per event. Returns whether one was sent.
 */
export function noteTerminalStatusEventForControllers(
    daemonId: string,
    sessionId: string,
    event: unknown,
): boolean {
    if (!daemonId || !sessionId) return false
    if (!isTerminalChatStatusEvent(event)) return false
    const prefix = `${daemonId}::${sessionId}::`
    for (const [key, controller] of controllerRegistry.entries()) {
        if (!key.startsWith(prefix)) continue
        if (controller.noteTerminalStatusEvent(event)) return true
    }
    return false
}

/**
 * Which sessions, per daemon, are being READ right now — the transcript
 * session interest. Filtered on `isRetained()`, NOT registry membership (least
 * privilege, design §9 item 4). Values are deduped and sorted.
 */
export function collectRetainedTranscriptSessionInterest(): Map<string, string[]> {
    const byDaemon = new Map<string, Set<string>>()
    for (const controller of controllerRegistry.values()) {
        if (!controller.isRetained()) continue
        const { daemonId, sessionId } = controller.getIdentity()
        if (!daemonId || !sessionId) continue
        const existing = byDaemon.get(daemonId)
        if (existing) existing.add(sessionId)
        else byDaemon.set(daemonId, new Set([sessionId]))
    }
    const result = new Map<string, string[]>()
    for (const [daemonId, sessionIds] of byDaemon.entries()) {
        result.set(daemonId, [...sessionIds].sort())
    }
    return result
}

/** Fires on controller creation and on every retain/release edge (0↔1). */
export function subscribeTranscriptSessionInterest(listener: () => void): () => void {
    return subscribeControllerRegistry(listener)
}

export function resetSessionChatControllersForTest(): void {
    fanOutBubbleCaches.clear()
    for (const controller of controllerRegistry.values()) controller.dispose()
    controllerRegistry.clear()
}

export function buildControllerHandle(
    snapshot: SessionChatSnapshot,
    loadHistoryPage: SessionChatControllerHandle['loadHistoryPage'],
): SessionChatControllerHandle {
    return { ...snapshot, loadHistoryPage }
}

function compareWarmSessionChatDescriptors(
    left: WarmSessionChatDescriptor,
    right: WarmSessionChatDescriptor,
): number {
    return left.daemonId.localeCompare(right.daemonId)
        || left.sessionId.localeCompare(right.sessionId)
        || (left.historySessionId || '').localeCompare(right.historySessionId || '')
}

function shouldWarmSessionChatConversation(
    conversation: ActiveConversation,
    options: { now?: number; recentActivityMs?: number } = {},
): boolean {
    const status = String(conversation.status || '').trim().toLowerCase()
    if (WARM_SESSION_CHAT_ACTIVE_STATUSES.has(status)) return true
    if ((conversation.modalMessage || '').trim()) return true
    if (Array.isArray(conversation.modalButtons) && conversation.modalButtons.length > 0) return true

    const now = options.now ?? Date.now()
    const recentActivityMs = Math.max(0, Number(options.recentActivityMs ?? DEFAULT_WARM_SESSION_CHAT_RECENT_ACTIVITY_MS))
    const lastActivityAt = Math.max(
        Number(conversation.lastUpdated || 0),
        Number(conversation.lastMessageAt || 0),
    )
    if (lastActivityAt > 0) {
        return (now - lastActivityAt) <= recentActivityMs
    }

    return Array.isArray(conversation.messages) && conversation.messages.length > 0
}

export function getWarmSessionChatDescriptorRefreshMs(recentActivityMs = DEFAULT_WARM_SESSION_CHAT_RECENT_ACTIVITY_MS): number {
    return Math.max(1_000, Math.min(30_000, Math.max(0, Number(recentActivityMs || 0))))
}

export function buildWarmSessionChatDescriptorState(
    conversations: ActiveConversation[],
    options: { now?: number; recentActivityMs?: number } = {},
): { descriptors: WarmSessionChatDescriptor[]; signature: string } {
    const seen = new Set<string>()
    const descriptors: WarmSessionChatDescriptor[] = []
    for (const conversation of conversations) {
        if (!shouldWarmSessionChatConversation(conversation, options)) continue
        const daemonId = getConversationDaemonRouteId(conversation)
        const sessionId = conversation.sessionId || ''
        if (!daemonId || !sessionId) continue
        // Read-safe id (undefined for an agy coordinator); the dedup key still
        // uses the sessionId fallback so warm descriptors stay stable.
        const historySessionIdForRead = getConversationHistorySessionIdForRead(conversation)
        const key = getControllerKey(daemonId, sessionId, historySessionIdForRead || sessionId)
        if (seen.has(key)) continue
        seen.add(key)
        descriptors.push({ daemonId, sessionId, historySessionId: historySessionIdForRead })
    }
    descriptors.sort(compareWarmSessionChatDescriptors)
    return {
        descriptors,
        signature: descriptors
            .map((descriptor) => `${descriptor.daemonId}|${descriptor.sessionId}|${descriptor.historySessionId}`)
            .join('||'),
    }
}

// The React binding layer lives in `session-chat-hooks.ts` so this module stays
// a state controller with no React dependency; re-exported for one import path.
export {
    useSessionChatController,
    useWarmSessionChatControllers,
    useWarmSessionChatSnapshotVersion,
} from './session-chat-hooks'
