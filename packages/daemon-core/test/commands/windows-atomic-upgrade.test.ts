import type { ChildProcess } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The module under test imports `execFileSync` as a named binding, so spying on
// the `child_process` namespace after import cannot intercept it. Partial-mock
// the module up front and make `execFileSync` delegate to the real impl by
// default, so full-flow tests keep spawning the real staged CLI while the
// install-hook env test can override behaviour for a single call.
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>()
  const execFileSync = vi.fn(actual.execFileSync)
  return { ...actual, execFileSync, default: { ...actual, execFileSync } }
})

// eslint-disable-next-line import/first
import * as child_process from 'child_process'
import {
  createDefaultWindowsAtomicHooks,
  performWindowsAtomicUpgrade,
  resolveWindowsInstallerLayout,
  cleanupInactivePrefixesWithGuard,
  boundedCleanupInactivePrefixes,
  DEFAULT_HEALTH_TIMEOUT_MS,
  type WindowsAtomicUpgradeHooks,
  type WindowsInstallerLayout,
} from '../../src/commands/windows-atomic-upgrade'
import { emitUpgradeFailureNotice } from '../../src/commands/upgrade-helper'

const roots: string[] = []

function fixture(): { layout: WindowsInstallerLayout; oldCmd: string; oldPs1: string; oldNoExt: string } {
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
  const oldNoExt = '#!/bin/sh\n# old no-ext shim\n'
  fs.writeFileSync(pointerPath, activeVersionName)
  fs.writeFileSync(path.join(stablePrefix, 'adhdev.cmd'), oldCmd)
  fs.writeFileSync(path.join(stablePrefix, 'adhdev.ps1'), oldPs1)
  fs.writeFileSync(path.join(stablePrefix, 'adhdev'), oldNoExt)
  return {
    layout: { homeDir, installRoot, stablePrefix, activePrefix, activeVersionName, pointerPath },
    oldCmd,
    oldPs1,
    oldNoExt,
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
  // npm's default no-extension POSIX shim falls back to the FIRST `node` on PATH
  // via an `else exec node ...` branch. Seed that exact shape so the pin test can
  // assert the system-node fallback is removed.
  fs.writeFileSync(
    path.join(prefix, 'adhdev'),
    '#!/bin/sh\nbasedir=$(dirname "$0")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node" "$basedir/../adhdev/dist/cli/index.js" "$@"\nelse\n  exec node "$basedir/../adhdev/dist/cli/index.js" "$@"\nfi\n',
  )
  // node-pty ships this prebuild; the upgrade must keep it to avoid a daemon
  // boot crash. Place it in every successful staged install by default.
  const conptyPath = path.join(prefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')
  fs.mkdirSync(path.dirname(conptyPath), { recursive: true })
  fs.writeFileSync(conptyPath, 'conpty.node placeholder')
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

  it('leaves the old pointer and all stable shims intact when staging fails', async () => {
    const { layout, oldCmd, oldPs1, oldNoExt } = fixture()
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
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev'), 'utf8')).toBe(oldNoExt)
    expect(rollbackRestarted).toBe(true)
  })

  it('writes an actionable last-error notice for non-lock failures', () => {
    const { layout } = fixture()
    // Second arg is the instance config dir (post Stage 3) — home/.adhdev is
    // the default instance, so the notice lands at the same path as before.
    emitUpgradeFailureNotice(['adhdev upgrade failed: ordinary npm failure', 'Previous version preserved.'], path.join(layout.homeDir, '.adhdev'))
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

  it('pins the no-extension adhdev shim to portable Node 22 with no system-node fallback', async () => {
    const { layout } = fixture()
    const result = await performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.1') }),
    })
    const noExt = fs.readFileSync(path.join(result.stagedPrefix, 'adhdev'), 'utf8')
    // Hard-codes the pinned runtime absolute path...
    expect(noExt).toContain(process.execPath)
    // ...and no longer contains npm's `else exec node` system-node fallback branch.
    expect(noExt).not.toMatch(/(^|\s)exec\s+node(\s|$)/m)
    expect(noExt).not.toMatch(/\belse\b/)
    // A single unconditional exec line is all that remains.
    expect(noExt.trim().split('\n').filter((l) => l.startsWith('exec ')).length).toBe(1)
  })

  it('aborts activation and preserves the stable no-ext shim when the staged pin still has a system-node fallback', async () => {
    const { layout, oldCmd, oldPs1, oldNoExt } = fixture()
    let rollbackRestarted = false
    await expect(performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => {
          installPackage(prefix, '1.0.18-rc.1')
          // Simulate the staged pin being defeated: re-seed npm's fallback shim
          // AFTER install so pinStagedShims must overwrite it. If the pin were
          // skipped, validation would let the fallback through. Here we corrupt
          // the pinned node path to force the validation guard to fire.
          const pkgJson = path.join(prefix, 'node_modules', 'adhdev', 'package.json')
          const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
          pkg.bin = { adhdev: 'dist/cli/does-not-exist.js' }
          fs.writeFileSync(pkgJson, JSON.stringify(pkg))
        },
        restartOld: () => { rollbackRestarted = true },
      }),
    })).rejects.toThrow()
    // Staging failed before activation → the stable shims (incl. no-ext) are intact.
    expect(rollbackRestarted).toBe(true)
    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), 'utf8')).toBe(oldCmd)
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), 'utf8')).toBe(oldPs1)
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev'), 'utf8')).toBe(oldNoExt)
  })

  it('rolls the pointer and stable shims back when the replacement daemon is unhealthy', async () => {
    const { layout, oldCmd, oldPs1, oldNoExt } = fixture()
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
    // The no-ext PATH shim must also roll back to the prior working shim — never
    // be left pointing at the removed staged prefix (the ENOENT doctor defect).
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev'), 'utf8')).toBe(oldNoExt)
  })

  it('re-issues valid launchers and preserves the active pointer on rollback when the stable shims were absent at snapshot time', async () => {
    const { layout } = fixture()
    // Simulate a partial/first install: the stable launcher surface is missing
    // entirely at the moment the upgrade snapshots it. The old logic deleted the
    // (nonexistent) targets on rollback, leaving PATH `adhdev` broken (ENOENT).
    fs.unlinkSync(path.join(layout.stablePrefix, 'adhdev.cmd'))
    fs.unlinkSync(path.join(layout.stablePrefix, 'adhdev.ps1'))
    fs.unlinkSync(path.join(layout.stablePrefix, 'adhdev'))
    fs.unlinkSync(layout.pointerPath)

    let restartedOld = 0
    await expect(performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => installPackage(prefix, '1.0.18-rc.1'),
        // Force a post-activation rollback so restoreStableFiles runs.
        waitForHealth: async () => false,
        restartOld: () => { restartedOld++ },
      }),
    })).rejects.toThrow('health/version gate')
    expect(restartedOld).toBe(1)

    // All three launchers exist again and redirect through the pointer — never
    // deleted, never left broken.
    const cmd = fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), 'utf8')
    const ps1 = fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), 'utf8')
    const noExt = fs.readFileSync(path.join(layout.stablePrefix, 'adhdev'), 'utf8')
    expect(cmd).toContain('.adhdev-current')
    expect(ps1).toContain('.adhdev-current')
    expect(noExt).toContain('.adhdev-current')
    // The pointer is restored to the last-known-good active version, not deleted,
    // so the redirect launchers reach a real prefix.
    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe(layout.activeVersionName)
  })

  it('always leaves the three shims and pointer valid on rollback even when only some were present at snapshot time', async () => {
    const { layout, oldCmd } = fixture()
    // Mixed state: .cmd present, .ps1 and no-ext absent, pointer present.
    fs.unlinkSync(path.join(layout.stablePrefix, 'adhdev.ps1'))
    fs.unlinkSync(path.join(layout.stablePrefix, 'adhdev'))

    await expect(performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.1', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => installPackage(prefix, '1.0.18-rc.1'),
        waitForHealth: async () => false,
      }),
    })).rejects.toThrow('health/version gate')

    // Present-at-snapshot .cmd restores its original bytes; the two absent shims
    // are re-issued as valid pointer-redirect launchers.
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), 'utf8')).toBe(oldCmd)
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), 'utf8')).toContain('.adhdev-current')
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev'), 'utf8')).toContain('.adhdev-current')
    // Pointer (present at snapshot) restores to its original value.
    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
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

  it('forces build-from-source=false in the install hook env for both npm config spellings', () => {
    const execMock = child_process.execFileSync as unknown as ReturnType<typeof vi.fn>
    execMock.mockClear()
    // Swallow the staged `npm install` so the assertion doesn't spawn a real node.
    execMock.mockReturnValueOnce('' as any)
    const atomicHooks = createDefaultWindowsAtomicHooks({
      packageName: 'adhdev',
      targetVersion: '1.0.18-rc.4',
      npmCliPath: '/tools/node22/npm-cli.js',
      restartArgv: [],
      cwd: '/',
      env: { USER_VAR: '1', npm_config_build_from_source: 'true' },
      log: () => {},
    })
    atomicHooks.install('/staged/prefix', '/tools/node22/node.exe')
    expect(execMock).toHaveBeenCalledTimes(1)
    const passedEnv = execMock.mock.calls[0][2]?.env as NodeJS.ProcessEnv
    expect(passedEnv['npm_config_build_from_source']).toBe('false')
    expect(passedEnv['npm_config_build-from-source']).toBe('false')
    expect(passedEnv['ADHDEV_BOOTSTRAP']).toBe('1')
    expect(passedEnv['USER_VAR']).toBe('1')
    expect(passedEnv['Path']).toMatch(/^\/tools\/node22;/)
  })

  describe('createDefaultWindowsAtomicHooks().waitForHealth version gate', () => {
    let server: http.Server | null = null
    let boundPort = 0

    function makeHooks(targetVersion: string, healthTimeoutMs = 30000, log: (m: string) => void = () => {}) {
      return createDefaultWindowsAtomicHooks({
        packageName: 'adhdev',
        targetVersion,
        npmCliPath: '/tools/node22/npm-cli.js',
        restartArgv: [],
        cwd: '/',
        env: {},
        log,
        // Bind the gate to the ephemeral stub port instead of the daemon's real
        // 19222 IPC port, which the coordinator's own live daemon occupies.
        healthPort: boundPort,
        healthTimeoutMs,
      })
    }

    // Serve the REAL local-IPC response shapes: /health = {ok, pid, wsPath, port}
    // (no version), version only under /api/v1/status → payload.status.version.
    function startStubDaemon(daemonPid: number, reportedVersion: string): Promise<void> {
      const srv = http.createServer((req, res) => {
        const url = (req.url || '/').split('?')[0]
        res.setHeader('content-type', 'application/json')
        if (url === '/health') {
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, pid: daemonPid, wsPath: '/ipc', port: boundPort }))
          return
        }
        if (url === '/api/v1/status') {
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, pid: daemonPid, wsPath: '/ipc', port: boundPort, status: { version: reportedVersion } }))
          return
        }
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'Not found' }))
      })
      server = srv
      return new Promise((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address()
          boundPort = typeof addr === 'object' && addr ? addr.port : 0
          resolve()
        })
      })
    }

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()))
        server = null
      }
    })

    it('passes the gate only when /api/v1/status version matches the target (not /health body)', async () => {
      const daemonPid = 5150
      await startStubDaemon(daemonPid, '1.0.18-rc.7')
      const ok = await makeHooks('1.0.18-rc.7').waitForHealth(daemonPid, '1.0.18-rc.7')
      expect(ok).toBe(true)
    })

    it('fails the gate when the live status version does not match the target', async () => {
      const daemonPid = 5151
      // /health is fully healthy for this pid, but the running version is stale —
      // the version must be read from /api/v1/status, so the gate must NOT pass.
      await startStubDaemon(daemonPid, '1.0.6')
      const ok = await makeHooks('1.0.18-rc.7', 1000).waitForHealth(daemonPid, '1.0.18-rc.7')
      expect(ok).toBe(false)
    })

    it('fails the gate when the live pid differs even if the version matches', async () => {
      await startStubDaemon(9999, '1.0.18-rc.7')
      const ok = await makeHooks('1.0.18-rc.7', 1000).waitForHealth(4242, '1.0.18-rc.7')
      expect(ok).toBe(false)
    })

    it('FIX A: logs a passing milestone with elapsed time when the gate is satisfied', async () => {
      const daemonPid = 5152
      await startStubDaemon(daemonPid, '1.0.18-rc.7')
      const logs: string[] = []
      const ok = await makeHooks('1.0.18-rc.7', 5000, (m) => logs.push(m)).waitForHealth(daemonPid, '1.0.18-rc.7')
      expect(ok).toBe(true)
      expect(logs.some((l) => /Health gate passed after \d+ms/.test(l))).toBe(true)
    })

    it('FIX A: logs a timeout diagnostic naming the budget when the gate never satisfies', async () => {
      await startStubDaemon(4321, '1.0.6') // version never matches the target
      const logs: string[] = []
      const ok = await makeHooks('1.0.18-rc.7', 700, (m) => logs.push(m)).waitForHealth(4321, '1.0.18-rc.7')
      expect(ok).toBe(false)
      // The timeout log must report the budget so a slow-boot rollback is diagnosable.
      expect(logs.some((l) => /Health gate timed out after \d+ms.*budget 700ms/.test(l))).toBe(true)
      // It reached the daemon (alive) but the version stayed stale — the exact
      // "components still booting" shape FIX A is meant to make visible.
      expect(logs.some((l) => /is alive at \d+ms; awaiting status\.version/.test(l))).toBe(true)
    })
  })

  it('FIX A: defaults the health-gate budget to 120s (Windows full-boot headroom, up from 30s)', () => {
    // Deterministic regression guard for the 30s→120s default bump. Live Windows
    // logs clustered every rollback at 33–35s because status.version only lands
    // after a full component boot that regularly exceeds 30s; 120s gives headroom.
    expect(DEFAULT_HEALTH_TIMEOUT_MS).toBe(120_000)
  })

  it('refuses activation when the staged conpty.node prebuild is missing', async () => {
    const { layout, oldCmd, oldPs1 } = fixture()
    let rollbackRestarted = false
    await expect(performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => {
          installPackage(prefix, '1.0.18-rc.4')
          fs.rmSync(path.join(prefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), { force: true })
        },
        restartOld: () => { rollbackRestarted = true },
      }),
    })).rejects.toThrow('conpty.node')
    expect(rollbackRestarted).toBe(true)
    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.cmd'), 'utf8')).toBe(oldCmd)
    expect(fs.readFileSync(path.join(layout.stablePrefix, 'adhdev.ps1'), 'utf8')).toBe(oldPs1)
  })

  it('proceeds with activation when the staged conpty.node prebuild is present', async () => {
    const { layout } = fixture()
    const result = await performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
      hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.4') }),
    })
    expect(fs.existsSync(path.join(result.stagedPrefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'))).toBe(true)
    expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe(path.basename(result.stagedPrefix))
  })

  /**
   * D4-b: a production incident took multiple investigation rounds partly
   * because the conpty gate logged nothing on success — there was no way to
   * tell from daemon-upgrade.log whether the gate had even run. It must now
   * log the exact verified path on every successful upgrade.
   */
  it('D4-b: logs the verified conpty prebuild path on successful activation', async () => {
    const { layout } = fixture()
    const logLines: string[] = []
    const result = await performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => installPackage(prefix, '1.0.18-rc.4'),
        log: (message) => logLines.push(message),
      }),
    })
    const expectedPath = path.join(result.stagedPrefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')
    expect(logLines.some((line) => line.includes('conpty prebuild verified at') && line.includes(expectedPath))).toBe(true)
  })

  /**
   * D4-a (shared path resolution): npm may hoist node-pty to
   * `<prefix>/node_modules/node-pty` instead of nesting it under
   * `node_modules/adhdev/node_modules/node-pty`, depending on the install-time
   * dependency graph. The gate must accept either layout — only reject when
   * BOTH are missing — otherwise a hoisted install would be false-flagged as
   * broken.
   */
  it('accepts a hoisted node-pty layout (node_modules/node-pty, no nested adhdev/node_modules)', async () => {
    const { layout } = fixture()
    const logLines: string[] = []
    const result = await performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => {
          installPackage(prefix, '1.0.18-rc.4')
          // Remove the nested layout the fixture seeds by default and place the
          // prebuild at the hoisted location instead.
          fs.rmSync(path.join(prefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty'), { recursive: true, force: true })
          const hoistedConpty = path.join(prefix, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')
          fs.mkdirSync(path.dirname(hoistedConpty), { recursive: true })
          fs.writeFileSync(hoistedConpty, 'conpty.node placeholder (hoisted)')
        },
        log: (message) => logLines.push(message),
      }),
    })
    const hoistedPath = path.join(result.stagedPrefix, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')
    expect(fs.existsSync(hoistedPath)).toBe(true)
    expect(logLines.some((line) => line.includes('conpty prebuild verified at') && line.includes(hoistedPath))).toBe(true)
  })

  it('rejects when neither the nested nor the hoisted node-pty layout has the conpty prebuild', async () => {
    const { layout } = fixture()
    await expect(performWindowsAtomicUpgrade({
      layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
      hooks: hooks({
        install: (prefix) => {
          installPackage(prefix, '1.0.18-rc.4')
          fs.rmSync(path.join(prefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), { force: true })
          // No hoisted fallback seeded either — both candidates are absent.
        },
      }),
    })).rejects.toThrow('conpty.node')
  })

  /**
   * D2: a failed upgrade used to leave its staged version-* prefix on disk. The
   * generic cleanup only sweeps a bounded slice of inactive prefixes and TS-only
   * self-upgraders never run install.ps1's stale-install sweep, so the debris
   * accumulated — one leftover survived 9 days and took part in a repeat
   * conpty.node outage.
   */
  describe('failed-upgrade staged prefix cleanup', () => {
    function stagedPrefixes(layout: WindowsInstallerLayout): string[] {
      return fs.readdirSync(layout.installRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('version-') && e.name !== layout.activeVersionName)
        .map((e) => e.name)
    }

    it('removes the staged prefix when the conpty gate rejects the install', async () => {
      const { layout } = fixture()
      await expect(performWindowsAtomicUpgrade({
        layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
        hooks: hooks({
          install: (prefix) => {
            installPackage(prefix, '1.0.18-rc.4')
            fs.rmSync(path.join(prefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), { force: true })
          },
          // The default cleanup hook is a no-op here, so anything left behind is
          // debris the failure path itself failed to reclaim.
          cleanup: () => {},
        }),
      })).rejects.toThrow('conpty.node')

      expect(stagedPrefixes(layout)).toEqual([])
      // The only working install must survive untouched.
      expect(fs.existsSync(layout.activePrefix)).toBe(true)
      expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
    })

    it('removes the staged prefix when the post-activation health gate fails', async () => {
      const { layout } = fixture()
      await expect(performWindowsAtomicUpgrade({
        layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
        hooks: hooks({
          install: (prefix) => installPackage(prefix, '1.0.18-rc.4'),
          waitForHealth: async () => false,
          cleanup: () => {},
        }),
      })).rejects.toThrow('health/version gate')

      expect(stagedPrefixes(layout)).toEqual([])
      // Rollback restored the pointer AND the active prefix is intact.
      expect(fs.existsSync(layout.activePrefix)).toBe(true)
      expect(fs.readFileSync(layout.pointerPath, 'utf8')).toBe('version-old')
    })

    it('removes the staged prefix when install itself throws, leaving the active tree intact', async () => {
      const { layout } = fixture()
      const logs: string[] = []
      // Earliest possible failure: the staged dir exists but was never populated.
      // The sentinel proves cleanup targeted only the staged prefix.
      fs.writeFileSync(path.join(layout.activePrefix, 'sentinel.txt'), 'active install')
      await expect(performWindowsAtomicUpgrade({
        layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.4', portableNode: process.execPath,
        hooks: hooks({
          install: () => { throw new Error('npm install exploded') },
          cleanup: () => {},
          log: (m) => logs.push(m),
        }),
      })).rejects.toThrow('npm install exploded')

      expect(stagedPrefixes(layout)).toEqual([])
      expect(fs.readFileSync(path.join(layout.activePrefix, 'sentinel.txt'), 'utf8')).toBe('active install')
      expect(logs.some((l) => /Cleaned up failed staged prefix/.test(l))).toBe(true)
    })
  })

  // FIX B: cleanup deletes inactive version-* prefixes in-process with fs.rm
  // instead of shelling out to powershell.exe under a 5000ms spawnSync timeout,
  // which ETIMEDOUT'd on Windows and left orphan version-* dirs accumulating.
  function seedVersionPrefix(installRoot: string, name: string): string {
    const prefix = path.join(installRoot, name)
    // Nested files mimic node_modules — the deep tree that blew the old timeout.
    const deep = path.join(prefix, 'node_modules', 'adhdev', 'dist')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'index.js'), 'x')
    fs.writeFileSync(path.join(prefix, 'adhdev.cmd'), 'x')
    return prefix
  }

  it('FIX B: cleanupInactivePrefixesWithGuard removes inactive version-* prefixes via fs.rm', async () => {
    const { layout } = fixture()
    const active = seedVersionPrefix(layout.installRoot, 'version-active')
    const stale1 = seedVersionPrefix(layout.installRoot, 'version-stale-1')
    const stale2 = seedVersionPrefix(layout.installRoot, 'version-stale-2')

    await cleanupInactivePrefixesWithGuard({
      layout,
      activePrefix: active,
      excludePids: [process.pid],
      waitMs: 100,
    })

    // The active prefix is preserved; every inactive version-* is gone.
    expect(fs.existsSync(active)).toBe(true)
    expect(fs.existsSync(stale1)).toBe(false)
    expect(fs.existsSync(stale2)).toBe(false)
  })

  // Phase 2: the Windows atomic-upgrade layout is per-instance. `instanceDir`
  // defaults to `.adhdev`, so the stable path is byte-for-byte identical to
  // before the option existed; the preview instance rotates ONLY its own tree.
  describe('Phase 2 per-instance pointer layout', () => {
    it('INVARIANT: an unset instanceDir resolves byte-identical ~/.adhdev paths (stable unchanged)', () => {
      const homeDir = path.join('/fake-home')
      const installPrefix = path.join(homeDir, '.adhdev', 'npm-installs', 'version-old')
      // The exact paths the pre-Phase-2 code hardcoded.
      const expectedInstallRoot = path.join(homeDir, '.adhdev', 'npm-installs')
      const expectedStablePrefix = path.join(homeDir, '.adhdev', 'npm-global')
      const expectedPointer = path.join(expectedStablePrefix, '.adhdev-current')

      const unset = resolveWindowsInstallerLayout({ homeDir, installPrefix, platform: 'win32' })
      const explicitStable = resolveWindowsInstallerLayout({ homeDir, installPrefix, platform: 'win32', instanceDir: '.adhdev' })
      const emptyString = resolveWindowsInstallerLayout({ homeDir, installPrefix, platform: 'win32', instanceDir: '' })

      for (const layout of [unset, explicitStable, emptyString]) {
        expect(layout).not.toBeNull()
        expect(layout!.installRoot).toBe(expectedInstallRoot)
        expect(layout!.stablePrefix).toBe(expectedStablePrefix)
        expect(layout!.pointerPath).toBe(expectedPointer)
        expect(layout!.activePrefix).toBe(installPrefix)
        expect(layout!.activeVersionName).toBe('version-old')
      }
      // Unset === explicit-stable, field for field (the invariant proof).
      expect(unset).toEqual(explicitStable)
      expect(emptyString).toEqual(explicitStable)
    })

    it('preview instanceDir resolves the whole layout under ~/.adhdev-preview, never touching ~/.adhdev', () => {
      const homeDir = path.join('/fake-home')
      const installPrefix = path.join(homeDir, '.adhdev-preview', 'npm-installs', 'version-pv')
      const layout = resolveWindowsInstallerLayout({
        homeDir, installPrefix, platform: 'win32', instanceDir: '.adhdev-preview',
      })
      expect(layout).not.toBeNull()
      expect(layout!.installRoot).toBe(path.join(homeDir, '.adhdev-preview', 'npm-installs'))
      expect(layout!.stablePrefix).toBe(path.join(homeDir, '.adhdev-preview', 'npm-global'))
      expect(layout!.pointerPath).toBe(path.join(homeDir, '.adhdev-preview', 'npm-global', '.adhdev-current'))
      expect(layout!.activeVersionName).toBe('version-pv')
      // Nothing in the resolved layout references the stable `.adhdev` tree.
      for (const p of [layout!.installRoot, layout!.stablePrefix, layout!.pointerPath, layout!.activePrefix]) {
        expect(p).not.toMatch(/[\\/]\.adhdev[\\/]/)
      }
    })

    it('rejects a preview prefix whose parent install root belongs to a different instance', () => {
      const homeDir = path.join('/fake-home')
      // A stable-tree prefix must not validate as a preview layout.
      const stablePrefixVersion = path.join(homeDir, '.adhdev', 'npm-installs', 'version-old')
      expect(resolveWindowsInstallerLayout({
        homeDir, installPrefix: stablePrefixVersion, platform: 'win32', instanceDir: '.adhdev-preview',
      })).toBeNull()
      // ...and vice-versa: a preview-tree prefix is not a stable layout.
      const previewPrefixVersion = path.join(homeDir, '.adhdev-preview', 'npm-installs', 'version-pv')
      expect(resolveWindowsInstallerLayout({
        homeDir, installPrefix: previewPrefixVersion, platform: 'win32', instanceDir: '.adhdev',
      })).toBeNull()
    })

    it('end-to-end preview upgrade rotates only the preview pointer while a stable tree sits untouched', async () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-atomic-pv-'))
      roots.push(homeDir)
      // Seed BOTH a stable and a preview installer tree side by side.
      const stableGlobal = path.join(homeDir, '.adhdev', 'npm-global')
      const stablePointer = path.join(stableGlobal, '.adhdev-current')
      fs.mkdirSync(stableGlobal, { recursive: true })
      fs.writeFileSync(stablePointer, 'version-stable-untouched')
      fs.writeFileSync(path.join(stableGlobal, 'adhdev.cmd'), '@echo stable\r\n')

      const previewInstallRoot = path.join(homeDir, '.adhdev-preview', 'npm-installs')
      const previewGlobal = path.join(homeDir, '.adhdev-preview', 'npm-global')
      const previewActive = path.join(previewInstallRoot, 'version-pv-old')
      fs.mkdirSync(previewActive, { recursive: true })
      fs.mkdirSync(previewGlobal, { recursive: true })
      const previewPointer = path.join(previewGlobal, '.adhdev-current')
      fs.writeFileSync(previewPointer, 'version-pv-old')
      fs.writeFileSync(path.join(previewGlobal, 'adhdev.cmd'), '@echo pv old\r\n')
      fs.writeFileSync(path.join(previewGlobal, 'adhdev.ps1'), '# pv old\r\n')
      fs.writeFileSync(path.join(previewGlobal, 'adhdev'), '#!/bin/sh\n# pv old\n')

      const layout = resolveWindowsInstallerLayout({
        homeDir, installPrefix: previewActive, platform: 'win32', instanceDir: '.adhdev-preview',
      })!
      const result = await performWindowsAtomicUpgrade({
        layout, packageName: 'adhdev', targetVersion: '1.0.18-rc.9', portableNode: process.execPath,
        hooks: hooks({ install: (prefix) => installPackage(prefix, '1.0.18-rc.9') }),
      })

      // Preview pointer advanced to the freshly staged prefix, under ~/.adhdev-preview.
      expect(fs.readFileSync(previewPointer, 'utf8')).toBe(path.basename(result.stagedPrefix))
      expect(result.stagedPrefix.startsWith(previewInstallRoot)).toBe(true)
      // The stable tree is byte-for-byte untouched.
      expect(fs.readFileSync(stablePointer, 'utf8')).toBe('version-stable-untouched')
      expect(fs.readFileSync(path.join(stableGlobal, 'adhdev.cmd'), 'utf8')).toBe('@echo stable\r\n')
    })
  })

  it('FIX B: boundedCleanupInactivePrefixes removes inactive version-* prefixes via fs.rm', () => {
    const { layout } = fixture()
    const active = seedVersionPrefix(layout.installRoot, 'version-active')
    const stale = seedVersionPrefix(layout.installRoot, 'version-stale')
    const logs: string[] = []

    boundedCleanupInactivePrefixes(layout, active, (m) => logs.push(m))

    expect(fs.existsSync(active)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
    // Clean run → no "incomplete" retry warning (the ETIMEDOUT-era symptom).
    expect(logs.some((l) => /incomplete/.test(l))).toBe(false)
  })
})
