import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execSync: vi.fn<(cmd: string) => string>(),
  execNpmCommandSync: vi.fn<(args: string[], options?: Record<string, unknown>, surface?: Record<string, unknown>) => string>(),
  resolveCurrentGlobalInstallSurface: vi.fn(() => ({ npmExecutable: 'npm', npmArgsPrefix: [], packageRoot: null, installPrefix: null, execOptions: { shell: false } })),
  spawnDetachedDaemonUpgradeHelper: vi.fn(),
  loadConfig: vi.fn(() => ({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' })),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: mocks.execSync,
  }
})

vi.mock('../../src/commands/upgrade-helper.js', () => ({
  execNpmCommandSync: mocks.execNpmCommandSync,
  resolveCurrentGlobalInstallSurface: mocks.resolveCurrentGlobalInstallSurface,
  spawnDetachedDaemonUpgradeHelper: mocks.spawnDetachedDaemonUpgradeHelper,
}))

vi.mock('../../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/config.js')>()
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    saveConfig: mocks.saveConfig,
    updateConfig: mocks.updateConfig,
  }
})

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
    mocks.execNpmCommandSync.mockReset()
    mocks.resolveCurrentGlobalInstallSurface.mockClear()
    mocks.spawnDetachedDaemonUpgradeHelper.mockReset()
    mocks.loadConfig.mockReset()
    mocks.loadConfig.mockReturnValue({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' })
    mocks.saveConfig.mockReset()
    mocks.updateConfig.mockReset()
    mocks.execSync.mockImplementation((cmd: string) => {
      throw new Error(`direct execSync should not be used for daemon_upgrade npm calls: ${cmd}`)
    })
    mocks.execNpmCommandSync.mockImplementation((args: string[]) => {
      if (args.join(' ') === 'view adhdev@latest version') return '0.9.13\n'
      if (args.join(' ') === 'view adhdev@next version') return '0.9.14\n'
      if (args.join(' ') === 'ls -g adhdev --depth=0 --json') {
        return JSON.stringify({ dependencies: { adhdev: { version: '0.9.13' } } })
      }
      throw new Error(`unexpected npm args: ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('schedules a restart when the globally installed package is latest but the running daemon is stale', async () => {
    const router = createRouter('0.9.12')

    const result = await router.execute('daemon_upgrade', { channel: 'stable' })

    expect(result).toMatchObject({ success: true, upgraded: true, version: '0.9.13', restarting: true, channel: 'stable', npmTag: 'latest' })
    expect(mocks.execNpmCommandSync).toHaveBeenCalledWith(
      ['view', 'adhdev@latest', 'version'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 10000 }),
      expect.objectContaining({ npmExecutable: 'npm' }),
    )
    expect(mocks.execNpmCommandSync).toHaveBeenCalledWith(
      ['ls', '-g', 'adhdev', '--depth=0', '--json'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 10000 }),
      expect.objectContaining({ npmExecutable: 'npm' }),
    )
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledTimes(1)
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(expect.objectContaining({
      packageName: 'adhdev',
      targetVersion: '0.9.13',
    }))
  })

  it('ignores a deprecated channel arg and upgrades on the build track (Phase 3)', async () => {
    // Pre-Phase-3 callers may still pass channel:'preview'. The release
    // channel is now a build-time identity, so the arg is accepted and
    // ignored: the upgrade targets THIS build's dist-tag (@latest under the
    // test env's stable track) and never rewrites updateChannel/serverUrl.
    const router = createRouter('0.9.12')

    const result = await router.execute('daemon_upgrade', { channel: 'preview' })

    expect(result).toMatchObject({ success: true, upgraded: true, version: '0.9.13', restarting: true, channel: 'stable', npmTag: 'latest' })
    expect(mocks.execNpmCommandSync).toHaveBeenCalledWith(
      ['view', 'adhdev@latest', 'version'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 10000 }),
      expect.objectContaining({ npmExecutable: 'npm' }),
    )
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(expect.objectContaining({
      packageName: 'adhdev',
      targetVersion: '0.9.13',
    }))
    // The removed persist path must stay removed: no updateChannel/serverUrl
    // write — a self-hoster's custom serverUrl can never be clobbered here.
    expect(mocks.updateConfig).not.toHaveBeenCalled()
  })

  it('ignores updatePolicy.channel from a stale dashboard one-click upgrade payload', async () => {
    const router = createRouter('0.9.12')

    const result = await router.execute('daemon_upgrade', {
      updatePolicy: {
        channel: 'preview',
        npmTag: 'next',
        targetVersion: '0.9.14',
        updateCommand: 'adhdev update --channel preview',
      },
    })

    expect(result).toMatchObject({ success: true, upgraded: true, version: '0.9.13', restarting: true, channel: 'stable', npmTag: 'latest' })
    expect(mocks.execNpmCommandSync).toHaveBeenCalledWith(
      ['view', 'adhdev@latest', 'version'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 10000 }),
      expect.objectContaining({ npmExecutable: 'npm' }),
    )
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(expect.objectContaining({
      packageName: 'adhdev',
      targetVersion: '0.9.13',
    }))
    expect(mocks.updateConfig).not.toHaveBeenCalled()
  })

  it('preserves a user-configured custom serverUrl (self-host) across upgrade', async () => {
    // Self-hoster pinned a custom API endpoint; upgrade must not clobber it.
    mocks.loadConfig.mockReturnValue({ updateChannel: 'stable', serverUrl: 'https://adhdev.internal.example.com' })
    const router = createRouter('0.9.12')

    const result = await router.execute('daemon_upgrade', {})

    expect(result).toMatchObject({ success: true, upgraded: true, version: '0.9.13', channel: 'stable' })
    expect(mocks.updateConfig).not.toHaveBeenCalled()
  })

  it('never steers serverUrl to a vendor default on upgrade (Phase 3)', async () => {
    // Default (non-self-host) users: the old path rewrote serverUrl to the
    // channel vendor default. That write path is gone — serverUrl config is
    // owned by setup/env, not by upgrades.
    mocks.loadConfig.mockReturnValue({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' })
    const router = createRouter('0.9.12')

    await router.execute('daemon_upgrade', {})

    expect(mocks.updateConfig).not.toHaveBeenCalled()
  })
})
