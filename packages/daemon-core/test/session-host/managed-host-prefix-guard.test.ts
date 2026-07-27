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
})
