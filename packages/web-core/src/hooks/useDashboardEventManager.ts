import { useEffect } from 'react'
import { dashboardWS } from '../compat'
import { eventManager } from '../managers/EventManager'
import type { SystemMessage, ToastConfig } from '../managers/EventManager'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'

type DashboardToast = {
    id: number
    message: string
    type: 'success' | 'info' | 'warning'
    timestamp: number
    targetKey?: string
    actions?: unknown
}

interface UseDashboardEventManagerOptions {
    ides: DaemonData[]
    sendDaemonCommand: (routeId: string, cmd: string, payload?: Record<string, unknown>) => Promise<any>
    setToasts: React.Dispatch<React.SetStateAction<DashboardToast[]>>
    setLocalUserMessages: React.Dispatch<React.SetStateAction<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>>
    resolveConversationByTarget: (target: string | null | undefined) => ActiveConversation | undefined
}

export function useDashboardEventManager({
    ides,
    sendDaemonCommand,
    setToasts,
    setLocalUserMessages,
    resolveConversationByTarget,
}: UseDashboardEventManagerOptions) {
    useEffect(() => {
        eventManager.setIdes(ides)
    }, [ides])

    useEffect(() => {
        eventManager.setResolveAction((routeId, cmd, payload) => {
            sendDaemonCommand(routeId, cmd, payload).catch(() => {})
        })
    }, [sendDaemonCommand])

    useEffect(() => {
        const unsubToast = eventManager.onToast((toast: ToastConfig) => {
            setToasts(prev => {
                const isDup = prev.some(t => t.message === toast.message && (toast.timestamp - t.timestamp) < 3000)
                if (isDup) return prev
                return [...prev.slice(-4), {
                    id: toast.id,
                    message: toast.message,
                    type: toast.type,
                    timestamp: toast.timestamp,
                    targetKey: toast.targetKey,
                    actions: toast.actions,
                }]
            })
            const dur = toast.duration || 5000
            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), dur)
        })

        const unsubSysMsg = eventManager.onSystemMessage((targetKey: string, msg: SystemMessage) => {
            setLocalUserMessages(prev => ({
                ...prev,
                [targetKey]: [...(prev[targetKey] || []), msg],
            }))
        })

        const unsubClearSysMsg = eventManager.onClearSystemMessage((targetKey: string, prefix: string) => {
            setLocalUserMessages(prev => {
                if (!prev[targetKey]?.length) return prev
                return {
                    ...prev,
                    [targetKey]: prev[targetKey].filter(
                        (message: any) => !(message.role === 'system' && message._localId?.startsWith(prefix)),
                    ),
                }
            })
        })

        return () => {
            unsubToast()
            unsubSysMsg()
            unsubClearSysMsg()
        }
    }, [setToasts, setLocalUserMessages])

    useEffect(() => {
        const unsubWS = dashboardWS.on('status_event', (payload: any) => eventManager.handleRawEvent(payload, 'ws'))
        return () => { unsubWS() }
    }, [])

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const data = event.data
            if (data?.type !== 'notification_action' || data.action !== 'approve') return
            if (!(data.ideId || data.targetSessionId || data.targetKey)) return

            const targetKey = data.targetSessionId || data.targetKey || data.ideId
            const matchedConv = resolveConversationByTarget(targetKey)
            const routeId = matchedConv?.ideId || data.ideId
            if (!routeId) return

            sendDaemonCommand(routeId, 'resolve_action', {
                action: 'approve',
                button: 'Approve',
                ...(matchedConv?.sessionId && { targetSessionId: matchedConv.sessionId }),
                ...(data.targetSessionId && { targetSessionId: data.targetSessionId }),
            }).catch(error => console.error('[SW Action] approve failed:', error))
        }

        navigator.serviceWorker?.addEventListener('message', handler)
        return () => navigator.serviceWorker?.removeEventListener('message', handler)
    }, [resolveConversationByTarget, sendDaemonCommand])
}
