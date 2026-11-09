import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ pipePath: '', pipeLstats: 0, unstablePipe: false, spawn: vi.fn(() => ({ unref() {}, pid: 4242, stdio: [null, null, null, { on() {}, end() {} }], once() {} })) }))
// lstat on a live Windows pipe opens a handle whose ino differs per call.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    // Healthy-disk fixture: the real preflight is not under test here.
    statfsSync: () => ({ bsize: 4096, blocks: 1e7, bavail: 5e6, bfree: 5e6, files: 0, ffree: 0, type: 0 }),
    lstatSync: ((file: any, opts?: any) => {
      const stat: any = (actual.lstatSync as any)(file, opts)
      if (fx.unstablePipe && String(file) === fx.pipePath) { fx.pipeLstats++; return { ...stat, ino: BigInt(1000 + fx.pipeLstats) } }
      return stat
    }) as any,
  }
})
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), spawn: fx.spawn }))
// Present the endpoint as a Windows named pipe regardless of the host OS.
vi.mock('@adhdev/session-host-core', async (original) => {
  const actual = await original<typeof import('@adhdev/session-host-core')>()
  return { ...actual, getDefaultSessionHostEndpoint: () => ({ kind: 'pipe', path: fx.pipePath }) }
})

import { createManagedSessionHost } from '../../src/session-host/managed-host'
import { ensureSessionHostReady, SessionHostUnavailableTransientError } from '../../src/session-host/runtime-support'
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context'

let configDir = ''
let originalConfigDir: string | undefined

beforeEach(() => {
  originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transient-reason-'))
  fx.pipePath = path.join(configDir, 'fake-pipe-endpoint')
  fs.writeFileSync(fx.pipePath, '')
  process.env.ADHDEV_CONFIG_DIR = configDir
  resetProcessInstanceContextForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
  resetProcessInstanceContextForTests()
  fx.unstablePipe = false
  fx.pipeLstats = 0
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('SessionHostUnavailableTransientError reasons', () => {
  it('names the failing readiness probe and the host state when spawn admission refuses', async () => {
    const endpoint = { kind: 'pipe' as const, path: path.join(configDir, 'absent-pipe') }
    const spawnHost = vi.fn()
    const error = await ensureSessionHostReady({
      endpoint, spawnHost, existingHostState: () => 'alive', isExistingSocketPresent: () => true,
      timeoutMs: 1500, canConnectRetries: 0,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(SessionHostUnavailableTransientError)
    expect(error.message).toMatch(/spawn admission refused: existing host state is alive\/alive/)
    expect(error.message).toMatch(/last probe error: /)
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('does not treat unstable named-pipe file identity as a host generation change', async () => {
    fx.unstablePipe = true
    const host = createManagedSessionHost({
      appName: 'pipegen', requiredRequestTypes: [], timeoutMs: 300,
      resolveEntryOverride: () => '/fake/session-host-entry.js',
    })
    const error = await host.ensureReady().catch((e) => e)
    expect(String(error?.message ?? error)).not.toMatch(/generation changed/)
  })
})
