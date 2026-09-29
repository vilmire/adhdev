import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POSIX boot health gate regression (2026-09-27 rc.62 incident).
 *
 * rc.62 installed cleanly and its CLI answered `--version`, so it passed the
 * POSIX pre-flight + post-install smoke gates — and then the DAEMON crashed on
 * boot on every machine. Windows rolled back on its own (atomic prefix +
 * health/version gate); macOS and Linux re-spawned the daemon into the broken
 * install, exited, and stayed dead until the owner restarted them by hand.
 *
 * These tests drive the real helper end to end with only the edges faked:
 *   - npm / `--version` via a mocked child_process.execFileSync (installs write
 *     a fake package tree into a temp prefix — nothing global is touched);
 *   - the daemon via a mocked child_process.spawn that either "crashes on boot"
 *     (the child emits a non-zero exit) or "boots" by serving a fake
 *     /health + /api/v1/status on an ephemeral loopback port, which the restart
 *     argv names with `-p` so the REAL probe code is exercised and no real
 *     daemon port (19222/19223) is ever touched.
 * Every pid a fake reports is above any OS pid_max, so the gate's stop step can
 * never signal a real process.
 */

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('child_process', () => mocks)

import { maybeRunDaemonUpgradeHelperFromEnv } from '../../src/commands/upgrade-helper'

const UPGRADE_HELPER_ENV = 'ADHDEV_DAEMON_UPGRADE_HELPER'
const FAKE_DAEMON_PID = 2_000_000_002
const FAKE_SPAWN_PID = 2_000_000_003

const tempRoots: string[] = []
let platformDescriptor: PropertyDescriptor | undefined
let exitSpy: ReturnType<typeof vi.spyOn>
let exitCodes: number[] = []
let savedArgv1: string | undefined
const savedEnv: Record<string, string | undefined> = {}

function makeTempHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-posix-bootgate-')))
  tempRoots.push(dir)
  return dir
}

function stageLiveInstall(homeDir: string): { prefixRoot: string; packageRoot: string } {
  const prefixRoot = path.join(homeDir, 'npm-prefix')
  const packageRoot = path.join(prefixRoot, 'node_modules', 'adhdev')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(path.join(prefixRoot, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '1.0.0' }), 'utf8')
  fs.writeFileSync(path.join(packageRoot, 'cli.js'), '// cli v1\n', 'utf8')
  fs.writeFileSync(path.join(prefixRoot, 'bin', 'adhdev'), '#!/bin/sh\nexec node cli.js\n', 'utf8')
  process.argv[1] = path.join(packageRoot, 'cli.js')
  return { prefixRoot, packageRoot }
}

function installedVersion(packageRoot: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function simulateNpmInstall(prefix: string, version: string): void {
  const pkgRoot = path.join(prefix, 'node_modules', 'adhdev')
  fs.rmSync(pkgRoot, { recursive: true, force: true })
  fs.mkdirSync(pkgRoot, { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version }), 'utf8')
  fs.writeFileSync(path.join(pkgRoot, 'cli.js'), `// cli v${version}\n`, 'utf8')
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(prefix, 'bin', 'adhdev'), '#!/bin/sh\nexec node cli.js\n', 'utf8')
}

/**
 * npm installs whatever `<pkg>@<version>` the argv names; `--version` always
 * works (rc.62's CLI did). `failVersions` makes an install of that version
 * throw — used to break the reinstall-previous fallback.
 */
function mockNpm(options: { failVersions?: string[] } = {}): void {
  mocks.execFileSync.mockImplementation((_file: string, args: readonly string[]) => {
    const argv = [...args]
    if (argv.includes('--version')) return '2.0.0\n'
    if (argv.includes('install')) {
      const spec = argv.find((a) => a.startsWith('adhdev@')) ?? 'adhdev@2.0.0'
      const version = spec.slice('adhdev@'.length)
      if (options.failVersions?.includes(version)) {
        throw Object.assign(new Error(`simulated npm failure installing ${spec}`), { status: 1 })
      }
      simulateNpmInstall(argv[argv.indexOf('--prefix') + 1], version)
      return ''
    }
    return ''
  })
}

/** A fake daemon IPC endpoint: /health + /api/v1/status on a fixed loopback port. */
class FakeDaemonPort {
  port = 0
  private server: http.Server | null = null
  private version: string | null = null

  async reserve(): Promise<number> {
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    this.port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return this.port
  }

  async serve(version: string): Promise<void> {
    this.version = version
    if (this.server) return
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/health') {
        res.end(JSON.stringify({ ok: true, pid: FAKE_DAEMON_PID, wsPath: '/ipc', port: this.port }))
        return
      }
      res.end(JSON.stringify({ ok: true, pid: FAKE_DAEMON_PID, status: { version: this.version } }))
    })
    this.server = server
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve))
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

type SpawnBehavior = { crash: true; beforeExit?: () => void } | { serve: string }

/**
 * Script the successive daemon spawns: the first is the replacement daemon,
 * later ones are rollback restarts. Past the end of the script every spawn
 * crashes.
 */
function scriptSpawns(fake: FakeDaemonPort, script: SpawnBehavior[]): void {
  let index = 0
  mocks.spawn.mockImplementation(() => {
    const behavior = script[index++] ?? { crash: true }
    const child = Object.assign(new EventEmitter(), { pid: FAKE_SPAWN_PID, unref: vi.fn() })
    if ('crash' in behavior) {
      behavior.beforeExit?.()
      setTimeout(() => child.emit('exit', 1, null), 20)
    } else {
      void fake.serve(behavior.serve)
    }
    return child
  })
}

function runHelper(configDir: string, port: number, livePackageRoot: string): Promise<boolean> {
  process.env.ADHDEV_CONFIG_DIR = configDir
  process.env[UPGRADE_HELPER_ENV] = JSON.stringify({
    packageName: 'adhdev',
    targetVersion: '2.0.0',
    parentPid: 0,
    restartArgv: [path.join(livePackageRoot, 'cli.js'), 'daemon', '-p', String(port)],
    sessionHostAppName: 'adhdev',
    healthTimeoutMs: 3_000,
    configDir,
  })
  return maybeRunDaemonUpgradeHelperFromEnv()
}

function readNotice(configDir: string): string {
  return fs.readFileSync(path.join(configDir, 'daemon-upgrade-last-error.txt'), 'utf8')
}

function readLog(configDir: string): string {
  return fs.readFileSync(path.join(configDir, 'daemon-upgrade.log'), 'utf8')
}

let fake: FakeDaemonPort

beforeEach(async () => {
  mocks.execFileSync.mockReset()
  mocks.spawn.mockReset()
  exitCodes = []
  for (const key of ['ADHDEV_CONFIG_DIR', 'HOME', 'USERPROFILE', UPGRADE_HELPER_ENV]) {
    savedEnv[key] = process.env[key]
  }
  savedArgv1 = process.argv[1]
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0)
    return undefined as never
  }) as never)
  fake = new FakeDaemonPort()
  await fake.reserve()
})

afterEach(async () => {
  await fake.close()
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

function setup(): { configDir: string; live: { prefixRoot: string; packageRoot: string } } {
  const homeDir = makeTempHome()
  const configDir = path.join(homeDir, '.adhdev-preview')
  fs.mkdirSync(configDir, { recursive: true })
  process.env.HOME = homeDir
  return { configDir, live: stageLiveInstall(homeDir) }
}

describe('POSIX in-place upgrade — boot health gate + automatic rollback', () => {
  it('commits the upgrade when the replacement daemon reports the target version', async () => {
    const { configDir, live } = setup()
    mockNpm()
    scriptSpawns(fake, [{ serve: '2.0.0' }])

    await runHelper(configDir, fake.port, live.packageRoot)

    expect(installedVersion(live.packageRoot)).toBe('2.0.0')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(exitCodes).toEqual([0])
    expect(fs.existsSync(path.join(configDir, 'daemon-upgrade-last-error.txt'))).toBe(false)
    expect(readLog(configDir)).toMatch(/Health gate \(replacement\) passed/)
    // Backup, pre-flight scratch and the interrupt journal are all gone.
    const leftovers = fs.readdirSync(configDir).filter((e) => e.startsWith('upgrade-') || e === 'daemon-upgrade-journal.json')
    expect(leftovers).toEqual([])
  })

  it('rolls back to the previous version when the new daemon crashes on boot (rc.62)', async () => {
    const { configDir, live } = setup()
    mockNpm()
    scriptSpawns(fake, [{ crash: true }, { serve: '1.0.0' }])

    await runHelper(configDir, fake.port, live.packageRoot)

    // ① The previous install is back on disk.
    expect(installedVersion(live.packageRoot)).toBe('1.0.0')
    // ② The daemon was restarted on it and verified healthy (second spawn).
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    // ③ The failure is durable, specific and surfaced to status callers.
    expect(exitCodes).toEqual([1])
    const notice = readNotice(configDir)
    expect(notice).toMatch(/adhdev@2\.0\.0 was ROLLED BACK to 1\.0\.0/)
    expect(notice).toMatch(/exited during boot \(code 1\)/)
    expect(notice).toMatch(/adhdev-upgrade-target: 2\.0\.0/)
    const log = readLog(configDir)
    expect(log).toMatch(/Health gate FAILED for 2\.0\.0/)
    expect(log).toMatch(/previous install restored via snapshot/)
    expect(log).toMatch(/Health gate \(rollback\) passed .* reports 1\.0\.0/)
    expect(fs.existsSync(path.join(configDir, 'daemon-upgrade-journal.json'))).toBe(false)
  })

  it('rolls back when the restarted daemon answers health with the wrong version', async () => {
    const { configDir, live } = setup()
    mockNpm()
    // Something answers the port, but never as 2.0.0 (e.g. a stale daemon that
    // kept the port, or a build stamped with the wrong version).
    scriptSpawns(fake, [{ serve: '1.9.9' }, { serve: '1.0.0' }])

    await runHelper(configDir, fake.port, live.packageRoot)

    expect(installedVersion(live.packageRoot)).toBe('1.0.0')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(exitCodes).toEqual([1])
    expect(readNotice(configDir)).toMatch(/reports version 1\.9\.9, not 2\.0\.0/)
    // The wrong-version daemon was asked to stop before the rollback restart.
    expect(readLog(configDir)).toMatch(new RegExp(`Stopping failed replacement daemon pid ${FAKE_DAEMON_PID}`))
  })

  it('falls back to reinstalling the exact previous version when the snapshot is gone', async () => {
    const { configDir, live } = setup()
    mockNpm()
    const dropSnapshot = () => {
      for (const entry of fs.readdirSync(configDir)) {
        if (entry.startsWith('upgrade-backup-')) fs.rmSync(path.join(configDir, entry), { recursive: true, force: true })
      }
    }
    scriptSpawns(fake, [{ crash: true, beforeExit: dropSnapshot }, { serve: '1.0.0' }])

    await runHelper(configDir, fake.port, live.packageRoot)

    expect(installedVersion(live.packageRoot)).toBe('1.0.0')
    const reinstall = mocks.execFileSync.mock.calls.find(([, args]) => (args as string[]).includes('adhdev@1.0.0'))
    expect(reinstall).toBeDefined()
    const reinstallArgs = reinstall![1] as string[]
    expect(reinstallArgs[reinstallArgs.indexOf('--prefix') + 1]).toBe(live.prefixRoot)
    expect(readNotice(configDir)).toMatch(/restored \(reinstall\)/)
    expect(exitCodes).toEqual([1])
  })

  it('reports a clear, actionable error when the rollback itself fails', async () => {
    const { configDir, live } = setup()
    // Snapshot lost AND the reinstall of 1.0.0 fails; every restart crashes.
    mockNpm({ failVersions: ['1.0.0'] })
    const dropSnapshot = () => {
      for (const entry of fs.readdirSync(configDir)) {
        if (entry.startsWith('upgrade-backup-')) fs.rmSync(path.join(configDir, entry), { recursive: true, force: true })
      }
    }
    scriptSpawns(fake, [{ crash: true, beforeExit: dropSnapshot }])

    await runHelper(configDir, fake.port, live.packageRoot)

    // Replacement + two rollback restart attempts: the helper never gives up
    // without trying to bring a daemon back.
    expect(mocks.spawn).toHaveBeenCalledTimes(3)
    expect(exitCodes).toEqual([1])
    const notice = readNotice(configDir)
    expect(notice).toMatch(/AND the automatic rollback to 1\.0\.0 failed/)
    expect(notice).toMatch(/NO healthy daemon is running/)
    // Paste-ready recovery pinned to the previous version and the same prefix.
    expect(notice).toMatch(/install -g adhdev@1\.0\.0 --force --prefix/)
    expect(readLog(configDir)).toMatch(/ROLLBACK RESTORE FAILED/)
  })
})
