import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression tests for the daemon_upgrade DOWNGRADE GUARD.
 *
 * INCIDENT REPRODUCED (2026-08-14, twice in one day): a coordinator called
 * mesh_restart_daemon(mode:'upgrade') against a node running 1.0.49-rc.2
 * (preview). That node's install surface resolved the dist-tag to 1.0.48, and
 * the old code — which only compared `currentInstalled === latest` for the
 * no-op case — installed it because it merely DIFFERED. The node was rolled
 * back with no warning, and afterwards could not launch sessions at all
 * ("Provider not found: claude-cli"), so it could not even be sent a task to
 * repair itself.
 *
 * The guard is deliberately asymmetric. Test 2 ("normal upgrade still
 * proceeds") is the load-bearing one: a guard that over-blocks would freeze
 * fleet-wide upgrades with no remote way to unfreeze them, which is strictly
 * worse than the bug it fixes. Every ambiguous case therefore FAILS OPEN, and
 * these tests pin that direction explicitly.
 *
 * Routed through the real DaemonCommandRouter (not the handler in isolation)
 * so the arg plumbing the mesh path actually uses is exercised.
 */

const mocks = vi.hoisted(() => ({
  execNpmCommandSync: vi.fn<(args: string[], options?: Record<string, unknown>, surface?: Record<string, unknown>) => string>(),
  resolveCurrentGlobalInstallSurface: vi.fn(() => ({ npmExecutable: 'npm', npmArgsPrefix: [], packageRoot: null, installPrefix: null, execOptions: { shell: false } })),
  spawnDetachedDaemonUpgradeHelper: vi.fn(),
  getUpgradeLogPath: vi.fn(() => '/tmp/adhdev-test-config/daemon-upgrade.log'),
  loadConfig: vi.fn(() => ({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' })),
  updateConfig: vi.fn(),
}))

vi.mock('../../src/commands/upgrade-helper.js', () => ({
  execNpmCommandSync: mocks.execNpmCommandSync,
  resolveNpmPublishedVersion: (packageName: string, tagOrVersion: string, surface?: Record<string, unknown>) =>
    String(mocks.execNpmCommandSync(['view', `${packageName}@${tagOrVersion}`, 'version'], { encoding: 'utf-8', timeout: 10_000 }, surface)).trim(),
  resolveCurrentGlobalInstallSurface: mocks.resolveCurrentGlobalInstallSurface,
  spawnDetachedDaemonUpgradeHelper: mocks.spawnDetachedDaemonUpgradeHelper,
  getUpgradeLogPath: mocks.getUpgradeLogPath,
}))

vi.mock('../../src/config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/config.js')>()
  return { ...actual, loadConfig: mocks.loadConfig, updateConfig: mocks.updateConfig }
})

import { DaemonCommandRouter } from '../../src/commands/router'

function createRouter(statusVersion: string) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    packageName: 'adhdev',
    statusVersion,
  })
}

/** Point the npm mocks at a given dist-tag version + globally-installed version. */
function setNpmVersions(published: string, installed: string | null) {
  mocks.execNpmCommandSync.mockImplementation((args: string[]) => {
    const joined = args.join(' ')
    if (joined === 'view adhdev@latest version') return `${published}\n`
    if (joined === 'ls -g adhdev --depth=0 --json') {
      return installed === null ? '{}' : JSON.stringify({ dependencies: { adhdev: { version: installed } } })
    }
    throw new Error(`unexpected npm args: ${joined}`)
  })
}

describe('daemon_upgrade downgrade guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.execNpmCommandSync.mockReset()
    mocks.resolveCurrentGlobalInstallSurface.mockClear()
    mocks.spawnDetachedDaemonUpgradeHelper.mockReset()
    mocks.loadConfig.mockReset()
    mocks.loadConfig.mockReturnValue({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' })
    mocks.updateConfig.mockReset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('refuses the exact incident: running 1.0.49-rc.2, dist-tag resolves to 1.0.48', async () => {
    setNpmVersions('1.0.48', '1.0.48')
    const router = createRouter('1.0.49-rc.2')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result).toMatchObject({
      success: false,
      upgraded: false,
      restarting: false,
      code: 'downgrade_refused',
      currentVersion: '1.0.49-rc.2',
      targetVersion: '1.0.48',
    })
    // The diagnosis fields that were missing during the real incident.
    expect(result.channel).toBeTruthy()
    expect(result.npmTag).toBeTruthy()
    expect(result.packageName).toBe('adhdev')
    expect(result.reason).toContain('DOWNGRADE')
    expect(result.reason).toContain('1.0.49-rc.2')
    expect(result.reason).toContain('1.0.48')
    // THE point of the guard: the daemon is untouched. No detached helper, so
    // no npm install and no process.exit(0) three seconds later.
    expect(mocks.spawnDetachedDaemonUpgradeHelper).not.toHaveBeenCalled()
  })

  it('★does NOT block a normal upgrade — the load-bearing regression guard', async () => {
    // If this ever fails, the fleet cannot be upgraded remotely at all.
    setNpmVersions('1.0.50', '1.0.49')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result).toMatchObject({ success: true, upgraded: true, restarting: true, targetVersion: '1.0.50' })
    expect(result.code).toBeUndefined()
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledTimes(1)
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'adhdev', targetVersion: '1.0.50' }),
    )
  })

  it('does not block an upgrade that moves a prerelease forward to its release', async () => {
    // 1.0.49-rc.2 → 1.0.49 is the normal preview→stable graduation and is an
    // ASCENT under semver §11. It must not be caught by the guard.
    setNpmVersions('1.0.49', '1.0.49')
    const router = createRouter('1.0.49-rc.2')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.code).toBeUndefined()
    expect(result.success).toBe(true)
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(
      expect.objectContaining({ targetVersion: '1.0.49' }),
    )
  })

  it('does not block an rc → later rc upgrade', async () => {
    setNpmVersions('1.0.49-rc.10', '1.0.49-rc.2')
    const router = createRouter('1.0.49-rc.2')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.code).toBeUndefined()
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(
      expect.objectContaining({ targetVersion: '1.0.49-rc.10' }),
    )
  })

  it('leaves the already-latest no-op intact (same version is not a downgrade)', async () => {
    setNpmVersions('1.0.49', '1.0.49')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result).toMatchObject({ success: true, upgraded: false, alreadyLatest: true, outcome: 'already_latest' })
    expect(result.code).toBeUndefined()
    expect(mocks.spawnDetachedDaemonUpgradeHelper).not.toHaveBeenCalled()
  })

  it('re-installs the same version when the running daemon is stale (equal is not a downgrade)', async () => {
    // Installed package already at target but the PROCESS is older — the
    // pre-existing "schedule a restart" path. Equal-or-newer target, so the
    // guard must stay out of the way.
    setNpmVersions('1.0.49', '1.0.49')
    const router = createRouter('1.0.48')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.code).toBeUndefined()
    expect(result.success).toBe(true)
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledTimes(1)
  })

  it('allowDowngrade:true forces the rollback and marks it in the response', async () => {
    setNpmVersions('1.0.48', '1.0.48')
    const router = createRouter('1.0.49-rc.2')

    const result: any = await router.execute('daemon_upgrade', { allowDowngrade: true })

    expect(result).toMatchObject({ success: true, upgraded: true, downgrade: true, targetVersion: '1.0.48' })
    expect(result.code).toBeUndefined()
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(
      expect.objectContaining({ targetVersion: '1.0.48' }),
    )
  })

  it('fails OPEN when the running version is unknown', async () => {
    // statusVersion unset in some embeddings. Unknown direction must never
    // block an upgrade.
    setNpmVersions('1.0.48', '1.0.48')
    const router = createRouter('')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.code).toBeUndefined()
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledTimes(1)
  })

  it('fails OPEN when the running version is unparsable', async () => {
    setNpmVersions('1.0.48', '1.0.48')
    const router = createRouter('dev-build')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.code).toBeUndefined()
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledTimes(1)
  })

  it('tolerates a leading v on the running version', async () => {
    // statusVersion is trimmed of a leading `v` before comparison; make sure
    // that path still detects the downgrade rather than failing open.
    setNpmVersions('1.0.48', '1.0.48')
    const router = createRouter('v1.0.49-rc.2')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.code).toBe('downgrade_refused')
    expect(mocks.spawnDetachedDaemonUpgradeHelper).not.toHaveBeenCalled()
  })

  it('refuses on a major/minor regression, not just a patch one', async () => {
    setNpmVersions('0.9.82', '0.9.82')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result).toMatchObject({ code: 'downgrade_refused', currentVersion: '1.0.49', targetVersion: '0.9.82' })
    expect(mocks.spawnDetachedDaemonUpgradeHelper).not.toHaveBeenCalled()
  })
})

describe('daemon_upgrade channel-hint acknowledgement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.execNpmCommandSync.mockReset()
    mocks.spawnDetachedDaemonUpgradeHelper.mockReset()
    mocks.loadConfig.mockReset()
    mocks.loadConfig.mockReturnValue({ updateChannel: 'stable', serverUrl: 'https://api.adhf.dev' })
    mocks.updateConfig.mockReset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('reports channelOverride when the requested channel conflicts with the build track', async () => {
    // The second half of the incident: the coordinator asked for
    // channel:'preview' and read back channel:'stable' with nothing saying the
    // request had been overridden. Behavior is unchanged (still ignored — the
    // track is a build identity) but it is no longer silent.
    setNpmVersions('1.0.50', '1.0.49')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', { channel: 'preview' })

    expect(result.success).toBe(true)
    expect(result.channelOverride).toMatchObject({
      requestedChannel: 'preview',
      effectiveChannel: 'stable',
      effectiveNpmTag: 'latest',
      ignored: true,
    })
    expect(result.channelOverride.reason).toContain('IGNORED')
    // Unchanged behavior: still upgrades on the build track, never switches.
    expect(result.channel).toBe('stable')
    expect(mocks.execNpmCommandSync).toHaveBeenCalledWith(
      ['view', 'adhdev@latest', 'version'],
      expect.anything(),
      expect.anything(),
    )
    expect(mocks.updateConfig).not.toHaveBeenCalled()
  })

  it('reports channelOverride from a stale dashboard updatePolicy payload too', async () => {
    setNpmVersions('1.0.50', '1.0.49')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', {
      updatePolicy: { channel: 'preview', npmTag: 'next', targetVersion: '1.0.60' },
    })

    expect(result.channelOverride).toMatchObject({ requestedChannel: 'preview', effectiveChannel: 'stable' })
  })

  it('stays silent when the requested channel matches the build track', async () => {
    // No override happened, so there is nothing to warn about. Flagging a
    // non-conflict would be noise that trains callers to ignore the field.
    setNpmVersions('1.0.50', '1.0.49')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', { channel: 'stable' })

    expect(result.channelOverride).toBeUndefined()
  })

  it('stays silent on a bare call with no channel hint', async () => {
    setNpmVersions('1.0.50', '1.0.49')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.channelOverride).toBeUndefined()
  })

  it('reports channelOverride on the downgrade refusal as well', async () => {
    setNpmVersions('1.0.48', '1.0.48')
    const router = createRouter('1.0.49-rc.2')

    const result: any = await router.execute('daemon_upgrade', { channel: 'preview' })

    expect(result.code).toBe('downgrade_refused')
    expect(result.channelOverride).toMatchObject({ requestedChannel: 'preview', ignored: true })
  })
})
