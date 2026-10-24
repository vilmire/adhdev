import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionHostServer, readVerifiedReplacementProvenance } from '../src/server.js'
import {
  createUncaughtExceptionLimiter,
  getSessionHostReplacementProvenanceFile,
  removeSessionHostReplacementProvenance,
} from '../src/index.js'

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

test('R4 start refuses live and unknown owners and every explicit replacement context before any listener', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-automatic-refusal-'))
  const realKill = process.kill
  const signaled: unknown[] = []
  process.kill = ((pid: number, signal: unknown) => { signaled.push([pid, signal]); throw new Error('unexpected signal') }) as any
  try {
    for (const fault of ['live', 'no-pid', 'null-owner', 'foreign-owner', 'explicit', 'undefined-callback', 'disk-artifact']) {
      const config = path.join(tmp, fault)
      fs.mkdirSync(config)
      const endpoint = path.join(config, 'host.sock'), pidFilePath = path.join(config, 'host.pid')
      fs.writeFileSync(endpoint, 'retained endpoint')
      if (fault !== 'no-pid') fs.writeFileSync(pidFilePath, '49152')
      if (fault === 'disk-artifact') fs.writeFileSync(path.join(config, 'test-session-host-replacement.json'), '{}')
      const server = new SessionHostServer({
        endpoint: { kind: 'unix', path: endpoint }, instanceConfigDir: config,
        storageRootDir: path.join(config, 'storage'), pidFilePath,
        isPidAlive: () => fault === 'live', getOwnerBirth: () => null,
        getSocketOwnerPids: () => fault === 'null-owner' ? null : fault === 'foreign-owner' ? [98765] : [],
        ...(fault === 'undefined-callback' ? { replacementProvenance: () => undefined } : {}),
        ...(fault === 'explicit' ? { replacementProvenance: { expectedPid: 49152, expectedBirth: 'known-birth', activeRuntimeCount: 0 } } : {}),
      })
      await assert.rejects(server.start())
      assert.equal(fs.readFileSync(endpoint, 'utf8'), 'retained endpoint')
      assert.deepEqual(signaled, [])
    }
  } finally { process.kill = realKill; fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('R4 late stop preserves a replacement endpoint without closing its path or renaming it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-late-stop-'))
  try {
    const endpoint = path.join(tmp, 'host.sock')
    fs.writeFileSync(endpoint, 'old endpoint')
    const server = new SessionHostServer({ endpoint: { kind: 'unix', path: endpoint }, storageRootDir: path.join(tmp, 'storage') })
    ;(server as any).endpointInode = fs.lstatSync(endpoint, { bigint: true }).ino
    fs.renameSync(endpoint, endpoint + '.old')
    fs.writeFileSync(endpoint, 'replacement endpoint')
    let unrefs = 0
    ;(server as any).ipcServer = {
      unref() { unrefs++ }, removeAllListeners() {},
      close() { throw new Error('close would unlink the replacement by path') },
    }
    await server.stop()
    assert.equal(unrefs, 1)
    assert.equal(fs.readFileSync(endpoint, 'utf8'), 'replacement endpoint')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('R2 pure eviction and provenance fences: unknown socket owner with dead pidfile refuses unlink, endpoint replaced during final owner query is retained, cancellation during dead-owner birth query precedes effects, automatic provenance takeover is unsupported, and confirmed dead empty socket unlinks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-r2-pure-'))
  const configDir = path.join(tmp, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const priorPid = 49152
  const realKill = process.kill.bind(process)
  const signaled: Array<[number, string | number | undefined]> = []

  try {
    // 1. Dead stale PID plus unknown socket ownership (null) refuses unlink
    const sock1 = path.join(tmp, 'dead-unknown.sock')
    const pidFile1 = path.join(tmp, 'dead-unknown.pid')
    fs.writeFileSync(sock1, 'live-bound-socket')
    fs.writeFileSync(pidFile1, `${priorPid}\n`, 'utf8')
    ;(process as any).kill = (pid: number, sig?: string | number) => {
      if (pid === priorPid && (sig === 0 || sig === undefined)) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      signaled.push([pid, sig])
      return true
    }
    const srvUnknown = new SessionHostServer({
      appName: 'adhdev-r2-unknown',
      endpoint: { kind: 'unix', path: sock1 },
      storageRootDir: path.join(tmp, 's1'),
      getOwnerBirth: () => null,
      instanceConfigDir: configDir,
      pidFilePath: pidFile1,
      getSocketOwnerPids: () => null,
    } as any)
    await assert.rejects(
      (srvUnknown as any).evictPriorEndpointOwners(),
      /session_host_prior_owner_socket_unverified/,
    )
    assert.equal(fs.existsSync(sock1), true)
    assert.deepEqual(signaled, [])

    // 2. Endpoint replaced during final owner query is retained
    const sock2 = path.join(tmp, 'replaced-final.sock')
    const pidFile2 = path.join(tmp, 'replaced-final.pid')
    fs.writeFileSync(sock2, 'first-endpoint')
    fs.writeFileSync(pidFile2, `${priorPid}\n`, 'utf8')
    let ownerChecks = 0
    let replacementInode: bigint | null = null
    const srvReplaced = new SessionHostServer({
      appName: 'adhdev-r2-replaced',
      endpoint: { kind: 'unix', path: sock2 },
      storageRootDir: path.join(tmp, 's2'),
      getOwnerBirth: () => null,
      instanceConfigDir: configDir,
      pidFilePath: pidFile2,
      getSocketOwnerPids: () => {
        ownerChecks += 1
        if (ownerChecks === 2) {
          fs.unlinkSync(sock2)
          fs.writeFileSync(sock2, 'second-endpoint-bound-by-peer')
          replacementInode = fs.lstatSync(sock2, { bigint: true }).ino
        }
        return []
      },
    } as any)
    await assert.rejects(
      (srvReplaced as any).evictPriorEndpointOwners(),
      /session_host_endpoint_changed_during_recovery/,
    )
    assert.equal(fs.existsSync(sock2), true)
    assert.equal(fs.lstatSync(sock2, { bigint: true }).ino, replacementInode)

    // 3. Cancellation during a dead-owner native birth query precedes unlink/start effects
    const sock3 = path.join(tmp, 'cancel-birth.sock')
    const pidFile3 = path.join(tmp, 'cancel-birth.pid')
    fs.writeFileSync(sock3, 'live-owner')
    fs.writeFileSync(pidFile3, `${priorPid}\n`, 'utf8')
    let cancelled = false
    signaled.length = 0
    ;(process as any).kill = (pid: number, sig?: string | number) => {
      if (pid === priorPid && (sig === 0 || sig === undefined)) return true
      signaled.push([pid, sig])
      return true
    }
    const srvCancel = new SessionHostServer({
      appName: 'adhdev-r2-cancel',
      endpoint: { kind: 'unix', path: sock3 },
      storageRootDir: path.join(tmp, 's3'),
      instanceConfigDir: configDir,
      pidFilePath: pidFile3,
      readOwnerArgs: () =>
        `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(configDir)}`,
      isPidAlive: () => false,
      getOwnerBirth: () => { cancelled = true; return null },
      getSocketOwnerPids: () => [],
      isCancelled: () => cancelled,
    } as any)
    await assert.rejects(
      (srvCancel as any).evictPriorEndpointOwners(),
      /session_host_start_cancelled/,
    )
    assert.deepEqual(signaled, [])
    assert.equal(fs.existsSync(sock3), true)

    // 4. Verified replacement provenance file + upgrade-lease.json consumer wiring and inverse negatives
    const appName = 'adhdev-r2-prov'
    const sock4 = path.join(tmp, 'prov-wired.sock')
    const pidFile4 = path.join(tmp, 'prov-wired.pid')
    fs.writeFileSync(sock4, 'prov-wired-socket')
    fs.writeFileSync(pidFile4, `${priorPid}\n`, 'utf8')
    const sock4Ino = fs.lstatSync(sock4, { bigint: true }).ino
    const provFile = getSessionHostReplacementProvenanceFile(appName, configDir)
    const leaseDir = path.join(configDir, 'session-host')
    fs.mkdirSync(leaseDir, { recursive: true })
    const leaseFile = path.join(leaseDir, 'upgrade-lease.json')
    const tokenHash = createHash('sha256').update('b'.repeat(64)).digest('hex')

    const writeValidProvenanceAndLease = () => {
      fs.writeFileSync(
        provFile,
        JSON.stringify({
          schemaVersion: 1,
          appName,
          instanceConfigDir: path.resolve(configDir),
          instanceConfigKey: instanceArgFor(configDir),
          endpointPath: sock4,
          expectedEndpointInode: sock4Ino.toString(),
          expectedPid: priorPid,
          expectedBirth: 'Sat Oct 24 06:00:00 2026',
          expectedBootId: 'boot-r2',
          expectedEpoch: 7,
          expectedOwner: 'owner-r2',
          expectedTokenHash: tokenHash,
          activeRuntimeCount: 0,
          issuedAtMs: Date.now(),
        }),
        { mode: 0o600 },
      )
      fs.chmodSync(provFile, 0o600)
      fs.writeFileSync(
        leaseFile,
        JSON.stringify({
          schema: 1,
          endpoint: sock4,
          epoch: 7,
          held: true,
          owner: 'owner-r2',
          tokenHash,
        }),
        { mode: 0o600 },
      )
      fs.chmodSync(leaseFile, 0o600)
    }

    writeValidProvenanceAndLease()
    // World-readable provenance file must be rejected
    fs.chmodSync(provFile, 0o644)
    assert.equal(
      readVerifiedReplacementProvenance({
        provenanceFile: provFile,
        instanceConfigDir: configDir,
        appName,
        endpointPath: sock4,
        leaseStateDir: leaseDir,
      }),
      undefined,
    )

    // Unheld or mismatched lease journal must be rejected
    writeValidProvenanceAndLease()
    fs.writeFileSync(
      leaseFile,
      JSON.stringify({
        schema: 1,
        endpoint: sock4,
        epoch: 7,
        held: false,
        owner: null,
        tokenHash: null,
      }),
      { mode: 0o600 },
    )
    assert.equal(
      readVerifiedReplacementProvenance({
        provenanceFile: provFile,
        instanceConfigDir: configDir,
        appName,
        endpointPath: sock4,
        leaseStateDir: leaseDir,
      }),
      undefined,
    )

    // R4: valid private provenance + matching held lease still cannot authorize automatic live eviction
    writeValidProvenanceAndLease()
    let prior4Alive = true
    signaled.length = 0
    ;(process as any).kill = (pid: number, sig?: string | number) => {
      if (pid === priorPid) {
        if (sig === 0 || sig === undefined) {
          if (prior4Alive) return true
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
        }
        signaled.push([pid, sig])
        if (sig === 'SIGTERM') prior4Alive = false
        return true
      }
      return realKill(pid, sig as any)
    }
    const srvWired = new SessionHostServer({
      appName,
      endpoint: { kind: 'unix', path: sock4 },
      storageRootDir: path.join(tmp, 's4'),
      instanceConfigDir: configDir,
      pidFilePath: pidFile4,
      readOwnerArgs: () =>
        `node /opt/adhdev/session-host-daemon/dist/index.js serve ${instanceArgFor(configDir)}`,
      getOwnerBirth: () => 'Sat Oct 24 06:00:00 2026',
      getSocketOwnerPids: () => (prior4Alive ? [priorPid] : []),
      replacementProvenance: () =>
        readVerifiedReplacementProvenance({
          provenanceFile: provFile,
          instanceConfigDir: configDir,
          appName,
          endpointPath: sock4,
          leaseStateDir: leaseDir,
        }),
    } as any)
    await assert.rejects((srvWired as any).evictPriorEndpointOwners(), /session_host_live_owner_replacement_unauthorized/)
    removeSessionHostReplacementProvenance(appName, configDir)
    assert.deepEqual(signaled, [])
    assert.equal(fs.existsSync(sock4), true)
    assert.equal(fs.existsSync(provFile), false)

    // 5. Confirmed dead prior owner with verified empty socket ownership unlinks stale socket cleanly
    const sock5 = path.join(tmp, 'dead-clean.sock')
    const pidFile5 = path.join(tmp, 'dead-clean.pid')
    fs.writeFileSync(sock5, 'stale-socket')
    fs.writeFileSync(pidFile5, `${priorPid}\n`, 'utf8')
    signaled.length = 0
    ;(process as any).kill = (pid: number, sig?: string | number) => {
      if (pid === priorPid && (sig === 0 || sig === undefined)) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      signaled.push([pid, sig])
      return true
    }
    const srvDeadClean = new SessionHostServer({
      appName: 'adhdev-r2-dead-clean',
      endpoint: { kind: 'unix', path: sock5 },
      storageRootDir: path.join(tmp, 's5'),
      getOwnerBirth: () => null,
      instanceConfigDir: configDir,
      pidFilePath: pidFile5,
      getSocketOwnerPids: () => [],
    } as any)
    await (srvDeadClean as any).evictPriorEndpointOwners()
    assert.equal(fs.existsSync(sock5), false)
    assert.deepEqual(signaled, [])

    // 6. Placeholder births ('win32'/'unknown') and post-parent-kill (liveCandidates.length === 0) provenance mismatches fail closed
    for (const placeholderBirth of ['win32', 'unknown']) {
      writeValidProvenanceAndLease()
      const rawProv = JSON.parse(fs.readFileSync(provFile, 'utf8'))
      rawProv.expectedBirth = placeholderBirth
      fs.writeFileSync(provFile, JSON.stringify(rawProv), { mode: 0o600 })
      assert.equal(
        readVerifiedReplacementProvenance({
          provenanceFilePath: provFile,
          instanceConfigDir: configDir,
          appName,
          endpointPath: sock4,
          leaseStateDir: leaseDir,
        }),
        undefined,
      )
    }

    const sock6 = path.join(tmp, 'post-parent-kill.sock')
    const pidFile6 = path.join(tmp, 'post-parent-kill.pid')
    fs.writeFileSync(sock6, 'swapped-socket-inode', { mode: 0o600 })
    const sock6ActualIno = fs.lstatSync(sock6, { bigint: true }).ino
    fs.writeFileSync(
      provFile,
      JSON.stringify({
        schema: 1,
        schemaVersion: 1,
        appName,
        instanceConfigDir: path.resolve(configDir),
        instanceConfigKey: instanceArgFor(configDir),
        endpointPath: sock6,
        expectedEndpointInode: (sock6ActualIno + 99999n).toString(),
        expectedPid: priorPid,
        expectedBirth: 'Sat Oct 24 06:00:00 2026',
        expectedBootId: 'boot-r2',
        expectedEpoch: 7,
        expectedOwner: 'owner-r2',
        expectedTokenHash: tokenHash,
        activeRuntimeCount: 0,
        issuedAtMs: Date.now(),
      }),
      { mode: 0o600 },
    )
    fs.writeFileSync(
      leaseFile,
      JSON.stringify({
        schema: 1,
        endpoint: sock6,
        epoch: 7,
        held: true,
        owner: 'owner-r2',
        tokenHash,
      }),
      { mode: 0o600 },
    )
    const srvPostParentKillMismatch = new SessionHostServer({
      appName,
      endpoint: { kind: 'unix', path: sock6 },
      storageRootDir: path.join(tmp, 's6'),
      instanceConfigDir: configDir,
      pidFilePath: pidFile6,
      isPidAlive: () => false,
      getSocketOwnerPids: () => [],
      replacementProvenance: () =>
        readVerifiedReplacementProvenance({
          provenanceFilePath: provFile,
          instanceConfigDir: configDir,
          appName,
          endpointPath: sock6,
          leaseStateDir: leaseDir,
        }),
    })
    await assert.rejects(
      () => (srvPostParentKillMismatch as any).evictPriorEndpointOwners(),
      /session_host_live_owner_replacement_unauthorized/,
    )
    assert.equal(fs.existsSync(sock6), true)
    removeSessionHostReplacementProvenance(appName, configDir)
  } finally {
    process.kill = realKill
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
