/**
 * session-nav — a tiny cross-surface bus for "open this session's chat tab".
 *
 * Several observation surfaces (SessionInfoDialog's coordinator jump, the mesh
 * dialog's session detail modal, the topology tab's session chips) want to
 * activate an existing chat tab, but they render deep inside dialogs with no
 * path to the dockview activation handlers that live in DashboardMainView.
 * Threading a callback down through every dialog prop chain would touch a
 * dozen components for one function — this bus is the deliberate shortcut:
 * emitters fire a request, DashboardMainView (the one place that can resolve a
 * sessionId to a conversation tab and activate it) subscribes.
 *
 * The subscriber owns the miss behaviour (e.g. a toast when the session lives
 * on another machine and has no local chat tab) — the emitter never needs to
 * know whether navigation succeeded.
 *
 * Off the dashboard (e.g. the /mesh page) nothing is subscribed. A surface that
 * can route registers a navigator (`registerSessionChatNavigator`): the request
 * is then held, the navigator moves to the dashboard, and the request is
 * replayed once DashboardMainView subscribes. While the replay window is open a
 * miss is retried quietly (the dashboard may still be mounting its tabs); the
 * last attempt at the deadline is delivered normally so the subscriber's own
 * `chatNotFound` toast answers a genuine miss. With neither a subscriber nor a
 * navigator the request cannot go anywhere, and a toast says so.
 */
import { i18next } from '../i18n/config'
import { eventManager } from '../managers/EventManager'

export interface SessionChatNavRequest {
    /** Daemon session id (registry/instance key). */
    sessionId: string
    /** Provider-side session id, when known — a secondary match key. */
    providerSessionId?: string
    /** Where the request came from — for logging/telemetry only. */
    source: string
    /**
     * Set by the bus on a replay attempt that is not the last one: a miss must
     * stay quiet (no toast) so the bus can retry once the dashboard has mounted.
     */
    deferMiss?: boolean
}

/**
 * What the subscriber did with a request. `not_found` (no tab for the session)
 * lets the bus retry a replay; `void` is treated as handled.
 */
export type SessionChatNavOutcome = 'opened' | 'not_found' | void

type Listener = (request: SessionChatNavRequest) => SessionChatNavOutcome

/** Moves the app to a surface that subscribes (the dashboard route). */
export type SessionChatNavigator = () => void

/** How long a request held across a navigation may wait for its subscriber. */
export const SESSION_CHAT_REPLAY_WINDOW_MS = 5_000
/** Quiet retry cadence while a replayed request has not found its tab yet. */
export const SESSION_CHAT_REPLAY_RETRY_MS = 250

const listeners = new Set<Listener>()
const navigators: SessionChatNavigator[] = []

interface PendingReplay {
    request: SessionChatNavRequest
    deadline: number
    retryTimer: ReturnType<typeof setTimeout> | null
    deadlineTimer: ReturnType<typeof setTimeout> | null
}

let pending: PendingReplay | null = null

function deliver(request: SessionChatNavRequest): SessionChatNavOutcome {
    let outcome: SessionChatNavOutcome
    for (const listener of [...listeners]) {
        try {
            const result = listener(request)
            if (result === 'opened' || outcome === undefined) outcome = result
        } catch {
            /* one bad subscriber must not break the others */
        }
    }
    return outcome
}

function clearPending(): void {
    if (!pending) return
    if (pending.retryTimer) clearTimeout(pending.retryTimer)
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer)
    pending = null
}

function showUnavailableToast(): void {
    eventManager.showToast(i18next.t('sessionNav.openChatUnavailable'), 'info')
}

/** Last attempt at the deadline: a normal delivery, so a miss toasts. */
function finishReplay(): void {
    const held = pending
    if (!held) return
    clearPending()
    if (listeners.size === 0) {
        showUnavailableToast()
        return
    }
    deliver({ ...held.request, deferMiss: false })
}

/** A quiet replay attempt; schedules the next one while the tab is still missing. */
function attemptReplay(): void {
    const held = pending
    if (!held) return
    if (held.retryTimer) {
        clearTimeout(held.retryTimer)
        held.retryTimer = null
    }
    // No subscriber right now (it is re-subscribing): the next subscribe re-arms.
    if (listeners.size === 0) return
    if (Date.now() >= held.deadline) {
        finishReplay()
        return
    }
    const outcome = deliver({ ...held.request, deferMiss: true })
    if (pending !== held) return
    if (outcome !== 'not_found') {
        clearPending()
        return
    }
    held.retryTimer = setTimeout(attemptReplay, SESSION_CHAT_REPLAY_RETRY_MS)
}

/**
 * Fire an open-chat request. Returns true when it was delivered to a
 * subscriber or held for replay behind a navigation; false (after a toast)
 * when nothing on this surface can open a chat.
 */
export function requestOpenSessionChat(request: SessionChatNavRequest): boolean {
    const clean: SessionChatNavRequest = { ...request }
    delete clean.deferMiss
    if (listeners.size > 0) {
        clearPending()
        deliver(clean)
        return true
    }
    const navigator = navigators[navigators.length - 1]
    if (!navigator) {
        showUnavailableToast()
        return false
    }
    clearPending()
    const held: PendingReplay = {
        request: clean,
        deadline: Date.now() + SESSION_CHAT_REPLAY_WINDOW_MS,
        retryTimer: null,
        deadlineTimer: null,
    }
    held.deadlineTimer = setTimeout(finishReplay, SESSION_CHAT_REPLAY_WINDOW_MS)
    pending = held
    try {
        navigator()
    } catch {
        clearPending()
        showUnavailableToast()
        return false
    }
    return true
}

/** Subscribe to open-chat requests. Returns the unsubscribe function. */
export function onOpenSessionChat(listener: Listener): () => void {
    listeners.add(listener)
    // A request held across a navigation: replay it to the new subscriber.
    // Deferred so the subscribing component finishes committing first.
    if (pending && !pending.retryTimer) {
        pending.retryTimer = setTimeout(attemptReplay, 0)
    }
    return () => { listeners.delete(listener) }
}

/**
 * Register the way to reach the dashboard from a surface with no subscriber.
 * The most recent registration wins. Returns the unregister function.
 */
export function registerSessionChatNavigator(navigator: SessionChatNavigator): () => void {
    navigators.push(navigator)
    return () => {
        const index = navigators.lastIndexOf(navigator)
        if (index >= 0) navigators.splice(index, 1)
    }
}

/** Test helper: drop subscribers, navigators and any held request. */
export function resetSessionChatNavForTests(): void {
    clearPending()
    listeners.clear()
    navigators.length = 0
}
