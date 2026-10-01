// POSIX stale session-host whose install prefix was deleted (2026-10-01).
//
// `brew upgrade adhdev` removes the previous versioned Cellar prefix. The new
// daemon then reattached to the old host still serving the socket; node-pty's
// spawn helper lived in the deleted prefix, so every create_session failed with
// `posix_spawn failed: No such file or directory`. The host reports its own
// entry path over the socket, so the daemon replaces it when that path is gone —
// and leaves a host from another prefix that still exists alone (its sessions
// are live and it can still spawn).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242, on: vi.fn() })),
}))
vi.mock('child_process', () => cp)

const host = vi.hoisted(() => ({ reportedEntry: '' }))
vi.mock('@adhdev/session-host-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhdev/session-host-core')>()
  class FakeClient {
    async connect() {}
    async request() {
      return { success: true, result: { hostEntryPath: host.reportedEntry } }
    }
    async close() {}
  }
  return { ...actual, SessionHostClient: FakeClient }
})

import { createManagedSessionHost } from '../../src/session-host/managed-host'
import { LOG } from '../../src/logging/logger'

const tempRoots: string[] = []
let platformDescriptor: PropertyDescriptor | undefined
let originalConfigDir: string | undefined
const STALE_PID = 31337

describe('managed session-host on POSIX: host from a deleted prefix', () => {
  let killSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    cp.execFileSync.mockReset()
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    originalConfigDir = process.env.ADHDEV_CONFIG_DIR
    // `ps` reports the host's command line, so the pid is provably ours.
    cp.execFileSync.mockImplementation(() => `node ${host.reportedEntry}`)
    warnSpy = vi.spyOn(LOG, 'warn')
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === STALE_PID && (signal === 0 || signal === undefined)) return true
      return true
    }) as typeof process.kill)
  })

  afterEach(() => {
    killSpy.mockRestore()
    warnSpy.mockRestore()
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function stage(): { appName: string; configDir: string } {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-posix-prefix-'))
    tempRoots.push(configDir)
    process.env.ADHDEV_CONFIG_DIR = configDir
    const appName = `adhdev-posix-${process.pid}-${Date.now()}`
    fs.writeFileSync(path.join(configDir, `${appName}-session-host.pid`), String(STALE_PID), 'utf8')
    return { appName, configDir }
  }

  async function ensure(appName: string) {
    const managed = createManagedSessionHost({ appName, requiredRequestTypes: ['delete_session'], timeoutMs: 200 })
    try {
      await managed.ensureReady()
    } catch {
      // No real session-host to spawn — only the stop decision matters here.
    }
  }

  // The guard's own decision. (A later "nothing reachable → respawn" path in
  // this fake environment may also signal the pid, so kills alone do not tell
  // the cases apart.)
  const guardStopped = () => warnSpy.mock.calls.some((c) => String(c[1]).includes('Reachable session-host reports it is running from'))
  const sigtermsToStale = () => killSpy.mock.calls.filter((c) => c[0] === STALE_PID && c[1] === 'SIGTERM')

  it('stops the host when the entry it reports no longer exists', async () => {
    const { appName, configDir } = stage()
    host.reportedEntry = path.join(configDir, 'Cellar', 'adhdev', '1.0.61', 'vendor', 'session-host-daemon', 'index.js')
    await ensure(appName)
    expect(guardStopped()).toBe(true)
    expect(sigtermsToStale().length).toBeGreaterThan(0)
  })

  it('leaves a host from another prefix alone while that prefix still exists', async () => {
    const { appName, configDir } = stage()
    const other = path.join(configDir, 'other-install', 'vendor', 'session-host-daemon', 'index.js')
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(other, '')
    host.reportedEntry = other
    await ensure(appName)
    expect(guardStopped()).toBe(false)
  })
})
