import { describe, expect, it } from 'vitest'
import { getDashboardMachineRefreshTargets } from '../../src/utils/dashboard-machine-refresh'
import type { DaemonData } from '../../src/types'

function createMachine(id: string, overrides: Partial<DaemonData> = {}): DaemonData {
  return {
    id,
    type: 'adhdev-daemon',
    status: 'online',
    timestamp: 1,
    ...overrides,
  } as DaemonData
}

describe('getDashboardMachineRefreshTargets', () => {
  it('refreshes daemon metadata for every dashboard machine entry', () => {
    const machines = [
      createMachine('machine-1', {
        detectedIdes: [],
        availableProviders: [],
        recentLaunches: [],
        workspaces: [],
      }),
      createMachine('machine-2', {
        detectedIdes: [{ id: 'cursor', type: 'cursor', name: 'Cursor', running: true } as any],
        availableProviders: [{ type: 'cursor-cli', category: 'cli', displayName: 'Cursor CLI' } as any],
        recentLaunches: [{ id: 'launch-1', providerType: 'cursor-cli' } as any],
        workspaces: [{ id: 'ws-1', path: '/repo', label: 'repo', addedAt: 1 } as any],
      }),
    ]

    expect(getDashboardMachineRefreshTargets(machines).metadataDaemonIds).toEqual(['machine-1', 'machine-2'])
  })

  it('refreshes runtime only for machines missing machine runtime fields', () => {
    const machines = [
      createMachine('machine-1', {
        machine: {
          platform: 'darwin',
        } as any,
      }),
      createMachine('machine-2', {
        machine: {
          platform: 'darwin',
          cpus: 8,
          totalMem: 16,
          arch: 'arm64',
          release: '25.0.0',
        } as any,
      }),
    ]

    expect(getDashboardMachineRefreshTargets(machines)).toEqual({
      metadataDaemonIds: ['machine-1', 'machine-2'],
      runtimeDaemonIds: ['machine-1'],
    })
  })
})
