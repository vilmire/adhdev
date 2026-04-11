import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { getProviderArgs } from './dashboardCommandUtils'

interface UseIdeCommandsOptions {
    routeId: string
    activeConv: ActiveConversation | undefined
    historyModalOpen: boolean
    chats: unknown[] | undefined
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    updateRouteChats: (routeId: string, chats: any) => void
    pushToast: (message: string, type?: 'success' | 'info' | 'warning') => void
}

interface ChatSessionEntry {
    id?: string
    active?: boolean
}

function isLikelyCollapsedHistoryResult(
    nextChats: unknown[] | undefined,
    activeConv: ActiveConversation | undefined,
) {
    if (!Array.isArray(nextChats) || nextChats.length !== 1 || !activeConv) return false
    const onlyChat = nextChats[0] as ChatSessionEntry
    if (onlyChat?.active === true) return true
    const activeIds = [activeConv.providerSessionId, activeConv.sessionId].filter((value): value is string => typeof value === 'string' && value.length > 0)
    return typeof onlyChat?.id === 'string' && activeIds.includes(onlyChat.id)
}

export function useIdeCommands({
    routeId,
    activeConv,
    historyModalOpen,
    chats,
    sendDaemonCommand,
    updateRouteChats,
    pushToast,
}: UseIdeCommandsOptions) {
    const [isCreatingChat, setIsCreatingChat] = useState(false)
    const [isRefreshingHistory, setIsRefreshingHistory] = useState(false)
    const [isSendingChat, setIsSendingChat] = useState(false)
    const historyRefreshedRef = useRef(false)

    const handleSendAgent = useCallback(async (rawMessage: string) => {
        const message = rawMessage.trim()
        if (!message || !routeId || isSendingChat || !activeConv) return

        setIsSendingChat(true)
        try {
            await sendDaemonCommand(routeId, 'send_chat', {
                message,
                waitForResponse: true,
                ...getProviderArgs(activeConv),
            })
        } catch (e) {
            console.error('[IDE] Send failed:', e)
        } finally {
            setIsSendingChat(false)
        }
    }, [routeId, isSendingChat, sendDaemonCommand, activeConv])

    const handleRefreshHistory = useCallback(async () => {
        if (!routeId || isRefreshingHistory || !activeConv) return

        setIsRefreshingHistory(true)
        try {
            const loadChats = async () => sendDaemonCommand(routeId, 'list_chats', {
                forceExpand: true,
                ...getProviderArgs(activeConv),
            })
            let res: any = await loadChats()
            let nextChats = res?.chats || res?.result?.chats
            if (isLikelyCollapsedHistoryResult(nextChats, activeConv)) {
                await new Promise(resolve => setTimeout(resolve, 450))
                res = await loadChats()
                nextChats = res?.chats || res?.result?.chats
            }
            if (res?.success && Array.isArray(nextChats)) {
                updateRouteChats(routeId, nextChats)
            }
        } catch (e) {
            console.error('[IDE] Refresh history failed:', e)
            pushToast('Failed to refresh history.', 'warning')
        } finally {
            setIsRefreshingHistory(false)
        }
    }, [routeId, isRefreshingHistory, sendDaemonCommand, activeConv, updateRouteChats, pushToast])

    const handleSwitchSession = useCallback(async (_targetIdeId: string, sessionId: string) => {
        if (!routeId || !activeConv) return

        try {
            const res: any = await sendDaemonCommand(routeId, 'switch_chat', {
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
    }, [routeId, sendDaemonCommand, activeConv, pushToast])

    const handleNewChat = useCallback(async () => {
        if (!routeId || isCreatingChat || !activeConv) return

        setIsCreatingChat(true)
        try {
            await sendDaemonCommand(routeId, 'new_chat', {
                ...getProviderArgs(activeConv),
            })
        } catch (e) {
            console.error('[IDE] New chat failed:', e)
            pushToast('Failed to create a new chat.', 'warning')
        } finally {
            setIsCreatingChat(false)
        }
    }, [routeId, isCreatingChat, sendDaemonCommand, activeConv, pushToast])

    useEffect(() => {
        if (!historyModalOpen) {
            historyRefreshedRef.current = false
            return
        }
        if (historyRefreshedRef.current || isRefreshingHistory) return
        if (!chats || chats.length === 0 || isLikelyCollapsedHistoryResult(chats, activeConv)) {
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
