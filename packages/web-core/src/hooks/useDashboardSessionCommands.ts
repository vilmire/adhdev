import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'
import { appendWarningToast, type DashboardToastSetter, getProviderArgs, getRouteTarget } from './dashboardCommandUtils'

interface UseDashboardSessionCommandsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    activeConv: ActiveConversation | undefined
    chats?: DaemonData['chats']
    updateIdeChats: (ideId: string, chats: DaemonData['chats']) => void
    setToasts: DashboardToastSetter
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setClearedTabs: Dispatch<SetStateAction<Record<string, number>>>
}

interface ChatSessionEntry {
    id?: string
    active?: boolean
}

function isLikelyCollapsedHistoryResult(
    nextChats: DaemonData['chats'] | undefined,
    activeConv: ActiveConversation | undefined,
) {
    if (!Array.isArray(nextChats) || nextChats.length !== 1 || !activeConv) return false
    const onlyChat = nextChats[0] as ChatSessionEntry
    if (onlyChat?.active === true) return true
    const activeIds = [activeConv.providerSessionId, activeConv.sessionId].filter((value): value is string => typeof value === 'string' && value.length > 0)
    return typeof onlyChat?.id === 'string' && activeIds.includes(onlyChat.id)
}

export function useDashboardSessionCommands({
    sendDaemonCommand,
    activeConv,
    chats,
    updateIdeChats,
    setToasts,
    setLocalUserMessages,
    setClearedTabs,
}: UseDashboardSessionCommandsOptions) {
    const [isCreatingChat, setIsCreatingChat] = useState(false)
    const [isRefreshingHistory, setIsRefreshingHistory] = useState(false)

    const handleLaunchIde = useCallback(async (ideType: string) => {
        try {
            await sendDaemonCommand('standalone', 'launch_ide', {
                ideType,
                enableCdp: true,
            })
        } catch (e) {
            console.error('Launch failed', e)
        }
    }, [sendDaemonCommand])

    const handleSwitchSession = useCallback(async (ideId: string, sessionId: string) => {
        try {
            const routeTarget = ideId || activeConv?.daemonId || ''
            const res: any = await sendDaemonCommand(routeTarget, 'switch_chat', {
                id: sessionId,
                sessionId,
                ...getProviderArgs(activeConv),
            })
            const scriptResult = res?.result
            const ok = res?.success === true || scriptResult === 'switched' || scriptResult === 'switched-by-title'

            if (ok) return

            if (scriptResult === false || scriptResult === 'not_found') {
                appendWarningToast(setToasts, '⚠️ Session tab not found — try refreshing history')
            } else if (typeof scriptResult === 'string' && scriptResult.startsWith('error:')) {
                appendWarningToast(setToasts, `⚠️ Switch error: ${scriptResult}`)
            } else {
                appendWarningToast(setToasts, '⚠️ Session switch failed')
            }
        } catch (e: any) {
            console.error('Switch failed', e)
            appendWarningToast(setToasts, `❌ Switch failed: ${e.message || 'connection error'}`)
        }
    }, [activeConv, sendDaemonCommand, setToasts])

    const handleNewChat = useCallback(async () => {
        if (!activeConv || isCreatingChat) return

        setIsCreatingChat(true)
        try {
            const routeTarget = getRouteTarget(activeConv)
            await sendDaemonCommand(routeTarget, 'new_chat', {
                ...getProviderArgs(activeConv),
            })
            setClearedTabs(prev => ({ ...prev, [activeConv.tabKey]: Date.now() }))
            setLocalUserMessages(prev => ({ ...prev, [activeConv.tabKey]: [] }))
        } catch (e) {
            console.error('New chat failed', e)
        } finally {
            setIsCreatingChat(false)
        }
    }, [activeConv, isCreatingChat, sendDaemonCommand, setClearedTabs, setLocalUserMessages])

    const handleRefreshHistory = useCallback(async () => {
        if (!activeConv || isRefreshingHistory) return

        setIsRefreshingHistory(true)
        try {
            const routeTarget = getRouteTarget(activeConv)
            const loadChats = async () => sendDaemonCommand(routeTarget, 'list_chats', {
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
                updateIdeChats(activeConv.ideId, nextChats)
                if (isLikelyCollapsedHistoryResult(nextChats, activeConv) && !isLikelyCollapsedHistoryResult(chats, activeConv)) {
                    appendWarningToast(setToasts, '⚠️ History dialog did not fully open — try once more')
                }
            }
        } catch (e) {
            console.error('Refresh history failed', e)
        } finally {
            setIsRefreshingHistory(false)
        }
    }, [activeConv, chats, isRefreshingHistory, sendDaemonCommand, updateIdeChats, setToasts])

    return {
        isCreatingChat,
        isRefreshingHistory,
        handleLaunchIde,
        handleSwitchSession,
        handleNewChat,
        handleRefreshHistory,
    }
}
