import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import { getConversationNotificationLabel } from '../components/dashboard/conversation-presenters'
import type { ActiveConversation } from '../components/dashboard/types'
import { requestNotificationPermission, useBrowserNotifications } from './useBrowserNotifications'

interface UseDashboardConversationMetaOptions {
    visibleConversations: ActiveConversation[]
    clearedTabs: Record<string, number>
    setClearedTabs: Dispatch<SetStateAction<Record<string, number>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
}

export function useDashboardConversationMeta({
    visibleConversations,
    clearedTabs,
    setClearedTabs,
    setActionLogs,
}: UseDashboardConversationMetaOptions) {
    useEffect(() => {
        requestNotificationPermission()
    }, [])

    const agentStates = useMemo(() =>
        visibleConversations.map(c => ({
            id: c.tabKey,
            name: getConversationNotificationLabel(c),
            status: c.status,
            activeModal: c.modalMessage ? { message: c.modalMessage, buttons: c.modalButtons } : null,
        })),
    [visibleConversations])

    useBrowserNotifications(agentStates)

    useEffect(() => {
        const keys = Object.keys(clearedTabs)
        if (keys.length === 0) return

        const timer = setTimeout(() => {
            setClearedTabs(prev => {
                const now = Date.now()
                const next: Record<string, number> = {}
                for (const [key, value] of Object.entries(prev)) {
                    if (now - value < 5000) next[key] = value
                }
                return Object.keys(next).length === Object.keys(prev).length ? prev : next
            })
        }, 5500)

        return () => clearTimeout(timer)
    }, [clearedTabs, setClearedTabs])

    useEffect(() => {
        const timer = setInterval(() => {
            const cutoff = Date.now() - 300_000
            setActionLogs(prev => {
                const filtered = prev.filter(log => log.timestamp > cutoff).slice(-100)
                return filtered.length === prev.length ? prev : filtered
            })
        }, 60_000)

        return () => clearInterval(timer)
    }, [setActionLogs])

    return null
}
