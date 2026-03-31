import type { Dispatch, SetStateAction } from 'react'
import { isAcpConv, isCliConv, type ActiveConversation } from '../components/dashboard/types'
import type { Toast } from '../context/BaseDaemonContext'

export type DashboardToastSetter = Dispatch<SetStateAction<Toast[]>>

export function getProviderArgs(conv: ActiveConversation | undefined) {
    if (!conv) return {}

    const targetSessionId = conv.sessionId ? { targetSessionId: conv.sessionId } : {}
    if (isCliConv(conv) || isAcpConv(conv)) {
        return { ...targetSessionId, agentType: conv.agentType || conv.ideType }
    }
    if (conv.streamSource === 'agent-stream') {
        return { ...targetSessionId, agentType: conv.agentType }
    }
    return targetSessionId
}

export function getRouteTarget(conv: ActiveConversation | undefined) {
    if (!conv) return ''
    return conv.ideId || conv.daemonId || ''
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
