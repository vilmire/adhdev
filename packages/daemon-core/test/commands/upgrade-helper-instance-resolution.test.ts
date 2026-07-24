import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveInstanceDir,
  resolveCurrentGlobalInstallSurface,
} from '../../src/commands/upgrade-helper'

// Phase 2: the Windows atomic-upgrade layout is per-instance. The canonical
// instance is derived from the running daemon's config-dir basename, which
// Phase 0/1 pin via ADHDEV_CONFIG_DIR (~/.adhdev stable, ~/.adhdev-preview
// preview). These tests prove that resolution and that it flows into the
// legacy node22-prefix convergence checks, while the stable path stays
// byte-for-byte identical.

const tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function real(value: string): string {
  return fs.realpathSync.native(value)
}

describe('resolveInstanceDir (config-dir basename → instanceDir)', () => {
  it('maps a stable config dir to `.adhdev`', () => {
    expect(resolveInstanceDir('/home/u/.adhdev')).toBe('.adhdev')
    // Trailing separators must not leak an empty basename.
    expect(resolveInstanceDir('/home/u/.adhdev/')).toBe('.adhdev')
  })

  it('maps a preview config dir to `.adhdev-preview`', () => {
    expect(resolveInstanceDir('/home/u/.adhdev-preview')).toBe('.adhdev-preview')
    expect(resolveInstanceDir(path.join('C:\\Users\\u', '.adhdev-preview'))).toBe('.adhdev-preview')
  })

  it('falls back to `.adhdev` for a degenerate (empty-basename) config dir', () => {
    expect(resolveInstanceDir('/')).toBe('.adhdev')
    expect(resolveInstanceDir('')).toBe('.adhdev')
  })

  it('defaults to the running daemon config-dir basename (ADHDEV_CONFIG_DIR → instance)', () => {
    const saved = process.env.ADHDEV_CONFIG_DIR
    try {
      // This is exactly the signal Phase 0/1 wire: the preview launcher pins
      // ADHDEV_CONFIG_DIR=~/.adhdev-preview, getConfigDir() honors it, and the
      // atomic-upgrade layer derives the instance from its basename.
      const previewDir = path.join(os.tmpdir(), 'adhdev-instance-env-.adhdev-preview')
      process.env.ADHDEV_CONFIG_DIR = previewDir
      expect(resolveInstanceDir()).toBe(path.basename(previewDir))
    } finally {
      if (saved === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = saved
    }
  })
})

describe('resolveCurrentGlobalInstallSurface instance scoping (win32 legacy convergence)', () => {
  // Build a legacy node22-prefix install for a given instance dir and assert the
  // FIX-C convergence redirects to THAT instance's npm-installs, never leaking
  // across instances.
  function legacyNode22Fixture(instanceDir: string) {
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-instance-conv-')))
    tempRoots.push(home)
    const node22Dir = path.join(home, instanceDir, 'tools', 'node22', 'node-v22.23.1-win-x64')
    const packageRoot = path.join(node22Dir, 'node_modules', 'adhdev')
    const cliPath = path.join(packageRoot, 'dist', 'cli', 'index.js')
    const nodePath = path.join(node22Dir, 'node.exe')
    fs.mkdirSync(path.dirname(cliPath), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '0.0.0-test' }))
    fs.writeFileSync(cliPath, '// cli\n')
    fs.writeFileSync(nodePath, '')
    return { home, cliPath, nodePath }
  }

  it('INVARIANT: explicit `.adhdev` converges to ~/.adhdev/npm-installs exactly as before', () => {
    const { home, cliPath, nodePath } = legacyNode22Fixture('.adhdev')
    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev', currentCliPath: cliPath, nodeExecutable: nodePath,
      platform: 'win32', homeDir: home, instanceDir: '.adhdev',
    })
    expect(surface.installPrefix).toBe(path.join(home, '.adhdev', 'npm-installs', 'version-legacy-migrate'))
  })

  it('preview instanceDir converges a legacy preview install onto ~/.adhdev-preview/npm-installs', () => {
    const { home, cliPath, nodePath } = legacyNode22Fixture('.adhdev-preview')
    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev', currentCliPath: cliPath, nodeExecutable: nodePath,
      platform: 'win32', homeDir: home, instanceDir: '.adhdev-preview',
    })
    // Redirects to the PREVIEW npm-installs, never the stable `.adhdev` tree.
    expect(surface.installPrefix).toBe(path.join(home, '.adhdev-preview', 'npm-installs', 'version-legacy-migrate'))
    expect(surface.installPrefix).not.toMatch(/[\\/]\.adhdev[\\/]/)
  })

  it('preview instanceDir follows the preview dispatcher pointer version when present', () => {
    const { home, cliPath, nodePath } = legacyNode22Fixture('.adhdev-preview')
    const npmGlobal = path.join(home, '.adhdev-preview', 'npm-global')
    fs.mkdirSync(npmGlobal, { recursive: true })
    fs.writeFileSync(path.join(npmGlobal, '.adhdev-current'), 'version-1700000000000-9-cafef00d\n')
    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev', currentCliPath: cliPath, nodeExecutable: nodePath,
      platform: 'win32', homeDir: home, instanceDir: '.adhdev-preview',
    })
    expect(surface.installPrefix).toBe(
      path.join(home, '.adhdev-preview', 'npm-installs', 'version-1700000000000-9-cafef00d'),
    )
  })

  it('a stable-instance surface does NOT converge a preview-tree legacy prefix (no cross-instance leak)', () => {
    // Running under a preview node22 tree but resolving with the stable
    // instanceDir: the prefix is NOT under the stable tools/node22, so FIX C
    // does not fire and the reverse-resolved (preview) prefix is left as-is.
    const { home, cliPath, nodePath } = legacyNode22Fixture('.adhdev-preview')
    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev', currentCliPath: cliPath, nodeExecutable: nodePath,
      platform: 'win32', homeDir: home, instanceDir: '.adhdev',
    })
    // No convergence → the preview node22 dir prefix survives untouched.
    expect(surface.installPrefix).not.toBe(path.join(home, '.adhdev', 'npm-installs', 'version-legacy-migrate'))
    expect(surface.installPrefix).toContain(path.join('.adhdev-preview', 'tools', 'node22'))
  })
})
