import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHealthyManagedHostDisk } from '../helpers/managed-host-disk'

useHealthyManagedHostDisk()

const cp = vi.hoisted(() => ({ spawn: vi.fn(() => ({ unref: vi.fn(), pid: 4242 })) }))
// Only the host spawn is faked; execFileSync stays real so the default
// connect probe (short-lived child node) exercises a real unix socket.
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), spawn: cp.spawn }))

import { createManagedSessionHost } from '../../src/session-host/managed-host'
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context'

const cleanups: Array<() => void> = []
let configDir = ''
let appName = ''
let originalConfigDir: string | undefined

beforeEach(() => {
  originalConfigDir = process.env.ADHDEV_CONFIG_DIR
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-sock-'))
  appName = `orph${process.pid}x${Math.random().toString(36).slice(2, 8)}`
  process.env.ADHDEV_CONFIG_DIR = configDir
  resetProcessInstanceContextForTests()
  cp.spawn.mockClear()
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
  else process.env.ADHDEV_CONFIG_DIR = originalConfigDir
  resetProcessInstanceContextForTests()
  for (const fn of cleanups.splice(0)) { try { fn() } catch { /* best effort */ } }
  fs.rmSync(configDir, { recursive: true, force: true })
})

function makeHost() {
  return createManagedSessionHost({
    appName,
    requiredRequestTypes: [],
    timeoutMs: 200,
    resolveEntryOverride: () => '/fake/session-host-entry.js',
    // lsof is not the proof under test; the connect probe is.
    getSocketOwnerPids: () => [],
  })
}

/** Our OWN throwaway child binds the socket; SIGKILL leaves the file with no listener. */
async function bindInChild(sockPath: string, mode: 'listen' | 'accept-silent'): Promise<ChildProcess> {
  const script = `const net=require('net');const s=net.createServer((c)=>{${mode === 'accept-silent' ? 'c.on("data",()=>{})' : 'c.end()'}});`
    + `s.listen(process.argv[1],()=>process.stdout.write('ready'));setInterval(()=>{},1e6)`
  const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const child = realSpawn(process.execPath, ['-e', script, sockPath], { stdio: ['ignore', 'pipe', 'ignore'] })
  cleanups.push(() => { child.kill('SIGKILL') })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('error', reject)
    child.once('exit', () => reject(new Error('child exited early')))
  })
  return child
}

async function killChild(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

describe.skipIf(process.platform === 'win32')('managed host orphan unix socket reclaim', () => {
  it('socket-only + no listener: classified dead, spawn proceeds', async () => {
    const host = makeHost()
    const sock = host.endpoint.path
    const child = await bindInChild(sock, 'listen')
    await killChild(child)
    expect(fs.lstatSync(sock).isSocket()).toBe(true)

    host.spawnHost()
    expect(cp.spawn).toHaveBeenCalledTimes(1)
  })

  it('corrupt pid file + no listener: recovered', async () => {
    const host = makeHost()
    const sock = host.endpoint.path
    const child = await bindInChild(sock, 'listen')
    await killChild(child)
    fs.writeFileSync(host.getPidFile(), 'not-a-pid\n')

    host.spawnHost()
    expect(cp.spawn).toHaveBeenCalledTimes(1)
  })

  it('socket-only + live listener: refused, nothing replaced', async () => {
    const host = makeHost()
    const sock = host.endpoint.path
    await bindInChild(sock, 'listen')

    expect(() => host.spawnHost()).toThrow()
    expect(cp.spawn).not.toHaveBeenCalled()
    expect(fs.existsSync(sock)).toBe(true)
  })

  it('socket-only + listener that accepts but never responds: refused', async () => {
    const host = makeHost()
    const sock = host.endpoint.path
    await bindInChild(sock, 'accept-silent')

    expect(() => host.spawnHost()).toThrow()
    expect(cp.spawn).not.toHaveBeenCalled()
    expect(fs.existsSync(sock)).toBe(true)
  })

  it.each(['timeout', 'connected', 'error'] as const)('orphan-looking socket but probe says %s: refused', async (probe) => {
    const host = createManagedSessionHost({
      appName, requiredRequestTypes: [], resolveEntryOverride: () => '/fake/entry.js',
      getSocketOwnerPids: () => [], probeSocketConnect: () => probe,
    })
    const child = await bindInChild(host.endpoint.path, 'listen')
    await killChild(child)

    expect(() => host.spawnHost()).toThrow()
    expect(cp.spawn).not.toHaveBeenCalled()
    expect(fs.existsSync(host.endpoint.path)).toBe(true)
  })

  it('a regular file at the endpoint path is never treated as an orphan socket', () => {
    const host = makeHost()
    fs.writeFileSync(host.endpoint.path, 'not a socket')
    cleanups.push(() => fs.rmSync(host.endpoint.path, { force: true }))

    expect(() => host.spawnHost()).toThrow()
    expect(cp.spawn).not.toHaveBeenCalled()
    expect(fs.readFileSync(host.endpoint.path, 'utf8')).toBe('not a socket')
  })

  it('pid-file ESRCH path is unchanged (dead pid + empty owners recovers)', () => {
    const host = makeHost()
    fs.writeFileSync(host.getPidFile(), '2147483646\n')
    // No endpoint file at all: dead pid, nothing to reclaim.
    host.spawnHost()
    expect(cp.spawn).toHaveBeenCalledTimes(1)
  })
})
