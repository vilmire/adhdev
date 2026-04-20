import { useCallback } from 'react'
import type { StatusReportPayload } from '../types'
import type { DaemonMetadataUpdate } from '@adhdev/daemon-core'
import { useBaseDaemonActions } from '../context/BaseDaemonContext'
import { useTransport } from '../context/TransportContext'
import { subscriptionManager } from '../managers/SubscriptionManager'
import { statusPayloadToEntries } from '../utils/status-transform'
import { DAEMON_METADATA_SUBSCRIPTION_WAIT_MS, DEFAULT_DAEMON_METADATA_FRESH_MS } from '../utils/daemon-timing'

const metadataInFlight = new Map<string, Promise<void>>()
const metadataLoadedAt = new Map<string, number>()
const metadataSubscriptions = new Set<string>()
const metadataWaiters = new Map<string, Set<(updated: boolean) => void>>()

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

function resolveMetadataWaiters(daemonId: string, updated: boolean) {
    const waiters = metadataWaiters.get(daemonId)
    if (!waiters || waiters.size === 0) return
    metadataWaiters.delete(daemonId)
    waiters.forEach((resolve) => resolve(updated))
}

function waitForMetadataUpdate(daemonId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const waiters = metadataWaiters.get(daemonId) || new Set<(updated: boolean) => void>()
        metadataWaiters.set(daemonId, waiters)

        const finish = (updated: boolean) => {
            clearTimeout(timer)
            waiters.delete(finish)
            if (waiters.size === 0) metadataWaiters.delete(daemonId)
            resolve(updated)
        }

        const timer = setTimeout(() => finish(false), timeoutMs)
        waiters.add(finish)
    })
}

export function useDaemonMetadataLoader() {
    const { sendCommand, sendData } = useTransport()
    const { injectEntries, getIdes } = useBaseDaemonActions()

    return useCallback(async (daemonId: string, opts?: { force?: boolean; minFreshMs?: number }) => {
        if (!daemonId) return

        const minFreshMs = opts?.minFreshMs ?? DEFAULT_DAEMON_METADATA_FRESH_MS
        const loadedAt = metadataLoadedAt.get(daemonId) || 0
        if (!opts?.force && metadataSubscriptions.has(daemonId) && loadedAt > 0) {
            return
        }
        if (!opts?.force && loadedAt > 0 && (Date.now() - loadedAt) < minFreshMs) {
            return
        }

        const existing = metadataInFlight.get(daemonId)
        if (existing) return existing

        const request = (async () => {
            if (sendData && !metadataSubscriptions.has(daemonId)) {
                metadataSubscriptions.add(daemonId)
                subscriptionManager.subscribe(
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
                        resolveMetadataWaiters(daemonId, true)
                    },
                )

                if (!opts?.force) {
                    const updated = await waitForMetadataUpdate(daemonId, DAEMON_METADATA_SUBSCRIPTION_WAIT_MS)
                    if (updated) return
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
            resolveMetadataWaiters(daemonId, true)
        })().finally(() => {
            metadataInFlight.delete(daemonId)
        })

        metadataInFlight.set(daemonId, request)
        return request
    }, [getIdes, injectEntries, sendCommand, sendData])
}
