import type { Dispatch, SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { getConversationDaemonRouteId, getConversationProviderType } from '../components/dashboard/conversation-selectors'
import { isAcpConv, isCliConv } from '../components/dashboard/types'
import type { Toast } from '../context/BaseDaemonContext'

export type DashboardToastSetter = Dispatch<SetStateAction<Toast[]>>

export function getProviderArgs(conv: ActiveConversation | undefined) {
    if (!conv) return {}

    const targetSessionId = conv.sessionId ? { targetSessionId: conv.sessionId } : {}
    if (conv.sessionId) {
        return targetSessionId
    }
    if (isCliConv(conv) || isAcpConv(conv)) {
        return { agentType: getConversationProviderType(conv) }
    }
    if (conv.streamSource === 'agent-stream') {
        return { agentType: getConversationProviderType(conv) }
    }
    return targetSessionId
}

export function getRouteTarget(conv: ActiveConversation | undefined) {
    if (!conv) return ''
    return getConversationDaemonRouteId(conv)
}

export function appendWarningToast(
    setToasts: DashboardToastSetter,
    message: string,
) {
    setToasts(prev => [...prev, {
        id: Date.now(),
        message,
        type: 'warning',
        timestamp: Date.now(),
    }])
}

export function getConversationSendBlockMessage(
    conv: Pick<ActiveConversation, 'status' | 'modalButtons'> | undefined,
): string | null {
    if (!conv) return null
    if (Array.isArray(conv.modalButtons) && conv.modalButtons.length > 0) {
        return 'Resolve the pending approval prompt before sending another message.'
    }

    switch (conv.status) {
        case 'waiting_approval':
        case 'waiting_for_user_input':
            return 'Resolve the pending approval prompt before sending another message.'
        default:
            return null
    }
}

export function getInlineSendFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || '')
    const normalized = message.toLowerCase()
    if (normalized.includes('still processing the previous prompt')) {
        return 'Wait for the current reply to finish before sending another message.'
    }
    if (normalized.includes('awaiting confirmation')) {
        return 'Resolve the pending approval prompt before sending another message.'
    }
    if (normalized.includes('not ready')) {
        return 'Wait for the runtime to finish starting up before sending a message.'
    }
    if (normalized.includes('not running')) {
        return 'Runtime is not available right now.'
    }
    return message || 'Unable to send message right now.'
}
