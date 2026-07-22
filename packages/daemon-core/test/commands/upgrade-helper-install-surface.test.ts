import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPinnedGlobalInstallCommand,
  resolveCurrentGlobalInstallSurface,
} from '../../src/commands/upgrade-helper'

const tempRoots: string[] = []

function createInstalledCliFixture(options: { prefixName: string; packageName?: string; scoped?: boolean }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-upgrade-surface-'))
  tempRoots.push(tempRoot)

  const prefixRoot = path.join(tempRoot, options.prefixName)
  const packageName = options.packageName || 'adhdev'
  const packageRoot = options.scoped
    ? path.join(prefixRoot, 'lib', 'node_modules', '@adhdev', 'daemon-standalone')
    : path.join(prefixRoot, 'lib', 'node_modules', packageName)
  const cliPath = options.scoped
    ? path.join(packageRoot, 'dist', 'index.js')
    : path.join(packageRoot, 'dist', 'cli', 'index.js')
  const nodePath = path.join(prefixRoot, 'bin', 'node')
  const npmPath = path.join(prefixRoot, 'bin', 'npm')

  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.mkdirSync(path.dirname(nodePath), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.0-test' }), 'utf8')
  fs.writeFileSync(cliPath, '// cli entry\n', 'utf8')
  fs.writeFileSync(nodePath, '#!/usr/bin/env node\n', 'utf8')
  fs.writeFileSync(npmPath, '#!/usr/bin/env node\n', 'utf8')

  return { prefixRoot, packageRoot, cliPath, nodePath, npmPath, packageName }
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function real(value: string): string {
  return fs.realpathSync.native(value)
}

describe('upgrade helper install surface', () => {
  it('pins adhdev upgrades to the currently running global prefix instead of a different npm default', () => {
    const fixture = createInstalledCliFixture({ prefixName: 'nvm', packageName: 'adhdev' })

    const surface = resolveCurrentGlobalInstallSurface({
      packageName: fixture.packageName,
      currentCliPath: fixture.cliPath,
      nodeExecutable: fixture.nodePath,
    })

    expect(surface.packageRoot).toBe(real(fixture.packageRoot))
    expect(surface.installPrefix).toBe(real(fixture.prefixRoot))
    expect(surface.npmExecutable).toBe(fixture.npmPath)

    const install = buildPinnedGlobalInstallCommand({
      packageName: fixture.packageName,
      targetVersion: '0.9.2',
      currentCliPath: fixture.cliPath,
      nodeExecutable: fixture.nodePath,
    })

    expect(install.command).toBe(fixture.npmPath)
    expect(install.args).toEqual([
      'install',
      '-g',
      'adhdev@0.9.2',
      '--force',
      '--prefix',
      real(fixture.prefixRoot),
    ])
  })

  it('pins scoped standalone upgrades to the active scoped package prefix', () => {
    const fixture = createInstalledCliFixture({
      prefixName: 'homebrew',
      packageName: '@adhdev/daemon-standalone',
      scoped: true,
    })

    const install = buildPinnedGlobalInstallCommand({
      packageName: fixture.packageName,
      targetVersion: '0.9.2',
      currentCliPath: fixture.cliPath,
      nodeExecutable: fixture.nodePath,
    })

    expect(install.args).toEqual([
      'install',
      '-g',
      '@adhdev/daemon-standalone@0.9.2',
      '--force',
      '--prefix',
      real(fixture.prefixRoot),
    ])
  })

  it('FIX C: forces a win32 legacy node22-prefix install to converge on the dispatcher prefix', () => {
    // Simulate the running adhdev living under ~/.adhdev/tools/node22/<node>/
    // node_modules/adhdev — the legacy layout a `npm i -g` under portable node22
    // produces. Self-upgrade must NOT reuse that prefix (it self-perpetuates and
    // shadows the dispatcher); it must redirect to ~/.adhdev/npm-installs/version-*.
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-fixc-home-')))
    tempRoots.push(home)
    const node22Dir = path.join(home, '.adhdev', 'tools', 'node22', 'node-v22.23.1-win-x64')
    const packageRoot = path.join(node22Dir, 'node_modules', 'adhdev')
    const cliPath = path.join(packageRoot, 'dist', 'cli', 'index.js')
    const nodePath = path.join(node22Dir, 'node.exe')
    const npmCliPath = path.join(node22Dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    fs.mkdirSync(path.dirname(cliPath), { recursive: true })
    fs.mkdirSync(path.dirname(npmCliPath), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '0.0.0-test' }))
    fs.writeFileSync(cliPath, '// cli\n')
    fs.writeFileSync(nodePath, '')
    fs.writeFileSync(npmCliPath, '')

    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev',
      currentCliPath: cliPath,
      nodeExecutable: nodePath,
      platform: 'win32',
      homeDir: home,
    })

    // No dispatcher pointer yet → migration sentinel under npm-installs.
    const expectedPrefix = path.join(home, '.adhdev', 'npm-installs', 'version-legacy-migrate')
    expect(surface.installPrefix).toBe(expectedPrefix)
    expect(surface.installPrefix).not.toContain(path.join('tools', 'node22'))
  })

  it('FIX C: converges a win32 legacy node22-prefix install onto the existing dispatcher pointer version', () => {
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-fixc-ptr-')))
    tempRoots.push(home)
    const node22Dir = path.join(home, '.adhdev', 'tools', 'node22', 'node-v22.23.1-win-x64')
    const packageRoot = path.join(node22Dir, 'node_modules', 'adhdev')
    const cliPath = path.join(packageRoot, 'dist', 'cli', 'index.js')
    const nodePath = path.join(node22Dir, 'node.exe')
    fs.mkdirSync(path.dirname(cliPath), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '0.0.0-test' }))
    fs.writeFileSync(cliPath, '// cli\n')
    fs.writeFileSync(nodePath, '')
    // An existing dispatcher pointer names the active version.
    const npmGlobal = path.join(home, '.adhdev', 'npm-global')
    fs.mkdirSync(npmGlobal, { recursive: true })
    fs.writeFileSync(path.join(npmGlobal, '.adhdev-current'), 'version-1700000000000-42-abcdef\n')

    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev',
      currentCliPath: cliPath,
      nodeExecutable: nodePath,
      platform: 'win32',
      homeDir: home,
    })

    expect(surface.installPrefix).toBe(path.join(home, '.adhdev', 'npm-installs', 'version-1700000000000-42-abcdef'))
  })

  it('FIX C: leaves a genuine win32 dispatcher prefix untouched (no false convergence)', () => {
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-fixc-disp-')))
    tempRoots.push(home)
    const versionPrefix = path.join(home, '.adhdev', 'npm-installs', 'version-1700000000000-7-deadbeef')
    const packageRoot = path.join(versionPrefix, 'node_modules', 'adhdev')
    const cliPath = path.join(packageRoot, 'dist', 'cli', 'index.js')
    const nodePath = path.join(home, '.adhdev', 'tools', 'node22', 'node-v22.23.1-win-x64', 'node.exe')
    fs.mkdirSync(path.dirname(cliPath), { recursive: true })
    fs.mkdirSync(path.dirname(nodePath), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '0.0.0-test' }))
    fs.writeFileSync(cliPath, '// cli\n')
    fs.writeFileSync(nodePath, '')

    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev',
      currentCliPath: cliPath,
      nodeExecutable: nodePath,
      platform: 'win32',
      homeDir: home,
    })

    // Already a dispatcher version- prefix → used as-is, never rewritten.
    expect(surface.installPrefix).toBe(real(versionPrefix))
  })

  it('FIX C: does not converge a node22-prefix install on non-win32 (scoped to Windows only)', () => {
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-fixc-posix-')))
    tempRoots.push(home)
    const node22Dir = path.join(home, '.adhdev', 'tools', 'node22', 'node-v22.23.1-linux-x64')
    const packageRoot = path.join(node22Dir, 'node_modules', 'adhdev')
    const cliPath = path.join(packageRoot, 'dist', 'cli', 'index.js')
    const nodePath = path.join(node22Dir, 'node')
    fs.mkdirSync(path.dirname(cliPath), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'adhdev', version: '0.0.0-test' }))
    fs.writeFileSync(cliPath, '// cli\n')
    fs.writeFileSync(nodePath, '')

    const surface = resolveCurrentGlobalInstallSurface({
      packageName: 'adhdev',
      currentCliPath: cliPath,
      nodeExecutable: nodePath,
      platform: 'linux',
      homeDir: home,
    })

    // POSIX keeps the reverse-resolved prefix (node22 dir) untouched.
    expect(surface.installPrefix).toBe(real(node22Dir))
  })

  it('runs Windows npm through npm-cli.js without shelling out to npm.cmd', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-upgrade-surface-win-'))
    tempRoots.push(tempRoot)
    const prefixRoot = path.join(tempRoot, 'portable node')
    const nodePath = path.join(prefixRoot, 'node.exe')
    const npmCmdPath = path.join(prefixRoot, 'npm.cmd')
    const npmCliPath = path.join(prefixRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    fs.mkdirSync(path.dirname(npmCliPath), { recursive: true })
    fs.writeFileSync(nodePath, '', 'utf8')
    fs.writeFileSync(npmCmdPath, '', 'utf8')
    fs.writeFileSync(npmCliPath, '', 'utf8')

    const install = buildPinnedGlobalInstallCommand({
      packageName: 'adhdev',
      targetVersion: 'latest',
      nodeExecutable: nodePath,
      platform: 'win32',
    })

    expect(install.command).toBe(nodePath)
    expect(install.args[0]).toBe(npmCliPath)
    expect(install.surface.npmArgsPrefix).toEqual([npmCliPath])
    expect(install.surface.execOptions).toEqual({ shell: false, windowsHide: true })
    expect(install.execOptions).toEqual({ shell: false, windowsHide: true })
  })
})
