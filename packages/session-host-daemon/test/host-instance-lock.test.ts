import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionHostServer } from '../src/server.js'
import { acquireHostInstanceLock, defaultReadBirth } from '../src/host-instance-lock.js'

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

for (const socket of ['absent', 'orphan', 'live'] as const) {
  test(`reused prior-boot PID with ${socket} socket uses reclaimed incarnation only`, { skip: process.platform === 'win32' }, async () => {
    const dir = tmp(), lockPath = path.join(dir, 'adhdev-session-host.pid.lock')
    const child = idleChild()
    let listener: ChildProcess | undefined
    const sock = path.join(dir, 'r.sock')
    const server = makeServer(dir, 'r.sock', { getSocketOwnerPids: () => [] })
    try {
      fs.writeFileSync(path.join(dir, 'adhdev-session-host.pid'), String(child.pid))
      fs.mkdirSync(lockPath)
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: child.pid, nonce: 'old', birth: 'prior-boot', acquiredAt: 1 }))
      if (socket !== 'absent') {
        listener = spawn(process.execPath, ['-e', 'require("net").createServer(c=>c.on("data",()=>{})).listen(process.argv[1],()=>process.stdout.write("ready"))', sock], { stdio: ['ignore', 'pipe', 'ignore'] })
        await new Promise<void>((resolve, reject) => { listener!.stdout!.once('data', () => resolve()); listener!.once('error', reject) })
        if (socket === 'orphan') await reap(listener)
      }
      if (socket === 'live') {
        await assert.rejects(server.start(), /session_host_prior_owner_socket_unverified/)
        assert.equal(fs.existsSync(sock), true)
      } else {
        await server.start()
        assert.equal(fs.existsSync(sock), true)
        const rival = makeServer(dir, 'other.sock')
        await assert.rejects(rival.start(), /session_host_instance_locked/)
      }
      assert.equal(child.exitCode, null, 'foreign process survives')
      assert.equal(fs.readFileSync(path.join(dir, 'adhdev-session-host.pid'), 'utf8'), String(child.pid), 'server leaves pidfile publication to CLI')
    } finally {
      await server.stop().catch(() => {}); if (listener) await reap(listener); await reap(child)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('lock reclaim refuses a concurrent owner update even when nonce is reused', () => {
  const dir = tmp(), lockPath = path.join(dir, 'h.lock'), file = path.join(lockPath, 'owner.json')
  try {
    fs.mkdirSync(lockPath)
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, nonce: 'same', birth: 'old' }))
    let reads = 0
    assert.throws(() => acquireHostInstanceLock({ lockPath, isPidAlive: () => true, readBirth: () => {
      if (++reads === 1) fs.writeFileSync(file, JSON.stringify({ pid: 4243, nonce: 'same', birth: 'older' }))
      return 'new'
    } }), /lock changed during reclaim/)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 4243)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

for (const change of ['birth', 'lock-owner', 'pidfile'] as const) {
  test(`reclaimed receipt refuses ${change} ABA before bind`, { skip: process.platform === 'win32' }, async () => {
    const dir = tmp(), child = idleChild(), lockPath = path.join(dir, 'adhdev-session-host.pid.lock')
    const pidFile = path.join(dir, 'adhdev-session-host.pid')
    let birth = defaultReadBirth(child.pid!)
    const server = makeServer(dir, 'a.sock', {
      getOwnerBirth: () => birth,
      getSocketOwnerPids: () => [],
    })
    try {
      fs.writeFileSync(pidFile, String(child.pid))
      fs.mkdirSync(lockPath)
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: child.pid, nonce: 'old', birth: 'old-birth' }))
      // Synthetic socket node is unnecessary here: initial path is absent and the
      // fence after await must still reject a changed incarnation/assignment.
      const original = (server as any).evictPriorEndpointOwners.bind(server)
      ;(server as any).evictPriorEndpointOwners = async () => {
        await original()
        if (change === 'birth') birth = 'another-incarnation'
        if (change === 'lock-owner') fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: child.pid, nonce: 'new-owner', birth: 'new-birth' }))
        if (change === 'pidfile') fs.writeFileSync(pidFile, String(process.pid))
      }
      await assert.rejects(server.start(), /changed_during_recovery|ownership changed during startup/)
      assert.equal(fs.existsSync(path.join(dir, 'a.sock')), false)
      assert.equal(child.exitCode, null)
      if (change === 'lock-owner') assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).nonce, 'new-owner')
    } finally { await server.stop().catch(() => {}); await reap(child); fs.rmSync(dir, { recursive: true, force: true }) }
  })
}

test('an old release receipt cannot delete a subsequent lock owner', () => {
  const dir = tmp(), lockPath = path.join(dir, 'h.lock')
  try {
    const first = acquireHostInstanceLock({ lockPath })
    first.release()
    const second = acquireHostInstanceLock({ lockPath })
    first.release()
    second.assertOwned()
    assert.equal(fs.existsSync(lockPath), true)
    second.release()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
