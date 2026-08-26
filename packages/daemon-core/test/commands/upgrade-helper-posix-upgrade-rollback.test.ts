import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POSIX upgrade orphaning regression (2026-08-26 rc.17 incident).
 *
 * rc.17 was a broken package: it INSTALLED cleanly but the CLI died instantly
 * on `--version`. win32 survived because the installer-managed atomic path
 * stages a new prefix and gates it before flipping the pointer. POSIX ran
 * `npm install -g --force` IN PLACE over the live prefix with no gate and no
 * rollback, then re-spawned the daemon into the broken tree — bricking the
 * CLI and the daemon together; only a manual npm reinstall recovered the box.
 *
 * These tests stage a fake global install in a temp dir (all paths injected —
 * nothing touches the real npm prefix or the live ~/.adhdev profile) and drive
 * the helper with a mock npm whose install "succeeds" while the installed CLI
 * cannot run, reproducing rc.17 exactly:
 *
 *   - pre-fix (red): the live prefix is overwritten with the broken package
 *     and the daemon is re-spawned into it → bricked.
 *   - post-fix (green): a pre-flight smoke gate on a throwaway prefix aborts
 *     the upgrade BEFORE the live install is touched, and the daemon is
 *     re-spawned on the untouched previous version.
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
let exitCodes: number[] = []
let savedArgv1: string | undefined
const savedEnv: Record<string, string | undefined> = {}

function makeTempHome(): string {
  // Resolve symlinks up front: the helper realpath()s the CLI path before
  // deriving the install prefix, and on macOS os.tmpdir() is /var/folders →
  // /private/var/folders. Comparing against the unresolved path would never
  // match the prefix the helper actually installs into.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-posix-upgrade-')))
  tempRoots.push(dir)
  return dir
}

/**
 * Stage a POSIX global install surface: <prefix>/node_modules/adhdev (v1.0.0,
 * working) + <prefix>/bin/adhdev shim. process.argv[1] is pinned into the
 * package so resolveCurrentGlobalInstallSurface resolves THIS temp prefix.
 */
function stageLiveInstall(homeDir: string): { prefixRoot: string; packageRoot: string; binShim: string } {
  const prefixRoot = path.join(homeDir, 'npm-prefix')
  const packageRoot = path.join(prefixRoot, 'node_modules', 'adhdev')
  const binShim = path.join(prefixRoot, 'bin', 'adhdev')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(path.dirname(binShim), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '1.0.0' }), 'utf8')
  fs.writeFileSync(path.join(packageRoot, 'cli.js'), '// cli v1\n', 'utf8')
  fs.writeFileSync(binShim, '#!/bin/sh\nexec node cli.js\n', 'utf8')
  process.argv[1] = path.join(packageRoot, 'cli.js')
  return { prefixRoot, packageRoot, binShim }
}

function installedVersion(packageRoot: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** Simulate npm's in-place swap: delete the old tree, write the new one. */
function simulateNpmInstall(prefix: string, version: string): void {
  const pkgRoot = path.join(prefix, 'node_modules', 'adhdev')
  fs.rmSync(pkgRoot, { recursive: true, force: true })
  fs.mkdirSync(pkgRoot, { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version }), 'utf8')
  fs.writeFileSync(path.join(pkgRoot, 'cli.js'), `// cli v${version}\n`, 'utf8')
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(prefix, 'bin', 'adhdev'), '#!/bin/sh\nexec node cli.js\n', 'utf8')
}

type FakePackage = 'broken' | 'working'

/**
 * Mock every child_process call. `install` performs the file swap into
 * whichever --prefix it was given; `--version` succeeds or dies depending on
 * the injected package quality. Anything else (`npm root -g`, …) succeeds
 * quietly.
 */
function mockNpmWithPackage(quality: FakePackage): void {
  mocks.execFileSync.mockImplementation((_file: string, args: readonly string[]) => {
    const argv = [...args]
    if (argv.includes('--version')) {
      if (quality === 'broken') {
        throw Object.assign(new Error('rc.17 clone: CLI dies instantly'), { status: 1 })
      }
      return '2.0.0\n'
    }
    if (argv.includes('install')) {
      const prefix = argv[argv.indexOf('--prefix') + 1]
      simulateNpmInstall(prefix, '2.0.0')
      return ''
    }
    return ''
  })
}

/** npm dies MID-SWAP: old tree deleted, nothing written, non-zero exit. */
function mockNpmInstallCrash(prefixToCorrupt: string): void {
  mocks.execFileSync.mockImplementation((_file: string, args: readonly string[]) => {
    const argv = [...args]
    if (argv.includes('--version')) return '2.0.0\n'
    if (argv.includes('install')) {
      const prefix = argv[argv.indexOf('--prefix') + 1]
      if (prefix === prefixToCorrupt) {
        fs.rmSync(path.join(prefix, 'node_modules', 'adhdev'), { recursive: true, force: true })
        throw Object.assign(new Error('simulated npm failure mid-swap'), { status: 1 })
      }
      simulateNpmInstall(prefix, '2.0.0')
      return ''
    }
    return ''
  })
}

function runHelper(payload: Record<string, unknown>, configDir: string): Promise<boolean> {
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
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    return undefined as never
  }) as never)
})

afterEach(() => {
  exitSpy.mockRestore()
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  if (savedArgv1 === undefined) delete process.argv[1]
  else process.argv[1] = savedArgv1
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('POSIX in-place upgrade — pre-flight gate + rollback', () => {
  it('aborts before touching the live install when the target package installs but its CLI cannot run (rc.17)', async () => {
    const homeDir = makeTempHome()
    const configDir = path.join(homeDir, '.adhdev')
    fs.mkdirSync(configDir, { recursive: true })
    process.env.HOME = homeDir
    const live = stageLiveInstall(homeDir)
    mockNpmWithPackage('broken')

    await runHelper({
      packageName: 'adhdev',
      targetVersion: '2.0.0',
      parentPid: 0,
      restartArgv: [path.join(live.packageRoot, 'cli.js'), 'daemon'],
      sessionHostAppName: 'adhdev',
    }, configDir)

    // ① The live install was NEVER overwritten: still v1.0.0, CLI intact.
    expect(installedVersion(live.packageRoot)).toBe('1.0.0')
    expect(fs.existsSync(live.binShim)).toBe(true)

    // The broken package was only ever installed into a throwaway pre-flight
    // prefix — npm never ran install against the live prefix.
    const liveInstalls = mocks.execFileSync.mock.calls.filter(([, args]) => {
      const argv = args as string[]
      return argv.includes('install') && argv[argv.indexOf('--prefix') + 1] === live.prefixRoot
    })
    expect(liveInstalls.length).toBe(0)
    // Pre-flight staging was cleaned up.
    expect(fs.readdirSync(configDir).filter((e) => e.startsWith('upgrade-preflight-')).length).toBe(0)

    // ② The daemon was re-spawned on the previous version (the helper's caller
    // has already exited — leaving it dead is the other half of the incident).
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0)

    // Failure is durable and actionable, and the run exits non-zero. The
    // helper's outer catch rewrites the notice with its generic wrapper
    // carrying the thrown error's message; the gate-authored specifics stay
    // in the durable upgrade log (same pattern as the conpty gate).
    expect(exitCodes).toEqual([1])
    const notice = fs.readFileSync(path.join(configDir, 'daemon-upgrade-last-error.txt'), 'utf8')
    expect(notice).toMatch(/Pre-flight smoke gate failed for adhdev@2\.0\.0/)
    const log = fs.readFileSync(path.join(configDir, 'daemon-upgrade.log'), 'utf8')
    expect(log).toMatch(/Pre-flight smoke gate FAILED/)
  })

  it('rolls back and restarts the daemon when npm dies mid-swap, leaving the old CLI working', async () => {
    const homeDir = makeTempHome()
    const configDir = path.join(homeDir, '.adhdev')
    fs.mkdirSync(configDir, { recursive: true })
    process.env.HOME = homeDir
    const live = stageLiveInstall(homeDir)
    mockNpmInstallCrash(live.prefixRoot)

    await runHelper({
      packageName: 'adhdev',
      targetVersion: '2.0.0',
      parentPid: 0,
      restartArgv: [path.join(live.packageRoot, 'cli.js'), 'daemon'],
      sessionHostAppName: 'adhdev',
    }, configDir)

    // The half-deleted package tree was restored from the snapshot.
    expect(installedVersion(live.packageRoot)).toBe('1.0.0')
    expect(fs.existsSync(live.binShim)).toBe(true)
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0)
    expect(exitCodes).toEqual([1])
    const log = fs.readFileSync(path.join(configDir, 'daemon-upgrade.log'), 'utf8')
    expect(log).toMatch(/Rollback restored the previous install/)
  })

  it('rolls back when the in-place install diverges from the pre-flight result', async () => {
    const homeDir = makeTempHome()
    const configDir = path.join(homeDir, '.adhdev')
    fs.mkdirSync(configDir, { recursive: true })
    process.env.HOME = homeDir
    const live = stageLiveInstall(homeDir)
    // Pre-flight passes (working), but the live install's CLI then fails the
    // post-install smoke test — only the live prefix's shim is broken.
    mocks.execFileSync.mockImplementation((_file: string, args: readonly string[]) => {
      const argv = [...args]
      if (argv.includes('--version')) {
        const shim = String(_file)
        if (shim.startsWith(live.prefixRoot)) {
          throw Object.assign(new Error('live CLI broken after swap'), { status: 1 })
        }
        return '2.0.0\n'
      }
      if (argv.includes('install')) {
        simulateNpmInstall(argv[argv.indexOf('--prefix') + 1], '2.0.0')
        return ''
      }
      return ''
    })

    await runHelper({
      packageName: 'adhdev',
      targetVersion: '2.0.0',
      parentPid: 0,
      restartArgv: [path.join(live.packageRoot, 'cli.js'), 'daemon'],
      sessionHostAppName: 'adhdev',
    }, configDir)

    expect(installedVersion(live.packageRoot)).toBe('1.0.0')
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0)
    expect(exitCodes).toEqual([1])
    const log = fs.readFileSync(path.join(configDir, 'daemon-upgrade.log'), 'utf8')
    expect(log).toMatch(/Rollback restored the previous install/)
  })

  it('upgrades cleanly when the target package is healthy (regression: normal path intact)', async () => {
    const homeDir = makeTempHome()
    const configDir = path.join(homeDir, '.adhdev')
    fs.mkdirSync(configDir, { recursive: true })
    process.env.HOME = homeDir
    const live = stageLiveInstall(homeDir)
    // A previous failure notice must be cleared by the successful run.
    fs.writeFileSync(path.join(configDir, 'daemon-upgrade-last-error.txt'), '[2026-08-26T00:00:00.000Z]\nold failure\n', 'utf8')
    mockNpmWithPackage('working')

    await runHelper({
      packageName: 'adhdev',
      targetVersion: '2.0.0',
      parentPid: 0,
      restartArgv: [path.join(live.packageRoot, 'cli.js'), 'daemon'],
      sessionHostAppName: 'adhdev',
    }, configDir)

    // The live install was upgraded to 2.0.0 and the daemon re-spawned.
    expect(installedVersion(live.packageRoot)).toBe('2.0.0')
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0)
    expect(exitCodes).toEqual([0])
    // Backup and pre-flight scratch dirs are cleaned up; the stale notice is gone.
    expect(fs.existsSync(path.join(configDir, 'daemon-upgrade-last-error.txt'))).toBe(false)
    const leftovers = fs.readdirSync(configDir).filter((e) => e.startsWith('upgrade-preflight-') || e.startsWith('upgrade-backup-'))
    expect(leftovers).toEqual([])
  })
})
