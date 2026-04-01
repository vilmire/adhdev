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

export function useDashboardConversationCommands({
    sendDaemonCommand,
    activeConv,
    setLocalUserMessages,
    setActionLogs,
    isStandalone,
}: UseDashboardConversationCommandsOptions) {
    const [isFocusingAgent, setIsFocusingAgent] = useState(false)
    const [isSendingChat, setIsSendingChat] = useState(false)
    const sendInFlightRef = useRef(false)

    const handleSendChat = useCallback(async (rawMessage: string) => {
        if (!activeConv) return

        const message = rawMessage.trim()
        if (!message || sendInFlightRef.current) return

        const tabKey = activeConv.tabKey
        sendInFlightRef.current = true
        setIsSendingChat(true)

        const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const userMsg = { role: 'user', content: message, timestamp: Date.now(), _localId: localId }
        setLocalUserMessages(prev => ({
            ...prev,
            [tabKey]: [...(prev[tabKey] || []), userMsg],
        }))

        try {
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) return

            await sendDaemonCommand(routeTarget, 'send_chat', {
                message,
                text: message,
                ...getProviderArgs(activeConv),
            })

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
            console.error('Send failed', e)
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
            if (isStandalone) {
                await sendDaemonCommand(activeConv.ideId, 'launch_ide', {
                    ideType: activeConv.ideType,
                    enableCdp: true,
                })
                return
            }

            await sendDaemonCommand(activeConv.ideId, 'vscode_command_exec', {
                commandId: 'adhdev.relaunchWithCdp',
                args: [{ force: true }],
            })
        } catch (e) {
            console.error('Relaunch failed', e)
        }
    }, [activeConv, isStandalone, sendDaemonCommand])

    const handleModalButton = useCallback(async (buttonText: string) => {
        if (!activeConv) return

        setActionLogs(prev => [...prev, {
            ideId: activeConv.tabKey,
            text: `🖱️ **${buttonText}** clicked`,
            timestamp: Date.now(),
        }])

        try {
            const buttons = activeConv.modalButtons || []
            const buttonIndex = buttons.indexOf(buttonText)
            const clean = buttonText.replace(/[⌥⏎⇧⌫⌘⌃]/g, '').trim().toLowerCase()
            const isApprove = /^(run|approve|accept|yes|allow|always|proceed|save)/.test(clean)
            const routeTarget = getRouteTarget(activeConv)
            if (!routeTarget) return

            const res = await sendDaemonCommand(routeTarget, 'resolve_action', {
                button: buttonText,
                action: isApprove ? 'approve' : 'reject',
                ...(buttonIndex >= 0 && { buttonIndex }),
                ...getProviderArgs(activeConv),
            })

            if (!res.success) {
                setActionLogs(prev => [...prev, {
                    ideId: activeConv.tabKey,
                    text: `⚠️ **${buttonText}** failed — button not found`,
                    timestamp: Date.now(),
                }])
            }
        } catch (e) {
            console.error('[ModalButton] Error:', e)
            setActionLogs(prev => [...prev, {
                ideId: activeConv.tabKey,
                text: `❌ **${buttonText}** error`,
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
