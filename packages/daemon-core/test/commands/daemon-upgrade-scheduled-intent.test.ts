import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Intent-vs-result contract for daemon_upgrade / daemon_restart (A + B) and
 * post-hoc observability (C):
 *
 * The command response goes out seconds BEFORE the daemon exits; the detached
 * helper decides the real outcome (npm install / staged verification / health
 * gate / rollback) tens of seconds to ~120s later, with no channel back to
 * the caller. So the response must:
 *   - say "scheduled" explicitly (`outcome: 'scheduled'`),
 *   - name the version as a TARGET (`targetVersion`), not the current version,
 *   - hand the caller the diagnosis path (`upgradeLogPath`) — the helper's
 *     trace lands in <configDir>/daemon-upgrade.log, never in the daemon log,
 *   - keep every legacy field (`upgraded` / `version` / `restarted` /
 *     `restarting`) intact so existing callers keep working.
 * And get_status_metadata must surface a failed/rolled-back upgrade after the
 * fact via `upgradeFailure` (the durable notice the helper leaves behind).
 *
 * Reverting daemon-lifecycle.ts / status-meta.ts to the bare legacy responses
 * turns these tests red.
 */

const mocks = vi.hoisted(() => ({
  execNpmCommandSync: vi.fn<(args: string[], options?: Record<string, unknown>, surface?: Record<string, unknown>) => string>(),
  resolveCurrentGlobalInstallSurface: vi.fn(() => ({ npmExecutable: 'npm', npmArgsPrefix: [], packageRoot: null, installPrefix: null, execOptions: { shell: false } })),
  spawnDetachedDaemonUpgradeHelper: vi.fn(),
  getUpgradeLogPath: vi.fn(() => '/tmp/adhdev-intent-test/daemon-upgrade.log'),
  readUpgradeFailureNotice: vi.fn(() => null as null | { noticePath: string; logPath: string; notice: string }),
  loadConfig: vi.fn(() => ({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' })),
  updateConfig: vi.fn(),
  buildStatusSnapshot: vi.fn(() => ({ instanceId: 'daemon_test' })),
  buildMachineInfo: vi.fn(() => ({})),
  getDaemonBuildInfo: vi.fn(() => ({ sha: 'test' })),
}))

vi.mock('../../src/commands/upgrade-helper.js', () => ({
  execNpmCommandSync: mocks.execNpmCommandSync,
  resolveCurrentGlobalInstallSurface: mocks.resolveCurrentGlobalInstallSurface,
  spawnDetachedDaemonUpgradeHelper: mocks.spawnDetachedDaemonUpgradeHelper,
  getUpgradeLogPath: mocks.getUpgradeLogPath,
  readUpgradeFailureNotice: mocks.readUpgradeFailureNotice,
}))

vi.mock('../../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/config.js')>()
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    updateConfig: mocks.updateConfig,
  }
})

vi.mock('../../src/status/snapshot.js', () => ({
  buildStatusSnapshot: mocks.buildStatusSnapshot,
  buildMachineInfo: mocks.buildMachineInfo,
}))

vi.mock('../../src/build-info.js', () => ({
  getDaemonBuildInfo: mocks.getDaemonBuildInfo,
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

describe('daemon_upgrade / daemon_restart — scheduled intent vs completed result', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.execNpmCommandSync.mockReset()
    mocks.spawnDetachedDaemonUpgradeHelper.mockReset()
    mocks.getUpgradeLogPath.mockClear()
    mocks.readUpgradeFailureNotice.mockReset()
    mocks.readUpgradeFailureNotice.mockReturnValue(null)
    mocks.execNpmCommandSync.mockImplementation((args: string[]) => {
      if (args.join(' ') === 'view adhdev@latest version') return '0.9.13\n'
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

  it('daemon_upgrade reports outcome "scheduled" + targetVersion, not a completed upgrade', async () => {
    const router = createRouter('0.9.12')

    const result = await router.execute('daemon_upgrade', {}) as any

    // The honest signal: scheduled, not done. The version is a TARGET.
    expect(result.outcome).toBe('scheduled')
    expect(result.targetVersion).toBe('0.9.13')
    expect(result.clientHint).toMatch(/SCHEDULED, not completed/i)
    // Diagnosis path handed to the caller (B).
    expect(result.upgradeLogPath).toBe('/tmp/adhdev-intent-test/daemon-upgrade.log')
    // Legacy contract intact: existing callers reading upgraded/version/
    // restarting keep working unchanged.
    expect(result).toMatchObject({ success: true, upgraded: true, version: '0.9.13', restarting: true })
    // The response must NOT claim the daemon is already on the target version.
    expect(result.upgradeCompleted).toBeUndefined()
    expect(result.currentVersion).toBeUndefined()
  })

  it('daemon_upgrade already-latest stays a no-op with an explicit outcome', async () => {
    const router = createRouter('0.9.13')

    const result = await router.execute('daemon_upgrade', {}) as any

    expect(result).toMatchObject({ success: true, upgraded: false, alreadyLatest: true, version: '0.9.13' })
    expect(result.outcome).toBe('already_latest')
    expect(mocks.spawnDetachedDaemonUpgradeHelper).not.toHaveBeenCalled()
  })

  it('daemon_restart reports outcome "scheduled" with the diagnosis path', async () => {
    const router = createRouter('0.9.13')

    const result = await router.execute('daemon_restart', {}) as any

    expect(result.outcome).toBe('scheduled')
    expect(result.upgradeLogPath).toBe('/tmp/adhdev-intent-test/daemon-upgrade.log')
    expect(result.clientHint).toMatch(/SCHEDULED, not completed/i)
    // Legacy contract intact.
    expect(result).toMatchObject({ success: true, restarted: true, restarting: true, mode: 'restart', killSessionHost: false })
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(expect.objectContaining({ skipInstall: true }))
  })

  it('get_status_metadata exposes a failed/rolled-back upgrade via upgradeFailure (C)', async () => {
    const notice = {
      noticePath: '/tmp/adhdev-intent-test/daemon-upgrade-last-error.txt',
      logPath: '/tmp/adhdev-intent-test/daemon-upgrade.log',
      notice: 'adhdev adhdev@0.9.13 upgrade failed and was rolled back: health gate timed out',
    }
    mocks.readUpgradeFailureNotice.mockReturnValue(notice)
    const router = createRouter('0.9.12')

    const result = await router.execute('get_status_metadata', {}) as any

    expect(result.success).toBe(true)
    expect(result.upgradeFailure).toEqual(notice)
  })

  it('get_status_metadata reports upgradeFailure: null when no upgrade failed', async () => {
    const router = createRouter('0.9.13')

    const result = await router.execute('get_status_metadata', {}) as any

    expect(result.success).toBe(true)
    expect(result.upgradeFailure).toBeNull()
  })
})
