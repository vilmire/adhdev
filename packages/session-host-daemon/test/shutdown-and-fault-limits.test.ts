import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { SessionHostServer } from '../src/server.js'
import { createUncaughtExceptionLimiter } from '../src/index.js'

const instanceArgFor = (configDir: string) =>
  `--instance-config-key=${createHash('sha256').update(path.resolve(configDir)).digest('hex')}`

// SIGINT and SIGTERM are registered as independent handlers, so a double signal
// (or a signal racing an explicit shutdown) can enter stop() twice. Without a
// re-entrancy guard the second entry re-runs flushAllPersistence() and
// runtime.stop() against already-cleared state.
test('stop() is re-entrant: concurrent and repeat calls tear down exactly once', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-stop-'))
  try {
    const server = new SessionHostServer({
      appName: `adhdev-stop-guard-${process.pid}`,
      endpoint: { kind: 'unix', path: path.join(tmp, 'sock') },
      storageRootDir: path.join(tmp, 'storage'),
    })
    await server.start()

    let flushes = 0
    const realFlush = server.flushAllPersistence.bind(server)
    ;(server as any).flushAllPersistence = (...args: any[]) => {
      flushes += 1
      return (realFlush as any)(...args)
    }

    // Two concurrent callers (the two signal handlers) plus a later one.
    await Promise.all([server.stop(), server.stop()])
    await server.stop()

    assert.equal(flushes, 1, 'teardown ran more than once')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// The uncaughtException handler deliberately swallows faults so a transient
// native crash (node-pty on Windows) does not kill healthy sessions. Unbounded
// swallowing instead produces a zombie that holds the socket and pid file while
// failing every request, so the tolerance is bounded.
test('uncaught-exception limiter tolerates bursts under the limit', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 10)
  for (let i = 0; i < 10; i++) {
    assert.equal(shouldExit(1000 + i).exit, false, `fault ${i + 1} should be tolerated`)
  }
})

test('uncaught-exception limiter exits once the limit is exceeded in the window', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 10)
  for (let i = 0; i < 10; i++) shouldExit(1000 + i)
  const eleventh = shouldExit(1010)
  assert.equal(eleventh.exit, true)
  assert.equal(eleventh.countInWindow, 11)
})

test('uncaught-exception limiter never exits on faults spread beyond the window', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 10)
  for (let i = 0; i < 50; i++) {
    assert.equal(shouldExit(i * 61_000).exit, false, 'slow drip must not trip the limiter')
  }
})

// Regression: a 0-based clock must not be mistaken for "no window yet". Using 0
// as the unset sentinel reset the window on every call, so the limiter never
// tripped when timestamps started at 0.
test('uncaught-exception limiter counts correctly from a zero timestamp', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 3)
  assert.equal(shouldExit(0).exit, false)
  assert.equal(shouldExit(1).exit, false)
  assert.equal(shouldExit(2).exit, false)
  assert.equal(shouldExit(3).exit, true)
})

test('start() refuses unauthorized live prior host eviction (cannot bypass parent refusal) and evicts only with explicit replacement provenance; late stop() never unlinks replacement socket', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-split-brain-'))
  const configDir = path.join(tmp, 'instance-config')
  fs.mkdirSync(configDir, { recursive: true })
  const sockPath = path.join(tmp, 'host.sock')
  const pidFilePath = path.join(tmp, 'host.pid')
  const priorPid = 49151
  const priorBirth = 'Sat Oct 24 06:00:00 2026'
  fs.writeFileSync(pidFilePath, `${priorPid}\n`, 'utf8')

  const killCalls: Array<[number, string | number | undefined]> = []
  let priorAlive = true
  const realKill = process.kill.bind(process)
  ;(process as any).kill = (pid: number, signal?: string | number) => {
    if (pid === priorPid) {
      killCalls.push([pid, signal])
      if (signal === 0 || signal === undefined) {
        if (priorAlive) return true
        const err = new Error('kill ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      priorAlive = false
      return true
    }
    return realKill(pid, signal as any)
  }

  let firstServer: SessionHostServer | null = null
  let secondServer: SessionHostServer | null = null
  let unauthorizedServer: SessionHostServer | null = null
  try {
    firstServer = new SessionHostServer({
      appName: `adhdev-split-brain-first-${process.pid}`,
      endpoint: { kind: 'unix', path: sockPath },
      storageRootDir: path.join(tmp, 'storage-1'),
      instanceConfigDir: configDir,
    } as any)
    await firstServer.start()
    const firstIno = fs.lstatSync(sockPath, { bigint: true }).ino

    // 1. Unauthorized child startup MUST refuse and never signal priorPid or unlink sockPath
    unauthorizedServer = new SessionHostServer({
      appName: `adhdev-split-brain-unauthorized-${process.pid}`,
      endpoint: { kind: 'unix', path: sockPath },
      storageRootDir: path.join(tmp, 'storage-unauth'),
      instanceConfigDir: configDir,
      pidFilePath,
      isManagedOwnerPid: (pid: number) => pid === priorPid,
      getOwnerBirth: () => priorBirth,
      getSocketOwnerPids: () => [priorPid],
    } as any)
    await assert.rejects(unauthorizedServer.start(), /session_host_live_owner_replacement_unauthorized/)
    assert.equal(
      killCalls.some(([pid, sig]) => pid === priorPid && (sig === 'SIGTERM' || sig === 'SIGKILL')),
      false,
      'unauthorized child startup must never signal a live prior host',
    )
    assert.equal(fs.lstatSync(sockPath, { bigint: true }).ino, firstIno)

    // 2. Authorized replacement with matching instance key, PID, birth, and socket inode succeeds
    secondServer = new SessionHostServer({
      appName: `adhdev-split-brain-second-${process.pid}`,
      endpoint: { kind: 'unix', path: sockPath },
      storageRootDir: path.join(tmp, 'storage-2'),
      instanceConfigDir: configDir,
      pidFilePath,
      isManagedOwnerPid: (pid: number) => pid === priorPid,
      getOwnerBirth: () => priorBirth,
      getSocketOwnerPids: () => (priorAlive ? [priorPid] : []),
      readOwnerArgs: () => `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(configDir)}`,
      replacementProvenance: {
        expectedPid: priorPid,
        expectedBirth: priorBirth,
        instanceConfigDir: configDir,
        expectedEndpointInode: firstIno,
      },
    } as any)
    await secondServer.start()

    assert.equal(
      killCalls.some(([pid, sig]) => pid === priorPid && sig === 'SIGTERM'),
      true,
      'authorized new host start() must stop prior managed host before rebinding socket',
    )
    const secondIno = fs.lstatSync(sockPath, { bigint: true }).ino

    // Old host stopping late must NOT unlink or rename the replacement host's bound socket inode
    const origClose = (firstServer as any).ipcServer.close.bind((firstServer as any).ipcServer)
    let sockExistedDuringClose = true
    ;(firstServer as any).ipcServer.close = (cb?: (err?: Error) => void) => {
      sockExistedDuringClose = fs.existsSync(sockPath) && fs.lstatSync(sockPath, { bigint: true }).ino === secondIno
      return origClose(cb)
    }
    await firstServer.stop()
    firstServer = null
    assert.equal(sockExistedDuringClose, true, 'runStop() must never rename the replacement socket away before close (M3)')
    assert.equal(fs.existsSync(sockPath), true, 'late stop() of old host unlinked replacement socket')
    assert.equal(fs.lstatSync(sockPath, { bigint: true }).ino, secondIno)

    await secondServer.stop()
    secondServer = null
  } finally {
    process.kill = realKill
    await unauthorizedServer?.stop().catch(() => {})
    await firstServer?.stop().catch(() => {})
    await secondServer?.stop().catch(() => {})
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('start() refuses stale pidfile with vanished socket when prior host is alive, wrong/duplicate/missing instance key, unreadable ownership, PID reuse before SIGKILL, and changed socket inode/owner before unlink', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-fences-'))
  const configDir = path.join(tmp, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const priorPid = 49152
  const realKill = process.kill.bind(process)
  let priorAlive = true
  let currentBirth: string | null = 'Sat Oct 24 06:00:00 2026'
  let currentCmd: string | null = `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(configDir)}`
  const signaled: Array<[number, string | number | undefined]> = []
  const createdServers: SessionHostServer[] = []

  try {
    // 1. Stale PID file + vanished socket with live prior host (unauthorized)
    const pidFile1 = path.join(tmp, 'vanished.pid')
    const sock1 = path.join(tmp, 'vanished.sock')
    fs.writeFileSync(pidFile1, `${priorPid}\n`, 'utf8')
    ;(process as any).kill = (pid: number, sig?: string | number) => {
      if (pid === priorPid) {
        if (sig === 0 || sig === undefined) return true
        signaled.push([pid, sig])
        return true
      }
      return realKill(pid, sig as any)
    }
    const vanishedServer = new SessionHostServer({
      appName: 'adhdev-vanished',
      endpoint: { kind: 'unix', path: sock1 },
      storageRootDir: path.join(tmp, 's1'),
      instanceConfigDir: configDir,
      pidFilePath: pidFile1,
    } as any)
    createdServers.push(vanishedServer)
    await assert.rejects(vanishedServer.start(), /session_host_live_owner_replacement_unauthorized/)
    assert.deepEqual(signaled, [])

    // 2. Wrong, duplicate, or missing instance key, or unreadable command/birth/pidfile
    for (const fault of ['missing-key', 'wrong-key', 'duplicate-key', 'unreadable-cmd', 'unreadable-birth', 'corrupt-pidfile'] as const) {
      signaled.length = 0
      const sock = path.join(tmp, `${fault}.sock`)
      const pidFile = path.join(tmp, `${fault}.pid`)
      fs.writeFileSync(sock, 'sock')
      fs.writeFileSync(pidFile, fault === 'corrupt-pidfile' ? 'corrupt\n' : `${priorPid}\n`, 'utf8')
      currentBirth = fault === 'unreadable-birth' ? null : 'Sat Oct 24 06:00:00 2026'
      currentCmd =
        fault === 'missing-key'
          ? 'node /opt/adhdev/session-host-daemon/dist/index.js serve'
          : fault === 'wrong-key'
            ? `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(path.join(tmp, 'other'))}`
            : fault === 'duplicate-key'
              ? `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(configDir)} --instance-config-key=${'a'.repeat(64)}`
              : fault === 'unreadable-cmd'
                ? null
                : `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(configDir)}`
      const srv = new SessionHostServer({
        appName: `adhdev-${fault}`,
        endpoint: { kind: 'unix', path: sock },
        storageRootDir: path.join(tmp, `storage-${fault}`),
        instanceConfigDir: configDir,
        pidFilePath: pidFile,
        getOwnerBirth: () => currentBirth,
        readOwnerArgs: () => currentCmd,
        getSocketOwnerPids: () => [priorPid],
        replacementProvenance: {
          expectedPid: priorPid,
          expectedBirth: 'Sat Oct 24 06:00:00 2026',
          instanceConfigDir: configDir,
        },
      } as any)
      await assert.rejects(srv.start(), /session_host_prior_owner_/)
      assert.deepEqual(signaled, [], `must never signal on ${fault}`)
      assert.equal(fs.existsSync(sock), true, `must never unlink socket on ${fault}`)
    }

    // 3. PID reuse / native birth change between SIGTERM and SIGKILL
    signaled.length = 0
    priorAlive = true
    currentBirth = 'Sat Oct 24 06:00:00 2026'
    currentCmd = `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(configDir)}`
    const reuseSock = path.join(tmp, 'reuse.sock')
    const reusePidFile = path.join(tmp, 'reuse.pid')
    fs.writeFileSync(reuseSock, 'sock')
    fs.writeFileSync(reusePidFile, `${priorPid}\n`, 'utf8')
    ;(process as any).kill = (pid: number, sig?: string | number) => {
      if (pid === priorPid) {
        if (sig === 0 || sig === undefined) return true
        signaled.push([pid, sig])
        if (sig === 'SIGTERM') {
          // Simulate OS recycling PID 49152 to a newly born process before grace expires
          currentBirth = 'Sat Oct 24 06:04:00 2026'
        }
        return true
      }
      return realKill(pid, sig as any)
    }
    const reuseServer = new SessionHostServer({
      appName: 'adhdev-reuse',
      endpoint: { kind: 'unix', path: reuseSock },
      storageRootDir: path.join(tmp, 's-reuse'),
      instanceConfigDir: configDir,
      pidFilePath: reusePidFile,
      evictGraceMs: 20,
      getOwnerBirth: () => currentBirth,
      readOwnerArgs: () => currentCmd,
      getSocketOwnerPids: () => [priorPid],
      replacementProvenance: {
        expectedPid: priorPid,
        expectedBirth: 'Sat Oct 24 06:00:00 2026',
        instanceConfigDir: configDir,
      },
    } as any)
    await assert.rejects(reuseServer.start(), /session_host_prior_owner_birth_mismatch/)
    assert.deepEqual(signaled, [[priorPid, 'SIGTERM']])
    assert.equal(fs.existsSync(reuseSock), true, 'must not unlink socket when PID was reused during grace period')

    // 4. Changed socket inode between validation and unlink
    signaled.length = 0
    priorAlive = true
    currentBirth = 'Sat Oct 24 06:00:00 2026'
    const raceSock = path.join(tmp, 'inode-race.sock')
    const racePidFile = path.join(tmp, 'inode-race.pid')
    fs.writeFileSync(raceSock, 'first-inode')
    fs.writeFileSync(racePidFile, `${priorPid}\n`, 'utf8')
    let replacementInode: bigint | null = null
    ;(process as any).kill = (pid: number, sig?: string | number) => {
      if (pid === priorPid) {
        if (sig === 0 || sig === undefined) {
          if (priorAlive) return true
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
        }
        signaled.push([pid, sig])
        priorAlive = false
        // Another process replaces the socket inode before unlink runs
        fs.unlinkSync(raceSock)
        fs.writeFileSync(raceSock, 'second-inode')
        replacementInode = fs.lstatSync(raceSock, { bigint: true }).ino
        return true
      }
      return realKill(pid, sig as any)
    }
    const raceServer = new SessionHostServer({
      appName: 'adhdev-inode-race',
      endpoint: { kind: 'unix', path: raceSock },
      storageRootDir: path.join(tmp, 's-race'),
      instanceConfigDir: configDir,
      pidFilePath: racePidFile,
      evictGraceMs: 20,
      getOwnerBirth: () => currentBirth,
      readOwnerArgs: () => currentCmd,
      getSocketOwnerPids: () => (priorAlive ? [priorPid] : []),
      replacementProvenance: {
        expectedPid: priorPid,
        expectedBirth: 'Sat Oct 24 06:00:00 2026',
        instanceConfigDir: configDir,
      },
    } as any)
    await assert.rejects(raceServer.start(), /session_host_endpoint_changed_during_recovery/)
    assert.equal(fs.existsSync(raceSock), true)
    assert.equal(fs.lstatSync(raceSock, { bigint: true }).ino, replacementInode)

    // 5. Proven-dead prior owner with unchanged stale socket recovers once cleanly
    const deadSock = path.join(tmp, 'dead-owner.sock')
    const deadPidFile = path.join(tmp, 'dead-owner.pid')
    fs.writeFileSync(deadSock, 'stale-dead-socket')
    fs.writeFileSync(deadPidFile, `${priorPid}\n`, 'utf8')
    priorAlive = false
    const recoveredServer = new SessionHostServer({
      appName: 'adhdev-dead-recovery',
      endpoint: { kind: 'unix', path: deadSock },
      storageRootDir: path.join(tmp, 's-dead'),
      instanceConfigDir: configDir,
      pidFilePath: deadPidFile,
      getSocketOwnerPids: () => [],
    } as any)
    await recoveredServer.start()
    await recoveredServer.stop()
  } finally {
    process.kill = realKill
    for (const s of createdServers) {
      await s.stop().catch(() => {})
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('C1: real lsof/ps authorized eviction only targets the listener of this exact socket and instance key and never signals other unix sockets or agent prompts mentioning session-host-daemon', async () => {
  if (process.platform === 'win32') return
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-c1-lsof-'))
  const configDir = path.join(tmp, 'instance-config')
  fs.mkdirSync(configDir, { recursive: true })
  const targetSockPath = path.join(tmp, 'target.sock')
  const unrelatedSockPath = path.join(tmp, 'unrelated.sock')
  const pidFilePath = path.join(tmp, 'stale-recycled.pid')

  // 1. Spawn a real child process running from `<tmp>/session-host-daemon/index.js`
  //    that listens on `targetSockPath` (the actual prior host owning `targetSockPath`).
  const fakeHostDir = path.join(tmp, 'session-host-daemon')
  fs.mkdirSync(fakeHostDir, { recursive: true })
  const fakeHostEntry = path.join(fakeHostDir, 'index.js')
  fs.writeFileSync(
    fakeHostEntry,
    `
      const net = require('net');
      const srv = net.createServer();
      srv.listen(${JSON.stringify(targetSockPath)}, () => {
        process.stdout.write('READY\\n');
      });
      process.on('SIGTERM', () => {
        srv.close(() => process.exit(0));
      });
      setInterval(() => {}, 10000);
    `,
    'utf8',
  )
  const targetListenerChild = spawn(process.execPath, [fakeHostEntry, 'serve', instanceArgFor(configDir)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  await new Promise<void>((resolve, reject) => {
    targetListenerChild.once('error', reject)
    targetListenerChild.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('READY')) resolve()
    })
  })
  const targetBirth = String(
    execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(targetListenerChild.pid)], { encoding: 'utf8' }),
  ).trim()

  // 2. Spawn a real decoy child process that holds a unix socket at `unrelatedSockPath`
  //    AND has "session-host-daemon/index.js" and "adhdev-sessiond" in its trailing prompt argv
  //    (simulating an agent CLI worker like codex/claude AND another instance's unix socket).
  //    Also write its PID into `pidFilePath` to simulate a recycled PID in a stale pidfile!
  const decoyScript = `
    const net = require('net');
    const srv = net.createServer();
    srv.listen(${JSON.stringify(unrelatedSockPath)}, () => {
      process.stdout.write('READY\\n');
    });
    setInterval(() => {}, 10000);
  `
  const decoyChild = spawn(
    process.execPath,
    ['-e', decoyScript, '--', '--prompt', 'investigate session-host-daemon/index.js and adhdev-sessiond split-brain'],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )
  await new Promise<void>((resolve, reject) => {
    decoyChild.once('error', reject)
    decoyChild.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('READY')) resolve()
    })
  })
  fs.writeFileSync(pidFilePath, `${decoyChild.pid}\n`, 'utf8')

  // Intercept process.kill so no unrelated process on the machine can ever be signaled,
  // while forwarding real signals to targetListenerChild so it exits cleanly on SIGTERM.
  const realKill = process.kill.bind(process)
  const signaledPids: Array<[number, string | number]> = []
  ;(process as any).kill = (pid: number, signal?: string | number) => {
    if (signal === 0 || signal === undefined) {
      return realKill(pid, 0)
    }
    signaledPids.push([pid, signal])
    if (pid === targetListenerChild.pid) {
      return realKill(pid, signal as any)
    }
    return true
  }

  let server: SessionHostServer | null = null
  try {
    server = new SessionHostServer({
      appName: `adhdev-c1-test-${process.pid}`,
      endpoint: { kind: 'unix', path: targetSockPath },
      storageRootDir: path.join(tmp, 'storage'),
      instanceConfigDir: configDir,
      pidFilePath,
      evictGraceMs: 200,
      replacementProvenance: {
        expectedPid: targetListenerChild.pid!,
        expectedBirth: targetBirth,
        instanceConfigDir: configDir,
      },
    } as any)
    await server.start()

    assert.deepEqual(
      signaledPids,
      [[targetListenerChild.pid!, 'SIGTERM']],
      `evictPriorEndpointOwners must signal ONLY targetListenerChild (pid ${targetListenerChild.pid}), never decoyChild (pid ${decoyChild.pid}) or other unix sockets, but signaled: ${JSON.stringify(signaledPids)}`,
    )
  } finally {
    process.kill = realKill
    await server?.stop().catch(() => {})
    try { realKill(targetListenerChild.pid!, 'SIGKILL') } catch { /* noop */ }
    try { realKill(decoyChild.pid!, 'SIGKILL') } catch { /* noop */ }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
