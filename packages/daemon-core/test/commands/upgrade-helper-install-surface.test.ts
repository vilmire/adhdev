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
})
