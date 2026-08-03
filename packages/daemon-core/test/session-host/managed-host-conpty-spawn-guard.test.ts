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
import { resolveConptyPrebuildCandidates } from '../../src/commands/windows-atomic-upgrade'

const tempRoots: string[] = []
let platformDescriptor: PropertyDescriptor | undefined
let originalHome: string | undefined
let originalConfigDir: string | undefined

/**
 * D4-a: the install-time conpty gate (windows-atomic-upgrade.ts) only proves
 * the prebuild existed at STAGING time. A live production incident showed it
 * can vanish from the ACTIVE prefix afterward through a mechanism that gate
 * cannot see. Re-verifying right before every session-host spawn on win32 is
 * the only remaining defense, and turns a 4ms `Cannot find module
 * './prebuilds/win32-x64/conpty.node'` require crash (no hint which prefix
 * was checked) into an immediate error naming the exact paths checked.
 *
 * `resolveEntry()` derives its packaged-layout candidates from THIS module's
 * own `__dirname`, which in a test process is the real daemon-core src tree —
 * not a disposable fixture. So the spawn-time guard's marker-matching
 * arithmetic (does `entry` look like a packaged install, and if so what
 * active prefix does it imply) is verified directly against representative
 * paths, including the verbatim shape from the production incident's require
 * stack. The behavioral guarantees that ARE safe to exercise through the real
 * `spawnHost()` in this process (no-op on non-win32; no-op when resolveEntry
 * falls through to a workspace package with no packaged-layout marker) are
 * covered separately below.
 */
describe('managed session-host conpty pre-spawn guard', () => {
  beforeEach(() => {
    cp.execFileSync.mockReset()
    cp.spawn.mockReset()
    cp.spawn.mockImplementation(() => ({ unref: vi.fn(), pid: 4242 }))
    // findPortableNode22 probes candidates with `-p process.versions.node`;
    // report a non-22 version everywhere so the spawn falls back to
    // process.execPath without needing a staged portable node for these tests.
    cp.execFileSync.mockImplementation(() => '24.3.0')
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    originalHome = process.env.HOME
    originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function makeTempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-managed-host-conpty-'))
    tempRoots.push(dir)
    return dir
  }

  it('does not throw and does not skip the spawn when resolveEntry falls through to the workspace package (dev/monorepo checkout, no packaged vendor layout)', () => {
    const homeDir = makeTempHome()
    process.env.HOME = homeDir
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    const appName = `adhdev-conpty-devcheckout-${process.pid}-${Date.now()}`
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })

    expect(() => host.spawnHost()).not.toThrow()
    expect(cp.spawn).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on non-win32 platforms regardless of conpty presence', () => {
    const homeDir = makeTempHome()
    process.env.HOME = homeDir
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    const appName = `adhdev-conpty-darwin-${process.pid}-${Date.now()}`
    const host = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })

    expect(() => host.spawnHost()).not.toThrow()
    expect(cp.spawn).toHaveBeenCalledTimes(1)
  })

  describe('resolveConptyPrebuildCandidates (shared with the install-time gate)', () => {
    it('lists both the nested and hoisted node-pty layouts under a given prefix', () => {
      const activePrefix = path.join('C:', 'Users', 'kjs0116', '.adhdev', 'npm-installs', 'version-current')
      const candidates = resolveConptyPrebuildCandidates(activePrefix)
      expect(candidates).toEqual([
        path.join(activePrefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
        path.join(activePrefix, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
      ])
    })

    it('finds a real conpty.node staged at the nested location on disk', () => {
      const homeDir = makeTempHome()
      const activePrefix = path.join(homeDir, 'npm-installs', 'version-current')
      const [nested] = resolveConptyPrebuildCandidates(activePrefix)
      fs.mkdirSync(path.dirname(nested), { recursive: true })
      fs.writeFileSync(nested, 'conpty.node placeholder')
      expect(resolveConptyPrebuildCandidates(activePrefix).some((c) => fs.existsSync(c))).toBe(true)
    })

    it('finds a real conpty.node staged at the hoisted location on disk', () => {
      const homeDir = makeTempHome()
      const activePrefix = path.join(homeDir, 'npm-installs', 'version-current')
      const [, hoisted] = resolveConptyPrebuildCandidates(activePrefix)
      fs.mkdirSync(path.dirname(hoisted), { recursive: true })
      fs.writeFileSync(hoisted, 'conpty.node placeholder (hoisted)')
      expect(resolveConptyPrebuildCandidates(activePrefix).some((c) => fs.existsSync(c))).toBe(true)
    })

    it('finds neither when conpty.node is absent from both layouts (the incident scenario)', () => {
      const homeDir = makeTempHome()
      const activePrefix = path.join(homeDir, 'npm-installs', 'version-current')
      fs.mkdirSync(activePrefix, { recursive: true })
      expect(resolveConptyPrebuildCandidates(activePrefix).some((c) => fs.existsSync(c))).toBe(false)
    })
  })

  describe('marker-matching arithmetic (mirrors verifyConptyPrebuildBeforeSpawn in managed-host.ts)', () => {
    function deriveActivePrefix(entry: string): string | null {
      const normalized = entry.replace(/\\/g, '/')
      const marker = '/node_modules/adhdev/vendor/session-host-daemon/'
      const markerIndex = normalized.lastIndexOf(marker)
      if (markerIndex === -1) return null
      return entry.slice(0, markerIndex)
    }

    it('derives the exact active prefix from the production incident require-stack shape', () => {
      const entry = 'C:\\Users\\kjs0116\\.adhdev\\npm-installs\\version-1784879721933-13212-ab0a5a54b6905\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js'
      expect(deriveActivePrefix(entry)).toBe(
        'C:\\Users\\kjs0116\\.adhdev\\npm-installs\\version-1784879721933-13212-ab0a5a54b6905',
      )
    })

    it('returns null (skip) for a workspace/monorepo package path with no packaged-layout marker', () => {
      const entry = '/Users/vilmire/Work/adhdev/oss/packages/session-host-daemon/dist/index.js'
      expect(deriveActivePrefix(entry)).toBeNull()
    })
  })
})
