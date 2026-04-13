import { useEffect, useState } from 'react'
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

export function useSessionModalSubscription(activeConv: ActiveConversation): SessionModalState {
    const { sendData } = useTransport()
    const [state, setState] = useState<SessionModalState>({})

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
        return () => {
            unsubscribe()
        }
    }, [activeConv.daemonId, activeConv.routeId, activeConv.sessionId, sendData])

    return state
}
