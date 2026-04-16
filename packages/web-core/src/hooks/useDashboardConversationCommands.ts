import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { isAcpConv, isCliConv } from '../components/dashboard/types'
import { getProviderArgs, getRouteTarget } from './dashboardCommandUtils'

interface UseDashboardConversationCommandsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    activeConv: ActiveConversation | undefined
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ routeId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
}

interface RecentSendAttempt {
    tabKey: string
    message: string
    timestamp: number
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

function unwrapCommandResult(raw: any): any {
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
    setLocalUserMessages,
    setActionLogs,
    isStandalone: _isStandalone,
}: UseDashboardConversationCommandsOptions) {
    const [isFocusingAgent, setIsFocusingAgent] = useState(false)
    const [isSendingChat, setIsSendingChat] = useState(false)
    const sendInFlightRef = useRef(false)
    const lastSendRef = useRef<RecentSendAttempt | null>(null)

    const handleSendChat = useCallback(async (rawMessage: string) => {
        if (!activeConv) return

        const message = rawMessage.trim()
        if (!message || sendInFlightRef.current) return

        const now = Date.now()
        const attempt: RecentSendAttempt = {
            tabKey: activeConv.tabKey,
            message,
            timestamp: now,
        }
        if (shouldSuppressRecentDuplicateSend(lastSendRef.current, attempt)) {
            return
        }

        sendInFlightRef.current = true
        setIsSendingChat(true)
        lastSendRef.current = attempt

        const localId = `${now}-${Math.random().toString(36).slice(2, 8)}`
        const userMsg = { role: 'user', content: message, timestamp: now, _localId: localId }
        const useLocalPendingMessage = !(isCliConv(activeConv) || isAcpConv(activeConv))
        if (useLocalPendingMessage) {
            setLocalUserMessages(prev => ({
                ...prev,
                [attempt.tabKey]: [...(prev[attempt.tabKey] || []), userMsg],
            }))
        }

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) return

            const raw = await sendDaemonCommand(routeTarget, 'send_chat', {
                message,
                ...getProviderArgs(activeConv),
            })
            const res = unwrapCommandResult(raw)

            if (useLocalPendingMessage && (res?.deduplicated || res?.sent === false)) {
                setLocalUserMessages(prev => ({
                    ...prev,
                    [attempt.tabKey]: (prev[attempt.tabKey] || []).filter(entry => entry._localId !== localId),
                }))
                return
            }

            if (res?.success === false) {
                throw new Error(res?.error || 'Send failed')
            }

            setTimeout(() => {
                const cutoff = Date.now() - 60000
                setLocalUserMessages(prev => {
                    const messages = prev[attempt.tabKey]
                    if (!messages) return prev
                    const filtered = messages.filter(entry => entry.timestamp > cutoff)
                    if (filtered.length === messages.length) return prev
                    return { ...prev, [attempt.tabKey]: filtered }
                })
            }, 60000)
        } catch (e) {
            const errorMessage = getErrorMessage(e)
            if (errorMessage.toLowerCase().includes('provider sendmessage did not confirm send')) {
                console.warn('Send not confirmed by provider script:', errorMessage)
            } else {
                console.error('Send failed', e)
            }
            lastSendRef.current = clearRecentSendOnFailure(lastSendRef.current, attempt)
            if (useLocalPendingMessage) {
                setLocalUserMessages(prev => ({
                    ...prev,
                    [attempt.tabKey]: (prev[attempt.tabKey] || []).filter(entry => entry._localId !== localId),
                }))
            }
            setActionLogs(prev => [...prev, {
                routeId: attempt.tabKey,
                text: `❌ **Send failed** — ${errorMessage || 'Unknown error'}`,
                timestamp: Date.now(),
            }])
        } finally {
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, sendDaemonCommand, setActionLogs, setLocalUserMessages])

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
            await sendDaemonCommand(activeConv.routeId, 'focus_session', {
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
        isFocusingAgent,
        handleSendChat,
        handleRelaunch,
        handleModalButton,
        handleFocusAgent,
    }
}
