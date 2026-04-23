import { useEffect } from 'react'
import { dashboardWS } from '../compat'
import { eventManager } from '../managers/EventManager'
import type { StatusEventPayload, ToastConfig } from '../managers/EventManager'
import type { Toast } from '../context/BaseDaemonContext'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'

interface UseDashboardEventManagerOptions {
    ides: DaemonData[]
    sendDaemonCommand: (routeId: string, cmd: string, payload?: Record<string, unknown>) => Promise<any>
    setToasts: React.Dispatch<React.SetStateAction<Toast[]>>
    resolveConversationByTarget: (target: string | null | undefined) => ActiveConversation | undefined
}

export function useDashboardEventManager({
    ides,
    sendDaemonCommand,
    setToasts,
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

        return () => {
            unsubToast()
        }
    }, [setToasts])

    useEffect(() => {
        const unsubWS = dashboardWS.on('status_event', (payload: StatusEventPayload) => {
            eventManager.handleRawEvent(payload, 'ws')
        })
        return () => { unsubWS() }
    }, [])

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const data = event.data
            if (data?.type !== 'notification_action' || typeof data.action !== 'string' || !data.action.startsWith('approval_')) return
            if (!(data.daemonId || data.targetSessionId || data.targetKey)) return

            const targetKey = data.targetSessionId || data.targetKey || data.daemonId
            const matchedConv = resolveConversationByTarget(targetKey)
            const routeId = matchedConv?.routeId || data.daemonId
            if (!routeId) return
            const buttonIndex = Number(data.buttonIndex)
            const buttonText = data.button || matchedConv?.modalButtons?.[buttonIndex] || 'Approve'
            const clean = String(buttonText).replace(/[⌥⏎⇧⌫⌘⌃↵]/g, '').trim().toLowerCase()
            const isApprove = /^(run|approve|accept|yes|allow|always|proceed|save)/.test(clean)

            sendDaemonCommand(routeId, 'resolve_action', {
                action: isApprove ? 'approve' : 'reject',
                button: buttonText,
                ...(Number.isFinite(buttonIndex) && { buttonIndex }),
                ...(matchedConv?.sessionId && { targetSessionId: matchedConv.sessionId }),
                ...(data.targetSessionId && { targetSessionId: data.targetSessionId }),
            }).catch(error => console.error('[SW Action] approval failed:', error))
        }

        navigator.serviceWorker?.addEventListener('message', handler)
        return () => navigator.serviceWorker?.removeEventListener('message', handler)
    }, [resolveConversationByTarget, sendDaemonCommand])
}
