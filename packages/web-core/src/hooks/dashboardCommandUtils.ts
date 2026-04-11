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
