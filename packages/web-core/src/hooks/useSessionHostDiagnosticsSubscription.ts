import { useEffect, useState } from 'react'
import type { SessionHostDiagnosticsSnapshot, SessionHostDiagnosticsUpdate } from '@adhdev/daemon-core'
import { useTransport } from '../context/TransportContext'
import { subscriptionManager } from '../managers/SubscriptionManager'

export const SESSION_HOST_DIAGNOSTICS_INITIAL_TIMEOUT_MS = 4000

export function useSessionHostDiagnosticsSubscription(
    daemonId: string | null | undefined,
    opts?: { enabled?: boolean; includeSessions?: boolean; limit?: number; intervalMs?: number },
) {
    const { sendData } = useTransport()
    const [diagnostics, setDiagnostics] = useState<SessionHostDiagnosticsSnapshot | null>(null)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!daemonId) {
            setDiagnostics(null)
            setLoading(false)
            return
        }
        if (!opts?.enabled || !sendData) {
            setLoading(false)
            return
        }
        setDiagnostics(null)
        setLoading(true)
        let initialTimeout: ReturnType<typeof setTimeout> | null = null
        const unsubscribe = subscriptionManager.subscribe(
            { sendData },
            daemonId,
            {
                type: 'subscribe',
                topic: 'session_host.diagnostics',
                key: `session_host:${daemonId}`,
                params: {
                    includeSessions: opts?.includeSessions !== false,
                    ...(typeof opts?.limit === 'number' ? { limit: opts.limit } : {}),
                    ...(typeof opts?.intervalMs === 'number' ? { intervalMs: opts.intervalMs } : {}),
                },
            },
            (update: SessionHostDiagnosticsUpdate) => {
                if (initialTimeout) {
                    clearTimeout(initialTimeout)
                    initialTimeout = null
                }
                setDiagnostics(update.diagnostics)
                setLoading(false)
            },
        )
        if (!unsubscribe.initialSendAccepted) {
            setLoading(false)
        } else {
            initialTimeout = setTimeout(() => {
                setLoading(false)
            }, SESSION_HOST_DIAGNOSTICS_INITIAL_TIMEOUT_MS)
        }
        return () => {
            if (initialTimeout) {
                clearTimeout(initialTimeout)
            }
            unsubscribe()
        }
    }, [daemonId, opts?.enabled, opts?.includeSessions, opts?.intervalMs, opts?.limit, sendData])

    return {
        diagnostics,
        loading,
        applyDiagnostics: setDiagnostics,
    }
}
