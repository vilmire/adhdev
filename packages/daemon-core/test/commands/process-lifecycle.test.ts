import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}))
vi.mock('child_process', () => ({ execFileSync: cp.execFileSync }))

import {
  getProcessCommandLine,
  killProcess,
  listOwnedNodeProcesses,
  parseNodeScriptPath,
  stopOwnedProcesses,
  stopOwnedProcessesForPrefixes,
  waitForPidExit,
} from '../../src/commands/process-lifecycle'

describe('process-lifecycle utilities', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    cp.execFileSync.mockReset()
    killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      return true
    })
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    killSpy.mockRestore()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  describe('getProcessCommandLine', () => {
    it('returns null for invalid pids', () => {
      expect(getProcessCommandLine(0)).toBeNull()
      expect(getProcessCommandLine(NaN)).toBeNull()
      expect(getProcessCommandLine(-1)).toBeNull()
    })

    it('uses ps on POSIX', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        expect(file).toBe('ps')
        expect(args).toEqual(['-o', 'command=', '-p', '1234'])
        return '/usr/bin/node /opt/adhdev/vendor/session-host-daemon/index.js\n'
      })

      expect(getProcessCommandLine(1234)).toBe('/usr/bin/node /opt/adhdev/vendor/session-host-daemon/index.js')
    })

    it('prefers PowerShell CIM on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      cp.execFileSync.mockImplementation((file: string, _args: readonly string[]) => {
        if (file === 'powershell.exe') return 'node "C:\\adhdev\\vendor\\session-host-daemon\\index.js"'
        if (file === 'wmic') return 'should not reach here'
        return ''
      })

      expect(getProcessCommandLine(1234)).toBe('node "C:\\adhdev\\vendor\\session-host-daemon\\index.js"')
    })

    it('falls back from CIM to wmic on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      cp.execFileSync.mockImplementation((file: string) => {
        if (file === 'powershell.exe') throw new Error('CIM unavailable')
        if (file === 'wmic') return 'node "C:\\adhdev\\vendor\\session-host-daemon\\index.js"\n'
        return ''
      })

      expect(getProcessCommandLine(1234)).toBe('node "C:\\adhdev\\vendor\\session-host-daemon\\index.js"')
    })
  })

  describe('parseNodeScriptPath', () => {
    it.each([
      ['node /opt/adhdev/vendor/session-host-daemon/index.js', '/opt/adhdev/vendor/session-host-daemon/index.js'],
      ['"/usr/bin/node" "/opt/adhdev/vendor/session-host-daemon/index.js" arg', '/opt/adhdev/vendor/session-host-daemon/index.js'],
      ['node "C:\\adhdev\\vendor\\session-host-daemon\\index.js"', 'C:\\adhdev\\vendor\\session-host-daemon\\index.js'],
      ['/usr/bin/node /opt/adhdev/dist/cli/index.js daemon -p 19222', '/opt/adhdev/dist/cli/index.js'],
      ['node', null],
      [null, null],
      ['', null],
    ])('parses %j as %j', (input, expected) => {
      expect(parseNodeScriptPath(input as string | null)).toBe(expected)
    })
  })

  describe('listOwnedNodeProcesses', () => {
    it('returns an empty array on POSIX', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      expect(listOwnedNodeProcesses({ prefixes: ['C:\\adhdev'] })).toEqual([])
      expect(cp.execFileSync).not.toHaveBeenCalled()
    })

    it('returns only node processes under the requested prefixes', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        const cmd = String(args[args.length - 1] || '')
        if (file === 'powershell.exe' && cmd.includes('Get-Process node')) {
          return '[1111,2222,3333,4444]'
        }
        if (file === 'powershell.exe' && cmd.includes('Win32_Process')) {
          const pid = cmd.match(/ProcessId=(\d+)/)?.[1]
          const lines: Record<string, string> = {
            '1111': 'node "C:\\adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js"',
            '2222': 'node "C:\\adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\dist\\cli\\index.js" daemon',
            '3333': 'node "C:\\other\\app.js"',
            '4444': 'node "C:\\adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\dist\\cli\\index.js" setup',
          }
          return lines[pid ?? ''] ?? ''
        }
        return ''
      })

      const owned = listOwnedNodeProcesses({
        prefixes: ['C:\\adhdev\\npm-installs\\version-old'],
        markers: ['session-host-daemon', 'dist/cli/index.js'],
      })

      const pids = owned.map((o) => o.pid)
      expect(pids).toContain(1111)
      expect(pids).toContain(2222)
      expect(pids).toContain(4444)
      expect(pids).not.toContain(3333)
    })

    it('excludes requested pids and never treats the helper as owned', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        const cmd = String(args[args.length - 1] || '')
        if (file === 'powershell.exe' && cmd.includes('Get-Process node')) return '[1111,2222]'
        if (file === 'powershell.exe' && cmd.includes('Win32_Process')) {
          const pid = cmd.match(/ProcessId=(\d+)/)?.[1]
          return pid === '1111'
            ? 'node "C:\\adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\dist\\cli\\index.js"'
            : 'node "C:\\adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\dist\\cli\\index.js"'
        }
        return ''
      })

      const owned = listOwnedNodeProcesses({
        prefixes: ['C:\\adhdev\\npm-installs\\version-old'],
        excludePids: [1111, 2222],
        markers: ['dist/cli/index.js'],
      })

      expect(owned).toEqual([])
    })
  })

  describe('stopOwnedProcesses', () => {
    it('kills every listed process and waits for exit', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        if (file === 'taskkill') {
          expect(args).toContain('/F')
          return ''
        }
        return ''
      })

      const result = await stopOwnedProcesses({
        processes: [
          { pid: 1111, commandLine: 'node old.js' },
          { pid: 2222, commandLine: 'node old.js' },
        ],
        waitMs: 1000,
      })

      expect(result.stopped).toBe(2)
      expect(result.survivors).toEqual([])
      expect(cp.execFileSync).toHaveBeenCalledWith('taskkill', expect.arrayContaining(['/PID', '1111', '/T', '/F']), expect.anything())
    })

    it('reports survivors that do not exit within the wait window', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      killSpy.mockRestore()
      const persistentKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      cp.execFileSync.mockImplementation((file: string) => {
        if (file === 'taskkill') return ''
        return ''
      })

      try {
        const result = await stopOwnedProcesses({
          processes: [{ pid: 1111, commandLine: 'node old.js' }],
          waitMs: 100,
        })
        expect(result.stopped).toBe(0)
        expect(result.survivors).toHaveLength(1)
        expect(result.survivors[0].pid).toBe(1111)
      } finally {
        persistentKill.mockRestore()
      }
    })
  })

  describe('stopOwnedProcessesForPrefixes', () => {
    it('logs survivors and returns them truthfully', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const logLines: string[] = []
      cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        const cmd = String(args[args.length - 1] || '')
        if (file === 'powershell.exe' && cmd.includes('Get-Process node')) return '[1111]'
        if (file === 'powershell.exe' && cmd.includes('Win32_Process')) {
          return 'node "C:\\adhdev\\npm-installs\\version-old\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js"'
        }
        if (file === 'taskkill') return ''
        return ''
      })

      // Make the killed process survive the short wait.
      killSpy.mockRestore()
      const persistentKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const result = await stopOwnedProcessesForPrefixes({
          prefixes: ['C:\\adhdev\\npm-installs\\version-old'],
          markers: ['session-host-daemon'],
          waitMs: 100,
          log: (msg) => logLines.push(msg),
        })
        expect(result.survivors).toHaveLength(1)
        expect(logLines.some((line) => line.includes('Could not stop'))).toBe(true)
      } finally {
        persistentKill.mockRestore()
      }
    })
  })
})
