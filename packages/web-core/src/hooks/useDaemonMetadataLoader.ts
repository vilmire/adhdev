import { useCallback, useEffect, useRef } from 'react'
import type { DaemonMetadataUpdate } from '@adhdev/daemon-core'
import { useBaseDaemonActions } from '../context/BaseDaemonContext'
import { useTransport } from '../context/TransportContext'
import { subscriptionManager, type SubscriptionHandle } from '../managers/SubscriptionManager'
import { statusPayloadToEntries } from '../utils/status-transform'

const metadataSubscriptions = new Set<string>()

/**
 * Ensure the dashboard holds a `daemon.metadata` subscription for a daemon —
 * the ONE daemon→dashboard state lane (data-path audit 2026-09-29 P0-3).
 *
 * The daemon answers a subscribe with a snapshot and then pushes keyed deltas
 * (SubscriptionManager folds them), so there is nothing to fetch: the first
 * push paints, later pushes keep the held state current. The callback is
 * idempotent per daemon; `opts` is accepted for call-site compatibility and
 * ignored — a live push lane is never stale.
 */
export function useDaemonMetadataLoader() {
    const { sendData } = useTransport()
    const { injectEntries, getIdes } = useBaseDaemonActions()

    // Subscriptions this hook instance opened, so unmount can release them.
    // The loader is an imperative callback invoked from event handlers (not an
    // effect), so there is no per-call cleanup point — without this the handle
    // returned by subscribe() would be dropped on the floor and both the local
    // handler and the daemon-side subscription would live forever.
    const ownedSubscriptionsRef = useRef(new Map<string, SubscriptionHandle>())

    useEffect(() => {
        const owned = ownedSubscriptionsRef.current
        return () => {
            for (const [daemonId, unsubscribe] of owned) {
                unsubscribe()
                metadataSubscriptions.delete(daemonId)
            }
            owned.clear()
        }
    }, [])

    return useCallback(async (daemonId: string, _opts?: { force?: boolean; minFreshMs?: number }) => {
        if (!daemonId || !sendData || metadataSubscriptions.has(daemonId)) return

        const unsubscribe = subscriptionManager.subscribe(
            { sendData },
            daemonId,
            {
                type: 'subscribe',
                topic: 'daemon.metadata',
                key: `daemon:metadata:${daemonId}`,
                params: {
                    includeSessions: true,
                },
            },
            (update: DaemonMetadataUpdate) => {
                const existingIdes = getIdes()
                const existingDaemon = existingIdes.find((entry) => entry.id === daemonId)
                const entries = statusPayloadToEntries(update.status, {
                    daemonId,
                    existingDaemon,
                    existingEntries: existingIdes,
                    timestamp: update.timestamp,
                })
                // The materialized update is the daemon's whole state, so it is
                // authoritative for this daemon's session list (a removal in a
                // delta must drop the entry).
                if (entries.length > 0) {
                    injectEntries(entries, { authoritativeDaemonIds: [daemonId] })
                }
            },
        )

        // Release any handle this instance already held for the daemon
        // before recording the new one, so a re-subscribe never orphans
        // the previous handler.
        ownedSubscriptionsRef.current.get(daemonId)?.()
        ownedSubscriptionsRef.current.set(daemonId, unsubscribe)
        metadataSubscriptions.add(daemonId)
    }, [getIdes, injectEntries, sendData])
}
