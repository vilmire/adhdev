import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'
import { appendWarningToast, type DashboardToastSetter, getProviderArgs, getRouteTarget } from './dashboardCommandUtils'

interface UseDashboardSessionCommandsOptions {
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    activeConv: ActiveConversation | undefined
    updateIdeChats: (ideId: string, chats: DaemonData['chats']) => void
    setToasts: DashboardToastSetter
    setLocalUserMessages: Dispatch<SetStateAction<Record<string, any[]>>>
    setClearedTabs: Dispatch<SetStateAction<Record<string, number>>>
}

export function useDashboardSessionCommands({
    sendDaemonCommand,
    activeConv,
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
            const res: any = await sendDaemonCommand(routeTarget, 'list_chats', {
                forceExpand: true,
                ...getProviderArgs(activeConv),
            })
            const chats = res?.chats || res?.result?.chats
            if (res?.success && Array.isArray(chats)) {
                updateIdeChats(activeConv.ideId, chats)
            }
        } catch (e) {
            console.error('Refresh history failed', e)
        } finally {
            setIsRefreshingHistory(false)
        }
    }, [activeConv, isRefreshingHistory, sendDaemonCommand, updateIdeChats])

    return {
        isCreatingChat,
        isRefreshingHistory,
        handleLaunchIde,
        handleSwitchSession,
        handleNewChat,
        handleRefreshHistory,
    }
}
