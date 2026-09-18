import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression test for a path-substring leak in daemon_upgrade / daemon_restart
 * self-package-name detection.
 *
 * daemon-lifecycle.ts (low-family) decides whether THIS daemon is
 * '@adhdev/daemon-standalone' or 'adhdev' via:
 *
 *   ctx.deps.packageName === '@adhdev/daemon-standalone'
 *     || process.argv[1]?.includes('daemon-standalone')
 *
 * `ctx.deps.packageName` is never populated at the router's one real
 * construction site (oss/packages/daemon-core/src/boot/daemon-lifecycle.ts),
 * so in every real process this collapses to the argv fallback alone. The bug:
 * `.includes()` matches ANY substring, including an unrelated ancestor
 * directory name — e.g. a git worktree checked out at a path containing the
 * literal text "daemon-standalone" (as this repository's own worktrees do for
 * work items about this file). A cloud daemon ('adhdev') running under such a
 * worktree gets misdetected as standalone, flips `pkgName` to
 * '@adhdev/daemon-standalone', and every downstream npm call targets the
 * wrong package.
 *
 * This test pins the PROPERTY directly: package identity must depend only on
 * path SEGMENTS, not on substring position. It sets `packageName: 'adhdev'`
 * explicitly (the real, authoritative signal) and points `process.argv[1]` at
 * a path where "daemon-standalone" appears only as an unrelated substring
 * (mid-segment, not its own path component) — the exact shape of a worktree
 * directory like ".../fix-standalone-self-detection-argv-leak/..." or
 * ".../refactor/daemon-standalone-index-decompose/oss/...". The result must
 * stay 'adhdev'.
 */

const mocks = vi.hoisted(() => ({
  execNpmCommandSync: vi.fn<(args: string[], options?: Record<string, unknown>, surface?: Record<string, unknown>) => string>(),
  resolveCurrentGlobalInstallSurface: vi.fn((opts: { packageName: string }) => ({
    npmExecutable: 'npm',
    npmArgsPrefix: [],
    packageRoot: null,
    installPrefix: null,
    execOptions: { shell: false },
    packageName: opts.packageName,
  })),
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

/** Only the 'adhdev' dist-tag query is a valid npm call in these tests. Any
 * other package name (e.g. the leak flipping to '@adhdev/daemon-standalone')
 * throws — the same mechanism the pre-existing downgrade-guard suite uses to
 * catch a wrong pkgName reaching npm. */
function mockAdhdevOnlyNpmVersions(published: string, installed: string | null) {
  mocks.execNpmCommandSync.mockImplementation((args: string[]) => {
    const joined = args.join(' ')
    if (joined === 'view adhdev@latest version') return `${published}\n`
    if (joined === 'ls -g adhdev --depth=0 --json') {
      return installed === null ? '{}' : JSON.stringify({ dependencies: { adhdev: { version: installed } } })
    }
    throw new Error(`unexpected npm args: ${joined}`)
  })
}

describe('daemon_upgrade / daemon_restart — argv self-detection path-segment boundary', () => {
  const originalArgv1 = process.argv[1]

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
    process.argv[1] = originalArgv1
  })

  it.each([
    ['worktree dir name containing the substring', '/Users/x/worktrees/adhdev-cloud-mesh/fix-standalone-self-detection-argv-leak/oss/node_modules/vitest/dist/workers/forks.js'],
    ['sibling refactor branch dir name', '/Users/x/worktrees/adhdev-cloud-mesh/refactor/daemon-standalone-index-decompose/oss/node_modules/vitest/dist/workers/forks.js'],
  ])('daemon_upgrade: keeps pkgName "adhdev" when argv[1] contains "daemon-standalone" only as an unrelated substring (%s)', async (_label, argvPath) => {
    process.argv[1] = argvPath
    mockAdhdevOnlyNpmVersions('1.0.50', '1.0.49')
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', {})

    // Would throw 'unexpected npm args: view @adhdev/daemon-standalone@latest version'
    // and be swallowed into {success:false} if the leak were present.
    expect(result.success).toBe(true)
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'adhdev' }),
    )
  })

  it('daemon_upgrade: still detects standalone when argv[1] has "daemon-standalone" as a real path segment', async () => {
    process.argv[1] = '/usr/local/lib/node_modules/@adhdev/daemon-standalone/dist/index.js'
    mocks.execNpmCommandSync.mockImplementation((args: string[]) => {
      const joined = args.join(' ')
      if (joined === 'view @adhdev/daemon-standalone@latest version') return '1.0.50\n'
      if (joined === 'ls -g @adhdev/daemon-standalone --depth=0 --json') {
        return JSON.stringify({ dependencies: { '@adhdev/daemon-standalone': { version: '1.0.49' } } })
      }
      throw new Error(`unexpected npm args: ${joined}`)
    })
    const router = createRouter('1.0.49')

    const result: any = await router.execute('daemon_upgrade', {})

    expect(result.success).toBe(true)
    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: '@adhdev/daemon-standalone' }),
    )
  })

  it('daemon_restart: keeps pkgName "adhdev" when argv[1] contains "daemon-standalone" only as an unrelated substring', async () => {
    process.argv[1] = '/Users/x/worktrees/adhdev-cloud-mesh/fix-standalone-self-detection-argv-leak/oss/node_modules/vitest/dist/workers/forks.js'
    const router = createRouter('1.0.49')

    await router.execute('daemon_restart', {})

    expect(mocks.spawnDetachedDaemonUpgradeHelper).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'adhdev' }),
    )
  })
})
