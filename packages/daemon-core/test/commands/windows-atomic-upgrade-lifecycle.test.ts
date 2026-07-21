import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })),
  spawnSync: vi.fn(() => ({ status: 0, error: null })),
}))
vi.mock('child_process', () => cp)

import {
  ADHDEV_OWNED_MARKERS,
  cleanupInactivePrefixesWithGuard,
  performWindowsAtomicUpgrade,
  resolveWindowsInstallerLayout,
  type WindowsAtomicUpgradeHooks,
  type WindowsInstallerLayout,
} from '../../src/commands/windows-atomic-upgrade'

const roots: string[] = []
let platformDescriptor: PropertyDescriptor | undefined
let killSpy: ReturnType<typeof vi.spyOn>

function fixture(): { layout: WindowsInstallerLayout; oldCmd: string; oldPs1: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-atomic-life-'))
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

function installPackage(prefix: string, version: string): void {
  const packageRoot = path.join(prefix, 'node_modules', 'adhdev')
  const cli = path.join(packageRoot, 'dist', 'cli', 'index.js')
  const vendorEntry = path.join(packageRoot, 'vendor', 'session-host-daemon', 'index.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.mkdirSync(path.dirname(vendorEntry), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'adhdev', version, bin: { adhdev: 'dist/cli/index.js' },
  }))
  fs.writeFileSync(cli, `console.log(${JSON.stringify(version)});\n`)
  fs.writeFileSync(vendorEntry, 'module.exports = {}\n')
  fs.writeFileSync(path.join(prefix, 'adhdev.cmd'), 'npm cmd')
  fs.writeFileSync(path.join(prefix, 'adhdev.ps1'), 'npm ps1')
  // Simulate the healthy rc.2 node-pty prebuild that DST-1772-DT confirmed.
  const conpty = path.join(packageRoot, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')
  fs.mkdirSync(path.dirname(conpty), { recursive: true })
  fs.writeFileSync(conpty, 'native')
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

function normalizePsPath(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\//g, '\\')
}

function versionForCliScript(scriptPath: string): string | null {
  try {
    const packageRoot = path.resolve(path.dirname(scriptPath), '..', '..')
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

// `removeInactivePrefix` passes the deletion script via `-EncodedCommand`
// (base64 UTF-16LE) rather than an inline literal, so decode it before pulling
// out the `-LiteralPath` target the mock should delete.
function decodePowerShellCommand(args: readonly string[]): string {
  const encodedIdx = args.findIndex((a) => a === '-EncodedCommand')
  if (encodedIdx !== -1 && args[encodedIdx + 1]) {
    try {
      return Buffer.from(String(args[encodedIdx + 1]), 'base64').toString('utf16le')
    } catch {
      return ''
    }
  }
  return String(args[args.length - 1] || '')
}

function removePrefixFromScript(script: string): void {
  const match = script.match(/-LiteralPath\s+('[^']+'|"[^"]+")/)
  if (!match) return
  const target = match[1].slice(1, -1)
  fs.rmSync(target, { recursive: true, force: true })
}

/**
 * Build a fake execFileSync/spawnSync router that enumerates node pids and
 * command lines, answers staged-CLI `--version` probes, and performs prefix
 * removal for cleanup assertions.
 */
function buildRouter(processes: Record<number, string>, survivors: Set<number> = new Set()) {
  const router = (file: string, args: readonly string[]) => {
    if (file === process.execPath || path.basename(file) === 'node' || path.basename(file) === 'node.exe') {
      const script = args[0]
      if (script && args[1] === '--version') {
        const version = versionForCliScript(script)
        if (version) return `${version}\n`
      }
      return ''
    }
    if (file === 'powershell.exe') {
      const cmd = String(args[args.length - 1] || '')
      if (cmd.includes('Get-Process node')) {
        return JSON.stringify(Object.keys(processes).map(Number))
      }
      if (cmd.includes('Win32_Process')) {
        const pid = Number(cmd.match(/ProcessId=(\d+)/)?.[1])
        return processes[pid] ?? ''
      }
      const decoded = decodePowerShellCommand(args)
      if (decoded.includes('Remove-Item')) {
        removePrefixFromScript(decoded)
        return ''
      }
      return ''
    }
    if (file === 'taskkill') {
      const pid = Number(args[args.indexOf('/PID') + 1])
      if (survivors.has(pid)) {
        throw new Error('Access denied')
      }
      return ''
    }
    return ''
  }

  // SpawnSync is used by prefix removal; route it through the same PowerShell
  // handler so tests can observe actual directory deletions. The removal script
  // arrives base64-encoded via `-EncodedCommand`, so decode before matching.
  cp.spawnSync.mockImplementation((file: string, args: readonly string[]) => {
    if (file === 'powershell.exe') {
      const cmd = decodePowerShellCommand(args)
      if (cmd.includes('Remove-Item')) {
        removePrefixFromScript(cmd)
        return { status: 0, error: null }
      }
    }
    return { status: 0, error: null }
  })

  return router
}

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  cp.execFileSync.mockReset()
  cp.spawn.mockClear()
  cp.spawnSync.mockClear()
  killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
    if (signal === 0) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    return true
  })
})

afterEach(() => {
  killSpy.mockRestore()
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Windows atomic upgrade lifecycle', () => {
  it('stops a stale session-host under the active prefix before activating the new prefix', async () => {
    const { layout } = fixture()
    const sessionHostPid = 14720
    const activeNorm = normalizePsPath(layout.activePrefix)
    const processes: Record<number, string> = {
      [sessionHostPid]: `node "${activeNorm}\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js"`,
    }
    cp.execFileSync.mockImplementation(buildRouter(processes))

    const result = await performWindowsAtomicUpgrade({
      layout,
      packageName: 'adhdev',
      targetVersion: '1.0.18-rc.2',
      portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.2') }),
    })

    expect(fs.existsSync(result.stagedPrefix)).toBe(true)
    expect(fs.existsSync(layout.activePrefix)).toBe(true)
    const taskkillCalls = cp.execFileSync.mock.calls.filter((c: any[]) => c[0] === 'taskkill')
    expect(taskkillCalls.some((c: any[]) => c[1].includes(String(sessionHostPid)))).toBe(true)
  })

  it('stops obsolete setup/helper node processes referencing an old versioned prefix', async () => {
    const { layout } = fixture()
    const setupPid = 15001
    const helperPid = 15002
    const activeNorm = normalizePsPath(layout.activePrefix)
    const processes: Record<number, string> = {
      [setupPid]: `node "${activeNorm}\\node_modules\\adhdev\\dist\\cli\\index.js" setup`,
      [helperPid]: `node "${activeNorm}\\node_modules\\adhdev\\dist\\cli\\index.js" daemon`,
    }
    cp.execFileSync.mockImplementation(buildRouter(processes))

    await performWindowsAtomicUpgrade({
      layout,
      packageName: 'adhdev',
      targetVersion: '1.0.18-rc.2',
      portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.2') }),
    })

    const killedPids = cp.execFileSync.mock.calls
      .filter((c: any[]) => c[0] === 'taskkill')
      .map((c: any[]) => Number(c[1][c[1].indexOf('/PID') + 1]))
    expect(killedPids).toContain(setupPid)
    expect(killedPids).toContain(helperPid)
  })

  it('refuses activation when an owned process cannot be stopped', async () => {
    const { layout } = fixture()
    const survivorPid = 99999
    const activeNorm = normalizePsPath(layout.activePrefix)
    const processes: Record<number, string> = {
      [survivorPid]: `node "${activeNorm}\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js"`,
    }
    cp.execFileSync.mockImplementation(buildRouter(processes, new Set([survivorPid])))

    await expect(performWindowsAtomicUpgrade({
      layout,
      packageName: 'adhdev',
      targetVersion: '1.0.18-rc.2',
      portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.2') }),
    })).rejects.toThrow('owned process')

    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
  })

  it('leaves unrelated node processes untouched', async () => {
    const { layout } = fixture()
    const unrelatedPid = 77777
    const activeNorm = normalizePsPath(layout.activePrefix)
    const processes: Record<number, string> = {
      [unrelatedPid]: `node "${activeNorm}\\node_modules\\some-user-script\\app.js"`,
    }
    cp.execFileSync.mockImplementation(buildRouter(processes))

    await performWindowsAtomicUpgrade({
      layout,
      packageName: 'adhdev',
      targetVersion: '1.0.18-rc.2',
      portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.2') }),
    })

    const killedPids = cp.execFileSync.mock.calls
      .filter((c: any[]) => c[0] === 'taskkill')
      .map((c: any[]) => Number(c[1][c[1].indexOf('/PID') + 1]))
    expect(killedPids).not.toContain(unrelatedPid)
  })

  it('does not delete an inactive prefix while an owned process still uses it', async () => {
    const { layout } = fixture()
    installPackage(layout.activePrefix, '1.0.17')
    const stalePrefix = path.join(layout.installRoot, 'version-stale')
    fs.mkdirSync(stalePrefix, { recursive: true })
    installPackage(stalePrefix, '1.0.16')
    const survivorPid = 88888
    const staleNorm = normalizePsPath(stalePrefix)
    const activeNorm = normalizePsPath(layout.activePrefix)
    const processes: Record<number, string> = {
      [survivorPid]: `node "${staleNorm}\\node_modules\\adhdev\\vendor\\session-host-daemon\\index.js"`,
    }
    cp.execFileSync.mockImplementation(buildRouter(processes, new Set([survivorPid])))
    killSpy.mockRestore()
    const persistentKill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === survivorPid) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      return true
    })

    try {
      await performWindowsAtomicUpgrade({
        layout,
        packageName: 'adhdev',
        targetVersion: '1.0.18-rc.2',
        portableNode: process.execPath,
        hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.2') }),
      })

      expect(fs.existsSync(stalePrefix)).toBe(true)
      expect(fs.existsSync(layout.activePrefix)).toBe(true)
    } finally {
      persistentKill.mockRestore()
    }
  })

  it('staged rc.2 prefix contains a valid node-pty prebuild and session-host entry', async () => {
    const { layout } = fixture()
    cp.execFileSync.mockImplementation(buildRouter({}))
    const result = await performWindowsAtomicUpgrade({
      layout,
      packageName: 'adhdev',
      targetVersion: '1.0.18-rc.2',
      portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.2') }),
    })

    const packageRoot = path.join(result.stagedPrefix, 'node_modules', 'adhdev')
    expect(fs.existsSync(path.join(packageRoot, 'vendor', 'session-host-daemon', 'index.js'))).toBe(true)
    expect(fs.existsSync(path.join(packageRoot, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'))).toBe(true)
  })

  it('does not accumulate obsolete prefixes across repeated updates', async () => {
    const { layout } = fixture()
    installPackage(layout.activePrefix, '1.0.17')
    cp.execFileSync.mockImplementation(buildRouter({}))

    const guardedCleanup = (l: WindowsInstallerLayout, activePrefix: string) =>
      cleanupInactivePrefixesWithGuard({
        layout: l,
        activePrefix,
        excludePids: [process.pid],
        markers: Array.from(ADHDEV_OWNED_MARKERS),
        waitMs: 15_000,
      })

    // First update: version-old -> version-1
    const first = await performWindowsAtomicUpgrade({
      layout,
      packageName: 'adhdev',
      targetVersion: '1.0.18-rc.2',
      portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => installPackage(prefix, '1.0.18-rc.2'),
        cleanup: guardedCleanup,
      }),
    })

    // Second update: version-1 -> version-2
    const nextLayout = resolveWindowsInstallerLayout({
      homeDir: layout.homeDir,
      installPrefix: first.stagedPrefix,
      platform: 'win32',
    })!
    const second = await performWindowsAtomicUpgrade({
      layout: nextLayout,
      packageName: 'adhdev',
      targetVersion: '1.0.18',
      portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => installPackage(prefix, '1.0.18'),
        cleanup: guardedCleanup,
      }),
    })

    expect(second.stagedPrefix).not.toBe(first.stagedPrefix)
    expect(fs.existsSync(second.stagedPrefix)).toBe(true)
    expect(fs.existsSync(first.stagedPrefix)).toBe(false)
    expect(fs.existsSync(layout.activePrefix)).toBe(false)
  })
})
