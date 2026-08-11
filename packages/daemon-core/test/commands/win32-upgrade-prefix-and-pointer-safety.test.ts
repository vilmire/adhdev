import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>()
  const execFileSync = vi.fn(actual.execFileSync)
  const spawnSync = vi.fn(actual.spawnSync)
  return { ...actual, execFileSync, spawnSync, default: { ...actual, execFileSync, spawnSync } }
})

// eslint-disable-next-line import/first
import * as child_process from 'child_process'
import {
  cleanupInactivePrefixesWithGuard,
  performWindowsAtomicUpgrade,
  type WindowsAtomicUpgradeHooks,
  type WindowsInstallerLayout,
} from '../../src/commands/windows-atomic-upgrade'

/**
 * Two irreversible-damage paths from the 2026-08-11 win32 outage.
 *
 * (1) The old install prefix was DELETED while a session-host was still running
 *     from it, because the process sweep that gates the deletion cannot see
 *     anything on a box where Windows process inspection is blocked — and
 *     reported "nothing running" rather than "could not check".
 *
 * (2) `.adhdev-current` was found EMPTY on the affected machine. An empty
 *     pointer is worse than a missing one: install.ps1's
 *     `Get-AdhdevActiveVersionPrefix` yields $null, and its stale-install sweep
 *     then protects NOTHING and queues every version-* prefix — the live one
 *     included — for deletion.
 */

const roots: string[] = []

function makeLayout(): WindowsInstallerLayout {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-prefix-safety-'))
  roots.push(homeDir)
  const installRoot = path.join(homeDir, '.adhdev', 'npm-installs')
  const stablePrefix = path.join(homeDir, '.adhdev', 'npm-global')
  const activeVersionName = 'version-new'
  const activePrefix = path.join(installRoot, activeVersionName)
  fs.mkdirSync(activePrefix, { recursive: true })
  fs.mkdirSync(stablePrefix, { recursive: true })
  return {
    homeDir,
    installRoot,
    stablePrefix,
    activePrefix,
    activeVersionName,
    pointerPath: path.join(stablePrefix, '.adhdev-current'),
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  vi.mocked(child_process.execFileSync).mockReset()
  vi.mocked(child_process.execFileSync).mockImplementation(actual.execFileSync as never)
})

describe('inactive-prefix cleanup refuses to delete on an unverified sweep', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  })

  /**
   * The live failure: a session-host is running from `version-old`, but the
   * command-line probe cannot report it. Deleting the prefix maims that
   * process — its already-loaded code keeps running and serving the socket,
   * while every lazy `require` (node-pty → conpty.node) now resolves into a
   * tree that no longer exists.
   */
  it('keeps the old prefix when the command-line probe is blocked', async () => {
    const layout = makeLayout()
    const oldPrefix = path.join(layout.installRoot, 'version-old')
    fs.mkdirSync(oldPrefix, { recursive: true })

    vi.mocked(child_process.execFileSync).mockImplementation(((file: string, args: readonly string[]) => {
      const argv = Array.isArray(args) ? args.join(' ') : ''
      if (file === 'powershell.exe' && argv.includes('Get-Process node')) return JSON.stringify([7777])
      if (file === 'powershell.exe' && argv.includes('Get-CimInstance')) throw new Error('Access denied')
      if (file === 'wmic') {
        const error: NodeJS.ErrnoException = new Error('not found')
        error.code = 'ENOENT'
        throw error
      }
      return ''
    }) as never)

    const logs: string[] = []
    await cleanupInactivePrefixesWithGuard({
      layout,
      activePrefix: layout.activePrefix,
      log: (m) => logs.push(m),
    })

    expect(fs.existsSync(oldPrefix)).toBe(true)
    expect(logs.join('\n')).toMatch(/Refusing to delete an install directory on an unverified sweep/i)
  })

  it('still deletes the old prefix when the sweep positively verifies it is clear', async () => {
    const layout = makeLayout()
    const oldPrefix = path.join(layout.installRoot, 'version-old')
    fs.mkdirSync(oldPrefix, { recursive: true })

    vi.mocked(child_process.execFileSync).mockImplementation(((file: string, args: readonly string[]) => {
      const argv = Array.isArray(args) ? args.join(' ') : ''
      if (file === 'powershell.exe' && argv.includes('Get-Process node')) return JSON.stringify([7777])
      if (file === 'powershell.exe' && argv.includes('Get-CimInstance')) {
        // Readable, and clearly not running under any adhdev prefix.
        return 'C:\\Program Files\\nodejs\\node.exe C:\\unrelated\\server.js'
      }
      return ''
    }) as never)

    await cleanupInactivePrefixesWithGuard({ layout, activePrefix: layout.activePrefix })

    expect(fs.existsSync(oldPrefix)).toBe(false)
  })
})

describe('.adhdev-current is never left empty', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    // POSIX atomicWrite branch — exercises the same restore logic without
    // shelling out to powershell.exe.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  })

  /**
   * A zero-length Buffer is truthy and `.toString()` gives '', so the old
   * `snapshot.exists && snapshot.data` restore wrote the empty pointer straight
   * back. Every rollback then re-propagated the corruption instead of healing
   * it, and the self-heal branch below it was unreachable.
   */
  it('rollback heals a zero-byte pointer instead of restoring it verbatim', async () => {
    const layout = makeLayout()
    // Pre-existing corruption: pointer exists but is empty.
    fs.writeFileSync(layout.pointerPath, '')
    fs.writeFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), '@echo old\r\n')
    fs.writeFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), '# old\r\n')
    fs.writeFileSync(path.join(layout.stablePrefix, 'adhdev'), '#!/bin/sh\n# old\n')

    const hooks: WindowsAtomicUpgradeHooks = {
      // Stage a prefix complete enough to pass the pre-activation gates
      // (conpty prebuild, package.json name/version, CLI entry) so the run
      // reaches activation and the failure below exercises the ROLLBACK path.
      install: (stagedPrefix: string) => {
        const pkgRoot = path.join(stagedPrefix, 'node_modules', 'adhdev')
        fs.mkdirSync(path.join(pkgRoot, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64'), { recursive: true })
        fs.writeFileSync(
          path.join(pkgRoot, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
          '',
        )
        fs.writeFileSync(
          path.join(pkgRoot, 'package.json'),
          JSON.stringify({ name: 'adhdev', version: '1.0.43', bin: { adhdev: 'cli.js' } }),
        )
        // A CLI entry that reports the target version, for validateStagedCli.
        fs.writeFileSync(path.join(pkgRoot, 'cli.js'), 'console.log("1.0.43")\n')
      },
      // Fail after activation so the rollback path runs.
      restart: () => { throw new Error('boom') },
      restartOld: () => {},
      waitForHealth: async () => false,
      stopProcess: () => {},
      cleanup: () => {},
      log: () => {},
    }

    await expect(performWindowsAtomicUpgrade({
      layout,
      packageName: 'adhdev',
      targetVersion: '1.0.43',
      portableNode: process.execPath,
      hooks,
    })).rejects.toThrow()

    const pointer = fs.readFileSync(layout.pointerPath, 'utf8').trim()
    expect(pointer).not.toBe('')
    expect(pointer).toBe(layout.activeVersionName)
  })
})
