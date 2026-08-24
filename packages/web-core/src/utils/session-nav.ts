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
 */

export interface SessionChatNavRequest {
    /** Daemon session id (registry/instance key). */
    sessionId: string
    /** Provider-side session id, when known — a secondary match key. */
    providerSessionId?: string
    /** Where the request came from — for logging/telemetry only. */
    source: string
}

type Listener = (request: SessionChatNavRequest) => void

const listeners = new Set<Listener>()

/** Fire an open-chat request. No-op (returns false) when nothing subscribed. */
export function requestOpenSessionChat(request: SessionChatNavRequest): boolean {
    if (listeners.size === 0) return false
    for (const listener of [...listeners]) {
        try {
            listener(request)
        } catch {
            /* one bad subscriber must not break the others */
        }
    }
    return true
}

/** Subscribe to open-chat requests. Returns the unsubscribe function. */
export function onOpenSessionChat(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
