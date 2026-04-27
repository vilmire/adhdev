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

beforeEach(() => {
  mocks.execFileSync.mockReset()
  mocks.spawn.mockClear()
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
})

afterEach(() => {
  killSpy.mockRestore()
  for (const appName of createdAppNames.splice(0)) {
    fs.rmSync(pidFileFor(appName), { force: true })
  }
})

describe('upgrade helper session-host stop', () => {
  it('kills only the pidfile-owned session-host process and does not pgrep sweep', () => {
    const appName = `adhdev-upgrade-stop-${process.pid}-${Date.now()}`
    const pidFile = writePidFile(appName, 43210)
    const execCalls: Array<{ file: string; args: readonly string[] }> = []
    mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      execCalls.push({ file, args })
      if (file === 'ps') return 'node /tmp/session-host-daemon/index.js\n'
      throw new Error(`unexpected execFileSync ${file}`)
    })

    stopSessionHostProcesses(appName)

    expect(killSpy).toHaveBeenCalledWith(43210, 'SIGTERM')
    expect(execCalls.some((call) => call.file === 'pgrep')).toBe(false)
    expect(fs.existsSync(pidFile)).toBe(false)
  })

  it('does not kill a stale pidfile reused by an unrelated process', () => {
    const appName = `adhdev-upgrade-stop-unrelated-${process.pid}-${Date.now()}`
    const pidFile = writePidFile(appName, 43211)
    const execCalls: Array<{ file: string; args: readonly string[] }> = []
    mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      execCalls.push({ file, args })
      if (file === 'ps') return 'node /tmp/not-the-session-host.js\n'
      throw new Error(`unexpected execFileSync ${file}`)
    })

    stopSessionHostProcesses(appName)

    expect(killSpy).not.toHaveBeenCalled()
    expect(execCalls.some((call) => call.file === 'pgrep')).toBe(false)
    expect(fs.existsSync(pidFile)).toBe(false)
  })
})
