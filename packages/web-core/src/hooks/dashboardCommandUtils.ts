import { i18next } from '../i18n/config'
import type { Dispatch, SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { getConversationDaemonRouteId, getConversationProviderType } from '../components/dashboard/conversation-selectors'
import { isCliConv } from '../components/dashboard/types'
import type { Toast } from '../context/BaseDaemonContext'

export type DashboardToastSetter = Dispatch<SetStateAction<Toast[]>>

export function getProviderArgs(conv: ActiveConversation | undefined) {
    if (!conv) return {}

    const targetSessionId = conv.sessionId ? { targetSessionId: conv.sessionId } : {}
    if (conv.sessionId) {
        return targetSessionId
    }
    if (isCliConv(conv)) {
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

/** Short, non-wrapping placeholders for the chat input while a modal blocks sending (i18n keys). */
export const SEND_BLOCKED_APPROVAL_PLACEHOLDER = 'chatPane.sendBlocked.approvalPlaceholder'
export const SEND_BLOCKED_CHOICE_PLACEHOLDER = 'chatPane.sendBlocked.choicePlaceholder'

export function getConversationSendBlockMessage(
    conv: Pick<ActiveConversation, 'status' | 'modalButtons'> | undefined,
): string | null {
    if (!conv) return null
    if (Array.isArray(conv.modalButtons) && conv.modalButtons.length > 0) {
        if (conv.status === 'waiting_choice') {
            return i18next.t('chatPane.sendBlocked.choiceMessage', { ns: 'common' })
        }
        return i18next.t('chatPane.sendBlocked.approvalMessage', { ns: 'common' })
    }

    return null
}

export function getConversationSendBlockedPlaceholder(
    conv: Pick<ActiveConversation, 'status' | 'modalButtons'> | undefined,
): string | null {
    if (!getConversationSendBlockMessage(conv)) return null
    return i18next.t(conv?.status === 'waiting_choice' ? SEND_BLOCKED_CHOICE_PLACEHOLDER : SEND_BLOCKED_APPROVAL_PLACEHOLDER, { ns: 'common' })
}

export function getInlineSendFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || '')
    const normalized = message.toLowerCase()
    if (normalized.includes('awaiting confirmation')) {
        return 'Approve or reject the pending request above.'
    }
    if (normalized.includes('not ready')) {
        return 'Wait for the runtime to finish starting up before sending a message.'
    }
    if (normalized.includes('not running')) {
        return 'Runtime is not available right now.'
    }
    return message || 'Unable to send message right now.'
}
