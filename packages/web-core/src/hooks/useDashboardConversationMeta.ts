import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import { isCliConv } from '../components/dashboard/types'
import { ptyBus } from '../components/dashboard/ptyBus'
import { p2pManager } from '../compat'
import { requestNotificationPermission, useBrowserNotifications } from './useBrowserNotifications'

interface UseDashboardConversationMetaOptions {
    conversations: ActiveConversation[]
    visibleConversations: ActiveConversation[]
    clearedTabs: Record<string, number>
    setClearedTabs: Dispatch<SetStateAction<Record<string, number>>>
    setMessageReceivedAt: Dispatch<SetStateAction<Record<string, number>>>
    setActionLogs: Dispatch<SetStateAction<{ ideId: string; text: string; timestamp: number }[]>>
}

export function useDashboardConversationMeta({
    conversations,
    visibleConversations,
    clearedTabs,
    setClearedTabs,
    setMessageReceivedAt,
    setActionLogs,
}: UseDashboardConversationMetaOptions) {
    const ptyBuffers = useRef<Map<string, string[]>>(new Map())

    useEffect(() => {
        requestNotificationPermission()
    }, [])

    const agentStates = useMemo(() =>
        visibleConversations.map(c => ({
            id: c.tabKey,
            name: c.title || c.agentName || c.ideId,
            status: c.status,
            activeModal: c.modalMessage ? { message: c.modalMessage, buttons: c.modalButtons } : null,
        })),
    [visibleConversations])

    useBrowserNotifications(agentStates)

    useEffect(() => {
        setMessageReceivedAt(prev => {
            const now = Date.now()
            let updated = false
            const next = { ...prev }

            for (const conv of conversations) {
                if (!conv.messages?.length) continue
                conv.messages.forEach((message: any, index: number) => {
                    const key = `${conv.ideId}-${message.id ?? `i-${index}`}`
                    if (next[key] == null) {
                        next[key] = now
                        updated = true
                    }
                })
            }

            return updated ? next : prev
        })
    }, [conversations, setMessageReceivedAt])

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

    useEffect(() => {
        const writePty = (cliId: string, data: string) => {
            if (!data) return

            ptyBus.emit(cliId, data)
            for (const conv of conversations) {
                if (!isCliConv(conv)) continue
                const convCliMatch = cliId === conv.sessionId || cliId === conv.ideId || cliId === conv.tabKey
                if (!convCliMatch) continue

                const buf = ptyBuffers.current.get(conv.tabKey) || []
                buf.push(data)
                if (buf.length > 10000) buf.splice(0, buf.length - 5000)
                ptyBuffers.current.set(conv.tabKey, buf)
            }
        }

        const unsubP2P = p2pManager.onPtyOutput(writePty)
        return () => { unsubP2P() }
    }, [conversations])

    return { ptyBuffers }
}
