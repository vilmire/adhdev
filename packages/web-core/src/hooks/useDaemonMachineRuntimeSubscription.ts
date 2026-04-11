import { useEffect } from 'react'
import type { MachineRuntimeUpdate } from '@adhdev/daemon-core'
import { useBaseDaemonActions } from '../context/BaseDaemonContext'
import { useTransport } from '../context/TransportContext'
import { subscriptionManager } from '../managers/SubscriptionManager'
import type { DaemonData } from '../types'

function buildRuntimeEntry(existingDaemon: DaemonData | undefined, daemonId: string, update: MachineRuntimeUpdate): DaemonData {
    return {
        ...(existingDaemon || {}),
        id: daemonId,
        type: existingDaemon?.type || 'adhdev-daemon',
        status: existingDaemon?.status || 'online',
        timestamp: update.timestamp,
        platform: update.machine.platform,
        machine: {
            ...(existingDaemon?.machine || {}),
            ...update.machine,
        },
    }
}

export function useDaemonMachineRuntimeSubscription(
    daemonIds: string[],
    opts?: { enabled?: boolean; intervalMs?: number },
) {
    const { sendData } = useTransport()
    const { injectEntries, getIdes } = useBaseDaemonActions()
    const daemonIdsKey = Array.from(new Set(daemonIds.filter(Boolean))).join('|')

    useEffect(() => {
        if (!opts?.enabled || !sendData) return
        const ids = daemonIdsKey ? daemonIdsKey.split('|') : []
        if (ids.length === 0) return

        const unsubs = ids.map((daemonId) => subscriptionManager.subscribe(
            { sendData },
            daemonId,
            {
                type: 'subscribe',
                topic: 'machine.runtime',
                key: `machine:${daemonId}`,
                params: {
                    intervalMs: opts?.intervalMs ?? 15_000,
                },
            },
            (update: MachineRuntimeUpdate) => {
                const existingDaemon = getIdes().find((entry) => entry.id === daemonId)
                const entry = buildRuntimeEntry(existingDaemon, daemonId, update)
                injectEntries([entry])
            },
        ))

        return () => {
            unsubs.forEach((unsubscribe) => unsubscribe())
        }
    }, [daemonIdsKey, getIdes, injectEntries, opts?.enabled, opts?.intervalMs, sendData])
}
