import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { getProviderArgs, getRouteTarget, getConversationSendBlockMessage, getInlineSendFailureMessage } from './dashboardCommandUtils'
import { getExplicitSessionRevealCommand } from '../components/dashboard/dashboardSessionCommands'

interface UseDashboardConversationCommandsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    activeConv: ActiveConversation | undefined
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
}

interface RecentSendAttempt {
    tabKey: string
    message: string
    timestamp: number
}

export function shouldBlockConversationSend({
    hasMessage,
    blockedMessage,
}: {
    hasMessage: boolean
    blockedMessage: string | null
    sendInFlight?: boolean
}): boolean {
    if (!hasMessage) return true
    return !!blockedMessage
}

export function shouldSuppressRecentDuplicateSend(
    lastSend: RecentSendAttempt | null | undefined,
    attempt: RecentSendAttempt,
    dedupeWindowMs = 2000,
): boolean {
    if (!lastSend) return false
    return lastSend.tabKey === attempt.tabKey
        && lastSend.message === attempt.message
        && (attempt.timestamp - lastSend.timestamp) < dedupeWindowMs
}

export function clearRecentSendOnFailure(
    lastSend: RecentSendAttempt | null | undefined,
    failedAttempt: RecentSendAttempt,
): RecentSendAttempt | null {
    if (!lastSend) return null
    return lastSend.tabKey === failedAttempt.tabKey
        && lastSend.message === failedAttempt.message
        && lastSend.timestamp === failedAttempt.timestamp
        ? null
        : lastSend
}

export function unwrapCommandResult(raw: any): any {
    if (!raw || typeof raw !== 'object') return raw
    if (raw.result && typeof raw.result === 'object') return raw.result
    return raw
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error || '')
}

function isExpectedActionResolutionError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase()
    return message.includes('button not found')
        || message.includes('not in approval state')
        || message.includes('command failed')
}

function getActionFailureText(buttonText: string, error?: unknown): string {
    const message = getErrorMessage(error)
    if (!message) return `⚠️ **${buttonText}** unavailable`
    if (message.toLowerCase().includes('button not found')) {
        return `⚠️ **${buttonText}** failed — button not found`
    }
    return `⚠️ **${buttonText}** failed — ${message}`
}

export function useDashboardConversationCommands({
    sendDaemonCommand,
    activeConv,
    setActionLogs,
    isStandalone: _isStandalone,
}: UseDashboardConversationCommandsOptions) {
    const [isFocusingAgent, setIsFocusingAgent] = useState(false)
    const [isSendingChat, setIsSendingChat] = useState(false)
    const [sendFeedbackMessage, setSendFeedbackMessage] = useState<string | null>(null)
    const sendInFlightRef = useRef(false)
    const lastSendRef = useRef<RecentSendAttempt | null>(null)

    useEffect(() => {
        setSendFeedbackMessage(null)
    }, [activeConv?.tabKey])

    const handleSendChat = useCallback(async (rawMessage: string): Promise<boolean> => {
        if (!activeConv) return false

        const message = rawMessage.trim()
        const blockedMessage = getConversationSendBlockMessage(activeConv)
        if (shouldBlockConversationSend({
            hasMessage: !!message,
            blockedMessage,
            sendInFlight: sendInFlightRef.current,
        })) {
            if (blockedMessage) setSendFeedbackMessage(blockedMessage)
            return false
        }

        const now = Date.now()
        const attempt: RecentSendAttempt = {
            tabKey: activeConv.tabKey,
            message,
            timestamp: now,
        }
        if (shouldSuppressRecentDuplicateSend(lastSendRef.current, attempt)) {
            setSendFeedbackMessage(null)
            return true
        }

        sendInFlightRef.current = true
        setIsSendingChat(true)
        setSendFeedbackMessage(null)
        lastSendRef.current = attempt

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) {
                lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
                setSendFeedbackMessage('Unable to send message right now.')
                return false
            }

            const raw = await sendDaemonCommand(routeTarget, 'send_chat', {
                message,
                ...getProviderArgs(activeConv),
            })
            const res = unwrapCommandResult(raw)

            if (res?.deduplicated) {
                setSendFeedbackMessage(null)
                return true
            }

            if (res?.sent === false) {
                throw new Error(res?.error || 'Send failed')
            }

            if (res?.success === false) {
                throw new Error(res?.error || 'Send failed')
            }

            setSendFeedbackMessage(null)
            return true
        } catch (e) {
            const errorMessage = getErrorMessage(e)
            if (errorMessage.toLowerCase().includes('provider sendmessage did not confirm send')) {
                console.warn('Send not confirmed by provider script:', errorMessage)
            } else {
                console.warn('Send blocked/failed', e)
            }
            lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
            setSendFeedbackMessage(getInlineSendFailureMessage(e))
            return false
        } finally {
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, sendDaemonCommand])

    const handleRelaunch = useCallback(async () => {
        if (!activeConv) return

        try {
            if (!activeConv.hostIdeType) return
            await sendDaemonCommand(activeConv.routeId, 'launch_ide', {
                ideType: activeConv.hostIdeType,
                enableCdp: true,
            })
        } catch (e) {
            console.error('Relaunch failed', e)
        }
    }, [activeConv, sendDaemonCommand])

    const handleModalButton = useCallback(async (buttonText: string) => {
        if (!activeConv) return

        try {
            const buttons = activeConv.modalButtons || []
            const buttonIndex = buttons.indexOf(buttonText)
            const clean = buttonText.replace(/[⌥⏎⇧⌫⌘⌃]/g, '').trim().toLowerCase()
            const isApprove = /^(run|approve|accept|yes|allow|always|proceed|save)/.test(clean)
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) return

            const raw = await sendDaemonCommand(routeTarget, 'resolve_action', {
                button: buttonText,
                action: isApprove ? 'approve' : 'reject',
                ...(buttonIndex >= 0 && { buttonIndex }),
                ...getProviderArgs(activeConv),
            })
            const res = unwrapCommandResult(raw)

            if (!res.success) {
                setActionLogs(prev => [...prev, {
                    routeId: activeConv.tabKey,
                    text: getActionFailureText(buttonText, res?.error),
                    timestamp: Date.now(),
                }])
            }
        } catch (e) {
            if (!isExpectedActionResolutionError(e)) {
                console.error('[ModalButton] Error:', e)
            }
            setActionLogs(prev => [...prev, {
                routeId: activeConv.tabKey,
                text: isExpectedActionResolutionError(e)
                    ? getActionFailureText(buttonText, e)
                    : `❌ **${buttonText}** error`,
                timestamp: Date.now(),
            }])
        }
    }, [activeConv, sendDaemonCommand, setActionLogs])

    const handleFocusAgent = useCallback(async () => {
        if (!activeConv || isFocusingAgent) return

        setIsFocusingAgent(true)
        try {
            await sendDaemonCommand(activeConv.routeId, getExplicitSessionRevealCommand(), {
                ...(activeConv.sessionId && { targetSessionId: activeConv.sessionId }),
            })
        } catch (e) {
            console.error('Focus agent failed', e)
        } finally {
            setIsFocusingAgent(false)
        }
    }, [activeConv, isFocusingAgent, sendDaemonCommand])

    return {
        isSendingChat,
        sendFeedbackMessage,
        isFocusingAgent,
        handleSendChat,
        handleRelaunch,
        handleModalButton,
        handleFocusAgent,
    }
}
