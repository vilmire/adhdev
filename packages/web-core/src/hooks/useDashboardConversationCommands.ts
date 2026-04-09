import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { getProviderArgs, getRouteTarget } from './dashboardCommandUtils'

interface UseDashboardConversationCommandsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    activeConv: ActiveConversation | undefined
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
    isStandalone: boolean
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
    const lastSendRef = useRef<{ tabKey: string; message: string; timestamp: number } | null>(null)

    const handleSendChat = useCallback(async (rawMessage: string) => {
        if (!activeConv) return

        const message = rawMessage.trim()
        if (!message || sendInFlightRef.current) return

        const tabKey = activeConv.tabKey
        const now = Date.now()
        const lastSend = lastSendRef.current
        if (
            lastSend
            && lastSend.tabKey === tabKey
            && lastSend.message === message
            && (now - lastSend.timestamp) < 2000
        ) {
            return
        }

        sendInFlightRef.current = true
        setIsSendingChat(true)
        lastSendRef.current = { tabKey, message, timestamp: now }

        const localId = `${now}-${Math.random().toString(36).slice(2, 8)}`
        const userMsg = { role: 'user', content: message, timestamp: now, _localId: localId }
        setLocalUserMessages(prev => ({
            ...prev,
            [tabKey]: [...(prev[tabKey] || []), userMsg],
        }))

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) return

            const raw = await sendDaemonCommand(routeTarget, 'send_chat', {
                message,
                ...getProviderArgs(activeConv),
            })
            const res = unwrapCommandResult(raw)

            if (res?.deduplicated || res?.sent === false) {
                setLocalUserMessages(prev => ({
                    ...prev,
                    [tabKey]: (prev[tabKey] || []).filter(entry => entry._localId !== localId),
                }))
                return
            }

            if (res?.success === false) {
                throw new Error(res?.error || 'Send failed')
            }

            setTimeout(() => {
                const cutoff = Date.now() - 60000
                setLocalUserMessages(prev => {
                    const messages = prev[tabKey]
                    if (!messages) return prev
                    const filtered = messages.filter(entry => entry.timestamp > cutoff)
                    if (filtered.length === messages.length) return prev
                    return { ...prev, [tabKey]: filtered }
                })
            }, 60000)
        } catch (e) {
            const message = getErrorMessage(e)
            if (message.toLowerCase().includes('provider sendmessage did not confirm send')) {
                console.warn('Send not confirmed by provider script:', message)
            } else {
                console.error('Send failed', e)
            }
            setLocalUserMessages(prev => ({
                ...prev,
                [tabKey]: (prev[tabKey] || []).filter(entry => entry._localId !== localId),
            }))
        } finally {
            sendInFlightRef.current = false
            setIsSendingChat(false)
        }
    }, [activeConv, sendDaemonCommand, setLocalUserMessages])

    const handleRelaunch = useCallback(async () => {
        if (!activeConv) return

        try {
            await sendDaemonCommand(activeConv.ideId, 'launch_ide', {
                ideType: activeConv.ideType,
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
                    ideId: activeConv.tabKey,
                    text: getActionFailureText(buttonText, res?.error),
                    timestamp: Date.now(),
                }])
            }
        } catch (e) {
            if (!isExpectedActionResolutionError(e)) {
                console.error('[ModalButton] Error:', e)
            }
            setActionLogs(prev => [...prev, {
                ideId: activeConv.tabKey,
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
            await sendDaemonCommand(activeConv.ideId, 'focus_session', {
                agentType: activeConv.agentType,
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
