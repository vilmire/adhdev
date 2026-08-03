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
 * B: `stopManagedSessionHostProcess` used to delete the pidfile unconditionally,
 * in a `finally`, even when it had killed nothing.
 *
 * That is what silently disarmed the D1 stale-prefix guard in production. On the
 * affected machines `getProcessCommandLine` always fails, so `isManagedPid`
 * returns false (fail-closed) and the kill is SKIPPED — but the pidfile was
 * removed anyway. The next `ensureReady` then read `getPid() === null`, so the
 * `existingPid !== null` branch never ran and the whole unverified-host recovery
 * was skipped. The zombie survived every restart with nothing tracking it.
 *
 * Retaining the pidfile for a survivor keeps it visible to that guard. The one
 * pid that must still be forgotten is a recycled pid positively identified as
 * someone else's process — retaining that would point the guard at a stranger.
 */
describe('managed session-host pidfile retention after a failed stop', () => {
  const tempRoots: string[] = []
  let platformDescriptor: PropertyDescriptor | undefined
  let originalHome: string | undefined
  let originalConfigDir: string | undefined
  let killSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    cp.execFileSync.mockReset()
    cp.spawn.mockReset()
    cp.spawn.mockImplementation(() => ({ unref: vi.fn(), pid: 4242 }))
    cp.execFileSync.mockImplementation(() => '')
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    originalHome = process.env.HOME
    originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  })

  afterEach(() => {
    killSpy?.mockRestore()
    killSpy = undefined
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function stage(appName: string, pid: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-pidfile-retention-'))
    tempRoots.push(dir)
    process.env.HOME = dir
    process.env.ADHDEV_CONFIG_DIR = path.join(dir, '.adhdev')
    const pidFile = path.join(dir, '.adhdev', `${appName}-session-host.pid`)
    fs.mkdirSync(path.dirname(pidFile), { recursive: true })
    fs.writeFileSync(pidFile, String(pid), 'utf8')
    return pidFile
  }

  /** Signal-0 liveness probe result, without touching any real process. */
  function mockLiveness(alive: boolean | 'eperm') {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: any) => {
      if (signal === 0) {
        if (alive === true) return true as any
        const error: NodeJS.ErrnoException = new Error(alive === 'eperm' ? 'EPERM' : 'ESRCH')
        error.code = alive === 'eperm' ? 'EPERM' : 'ESRCH'
        throw error
      }
      return true as any
    }) as any)
  }

  it('KEEPS the pidfile when the kill was skipped because the pid was unverifiable and the process is still alive', () => {
    const appName = `adhdev-retain-${process.pid}-${Date.now()}`
    const zombiePid = 21001
    const pidFile = stage(appName, zombiePid)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mockLiveness(true)

    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      // Reproduce the production machine: the command line cannot be read, so
      // the managed check fails closed and no identification is possible.
      isManagedPid: () => false,
      identifiesPid: () => false,
    })

    expect(host.stopManagedSessionHostProcess()).toBe(false)
    // The survivor must remain tracked, otherwise D1 goes blind next start.
    expect(fs.existsSync(pidFile)).toBe(true)
    expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(String(zombiePid))
  })

  it('KEEPS the pidfile when the process outlives a kill attempt that reported success', () => {
    const appName = `adhdev-retain-survivor-${process.pid}-${Date.now()}`
    const pidFile = stage(appName, 21002)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mockLiveness(true)
    // taskkill returns cleanly, yet the process is still there afterwards.
    cp.execFileSync.mockImplementation(() => '')

    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      isManagedPid: () => true,
      identifiesPid: () => true,
    })

    host.stopManagedSessionHostProcess()
    expect(fs.existsSync(pidFile)).toBe(true)
  })

  it('REMOVES the pidfile once the process is actually gone', () => {
    const appName = `adhdev-remove-dead-${process.pid}-${Date.now()}`
    const pidFile = stage(appName, 21003)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mockLiveness(false)

    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      isManagedPid: () => true,
      identifiesPid: () => true,
    })

    host.stopManagedSessionHostProcess()
    expect(fs.existsSync(pidFile)).toBe(false)
  })

  it('REMOVES the pidfile for a recycled pid positively identified as an unrelated process', () => {
    const appName = `adhdev-remove-recycled-${process.pid}-${Date.now()}`
    const pidFile = stage(appName, 21004)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // Alive, but proven to belong to somebody else — must not be retained, or
    // the stale-host guard would later treat a stranger's process as our host.
    mockLiveness(true)

    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      isManagedPid: () => false,
      identifiesPid: () => true,
    })

    expect(host.stopManagedSessionHostProcess()).toBe(false)
    expect(fs.existsSync(pidFile)).toBe(false)
  })

  it('treats EPERM as alive: a process we lack rights to kill stays tracked', () => {
    const appName = `adhdev-retain-eperm-${process.pid}-${Date.now()}`
    const pidFile = stage(appName, 21005)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mockLiveness('eperm')

    const host = createManagedSessionHost({
      appName,
      requiredRequestTypes: ['delete_session'],
      isManagedPid: () => false,
      identifiesPid: () => false,
    })

    host.stopManagedSessionHostProcess()
    expect(fs.existsSync(pidFile)).toBe(true)
  })
})
