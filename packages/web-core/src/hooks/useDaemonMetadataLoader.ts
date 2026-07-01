import { useCallback } from 'react'
import type { StatusReportPayload } from '../types'
import type { DaemonMetadataUpdate } from '@adhdev/daemon-core'
import { useBaseDaemonActions } from '../context/BaseDaemonContext'
import { useTransport } from '../context/TransportContext'
import { subscriptionManager } from '../managers/SubscriptionManager'
import { statusPayloadToEntries } from '../utils/status-transform'
import { DEFAULT_DAEMON_METADATA_FRESH_MS } from '../utils/daemon-timing'
import { shouldLoadDaemonMetadata } from '../utils/daemon-metadata-swr'

const metadataInFlight = new Map<string, Promise<void>>()
const metadataLoadedAt = new Map<string, number>()
const metadataSubscriptions = new Set<string>()

function unwrapStatusPayload(raw: unknown): StatusReportPayload | null {
    if (!raw || typeof raw !== 'object') return null
    const body = raw as Record<string, unknown>
    const direct = body.status
    if (direct && typeof direct === 'object') return direct as StatusReportPayload
    const nested = body.result
    if (nested && typeof nested === 'object' && 'status' in (nested as Record<string, unknown>)) {
        const status = (nested as Record<string, unknown>).status
        if (status && typeof status === 'object') return status as StatusReportPayload
    }
    return body as unknown as StatusReportPayload
}

export function useDaemonMetadataLoader() {
    const { sendCommand, sendData } = useTransport()
    const { injectEntries, getIdes } = useBaseDaemonActions()

    return useCallback(async (daemonId: string, opts?: { force?: boolean; minFreshMs?: number }) => {
        if (!daemonId) return

        const minFreshMs = opts?.minFreshMs ?? DEFAULT_DAEMON_METADATA_FRESH_MS
        // Held-first SWR: the daemon store already holds the last snapshot and is
        // rendered immediately by callers. Only decide whether a background
        // freshen is needed here.
        if (!shouldLoadDaemonMetadata({
            force: opts?.force,
            hasSubscription: metadataSubscriptions.has(daemonId),
            loadedAt: metadataLoadedAt.get(daemonId) || 0,
            now: Date.now(),
            minFreshMs,
        })) {
            return
        }

        const existing = metadataInFlight.get(daemonId)
        if (existing) return existing

        const request = (async () => {
            // Establish the metadata subscription so future pushes keep the held
            // snapshot fresh. This runs in the background — we do NOT block first
            // paint waiting for its initial push. The get_status_metadata fetch
            // below is fired in parallel and is the fast path that populates the
            // held snapshot on the very first load.
            if (sendData && !metadataSubscriptions.has(daemonId)) {
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
                        if (entries.length > 0) {
                            injectEntries(entries)
                        }
                        metadataLoadedAt.set(daemonId, Date.now())
                    },
                )

                if (unsubscribe.initialSendAccepted) {
                    metadataSubscriptions.add(daemonId)
                } else {
                    metadataSubscriptions.delete(daemonId)
                }
            }

            const response = await sendCommand(daemonId, 'get_status_metadata')
            const payload = unwrapStatusPayload(response)
            if (!payload) return

            const existingIdes = getIdes()
            const existingDaemon = existingIdes.find((entry) => entry.id === daemonId)
            const entries = statusPayloadToEntries(payload, {
                daemonId,
                existingDaemon,
                existingEntries: existingIdes,
                timestamp: payload.timestamp || Date.now(),
            })
            if (entries.length > 0) {
                injectEntries(entries, { authoritativeDaemonIds: [daemonId] })
            }
            metadataLoadedAt.set(daemonId, Date.now())
        })().finally(() => {
            metadataInFlight.delete(daemonId)
        })

        metadataInFlight.set(daemonId, request)
        return request
    }, [getIdes, injectEntries, sendCommand, sendData])
}
