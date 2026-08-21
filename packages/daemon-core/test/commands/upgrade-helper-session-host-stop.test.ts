import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock('child_process', () => mocks)

import { stopSessionHostProcesses } from '../../src/commands/upgrade-helper'

const createdAppNames: string[] = []
let killSpy: ReturnType<typeof vi.spyOn>

function pidFileFor(appName: string): string {
  return path.join(os.homedir(), '.adhdev', `${appName}-session-host.pid`)
}

function writePidFile(appName: string, pid: number): string {
  const pidFile = pidFileFor(appName)
  fs.mkdirSync(path.dirname(pidFile), { recursive: true })
  fs.writeFileSync(pidFile, String(pid), 'utf8')
  createdAppNames.push(appName)
  return pidFile
}

// stopSessionHostProcesses branches on process.platform (POSIX uses `ps` +
// process.kill; win32 uses powershell/wmic + taskkill). Pin the platform so this
// suite deterministically exercises the POSIX path regardless of the host OS the
// tests run on (e.g. a Windows dev machine).
let platformDescriptor: PropertyDescriptor | undefined
let originalConfigDir: string | undefined
const originalHomeEnvs = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
}
let tmpHome = ''

beforeEach(() => {
  mocks.execFileSync.mockReset()
  mocks.spawn.mockClear()
  // The stop path resolves the pid file through the instance config dir
  // (Stage 3); pin it to the legacy default this suite writes against.
  // HOME/USERPROFILE go to a per-test tmp dir FIRST: this suite previously
  // pinned ADHDEV_CONFIG_DIR to the REAL ~/.adhdev and created/deleted real
  // pidfiles there on every run — a live-state write no test may make.
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-upgrade-stop-home-'))
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  process.env.ADHDEV_CONFIG_DIR = path.join(os.homedir(), '.adhdev')
  // SIGTERM (kill request) succeeds; the signal-0 liveness probe in
  // waitForPidExit throws to signal the process is already gone, so the
  // post-kill wait resolves immediately instead of spinning for 15s.
  killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
    if (signal === 0) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    return true
  })
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})

afterEach(() => {
  killSpy.mockRestore()
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
  if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
  for (const appName of createdAppNames.splice(0)) {
    fs.rmSync(pidFileFor(appName), { force: true })
  }
  for (const [key, value] of Object.entries(originalHomeEnvs)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('upgrade helper session-host stop', () => {
  it('kills only the pidfile-owned session-host process and does not pgrep sweep', async () => {
    const appName = `adhdev-upgrade-stop-${process.pid}-${Date.now()}`
    const pidFile = writePidFile(appName, 43210)
    const execCalls: Array<{ file: string; args: readonly string[] }> = []
    mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      execCalls.push({ file, args })
      if (file === 'ps') return 'node /tmp/session-host-daemon/index.js\n'
      throw new Error(`unexpected execFileSync ${file}`)
    })

    await stopSessionHostProcesses(appName)

    expect(killSpy).toHaveBeenCalledWith(43210, 'SIGTERM')
    expect(execCalls.some((call) => call.file === 'pgrep')).toBe(false)
    expect(fs.existsSync(pidFile)).toBe(false)
  })

  it('does not kill a stale pidfile reused by an unrelated process', async () => {
    const appName = `adhdev-upgrade-stop-unrelated-${process.pid}-${Date.now()}`
    const pidFile = writePidFile(appName, 43211)
    const execCalls: Array<{ file: string; args: readonly string[] }> = []
    mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      execCalls.push({ file, args })
      if (file === 'ps') return 'node /tmp/not-the-session-host.js\n'
      throw new Error(`unexpected execFileSync ${file}`)
    })

    await stopSessionHostProcesses(appName)

    expect(killSpy).not.toHaveBeenCalled()
    expect(execCalls.some((call) => call.file === 'pgrep')).toBe(false)
    expect(fs.existsSync(pidFile)).toBe(false)
  })
})
