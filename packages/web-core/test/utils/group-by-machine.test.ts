import { describe, expect, it } from 'vitest'
import { groupByMachine } from '../../src/utils/daemon-utils'
import type { DaemonData } from '../../src/types'

function daemonMachine(id: string, overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id,
        type: 'adhdev-daemon',
        status: 'online',
        ...overrides,
    } as DaemonData
}

function cliSession(id: string, overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id,
        type: 'claude-cli',
        cliName: 'Claude Code',
        status: 'running',
        transport: 'pty',
        _isCli: true,
        ...overrides,
    } as DaemonData
}

describe('groupByMachine session attribution', () => {
    it('attributes a mesh-delegated session to its owner (worker) machine, not the reporting coordinator', () => {
        const daemons: DaemonData[] = [
            daemonMachine('daemon_coordinator'),
            daemonMachine('daemon_worker'),
            // Coordinator-synthesised copy: reported under the coordinator (daemonId) but owned by the worker.
            cliSession('daemon_coordinator:cli:remote-1', {
                daemonId: 'daemon_coordinator',
                ownerDaemonId: 'daemon_worker',
            }),
        ]

        const machines = groupByMachine(daemons, {})
        const coordinator = machines.find(m => m.machineId === 'daemon_coordinator')
        const worker = machines.find(m => m.machineId === 'daemon_worker')

        expect(coordinator?.cliSessions).toHaveLength(0)
        expect(worker?.cliSessions).toHaveLength(1)
        expect(worker?.cliSessions[0].id).toBe('daemon_coordinator:cli:remote-1')
    })

    it('keeps a non-mesh session grouped by daemonId when ownerDaemonId is absent (no regression)', () => {
        const daemons: DaemonData[] = [
            daemonMachine('daemon_local'),
            cliSession('daemon_local:cli:s1', { daemonId: 'daemon_local' }),
        ]

        const machines = groupByMachine(daemons, {})
        const local = machines.find(m => m.machineId === 'daemon_local')

        expect(local?.cliSessions).toHaveLength(1)
        expect(local?.cliSessions[0].id).toBe('daemon_local:cli:s1')
    })
})
