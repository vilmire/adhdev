import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })),
}))
vi.mock('child_process', () => cp)

import { createManagedSessionHost } from '../../src/session-host/managed-host'

/**
 * D4-b: conpty re-verification on the REUSE path.
 *
 * D4-a only guards `spawnHost()`. When a session-host already answers the
 * socket, `ensureSessionHostReady` returns that endpoint immediately and never
 * spawns — so a zombie host from a deleted install prefix is reused, and every
 * `create_session` then fails in ~4ms when it lazily requires node-pty against
 * a conpty.node that no longer exists. That is the shipped production incident.
 *
 * The pid-based guards cannot catch this case: they all route through
 * `getProcessCommandLine`, which fails structurally on the affected machines
 * (`Get-CimInstance` access denied, no `wmic`). The reuse guard therefore keys
 * off an independent, permission-free signal — whether conpty.node exists in
 * the currently active prefix.
 *
 * `resolveEntry()` computes its packaged-layout candidates from this module's
 * real `__dirname`, which in a test process is the daemon-core src tree and has
 * no `/node_modules/adhdev/vendor/session-host-daemon/` marker. The guard is a
 * documented no-op in that layout (there is no "active prefix" to check), which
 * is exactly what lets these tests assert the healthy-install and non-win32
 * paths do not kill anything.
 */
describe('managed session-host conpty reuse guard', () => {
  const tempRoots: string[] = []
  let platformDescriptor: PropertyDescriptor | undefined
  let originalHome: string | undefined
  let originalConfigDir: string | undefined

  beforeEach(() => {
    cp.execFileSync.mockReset()
    cp.spawn.mockReset()
    cp.spawn.mockImplementation(() => ({ unref: vi.fn(), pid: 4242 }))
    cp.execFileSync.mockImplementation(() => '24.3.0')
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    originalHome = process.env.HOME
    originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  })

  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function stageHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-conpty-reuse-'))
    tempRoots.push(dir)
    process.env.HOME = dir
    process.env.ADHDEV_CONFIG_DIR = path.join(dir, '.adhdev')
    return dir
  }

  function stagePidFile(homeDir: string, appName: string, pid: number): string {
    const pidFile = path.join(homeDir, '.adhdev', `${appName}-session-host.pid`)
    fs.mkdirSync(path.dirname(pidFile), { recursive: true })
    fs.writeFileSync(pidFile, String(pid), 'utf8')
    return pidFile
  }

  function taskkillCalls(): any[][] {
    return cp.execFileSync.mock.calls.filter((c: any[]) => c[0] === 'taskkill')
  }

  /**
   * No real session-host answers the socket in a test process, so `ensureReady`
   * ALWAYS reaches its pre-existing failure path, which stops the host and
   * retries once. Those kills predate this fix and are not attributable to the
   * reuse guard, so counting taskkills across a full `ensureReady` cannot
   * distinguish the two.
   *
   * What is uniquely observable is the guard's decision input: the same
   * `verifyConptyPrebuildBeforeSpawn` the reuse path now calls, reached through
   * the public `spawnHost()`. A healthy/dev layout must not throw (hence nothing
   * is stopped); a packaged prefix with no prebuild must throw.
   */
  it('does not fault a reachable host when the active prefix is healthy (nothing for the guard to stop)', async () => {
    const homeDir = stageHome()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const appName = `adhdev-reuse-healthy-${process.pid}-${Date.now()}`
    stagePidFile(homeDir, appName, 15001)

    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 100 })
    const currentEntry = host.resolveEntry()
    cp.execFileSync.mockImplementation((file: string, args: readonly string[] = []) => {
      if (file === 'powershell.exe') {
        const cmd = String(args[args.length - 1] || '')
        if (cmd.includes('Win32_Process')) return `node "${currentEntry}"`
      }
      return '24.3.0'
    })

    // The guard's verification passes, so the reuse path proceeds untouched.
    expect(() => host.spawnHost()).not.toThrow()
    // And ensureReady still completes its normal (here: failing) flow rather
    // than throwing the conpty error out of the new pre-reuse check.
    await expect(host.ensureReady()).rejects.toThrow(/did not become ready|failed to start/i)
  })

  it('never engages on non-win32 platforms', async () => {
    const homeDir = stageHome()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const appName = `adhdev-reuse-darwin-${process.pid}-${Date.now()}`
    stagePidFile(homeDir, appName, 15002)

    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 100 })
    await host.ensureReady().catch(() => {})

    // POSIX must be untouched by the win32-only guard: `taskkill` is a Windows
    // binary and the guard is the only new stop source, so zero calls proves it
    // never engaged here.
    expect(taskkillCalls()).toHaveLength(0)
  })

  /**
   * Stage the production incident: a packaged install layout (so the guard has
   * an active prefix to check) whose conpty.node is absent — the state left
   * behind when the prefix the running host was spawned from is deleted.
   */
  function stagePackagedEntryWithoutConpty(homeDir: string, withPrebuild: boolean): string {
    const activePrefix = path.join(homeDir, 'npm-installs', 'version-1784879721933')
    const entry = path.join(activePrefix, 'node_modules', 'adhdev', 'vendor', 'session-host-daemon', 'index.js')
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, '// staged session-host entry')
    if (withPrebuild) {
      const prebuild = path.join(
        activePrefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node',
      )
      fs.mkdirSync(path.dirname(prebuild), { recursive: true })
      fs.writeFileSync(prebuild, 'conpty.node placeholder')
    }
    return entry
  }

  it('stops a REACHABLE host instead of reusing it when the active prefix has no conpty prebuild', async () => {
    const homeDir = stageHome()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const appName = `adhdev-reuse-missing-${process.pid}-${Date.now()}`
    const zombiePid = 15003
    stagePidFile(homeDir, appName, zombiePid)
    const entry = stagePackagedEntryWithoutConpty(homeDir, false)

    // `ensureReady` ALSO stops the host on its pre-existing failure/retry path,
    // so "a stop happened" attributes nothing on its own. `extraStop` runs
    // inside every stop, making stops countable: the pre-existing path
    // contributes a fixed two (the initial failure handler and its retry), and
    // the reuse guard contributes exactly one more, ahead of them. Counting is
    // therefore what distinguishes the guard from the baseline — and this
    // assertion fails (2 !== 3) if the reuse guard is removed.
    let stops = 0
    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 100,
      resolveEntryOverride: () => entry,
      extraStop: () => { stops += 1; return false },
      // Reproduce the affected machine exactly: the command line is unreadable,
      // so every pid-based guard (D1 included) is disarmed and only the
      // conpty-based reuse guard can act.
      isManagedPid: () => false,
      identifiesPid: () => false,
    })

    await host.ensureReady().catch(() => {})

    expect(stops).toBe(3)
  })

  it('does NOT stop a reachable host when the packaged prefix still has its conpty prebuild', async () => {
    const homeDir = stageHome()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const appName = `adhdev-reuse-present-${process.pid}-${Date.now()}`
    stagePidFile(homeDir, appName, 15004)
    const entry = stagePackagedEntryWithoutConpty(homeDir, true)

    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 100,
      resolveEntryOverride: () => entry,
    })

    // A healthy prefix must pass the guard: spawn-time verification succeeds, so
    // the reuse path is never faulted and a live host would simply be reused.
    expect(() => host.spawnHost()).not.toThrow()
  })

  it('refuses to spawn into a packaged prefix with no conpty prebuild (D4-a still intact)', () => {
    const homeDir = stageHome()
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const appName = `adhdev-spawn-missing-${process.pid}-${Date.now()}`
    const entry = stagePackagedEntryWithoutConpty(homeDir, false)

    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 100,
      resolveEntryOverride: () => entry,
    })

    expect(() => host.spawnHost()).toThrow(/conpty\.node missing/)
    expect(cp.spawn).not.toHaveBeenCalled()
  })
})
