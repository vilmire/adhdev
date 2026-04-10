import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { getProviderArgs } from './dashboardCommandUtils'

interface UseIdeCommandsOptions {
    ideId: string
    activeConv: ActiveConversation | undefined
    historyModalOpen: boolean
    chats: unknown[] | undefined
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    updateIdeChats: (ideId: string, chats: any) => void
    pushToast: (message: string, type?: 'success' | 'info' | 'warning') => void
}

export function useIdeCommands({
    ideId,
    activeConv,
    historyModalOpen,
    chats,
    sendDaemonCommand,
    updateIdeChats,
    pushToast,
}: UseIdeCommandsOptions) {
    const [isCreatingChat, setIsCreatingChat] = useState(false)
    const [isRefreshingHistory, setIsRefreshingHistory] = useState(false)
    const [isSendingChat, setIsSendingChat] = useState(false)
    const historyRefreshedRef = useRef(false)

    const handleSendAgent = useCallback(async (rawMessage: string) => {
        const message = rawMessage.trim()
        if (!message || !ideId || isSendingChat || !activeConv) return

        setIsSendingChat(true)
        try {
            await sendDaemonCommand(ideId, 'send_chat', {
                message,
                waitForResponse: true,
                ...getProviderArgs(activeConv),
            })
        } catch (e) {
            console.error('[IDE] Send failed:', e)
        } finally {
            setIsSendingChat(false)
        }
    }, [ideId, isSendingChat, sendDaemonCommand, activeConv])

    const handleRefreshHistory = useCallback(async () => {
        if (!ideId || isRefreshingHistory || !activeConv) return

        setIsRefreshingHistory(true)
        try {
            const res: any = await sendDaemonCommand(ideId, 'list_chats', {
                forceExpand: true,
                ...getProviderArgs(activeConv),
            })
            const nextChats = res?.chats || res?.result?.chats
            if (res?.success && Array.isArray(nextChats)) {
                updateIdeChats(ideId, nextChats)
            }
        } catch (e) {
            console.error('[IDE] Refresh history failed:', e)
            pushToast('Failed to refresh history.', 'warning')
        } finally {
            setIsRefreshingHistory(false)
        }
    }, [ideId, isRefreshingHistory, sendDaemonCommand, activeConv, updateIdeChats, pushToast])

    const handleSwitchSession = useCallback(async (_targetIdeId: string, sessionId: string) => {
        if (!ideId || !activeConv) return

        try {
            const res: any = await sendDaemonCommand(ideId, 'switch_chat', {
                id: sessionId,
                sessionId,
                ...getProviderArgs(activeConv),
            })
            const scriptResult = res?.result
            const ok = res?.success === true || scriptResult === 'switched' || scriptResult === 'switched-by-title'
            if (ok) return

            if (scriptResult === false || scriptResult === 'not_found') {
                pushToast('Session tab not found. Try refreshing history.', 'warning')
            } else if (typeof scriptResult === 'string' && scriptResult.startsWith('error:')) {
                pushToast(`Session switch error: ${scriptResult}`, 'warning')
            } else {
                pushToast('Failed to switch sessions.', 'warning')
            }
        } catch (e: any) {
            console.error('[IDE] Switch session failed:', e)
            pushToast(`Session switch failed: ${e?.message || 'connection error'}`, 'warning')
        }
    }, [ideId, sendDaemonCommand, activeConv, pushToast])

    const handleNewChat = useCallback(async () => {
        if (!ideId || isCreatingChat || !activeConv) return

        setIsCreatingChat(true)
        try {
            await sendDaemonCommand(ideId, 'new_chat', {
                ...getProviderArgs(activeConv),
            })
        } catch (e) {
            console.error('[IDE] New chat failed:', e)
            pushToast('Failed to create a new chat.', 'warning')
        } finally {
            setIsCreatingChat(false)
        }
    }, [ideId, isCreatingChat, sendDaemonCommand, activeConv, pushToast])

    useEffect(() => {
        if (!historyModalOpen) {
            historyRefreshedRef.current = false
            return
        }
        if (historyRefreshedRef.current || isRefreshingHistory) return
        if (!chats || chats.length === 0) {
            historyRefreshedRef.current = true
            void handleRefreshHistory()
        }
    }, [historyModalOpen, chats, isRefreshingHistory, handleRefreshHistory])

    return {
        isSendingChat,
        isCreatingChat,
        isRefreshingHistory,
        handleSendAgent,
        handleRefreshHistory,
        handleSwitchSession,
        handleNewChat,
    }
}
