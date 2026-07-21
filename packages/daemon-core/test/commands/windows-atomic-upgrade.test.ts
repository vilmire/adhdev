import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  performWindowsAtomicUpgrade,
  resolveWindowsInstallerLayout,
  type WindowsAtomicUpgradeHooks,
  type WindowsInstallerLayout,
} from '../../src/commands/windows-atomic-upgrade'
import { emitUpgradeFailureNotice } from '../../src/commands/upgrade-helper'

const roots: string[] = []

function fixture(): { layout: WindowsInstallerLayout; oldCmd: string; oldPs1: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-atomic-win-'))
  roots.push(homeDir)
  const installRoot = path.join(homeDir, '.adhdev', 'npm-installs')
  const stablePrefix = path.join(homeDir, '.adhdev', 'npm-global')
  const activeVersionName = 'version-old'
  const activePrefix = path.join(installRoot, activeVersionName)
  const pointerPath = path.join(stablePrefix, '.adhdev-current')
  fs.mkdirSync(activePrefix, { recursive: true })
  fs.mkdirSync(stablePrefix, { recursive: true })
  const oldCmd = '@echo old cmd\r\n'
  const oldPs1 = '# old ps1\r\n'
  fs.writeFileSync(pointerPath, activeVersionName)
  fs.writeFileSync(path.join(stablePrefix, 'adhdev.cmd'), oldCmd)
  fs.writeFileSync(path.join(stablePrefix, 'adhdev.ps1'), oldPs1)
  return {
    layout: { homeDir, installRoot, stablePrefix, activePrefix, activeVersionName, pointerPath },
    oldCmd,
    oldPs1,
  }
}

function installPackage(prefix: string, version: string, marker?: string): void {
  const packageRoot = path.join(prefix, 'node_modules', 'adhdev')
  const cli = path.join(packageRoot, 'dist', 'cli', 'index.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'adhdev', version, bin: { adhdev: 'dist/cli/index.js' },
  }))
  fs.writeFileSync(cli, `${marker ? `require('fs').writeFileSync(${JSON.stringify(marker)}, process.execPath);` : ''} console.log(${JSON.stringify(version)});\n`)
  fs.writeFileSync(path.join(prefix, 'adhdev.cmd'), 'npm cmd')
  fs.writeFileSync(path.join(prefix, 'adhdev.ps1'), 'npm ps1')
}

function child(pid = 4242): ChildProcess {
  return { pid } as ChildProcess
}

function hooks(overrides: Partial<WindowsAtomicUpgradeHooks> = {}): WindowsAtomicUpgradeHooks {
  return {
    install: () => {},
    restart: () => child(),
    restartOld: () => {},
    waitForHealth: async () => true,
    stopProcess: () => {},
    cleanup: () => {},
    log: () => {},
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Windows installer-managed atomic upgrade', () => {
  it('detects only the active Windows pointer layout and documents the macOS harness skip', () => {
    const { layout } = fixture()
    expect(resolveWindowsInstallerLayout({
      homeDir: layout.homeDir, installPrefix: layout.activePrefix, platform: 'win32',
    })?.activeVersionName).toBe('version-old')
    expect(resolveWindowsInstallerLayout({
      homeDir: layout.homeDir, installPrefix: layout.activePrefix, platform: 'darwin',
    })).toBeNull()
    // Windows PowerShell 5.1 execution is exercised only on Windows CI; macOS
    // validates the filesystem transaction and intentionally skips PS5.1 itself.
  })

  it('still protects a running versioned prefix after a partial update lost or stale-pinned the pointer', () => {
    const { layout } = fixture()
    fs.unlinkSync(layout.pointerPath)
    expect(resolveWindowsInstallerLayout({
      homeDir: layout.homeDir, installPrefix: layout.activePrefix, platform: 'win32',
    })?.activePrefix).toBe(layout.activePrefix)
    fs.writeFileSync(layout.pointerPath, 'version-some-other-attempt')
    expect(resolveWindowsInstallerLayout({
      homeDir: layout.homeDir, installPrefix: layout.activePrefix, platform: 'win32',
    })?.activeVersionName).toBe('version-old')
  })

  it('does not touch the active prefix or stable shims until staging validates', async () => {
    const { layout, oldCmd, oldPs1 } = fixture()
    const activeSentinel = path.join(layout.activePrefix, 'sentinel.txt')
    fs.writeFileSync(activeSentinel, 'old-active')
    let installedPrefix = ''
    await performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => {
          installedPrefix = prefix
          expect(prefix).not.toBe(layout.activePrefix)
          expect(fs.readFileSync(activeSentinel, 'utf8')).toBe('old-active')
          expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
          expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), 'utf8')).toBe(oldCmd)
          expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), 'utf8')).toBe(oldPs1)
          installPackage(prefix, '1.0.18-rc.1')
        },
      }),
    })
    expect(installedPrefix).not.toBe(layout.activePrefix)
    expect(fs.readFileSync(activeSentinel, 'utf8')).toBe('old-active')
  })

  it('leaves the old pointer and both stable shims intact when staging fails', async () => {
    const { layout, oldCmd, oldPs1 } = fixture()
    let rollbackRestarted = false
    await expect(performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({
        install: () => { throw new Error('ordinary npm failure') },
        restartOld: () => { rollbackRestarted = true },
      }),
    })).rejects.toThrow('ordinary npm failure')
    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), 'utf8')).toBe(oldCmd)
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), 'utf8')).toBe(oldPs1)
    expect(rollbackRestarted).toBe(true)
  })

  it('writes an actionable last-error notice for non-lock failures', () => {
    const { layout } = fixture()
    emitUpgradeFailureNotice(['adhdev upgrade failed: ordinary npm failure', 'Previous version preserved.'], layout.homeDir)
    const notice = fs.readFileSync(path.join(layout.homeDir, '.adhdev', 'daemon-upgrade-last-error.txt'), 'utf8')
    expect(notice).toContain('ordinary npm failure')
    expect(notice).toContain('Previous version preserved')
  })

  it('pins cmd and ps1 to the absolute runtime before pointer activation and ignores PATH Node shadowing', async () => {
    const { layout } = fixture()
    const marker = path.join(layout.homeDir, 'exec-path.txt')
    const oldPath = process.env.PATH
    process.env.PATH = `${path.join(layout.homeDir, 'fake-node24')}${path.delimiter}${oldPath || ''}`
    try {
      const result = await performWindowsAtomicUpgrade({
        layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
        hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.1', marker) }),
      })
      expect(fs.readFileSync(path.join(result.stagedPrefix, 'adhdev.cmd'), 'utf8')).toContain(process.execPath)
      expect(fs.readFileSync(path.join(result.stagedPrefix, 'adhdev.ps1'), 'utf8')).toContain(process.execPath)
      expect(fs.readFileSync(marker, 'utf8')).toBe(process.execPath)
      expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe(path.basename(result.stagedPrefix))
    } finally {
      process.env.PATH = oldPath
    }
  })

  it('rolls the pointer and stable shims back when the replacement daemon is unhealthy', async () => {
    const { layout, oldCmd, oldPs1 } = fixture()
    let stopped = 0
    let restartedOld = 0
    await expect(performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => installPackage(prefix, '1.0.18-rc.1'),
        waitForHealth: async () => false,
        stopProcess: (pid) => { stopped = pid },
        restartOld: () => { restartedOld++ },
      }),
    })).rejects.toThrow('health/version gate')
    expect(stopped).toBe(4242)
    expect(restartedOld).toBe(1)
    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), 'utf8')).toBe(oldCmd)
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), 'utf8')).toBe(oldPs1)
  })

  it('supports preview-to-stable switching and repeated updates with fresh prefixes', async () => {
    const first = fixture()
    const preview = await performWindowsAtomicUpgrade({
      layout: first.layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.1') }),
    })
    const nextLayout = resolveWindowsInstallerLayout({
      homeDir: first.layout.homeDir, installPrefix: preview.stagedPrefix, platform: 'win32',
    })!
    const stable = await performWindowsAtomicUpgrade({
      layout: nextLayout, packageName: 'adhdev', targetVersion: '1.0.18', portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18') }),
    })
    expect(stable.stagedPrefix).not.toBe(preview.stagedPrefix)
    expect(fs.readFileSync(nextLayout.pointerPath, 'utf8')).toBe(path.basename(stable.stagedPrefix))
    const pkg = JSON.parse(fs.readFileSync(path.join(stable.stagedPrefix, 'node_modules', 'adhdev', 'package.json'), 'utf8'))
    expect(pkg.version).toBe('1.0.18')
  })
})
