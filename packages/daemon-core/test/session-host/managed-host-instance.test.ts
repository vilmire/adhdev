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
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context'
import { resolveSessionHostIpcKey } from '@adhdev/session-host-core'

// Stage 3 POSIX instance isolation: the managed session-host factory must
// derive its pid file, IPC endpoint, log dir, and spawned-child env from the
// resolved instance (ADHDEV_CONFIG_DIR) — never a hardcoded ~/.adhdev — and
// two simultaneous instances must land on DISJOINT namespaces so they cannot
// attach to, kill, or rebind each other's session host.

const tempRoots: string[] = []
let originalConfigDir: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  resetProcessInstanceContextForTests()
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

// resolveInstanceContext()'s default homeDir is os.homedir(), which reads
// USERPROFILE on win32 (not HOME) — relocating only HOME leaves the
// isDefaultInstanceConfigDir() comparison pointed at the REAL profile, so
// the "default instance" case below would get a non-empty ipcKey (wrongly
// treated as a non-default instance) instead of the legacy empty one.
function setFakeHome(dir: string): void {
  process.env.HOME = dir
  process.env.USERPROFILE = dir
}

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-managed-host-instance-'))
  tempRoots.push(dir)
  return dir
}

function makeHost(appName: string) {
  return createManagedSessionHost({
    appName,
    requiredRequestTypes: ['delete_session'],
    timeoutMs: 200,
  })
}

describe('managed session-host instance namespacing', () => {
  it('default instance keeps the legacy un-suffixed endpoint and ~/.adhdev pid file', () => {
    const homeDir = makeTempHome()
    setFakeHome(homeDir)
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    resetProcessInstanceContextForTests()

    const host = makeHost('adhdev')
    expect(host.getPidFile()).toBe(path.join(homeDir, '.adhdev', 'adhdev-session-host.pid'))
    // win32 IPC uses a named pipe, not a Unix domain socket file — see
    // getDefaultSessionHostEndpoint() in session-host-core/src/ipc.ts.
    expect(host.endpoint.path).toBe(
      process.platform === 'win32'
        ? '\\\\.\\pipe\\adhdev-session-host'
        : path.join(os.tmpdir(), 'adhdev-session-host.sock'),
    )
    expect(host.getStatusPaths().pidFile).toBe(host.getPidFile())
    expect(host.getStatusPaths().endpoint.path).toBe(host.endpoint.path)
  })

  it('preview instance namespaces pid file, endpoint, and pins the child env', () => {
    const homeDir = makeTempHome()
    setFakeHome(homeDir)
    const previewDir = path.join(homeDir, '.adhdev-preview')
    process.env.ADHDEV_CONFIG_DIR = previewDir
    resetProcessInstanceContextForTests()

    const host = makeHost('adhdev-preview')
    const expectedKey = resolveSessionHostIpcKey(previewDir, homeDir)
    expect(expectedKey).toMatch(/^[0-9a-f]{12}$/)

    // Pid file + state live under the instance dir, never the stable default.
    expect(host.getPidFile()).toBe(path.join(previewDir, 'adhdev-preview-session-host.pid'))
    expect(host.getPidFile().startsWith(path.join(homeDir, '.adhdev') + path.sep)).toBe(false)

    // Endpoint is namespaced by the config-dir-derived key. win32 IPC uses a
    // named pipe, not a Unix domain socket file — see
    // getDefaultSessionHostEndpoint() in session-host-core/src/ipc.ts.
    expect(host.endpoint.path).toBe(
      process.platform === 'win32'
        ? `\\\\.\\pipe\\adhdev-preview-session-host-${expectedKey}`
        : path.join(os.tmpdir(), `adhdev-preview-session-host-${expectedKey}.sock`),
    )

    // The spawned host child inherits the PINNED instance identity so it
    // derives the very same namespace and can never be retargeted by another
    // install editing a shared config file.
    const env = host.buildEnv({ PATH: '/usr/bin' })
    expect(env.ADHDEV_CONFIG_DIR).toBe(previewDir)
    expect(env.ADHDEV_SESSION_HOST_NAME).toBe('adhdev-preview')
  })

  it('two simultaneous instances cannot attach to the same session host', () => {
    const homeDir = makeTempHome()
    setFakeHome(homeDir)

    // The factory resolves its instance LAZILY (per call) so entrypoints that
    // pin ADHDEV_CONFIG_DIR during bootstrap still resolve correctly; capture
    // each instance's paths while its env is active, then compare.
    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    resetProcessInstanceContextForTests()
    const stable = makeHost('adhdev')
    const stableEndpoint = stable.endpoint.path
    const stablePidFile = stable.getPidFile()

    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev-preview')
    resetProcessInstanceContextForTests()
    const preview = makeHost('adhdev')
    const previewEndpoint = preview.endpoint.path
    const previewPidFile = preview.getPidFile()
    const previewPidDir = path.dirname(previewPidFile)
    fs.mkdirSync(previewPidDir, { recursive: true })
    fs.writeFileSync(previewPidFile, '12345', 'utf8')
    const previewPid = preview.getPid()

    // Same appName on both: only the instance key keeps them apart. This is
    // the regression the audit flagged — a same-name install must not attach
    // to another instance's socket.
    expect(stableEndpoint).not.toBe(previewEndpoint)
    expect(stablePidFile).not.toBe(previewPidFile)

    // Stale-pid validation is scoped to the instance's own pid file: the
    // preview factory reads its own pid and (below) the stable factory never
    // sees it.
    expect(previewPid).toBe(12345)

    process.env.ADHDEV_CONFIG_DIR = path.join(homeDir, '.adhdev')
    resetProcessInstanceContextForTests()
    expect(stable.getPid()).toBe(null)
    expect(stable.endpoint.path).toBe(stableEndpoint)
  })

  it('logfile spawn stdio creates the session-host log under the instance logs dir', () => {
    const homeDir = makeTempHome()
    setFakeHome(homeDir)
    const previewDir = path.join(homeDir, '.adhdev-preview')
    process.env.ADHDEV_CONFIG_DIR = previewDir
    resetProcessInstanceContextForTests()
    cp.spawn.mockClear()

    const host = createManagedSessionHost({
      appName: 'adhdev-preview',
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 200,
      spawnStdio: 'logfile',
    })
    host.spawnHost()

    expect(cp.spawn).toHaveBeenCalledTimes(1)
    const expectedLog = path.join(previewDir, 'logs', 'session-host.log')
    expect(fs.existsSync(expectedLog)).toBe(true)
    // Never in the stable default dir.
    expect(fs.existsSync(path.join(homeDir, '.adhdev', 'logs', 'session-host.log'))).toBe(false)

    // The spawned child carries the pinned instance identity.
    const spawnEnv = cp.spawn.mock.calls[0][2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.ADHDEV_CONFIG_DIR).toBe(previewDir)
    expect(spawnEnv.ADHDEV_SESSION_HOST_NAME).toBe('adhdev-preview')
  })
})
