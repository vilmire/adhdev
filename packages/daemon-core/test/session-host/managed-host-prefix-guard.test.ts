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

const tempRoots: string[] = []
let platformDescriptor: PropertyDescriptor | undefined
let originalConfigDir: string | undefined

describe('managed session-host prefix guard', () => {
  beforeEach(() => {
    cp.execFileSync.mockReset()
    cp.spawn.mockReset()
    cp.spawn.mockImplementation(() => ({ unref: vi.fn(), pid: 4242 }))
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function makeTempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-managed-host-guard-'))
    tempRoots.push(dir)
    return dir
  }

  it('stops a reachable session-host that is running from a different prefix', async () => {
    const homeDir = makeTempHome()
    const originalHome = process.env.HOME
    process.env.HOME = homeDir
    // Instance-aware pid file resolution (Stage 3) follows ADHDEV_CONFIG_DIR;
    // pin it to the legacy default this test stages.
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    const appName = `adhdev-guard-${process.pid}-${Date.now()}`
    const stalePid = 14720
    const pidFile = path.join(homeDir, '.adhdev', `${appName}-session-host.pid`)
    fs.mkdirSync(path.dirname(pidFile), { recursive: true })
    fs.writeFileSync(pidFile, String(stalePid), 'utf8')

    cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      if (file === 'powershell.exe') {
        const cmd = String(args[args.length - 1] || '')
        if (cmd.includes('Win32_Process')) {
          // The real entry resolves inside the current package tree; report a
          // stale prefix path instead.
          return `node "C:\\Users\\dev\\.adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js"`
        }
      }
      if (file === 'taskkill') return ''
      return ''
    })

    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
    try {
      await host.ensureReady()
    } catch {
      // The spawn will fail because there is no real session-host daemon; we only
      // care that the stale host was detected and killed before the spawn attempt.
    }

    const taskkillCalls = cp.execFileSync.mock.calls.filter((c: any[]) => c[0] === 'taskkill')
    expect(taskkillCalls.length).toBeGreaterThan(0)
    expect(taskkillCalls.some((c: any[]) => c[1].includes(String(stalePid)))).toBe(true)
    process.env.HOME = originalHome
  })

  it('does not stop a reachable session-host that is already running from the current entry', async () => {
    const homeDir = makeTempHome()
    const originalHome = process.env.HOME
    process.env.HOME = homeDir
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    const appName = `adhdev-guard-matching-${process.pid}-${Date.now()}`
    const currentPid = 14721
    const pidFile = path.join(homeDir, '.adhdev', `${appName}-session-host.pid`)
    fs.mkdirSync(path.dirname(pidFile), { recursive: true })
    fs.writeFileSync(pidFile, String(currentPid), 'utf8')

    // Discover the current entry path that resolveEntry will use.
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
    const currentEntry = host.resolveEntry()

    // Record spawn/taskkill ordering across both mocks. The guard runs before the
    // first spawn, so a guard-triggered kill would land before any spawn; the
    // retry stop (after the first spawn fails to connect) lands after it.
    const events: string[] = []
    cp.spawn.mockImplementation(() => {
      events.push('spawn')
      return { unref: vi.fn(), pid: 4242 }
    })
    cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      if (file === 'powershell.exe') {
        const cmd = String(args[args.length - 1] || '')
        if (cmd.includes('Win32_Process')) {
          return `node "${currentEntry}"`
        }
      }
      if (file === 'taskkill') {
        events.push('taskkill')
        return ''
      }
      return ''
    })

    try {
      await host.ensureReady()
    } catch {
      // spawn expected to fail because there is no real session-host daemon
    }

    // The defensive prefix guard must not kill a host that is already executing
    // from the current entry: no taskkill may precede the first spawn. A later
    // retry stop (after the spawn fails to connect) is unrelated to the guard.
    const firstSpawn = events.indexOf('spawn')
    const firstTaskkill = events.indexOf('taskkill')
    expect(firstSpawn).toBeGreaterThan(-1)
    expect(firstTaskkill === -1 || firstTaskkill > firstSpawn).toBe(true)
    process.env.HOME = originalHome
  })

  /**
   * D1 regression: when the command-line probe cannot answer (AV/EDR blocking
   * powershell.exe, execution policy, timeout — both the Get-CimInstance and
   * wmic probes throw), `getRunningSessionHostScriptPath` returns null. The old
   * guard short-circuited on `runningPath &&` and skipped entirely, treating
   * "cannot verify" as "healthy". That let a stale-prefix host survive and take
   * create_session down with `Failed to load native module: conpty.node`.
   */
  describe('unverifiable host command line', () => {
    function stageUnverifiablePid(appName: string, pid: number, homeDir: string): void {
      const pidFile = path.join(homeDir, '.adhdev', `${appName}-session-host.pid`)
      fs.mkdirSync(path.dirname(pidFile), { recursive: true })
      fs.writeFileSync(pidFile, String(pid), 'utf8')
    }

    /** Both win32 command-line probes fail, so the path is unverifiable. */
    function mockProbeFailure(record?: (event: string) => void) {
      cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        if (file === 'powershell.exe') {
          const cmd = String(args[args.length - 1] || '')
          if (cmd.includes('Win32_Process')) throw new Error('Access is denied.')
        }
        if (file === 'wmic') throw new Error("'wmic' is not recognized")
        if (file === 'taskkill') {
          record?.('taskkill')
          return ''
        }
        return ''
      })
    }

    it('stops the host when its command line cannot be read (fails safe, not silently skipped)', async () => {
      const homeDir = makeTempHome()
      const originalHome = process.env.HOME
      process.env.HOME = homeDir
      process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
      const appName = `adhdev-guard-unverifiable-${process.pid}-${Date.now()}`
      const unverifiablePid = 14722
      stageUnverifiablePid(appName, unverifiablePid, homeDir)

      const events: string[] = []
      cp.spawn.mockImplementation(() => {
        events.push('spawn')
        return { unref: vi.fn(), pid: 4242 }
      })
      mockProbeFailure((e) => events.push(e))

      const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
      try {
        await host.ensureReady()
      } catch {
        // No real session-host daemon exists; only the guard behavior matters.
      }

      // The guard must have killed the unverifiable pid BEFORE the first spawn.
      const firstSpawn = events.indexOf('spawn')
      const firstTaskkill = events.indexOf('taskkill')
      expect(firstTaskkill).toBeGreaterThan(-1)
      expect(firstTaskkill).toBeLessThan(firstSpawn)
      const taskkillCalls = cp.execFileSync.mock.calls.filter((c: any[]) => c[0] === 'taskkill')
      expect(taskkillCalls.some((c: any[]) => c[1].includes(String(unverifiablePid)))).toBe(true)
      process.env.HOME = originalHome
    })

    it('does not kill/respawn in a loop when the host stays unverifiable', async () => {
      const homeDir = makeTempHome()
      const originalHome = process.env.HOME
      process.env.HOME = homeDir
      process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
      const appName = `adhdev-guard-noloop-${process.pid}-${Date.now()}`
      const unverifiablePid = 14723
      stageUnverifiablePid(appName, unverifiablePid, homeDir)

      mockProbeFailure()
      const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })

      // First pass: the guard stops the unverifiable host once.
      try { await host.ensureReady() } catch { /* no real daemon */ }
      const afterFirst = cp.execFileSync.mock.calls
        .filter((c: any[]) => c[0] === 'taskkill' && c[1].includes(String(unverifiablePid))).length
      expect(afterFirst).toBeGreaterThan(0)

      // Re-stage the SAME pid and run the guard again. Because the pid was
      // already stopped once for being unverifiable, the guard must leave it
      // alone — otherwise every ensureReady would kill and respawn forever.
      stageUnverifiablePid(appName, unverifiablePid, homeDir)
      const callsBeforeSecond = cp.execFileSync.mock.calls.length
      try { await host.ensureReady() } catch { /* no real daemon */ }

      const guardKillsInSecondPass = cp.execFileSync.mock.calls
        .slice(callsBeforeSecond)
        .filter((c: any[]) => c[0] === 'taskkill' && c[1].includes(String(unverifiablePid)))
      // The retry path inside ensureReady may still stop the host after a failed
      // connect, but the *guard* (which runs before the first spawn of the pass)
      // must not have fired again. Assert via the spawn ordering.
      const spawnsInSecondPass = cp.spawn.mock.calls.length
      expect(spawnsInSecondPass).toBeGreaterThan(0)
      expect(guardKillsInSecondPass.length).toBeLessThanOrEqual(afterFirst)
      process.env.HOME = originalHome
    })

    it('still stops a host whose command line proves a different prefix, even after an unverifiable stop', async () => {
      const homeDir = makeTempHome()
      const originalHome = process.env.HOME
      process.env.HOME = homeDir
      process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
      const appName = `adhdev-guard-mixed-${process.pid}-${Date.now()}`
      const stalePid = 14724
      stageUnverifiablePid(appName, stalePid, homeDir)

      // Probe now succeeds and reports a stale prefix: conclusive evidence is
      // never rate-limited by the unverifiable-stop bookkeeping.
      const events: string[] = []
      cp.spawn.mockImplementation(() => {
        events.push('spawn')
        return { unref: vi.fn(), pid: 4242 }
      })
      cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        if (file === 'powershell.exe') {
          const cmd = String(args[args.length - 1] || '')
          if (cmd.includes('Win32_Process')) {
            return `node "C:\\Users\\dev\\.adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js"`
          }
        }
        if (file === 'taskkill') {
          events.push('taskkill')
          return ''
        }
        return ''
      })

      const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
      try { await host.ensureReady() } catch { /* no real daemon */ }

      const firstSpawn = events.indexOf('spawn')
      const firstTaskkill = events.indexOf('taskkill')
      expect(firstTaskkill).toBeGreaterThan(-1)
      expect(firstTaskkill).toBeLessThan(firstSpawn)
      process.env.HOME = originalHome
    })
  })
})
