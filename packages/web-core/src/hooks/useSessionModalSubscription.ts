import { useEffect, useRef, useState } from 'react'
import type { SessionModalUpdate } from '@adhdev/daemon-core'
import type { ActiveConversation } from '../components/dashboard/types'
import { webDebugStore } from '../debug/webDebugStore'
import { useTransport } from '../context/TransportContext'
import { subscriptionManager } from '../managers/SubscriptionManager'

export interface SessionModalState {
    status?: string
    modalMessage?: string
    modalButtons?: string[]
}

function getConversationDaemonId(conversation: ActiveConversation): string | null {
    return conversation.daemonId || (conversation.routeId.includes(':') ? conversation.routeId.split(':')[0] || null : conversation.routeId || null)
}

/**
 * STATUS-LANE-SELFHEAL: the status lane is push-only, so a single dropped
 * `session.modal` update strands the pane until unmount.
 *
 * The transcript lane (session-chat-tail-controller) already self-heals via
 * mount / visibilitychange / reconnect; this lane had NONE of those, which is
 * why a finished agent kept rendering "Agent generating…" indefinitely. That is
 * a defect on every platform — desktop merely hid it, because switching tabs
 * remounts often enough to paper over a lost push.
 *
 * ★ Re-SUBSCRIBE rather than poll. `SubscriptionManager.resubscribeForDaemon`
 * re-sends the stored subscribe request, and the daemon answers a subscribe
 * with the current state — so recovery is a replay of the existing contract,
 * not a new one.
 *
 * ★ NO TIMERS, deliberately. iOS suspends background timers unpredictably, so a
 * watchdog interval is exactly the mechanism that cannot be relied on for the
 * case this fixes (returning to a backgrounded PWA). Every trigger below is an
 * edge the browser guarantees to deliver on resume:
 *   - `visibilitychange`→visible — tab/app foregrounded
 *   - `pageshow` with `persisted` — BFCache restore, which fires INSTEAD of
 *     visibilitychange on iOS app-switch return. Before this, `useShellFreshness`
 *     was the only listener for it in the entire repo, leaving both data lanes
 *     blind to the single most common iOS resume path.
 *   - transport reconnect edge — a dropped P2P/WS connection loses the
 *     server-side subscription, so the daemon must be told again.
 */
export function useSessionModalSubscription(activeConv: ActiveConversation): SessionModalState {
    const { sendData, isConnected } = useTransport()
    const [state, setState] = useState<SessionModalState>({})
    // Held so the recovery effect can re-send the subscribe request without
    // tearing down and rebuilding the handler registration.
    const resyncRef = useRef<(() => void) | null>(null)

    useEffect(() => {
        const daemonId = getConversationDaemonId(activeConv)
        if (!daemonId || !activeConv.sessionId || !sendData) {
            setState({})
            return
        }
        const unsubscribe = subscriptionManager.subscribe(
            { sendData },
            daemonId,
            {
                type: 'subscribe',
                topic: 'session.modal',
                key: `daemon:${daemonId}:session-modal:${activeConv.sessionId}`,
                params: {
                    targetSessionId: activeConv.sessionId,
                },
            },
            (update: SessionModalUpdate) => {
                setState({
                    status: update.status,
                    modalMessage: update.modalMessage,
                    modalButtons: update.modalButtons,
                })
                webDebugStore.record({
                    interactionId: update.interactionId,
                    kind: 'dashboard.session_modal_applied',
                    topic: 'session.modal',
                    payload: {
                        sessionId: activeConv.sessionId,
                        status: update.status,
                        modalButtonCount: Array.isArray(update.modalButtons) ? update.modalButtons.length : 0,
                    },
                })
            },
        )
        if (!unsubscribe.initialSendAccepted) {
            setState({})
        }
        // Re-send the stored subscribe request for this daemon. Cheap and
        // idempotent: the manager keeps one entry per (topic, key), so this
        // re-arms the daemon side without duplicating handlers or state.
        resyncRef.current = () => {
            subscriptionManager.resubscribeForDaemon(daemonId, { sendData })
            webDebugStore.record({
                kind: 'dashboard.session_modal_resync',
                topic: 'session.modal',
                payload: { sessionId: activeConv.sessionId },
            })
        }
        return () => {
            resyncRef.current = null
            unsubscribe()
        }
    }, [activeConv.daemonId, activeConv.routeId, activeConv.sessionId, sendData])

    // Event-driven recovery. Split from the subscribe effect so re-arming never
    // tears the subscription down — a teardown would drop the last known state
    // and flash empty before the daemon answers.
    useEffect(() => {
        const daemonId = getConversationDaemonId(activeConv)
        if (!daemonId || !activeConv.sessionId || !sendData) return

        const resync = () => resyncRef.current?.()

        const onVisible = () => {
            if (typeof document === 'undefined') return
            if (document.visibilityState === 'visible') resync()
        }
        // BFCache restore. Only `persisted` matters: a normal load already
        // subscribed via the effect above, so re-arming there would be a
        // redundant send on every navigation.
        const onPageShow = (event: PageTransitionEvent) => {
            if (event.persisted) resync()
        }

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisible)
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('pageshow', onPageShow)
        }

        // Reconnect edge. `isConnected` is a synchronous boolean read with no
        // event of its own, so this samples it on the visibility edges we
        // already receive rather than introducing a timer — a reconnect that
        // happens while the tab is hidden is recovered by the visible edge that
        // follows it, which is the only moment the stale UI is observable.
        let lastConnected = isConnected ? isConnected(daemonId) : true
        const onMaybeReconnected = () => {
            if (!isConnected) return
            const connectedNow = isConnected(daemonId)
            if (connectedNow && !lastConnected) resync()
            lastConnected = connectedNow
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onMaybeReconnected)
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('online', onMaybeReconnected)
        }

        return () => {
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisible)
                document.removeEventListener('visibilitychange', onMaybeReconnected)
            }
            if (typeof window !== 'undefined') {
                window.removeEventListener('pageshow', onPageShow)
                window.removeEventListener('online', onMaybeReconnected)
            }
        }
    }, [activeConv.daemonId, activeConv.routeId, activeConv.sessionId, sendData, isConnected])

    return state
}
