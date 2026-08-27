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
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalConfigDir: string | undefined

// The session-host spawn must run under the bundled portable Node 22 on win32 so
// node-pty loads its shipped conpty.node prebuild. On every other platform the
// spawn must remain byte-for-byte `process.execPath`.
describe('managed session-host node runtime pin', () => {
  beforeEach(() => {
    cp.execFileSync.mockReset()
    cp.spawn.mockReset()
    cp.spawn.mockImplementation(() => ({ unref: vi.fn(), pid: 4242 }))
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function makeTempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-managed-host-pin-'))
    tempRoots.push(dir)
    return dir
  }

  // findPortableNode22() is called with os.homedir(), which reads
  // USERPROFILE on win32 (not HOME) — relocate both so the staged fixture
  // under <home>/.adhdev/tools/node22 is actually found.
  function setFakeHome(dir: string): void {
    process.env.HOME = dir
    process.env.USERPROFILE = dir
  }

  function stagePortableNode22(homeDir: string): string {
    const portableDir = path.join(homeDir, '.adhdev', 'tools', 'node22', 'node-v22.11.0-win-x64')
    fs.mkdirSync(portableDir, { recursive: true })
    const nodeExe = path.join(portableDir, 'node.exe')
    fs.writeFileSync(nodeExe, 'binary', 'utf8')
    return nodeExe
  }

  it('spawns the session-host with portable Node 22 on win32', () => {
    const homeDir = makeTempHome()
    setFakeHome(homeDir)
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const portableNode = stagePortableNode22(homeDir)

    // findPortableNode22 probes each candidate node with `-p process.versions.node`.
    // Report 22 only for the staged portable node so it wins over process.execPath.
    cp.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      if (Array.isArray(args) && args[0] === '-p' && String(args[1] || '').includes('process.versions.node')) {
        return path.resolve(file) === path.resolve(portableNode) ? '22.11.0' : '24.3.0'
      }
      return ''
    })

    const appName = `adhdev-pin-${process.pid}-${Date.now()}`
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
    host.spawnHost()

    expect(cp.spawn).toHaveBeenCalledTimes(1)
    const [executable] = cp.spawn.mock.calls[0]
    expect(path.resolve(executable)).toBe(path.resolve(portableNode))
    expect(executable).not.toBe(process.execPath)
  })

  it('falls back to process.execPath on win32 when no portable Node 22 is staged', () => {
    const homeDir = makeTempHome()
    setFakeHome(homeDir)
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    // No portable node staged; any node probe reports non-22 so nothing qualifies.
    cp.execFileSync.mockImplementation(() => '24.3.0')

    const appName = `adhdev-pin-fallback-${process.pid}-${Date.now()}`
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
    host.spawnHost()

    expect(cp.spawn).toHaveBeenCalledTimes(1)
    const [executable] = cp.spawn.mock.calls[0]
    expect(executable).toBe(process.execPath)
  })

  it('spawns the session-host with process.execPath unchanged on non-win32 (invariant)', () => {
    const homeDir = makeTempHome()
    setFakeHome(homeDir)
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    // Even if a portable node happens to exist, non-win32 must never resolve it.
    stagePortableNode22(homeDir)
    cp.execFileSync.mockImplementation(() => '22.11.0')

    const appName = `adhdev-pin-linux-${process.pid}-${Date.now()}`
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
    host.spawnHost()

    expect(cp.spawn).toHaveBeenCalledTimes(1)
    const [executable] = cp.spawn.mock.calls[0]
    expect(executable).toBe(process.execPath)
    // The runtime resolver must not probe any node binary on non-win32.
    const probeCalls = cp.execFileSync.mock.calls.filter(
      (c: any[]) => Array.isArray(c[1]) && c[1][0] === '-p',
    )
    expect(probeCalls.length).toBe(0)
  })
})
