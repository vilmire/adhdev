import { useCallback } from 'react'
import type { MachineInfo } from '@adhdev/daemon-core'
import { useBaseDaemonActions } from '../context/BaseDaemonContext'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import { DEFAULT_MACHINE_RUNTIME_FRESH_MS } from '../utils/daemon-timing'

const runtimeInFlight = new Map<string, Promise<void>>()
const runtimeLoadedAt = new Map<string, number>()

function unwrapMachineRuntime(raw: unknown): { machine: MachineInfo; timestamp?: number } | null {
    if (!raw || typeof raw !== 'object') return null
    const body = raw as Record<string, unknown>
    const machine = body.machine
    if (!machine || typeof machine !== 'object') return null
    return {
        machine: machine as MachineInfo,
        timestamp: typeof body.timestamp === 'number' ? body.timestamp : undefined,
    }
}

function buildRuntimeEntry(existingDaemon: DaemonData | undefined, daemonId: string, machine: MachineInfo, timestamp: number): DaemonData {
    return {
        ...(existingDaemon || {}),
        id: daemonId,
        type: existingDaemon?.type || 'adhdev-daemon',
        status: existingDaemon?.status || 'online',
        timestamp,
        platform: machine.platform,
        machine,
    }
}

export function useDaemonMachineRuntimeLoader() {
    const { sendCommand } = useTransport()
    const { injectEntries, getIdes } = useBaseDaemonActions()

    return useCallback(async (daemonId: string, opts?: { force?: boolean; minFreshMs?: number }) => {
        if (!daemonId) return

        const minFreshMs = opts?.minFreshMs ?? DEFAULT_MACHINE_RUNTIME_FRESH_MS
        const loadedAt = runtimeLoadedAt.get(daemonId) || 0
        if (!opts?.force && loadedAt > 0 && (Date.now() - loadedAt) < minFreshMs) {
            return
        }

        const existing = runtimeInFlight.get(daemonId)
        if (existing) return existing

        const request = (async () => {
            const response = await sendCommand(daemonId, 'get_machine_runtime_stats')
            const payload = unwrapMachineRuntime(response)
            if (!payload) return

            const existingDaemon = getIdes().find((entry) => entry.id === daemonId)
            const entry = buildRuntimeEntry(existingDaemon, daemonId, payload.machine, payload.timestamp || Date.now())
            injectEntries([entry])
            runtimeLoadedAt.set(daemonId, Date.now())
        })().finally(() => {
            runtimeInFlight.delete(daemonId)
        })

        runtimeInFlight.set(daemonId, request)
        return request
    }, [getIdes, injectEntries, sendCommand])
}
