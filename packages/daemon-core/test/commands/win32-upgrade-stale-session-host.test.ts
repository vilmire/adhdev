import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}))
vi.mock('child_process', () => cp)

import {
  stopSessionHostProcesses,
} from '../../src/commands/upgrade-helper'
import {
  inspectOwnedNodeProcesses,
  stopOwnedProcessesForPrefixes,
} from '../../src/commands/process-lifecycle'

/**
 * Regression pack for the win32 "upgraded successfully, then every session
 * fails" outage (owner machine, stable 1.0.42, 2026-08-11).
 *
 * Observed: a dashboard upgrade completed, the OLD install prefix was deleted,
 * but the session-host process from that prefix SURVIVED. It kept answering its
 * socket, so it was reused, and every `create_session` died in ~1ms with
 * `Cannot find module './prebuilds/win32-x64/conpty.node'` naming a directory
 * that no longer existed. `adhdev daemon:restart` cleared it.
 *
 * The enabling condition on that class of box is that Windows process
 * inspection is unavailable: AV/EDR denies `Get-CimInstance Win32_Process` and
 * `wmic` is gone (removed by default in Win11 24H2+). Every guard in the
 * upgrade path routed through that probe and therefore failed OPEN — an
 * unreadable process was indistinguishable from no process at all.
 */

/** Simulate a box where BOTH command-line probes fail (AV/EDR + no wmic). */
function mockBrokenCommandLineProbe(enumeratedPids: number[]) {
  cp.execFileSync.mockImplementation(((file: string, args: readonly string[]) => {
    const argv = Array.isArray(args) ? args.join(' ') : ''
    if (file === 'powershell.exe' && argv.includes('Get-Process node')) {
      return JSON.stringify(enumeratedPids)
    }
    if (file === 'powershell.exe' && argv.includes('Get-CimInstance')) {
      throw new Error('Access denied')
    }
    if (file === 'wmic') {
      const error: NodeJS.ErrnoException = new Error('wmic not found')
      error.code = 'ENOENT'
      throw error
    }
    return ''
  }) as never)
}

describe('win32 upgrade — stale session-host survival', () => {
  const tempRoots: string[] = []
  let platformDescriptor: PropertyDescriptor | undefined
  let originalHome: string | undefined
  let originalConfigDir: string | undefined
  let killSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    cp.execFileSync.mockReset()
    cp.spawn.mockReset()
    cp.execFileSync.mockImplementation(() => '')
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    originalHome = process.env.HOME
    originalConfigDir = process.env.ADHDEV_CONFIG_DIR
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
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

  function stageConfigDir(appName: string, pid: number): { configDir: string; pidFile: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-win32-stale-host-'))
    tempRoots.push(dir)
    process.env.HOME = dir
    const configDir = path.join(dir, '.adhdev')
    process.env.ADHDEV_CONFIG_DIR = configDir
    fs.mkdirSync(configDir, { recursive: true })
    const pidFile = path.join(configDir, `${appName}-session-host.pid`)
    fs.writeFileSync(pidFile, String(pid), 'utf8')
    return { configDir, pidFile }
  }

  /** Control the signal-0 liveness probe without touching a real process. */
  function mockLiveness(alive: boolean) {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: unknown) => {
      if (signal === 0 || signal === undefined) {
        if (alive) return true as never
        const error: NodeJS.ErrnoException = new Error('ESRCH')
        error.code = 'ESRCH'
        throw error
      }
      return true as never
    }) as never)
  }

  describe('A. stopSessionHostProcesses honors its own pidfile', () => {
    /**
     * THE root cause. `isManagedSessionHostPid` required a command-line match
     * before killing. With the probe broken it returned false, the kill was
     * SKIPPED — and the pidfile was then deleted anyway in a `finally`, erasing
     * the only evidence that did not depend on the broken probe.
     */
    it('kills a pid whose command line is unreadable, because the pidfile is our own record', async () => {
      const { configDir } = stageConfigDir('adhdev', 31337)
      mockBrokenCommandLineProbe([31337])
      mockLiveness(false) // exits promptly once killed

      const outcome = await stopSessionHostProcesses('adhdev', configDir)

      expect(outcome.pid).toBe(31337)
      expect(outcome.identity).toBe('unknown')
      expect(outcome.stopped).toBe(true)
      expect(outcome.survived).toBe(false)

      const taskkills = cp.execFileSync.mock.calls.filter(([file]) => file === 'taskkill')
      expect(taskkills).toHaveLength(1)
      expect(taskkills[0][1]).toEqual(['/PID', '31337', '/T', '/F'])
    })

    it('retains the pidfile when the tracked host survives the stop attempt', async () => {
      const { configDir, pidFile } = stageConfigDir('adhdev', 31338)
      mockBrokenCommandLineProbe([31338])
      mockLiveness(true) // never dies

      const outcome = await stopSessionHostProcesses('adhdev', configDir)

      expect(outcome.survived).toBe(true)
      expect(fs.existsSync(pidFile)).toBe(true)
    })

    it('spares — and forgets — a pid positively identified as an unrelated process', async () => {
      const { configDir, pidFile } = stageConfigDir('adhdev', 31339)
      cp.execFileSync.mockImplementation(((file: string, args: readonly string[]) => {
        const argv = Array.isArray(args) ? args.join(' ') : ''
        if (file === 'powershell.exe' && argv.includes('Get-CimInstance')) {
          return 'C:\\Windows\\System32\\notepad.exe'
        }
        return ''
      }) as never)

      const outcome = await stopSessionHostProcesses('adhdev', configDir)

      expect(outcome.identity).toBe('unrelated')
      expect(cp.execFileSync.mock.calls.filter(([file]) => file === 'taskkill')).toHaveLength(0)
      expect(fs.existsSync(pidFile)).toBe(false)
    })
  })

  describe('B. the process sweep distinguishes "clean" from "could not verify"', () => {
    /**
     * `listOwnedNodeProcesses` collapsed probe failure into `[]`, and every
     * caller read `[]` as permission to proceed. That is what let the cleanup
     * delete the old prefix while a live host was still running from it.
     */
    it('reports probeFailed when the pid enumeration itself throws', () => {
      cp.execFileSync.mockImplementation((() => {
        throw new Error('powershell blocked by policy')
      }) as never)

      const sweep = inspectOwnedNodeProcesses({ prefixes: ['C:\\Users\\u\\.adhdev\\npm-installs\\version-old'] })

      expect(sweep.processes).toEqual([])
      expect(sweep.probeFailed).toBe(true)
      expect(sweep.probeFailureReason).toMatch(/enumeration failed/i)
    })

    it('reports probeFailed when a pid exists but its command line is unreadable', () => {
      mockBrokenCommandLineProbe([9001])

      const sweep = inspectOwnedNodeProcesses({ prefixes: ['C:\\Users\\u\\.adhdev\\npm-installs\\version-old'] })

      expect(sweep.processes).toEqual([])
      expect(sweep.probeFailed).toBe(true)
      expect(sweep.probeFailureReason).toMatch(/unreadable command line/i)
    })

    it('reports a genuinely clean sweep as verified, not as a probe failure', () => {
      cp.execFileSync.mockImplementation(((file: string, args: readonly string[]) => {
        const argv = Array.isArray(args) ? args.join(' ') : ''
        if (file === 'powershell.exe' && argv.includes('Get-Process node')) return JSON.stringify([4242])
        if (file === 'powershell.exe' && argv.includes('Get-CimInstance')) {
          return 'C:\\Program Files\\nodejs\\node.exe C:\\some\\other\\app.js'
        }
        return ''
      }) as never)

      const sweep = inspectOwnedNodeProcesses({ prefixes: ['C:\\Users\\u\\.adhdev\\npm-installs\\version-old'] })

      expect(sweep.processes).toEqual([])
      expect(sweep.probeFailed).toBe(false)
    })

    it('propagates probeFailed through stopOwnedProcessesForPrefixes', async () => {
      mockBrokenCommandLineProbe([9002])

      const result = await stopOwnedProcessesForPrefixes({
        prefixes: ['C:\\Users\\u\\.adhdev\\npm-installs\\version-old'],
      })

      expect(result.survivors).toEqual([])
      expect(result.probeFailed).toBe(true)
    })
  })
})
