import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execSync: vi.fn<(cmd: string) => string>(),
  spawnDetachedDaemonUpgradeHelper: vi.fn(),
}))

vi.mock('child_process', () => ({
  execSync: mocks.execSync,
}))

vi.mock('../../src/commands/upgrade-helper.js', () => ({
  spawnDetachedDaemonUpgradeHelper: mocks.spawnDetachedDaemonUpgradeHelper,
}))

import { DaemonCommandRouter } from '../../src/commands/router'

function createRouter(statusVersion: string) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    packageName: 'adhdev',
    statusVersion,
  })
}

describe('daemon_upgrade runtime version handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.execSync.mockReset()
    mocks.spawnDetachedDaemonUpgradeHelper.mockReset()
    mocks.execSync.mockImplementation((cmd: string) => {
      if (cmd === 'npm view adhdev version') return '0.9.13\n'
      if (cmd === 'npm ls -g adhdev --depth=0 --json') {
        return JSON.stringify({ dependencies: { adhdev: { version: '0.9.13' } } })
      }
      throw new Error(`unexpected command: ${cmd}`)
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('schedules a restart when the globally installed package is latest but the running daemon is stale', async () => {
    const router = createRouter('0.9.12')

    const result = await router.execute('daemon_upgrade', {})

    expect(result).toMatchObject({ success: true, upgraded: true, version: '0.9.13', restarting: true })
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledTimes(1)
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(expect.objectContaining({
      packageName: 'adhdev',
      targetVersion: '0.9.13',
    }))
  })
})
