import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock('child_process', () => mocks)

import { listForeignNativeAddonHolders, stopForeignNativeAddonHolders } from '../../src/commands/upgrade-helper'

// These helpers branch on process.platform: the conpty.node / ghostty-vt.dll
// exclusive lock only exists on Windows, so the whole feature is a no-op on
// POSIX. Pin win32 so the suite exercises the real path regardless of host OS.
let platformDescriptor: PropertyDescriptor | undefined
let killSpy: ReturnType<typeof vi.spyOn>

const PACKAGE_ROOT = 'C:\\Users\\dev\\AppData\\Local\\nvm\\v22.14.0\\node_modules\\adhdev'

// Route the two distinct powershell.exe call-sites (the holder enumeration vs.
// getProcessCommandLine's Get-CimInstance) plus taskkill by inspecting the argv.
function routeExec(onHolders: () => string, opts: { commandLine?: string; taskkillThrows?: boolean } = {}) {
  return (file: string, args: readonly string[]) => {
    const cmd = String(args[args.length - 1] || '')
    if (file === 'powershell.exe' && cmd.includes('Get-Process node')) return onHolders()
    if (file === 'powershell.exe' && cmd.includes('Win32_Process')) return opts.commandLine ?? 'node %TEMP%\\pty_probe.cjs'
    if (file === 'taskkill') {
      if (opts.taskkillThrows) throw new Error('Access denied')
      return ''
    }
    throw new Error(`unexpected execFileSync ${file} ${cmd}`)
  }
}

beforeEach(() => {
  mocks.execFileSync.mockReset()
  mocks.spawn.mockClear()
  // SIGTERM (kill request) succeeds; the signal-0 liveness probe in
  // waitForPidExit throws ESRCH so the post-kill wait resolves immediately
  // instead of spinning the full 15s timeout.
  killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
    if (signal === 0) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    return true
  })
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterEach(() => {
  killSpy.mockRestore()
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
})

describe('foreign native-addon holder detection', () => {
  it('returns nothing on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(listForeignNativeAddonHolders(PACKAGE_ROOT)).toEqual([])
  })

  it('returns nothing when the package root is unknown', () => {
    expect(listForeignNativeAddonHolders(null)).toEqual([])
    expect(listForeignNativeAddonHolders('')).toEqual([])
  })

  it('lists foreign holder pids, excluding the helper itself, with command lines', () => {
    mocks.execFileSync.mockImplementation(
      routeExec(() => `56396\n37304\n${process.pid}\n`, { commandLine: 'node %TEMP%\\pty_cr_probe.cjs' }),
    )

    const holders = listForeignNativeAddonHolders(PACKAGE_ROOT)
    const pids = holders.map((h) => h.pid)
    expect(pids).toContain(56396)
    expect(pids).toContain(37304)
    expect(pids).not.toContain(process.pid)
    expect(holders[0].commandLine).toMatch(/pty_cr_probe\.cjs/)
  })

  it('terminates each foreign holder and waits for exit, excluding the parent pid', async () => {
    mocks.execFileSync.mockImplementation(routeExec(() => '56396\n34316\n'))

    const results = await stopForeignNativeAddonHolders(PACKAGE_ROOT, { parentPid: 34316 })

    // 34316 == parentPid, handled separately, so only 56396 is acted on.
    expect(results.map((r) => r.pid)).toEqual([56396])
    expect(results[0].killed).toBe(true)
    const taskkillCalls = mocks.execFileSync.mock.calls.filter((c: any[]) => c[0] === 'taskkill')
    expect(taskkillCalls.some((c: any[]) => c[1].includes('56396'))).toBe(true)
    expect(taskkillCalls.some((c: any[]) => c[1].includes('34316'))).toBe(false)
  })

  it('reports killed=false when taskkill fails', async () => {
    mocks.execFileSync.mockImplementation(
      routeExec(() => '99999\n', { commandLine: 'node weird.cjs', taskkillThrows: true }),
    )

    const results = await stopForeignNativeAddonHolders(PACKAGE_ROOT)
    expect(results).toEqual([{ pid: 99999, commandLine: 'node weird.cjs', killed: false }])
  })

  it('scopes the enumeration script to this install package root and both locked addons', () => {
    let capturedScript = ''
    mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      const cmd = String(args[args.length - 1] || '')
      if (file === 'powershell.exe' && cmd.includes('Get-Process node')) {
        capturedScript = cmd
        return ''
      }
      throw new Error(`unexpected execFileSync ${file} ${cmd}`)
    })

    listForeignNativeAddonHolders(PACKAGE_ROOT)
    // Scoped to THIS install's package root (lower-cased, backslash form) so a
    // holder of an unrelated install is never matched.
    expect(capturedScript.toLowerCase()).toContain(PACKAGE_ROOT.toLowerCase())
    expect(capturedScript).toContain('conpty.node')
    expect(capturedScript).toContain('ghostty-vt.dll')
  })
})
