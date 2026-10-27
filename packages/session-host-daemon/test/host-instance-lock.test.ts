import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionHostServer } from '../src/server.js'
import { acquireHostInstanceLock } from '../src/host-instance-lock.js'

// Throwaway children only: they hold a lock record / idle; never a real host.
const idleChild = (): ChildProcess => spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' })
const reap = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve()
  child.once('exit', () => resolve()); child.kill('SIGKILL')
})
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hlock-'))
const makeServer = (dir: string, sockName: string, extra: Record<string, unknown> = {}) => new SessionHostServer({
  // Distinct socket per server == differing os.tmpdir() between start paths.
  endpoint: { kind: 'unix', path: path.join(dir, sockName) },
  instanceConfigDir: dir,
  pidFilePath: path.join(dir, 'adhdev-session-host.pid'), // shared instance identity
  storageRootDir: path.join(dir, `storage-${sockName}`),
  ...extra,
})

test('two hosts of one instance with different socket paths cannot both serve', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp()
  const first = makeServer(dir, 'a.sock'), second = makeServer(dir, 'b.sock')
  try {
    await first.start()
    await assert.rejects(second.start(), /session_host_instance_locked/)
    assert.equal(fs.existsSync(path.join(dir, 'b.sock')), false, 'refused host must not bind')
  } finally {
    await first.stop().catch(() => {}); await second.stop().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lock held by a live foreign pid blocks start; dead pid is reclaimed (positive proof)', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp(), lockPath = path.join(dir, 'adhdev-session-host.pid.lock')
  const child = idleChild()
  try {
    fs.mkdirSync(lockPath)
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: child.pid, nonce: 'n1', birth: null, acquiredAt: Date.now() }))
    const blocked = makeServer(dir, 'a.sock')
    await assert.rejects(blocked.start(), /session_host_instance_locked: held by live pid/)
    assert.equal(fs.existsSync(path.join(dir, 'a.sock')), false)
    await reap(child)
    const next = makeServer(dir, 'a.sock')
    await next.start()
    assert.equal(fs.existsSync(path.join(dir, 'a.sock')), true)
    await next.stop()
  } finally { await reap(child); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('live pid with a different native birth is a reused pid and is reclaimed', () => {
  const dir = tmp(), lockPath = path.join(dir, 'h.lock')
  try {
    fs.mkdirSync(lockPath)
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 4242, nonce: 'n', birth: 'Mon Oct 26 10:00:00 2026', acquiredAt: 1 }))
    const same = { lockPath, isPidAlive: () => true }
    assert.throws(() => acquireHostInstanceLock({ ...same, readBirth: () => 'Mon Oct 26 10:00:00 2026' }), /held by live pid 4242/)
    assert.throws(() => acquireHostInstanceLock({ ...same, readBirth: () => null }), /held by live pid 4242/, 'unknown birth fails closed')
    const lock = acquireHostInstanceLock({ ...same, readBirth: (pid) => (pid === 4242 ? 'Tue Oct 27 09:00:00 2026' : 'self') })
    lock.release()
    assert.equal(fs.existsSync(lockPath), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('fresh ownerless lock dir (holder mid-acquire) is not stolen; stale one is', () => {
  const dir = tmp(), lockPath = path.join(dir, 'h.lock')
  try {
    fs.mkdirSync(lockPath)
    assert.throws(() => acquireHostInstanceLock({ lockPath }), /owner record not yet written/)
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lockPath, old, old)
    acquireHostInstanceLock({ lockPath }).release()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('stop() releases the lock unless the host holds it until process exit', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp(), lockPath = path.join(dir, 'adhdev-session-host.pid.lock')
  try {
    const plain = makeServer(dir, 'a.sock')
    await plain.start(); assert.equal(fs.existsSync(lockPath), true)
    await plain.stop(); assert.equal(fs.existsSync(lockPath), false)
    const held = makeServer(dir, 'a.sock', { holdInstanceLockUntilExit: true })
    await held.start(); await held.stop()
    assert.equal(fs.existsSync(lockPath), true, 'lock outlives stop() until the process is gone')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a failed start releases the lock', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp(), lockPath = path.join(dir, 'adhdev-session-host.pid.lock')
  try {
    fs.writeFileSync(path.join(dir, 'adhdev-session-host.pid'), String(process.pid)) // live owner: eviction refuses
    await assert.rejects(makeServer(dir, 'a.sock').start(), /session_host_live_owner_replacement_unauthorized/)
    assert.equal(fs.existsSync(lockPath), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
