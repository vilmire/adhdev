import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * D3 regression: the FALLBACK in-place upgrade path (the branch taken when no
 * installer-managed Windows pointer layout exists) had none of the conpty
 * protections the atomic path carries.
 *
 * A zero-exit `npm install` is not proof of a usable install: when node-pty is
 * rebuilt from source on a box with no build tools, the install script deletes
 * the shipped win32-x64 prebuild and leaves no conpty.node behind. npm reports
 * success, the helper restarted the daemon into it, and every create_session
 * then died in ~4ms with `Failed to load native module: conpty.node` — the exact
 * shape of the 2026-07-24 / 2026-08-02 production outages.
 *
 * Unlike the atomic path there is no pointer swap to roll back (the files are
 * already overwritten in place), so the protection is: throw BEFORE
 * spawnDetachedDaemonRestart, leaving the still-running daemon on the code it
 * already has loaded, and write an actionable failure notice.
 *
 * This mirrors `windows-atomic-upgrade.test.ts` → "refuses activation when the
 * staged conpty.node prebuild is missing".
 */

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })),
}))
vi.mock('child_process', () => mocks)

import { maybeRunDaemonUpgradeHelperFromEnv } from '../../src/commands/upgrade-helper'

const UPGRADE_HELPER_ENV = 'ADHDEV_DAEMON_UPGRADE_HELPER'

const tempRoots: string[] = []
let platformDescriptor: PropertyDescriptor | undefined
let exitSpy: ReturnType<typeof vi.spyOn>
let killSpy: ReturnType<typeof vi.spyOn>
let exitCodes: number[] = []
let savedArgv1: string | undefined
const savedEnv: Record<string, string | undefined> = {}

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-fallback-conpty-'))
  tempRoots.push(dir)
  return dir
}

/**
 * Stage a global npm install surface whose prefix has NO installer-managed
 * pointer layout, so `resolveWindowsInstallerLayout` returns null and the helper
 * takes the fallback in-place branch.
 */
function stageInstallSurface(homeDir: string, options: { withConpty: boolean }): {
  prefixRoot: string
  cliPath: string
  nodePath: string
} {
  const prefixRoot = path.join(homeDir, 'npm-prefix')
  const packageRoot = path.join(prefixRoot, 'node_modules', 'adhdev')
  const cliPath = path.join(packageRoot, 'dist', 'cli', 'index.js')
  const nodePath = path.join(prefixRoot, 'node.exe')
  const npmPath = path.join(prefixRoot, 'npm.cmd')

  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '1.0.0' }), 'utf8')
  fs.writeFileSync(cliPath, '// cli\n', 'utf8')
  fs.writeFileSync(nodePath, '#!node\n', 'utf8')
  fs.writeFileSync(npmPath, '@echo off\n', 'utf8')

  if (options.withConpty) {
    writeConpty(prefixRoot)
  }
  // resolveCurrentGlobalInstallSurface walks up from the RUNNING cli path
  // (process.argv[1]) to find the package root and its global prefix. Pin it to
  // this fixture so the helper installs into — and gates on — the staged tree.
  process.argv[1] = cliPath
  return { prefixRoot, cliPath, nodePath }
}

/** The exact path the conpty gate checks — matches the real Windows layout. */
function conptyPathFor(prefixRoot: string): string {
  return path.join(
    prefixRoot, 'node_modules', 'adhdev', 'node_modules', 'node-pty',
    'prebuilds', 'win32-x64', 'conpty.node',
  )
}

function writeConpty(prefixRoot: string): void {
  const conpty = conptyPathFor(prefixRoot)
  fs.mkdirSync(path.dirname(conpty), { recursive: true })
  fs.writeFileSync(conpty, 'conpty.node placeholder', 'utf8')
}

function runHelper(payload: Record<string, unknown>, configDir: string): Promise<boolean> {
  // The helper resolves its log/notice paths through getConfigDir(), and its
  // instance-conflict guard compares the payload against ADHDEV_CONFIG_DIR, so
  // both must name this test's temp instance.
  process.env.ADHDEV_CONFIG_DIR = configDir
  process.env[UPGRADE_HELPER_ENV] = JSON.stringify({ ...payload, configDir })
  return maybeRunDaemonUpgradeHelperFromEnv()
}

beforeEach(() => {
  mocks.execFileSync.mockReset()
  mocks.spawn.mockReset()
  mocks.spawn.mockImplementation(() => ({ unref: vi.fn(), pid: 4242 }))
  exitCodes = []

  for (const key of ['ADHDEV_CONFIG_DIR', 'HOME', 'USERPROFILE', UPGRADE_HELPER_ENV]) {
    savedEnv[key] = process.env[key]
  }

  savedArgv1 = process.argv[1]
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

  // The helper calls process.exit at the end of both branches; capture instead.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    return undefined as never
  }) as never)

  // waitForPidExit's signal-0 liveness probe: report "already gone" so the
  // parent-exit wait resolves immediately instead of spinning for 15s.
  killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
    if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  })
})

afterEach(() => {
  exitSpy.mockRestore()
  killSpy.mockRestore()
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  if (savedArgv1 === undefined) delete process.argv[1]
  else process.argv[1] = savedArgv1
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('fallback in-place upgrade — conpty verification gate', () => {
  it('throws before restarting the daemon when npm "succeeds" but leaves no conpty.node', async () => {
    const homeDir = makeTempHome()
    const configDir = path.join(homeDir, '.adhdev')
    fs.mkdirSync(configDir, { recursive: true })
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    // Install surface WITHOUT the prebuild: this is the source-rebuild-without-
    // build-tools outcome the gate exists to catch.
    const surface = stageInstallSurface(homeDir, { withConpty: false })

    // Every child_process call succeeds — including the npm install itself. The
    // install "works" by every signal npm gives us; only the missing file
    // distinguishes a broken install from a good one.
    mocks.execFileSync.mockImplementation(() => '')

    await runHelper({
      packageName: 'adhdev',
      targetVersion: '9.9.9',
      parentPid: 0,
      restartArgv: [surface.cliPath, 'daemon'],
    }, configDir)

    // The daemon must NOT have been restarted into the broken install.
    const restartSpawns = mocks.spawn.mock.calls
    expect(restartSpawns.length).toBe(0)

    // The helper's outer catch turns the throw into a failure exit.
    expect(exitCodes).toEqual([1])

    // An actionable notice reaches the user. The helper's outer catch rewrites
    // the notice file with its generic wrapper, so assert the specific
    // gate-authored guidance in the durable upgrade log (which keeps both).
    const notice = fs.readFileSync(path.join(configDir, 'daemon-upgrade-last-error.txt'), 'utf8')
    expect(notice).toMatch(/conpty\.node/)

    const log = fs.readFileSync(path.join(configDir, 'daemon-upgrade.log'), 'utf8')
    expect(log).toMatch(/Post-install conpty verification failed/)
    expect(log).toMatch(/was NOT restarted/)
    // The gate must fire before the restart is even attempted.
    expect(log).not.toMatch(/Restarting daemon with args/)
  })

  it('restarts the daemon normally when the install kept conpty.node', async () => {
    const homeDir = makeTempHome()
    const configDir = path.join(homeDir, '.adhdev')
    fs.mkdirSync(configDir, { recursive: true })
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    const surface = stageInstallSurface(homeDir, { withConpty: true })

    mocks.execFileSync.mockImplementation(() => '')

    await runHelper({
      packageName: 'adhdev',
      targetVersion: '9.9.9',
      parentPid: 0,
      restartArgv: [surface.cliPath, 'daemon'],
    }, configDir)

    // Control case: same flow, prebuild present → the restart proceeds and the
    // run exits successfully. This proves the gate is not simply always-throwing.
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0)
    expect(exitCodes).toEqual([0])
  })

  it('forces the shipped prebuild by pinning npm build-from-source=false on the install env', async () => {
    const homeDir = makeTempHome()
    const configDir = path.join(homeDir, '.adhdev')
    fs.mkdirSync(configDir, { recursive: true })
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    const surface = stageInstallSurface(homeDir, { withConpty: true })

    const installEnvs: NodeJS.ProcessEnv[] = []
    mocks.execFileSync.mockImplementation((_file: string, args: readonly string[], opts: any) => {
      if (Array.isArray(args) && args.includes('install') && opts?.env) {
        installEnvs.push(opts.env)
      }
      return ''
    })

    await runHelper({
      packageName: 'adhdev',
      targetVersion: '9.9.9',
      parentPid: 0,
      restartArgv: [surface.cliPath, 'daemon'],
    }, configDir)

    expect(installEnvs.length).toBeGreaterThan(0)
    for (const env of installEnvs) {
      // Both spellings: npm normalizes config keys inconsistently across versions,
      // and a machine/user .npmrc setting build-from-source=true would otherwise
      // trigger the source rebuild that deletes the prebuild.
      expect(env.npm_config_build_from_source).toBe('false')
      expect(env['npm_config_build-from-source']).toBe('false')
    }
  })
})
