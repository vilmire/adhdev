import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostStorage } from '../src/storage.js';
import { observeRecoveryTombstones } from '../src/operator-recovery-control.js';
import { SessionHostServer } from '../src/server.js';
const nonce = 'a'.repeat(64); const fenceDigest = 'b'.repeat(64);
test('strict real storage census refuses malformed and unrecognized saved state that tolerant boot ignores', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-collector-storage-'));
  const storage = new SessionHostStorage({ rootDir: root });
  assert.equal(storage.recoveryInventory().complete, true);
  mkdirSync(join(root, 'runtimes'));
  writeFileSync(join(root, 'runtimes', 'broken.json'), '{');
  assert.equal(storage.loadAll().length, 0);
  assert.equal(storage.recoveryInventory().complete, false);
});
test('real collector and IPC cannot upgrade empty registry or restorePending=false to ABSENT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-collector-native-'));
  const host = new SessionHostServer({ storageRootDir: root, instanceConfigDir: root }) as any;
  host.restorePending = false;
  host.fullRestoreState = 'failed';
  const reply = await host.handleRequest({ type: 'attest_operator_recovery_v1', payload: { nonce, fenceDigest } });
  assert.equal(reply.success, true); assert.equal(reply.result.verdict, 'UNKNOWN');
  assert.equal(host.registry.listSessions().length, 0);
  assert.equal(host.mutatingRequests, 0);
});
test('retained hosts without private parent bootstrap refuse native owner enrollment and forged fence requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-collector-unenrolled-'));
  const host = new SessionHostServer({ storageRootDir: root });
  assert.equal((await host.handleRequest({ type: 'prepare_operator_recovery_fence_v1' })).success, false);
  assert.equal((await host.handleRequest({ type: 'install_operator_recovery_fence_v1', payload: { message: 'forged', signature: '0'.repeat(128) } })).success, false);
});

test('extracted lifecycle waiter preserves exit delivery and non-live failure result', async () => {
  const { RuntimeExitWaiters } = await import('../src/session-lifecycle.js');
  const waiters = new RuntimeExitWaiters();
  const pending = waiters.wait('fixture-runtime', 100, true, 'running');
  waiters.resolve('fixture-runtime', null);
  assert.equal(await pending, null);
  assert.equal(await waiters.wait('failed-fixture', 100, false, 'failed'), 1);
});

test('strict inventory includes both exact UUID tombstones and rejects mixed-case filename aliases and corrupt diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-tombstones-'));
  const storage = new SessionHostStorage({ rootDir: root });
  const ids = ['de321185-4ebc-40aa-8c6e-b4919e87fae3', '60806c79-7d77-4614-9fa6-e628533478ba'];
  const termination = { exitCode: null, signal: null, reason: 'unknown' as const, lifecycle: 'failed' as const, terminatedAt: 100 };
  for (const id of ids) storage.saveTombstone(id, termination);
  const inventory = storage.recoveryInventory();
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.tombstones.map(t => t.sessionId).sort(), [...ids].sort());
  writeFileSync(join(root, 'tombstones', ids[0]+'.json'), JSON.stringify({sessionId: ids[1], termination, updatedAt: 100}));
  assert.equal(storage.recoveryInventory().complete, false);
  storage.saveTombstone(ids[0], termination);
  writeFileSync(join(root, 'tombstones', ids[0].toUpperCase()+'.json'), JSON.stringify({sessionId: ids[0].toUpperCase(), termination, updatedAt: 100}));
  assert.equal(storage.recoveryInventory().complete, false);
});

test('missing runtimes cannot hide malformed, unknown, symlinked or hardlinked tombstones', async () => {
  const fs = await import('node:fs');
  for (const kind of ['corrupt','unknown','symlink-dir','symlink-file','hardlink','invalid-termination']) {
    const root = mkdtempSync(join(tmpdir(), 'recovery-tombstone-negative-'));
    const storage = new SessionHostStorage({ rootDir: root });
    const dir = join(root,'tombstones'); const id = 'de321185-4ebc-40aa-8c6e-b4919e87fae3';
    mkdirSync(dir);
    const payload = JSON.stringify({sessionId:id, termination:{exitCode:null,signal:null,reason:'unknown',lifecycle:'failed',terminatedAt:100},updatedAt:100});
    if (kind === 'symlink-dir') { fs.renameSync(dir,dir+'-real'); fs.symlinkSync(dir+'-real',dir); }
    else if (kind === 'symlink-file') { writeFileSync(join(root,'real'),payload); fs.symlinkSync(join(root,'real'),join(dir,id+'.json')); }
    else if (kind === 'hardlink') { writeFileSync(join(root,'real'),payload); fs.linkSync(join(root,'real'),join(dir,id+'.json')); }
    else writeFileSync(join(dir, kind === 'unknown' ? 'unknown.txt' : id+'.json'), kind === 'invalid-termination' ? JSON.stringify({sessionId:id,termination:{},updatedAt:100}) : '{');
    assert.equal(storage.recoveryInventory().complete, false, kind);
  }
});

test('both immutable UUID tombstones affect local safety, while known termination never upgrades the native collector', async () => {
  for (const id of ['de321185-4ebc-40aa-8c6e-b4919e87fae3','60806c79-7d77-4614-9fa6-e628533478ba']) {
    const root = mkdtempSync(join(tmpdir(),'recovery-tombstone-safety-'));
    const storage = new SessionHostStorage({ rootDir: root });
    storage.saveTombstone(id,{exitCode:null,signal:null,reason:'unknown',lifecycle:'failed',terminatedAt:100});
    const tombstones = storage.recoveryInventory().tombstones;
    assert.equal(observeRecoveryTombstones(tombstones,new Map()),'unknown');
    assert.equal(observeRecoveryTombstones(tombstones,new Map([[id,{}]])),'live');
    storage.saveTombstone(id,{exitCode:0,signal:null,reason:'exit',lifecycle:'stopped',terminatedAt:100});
    assert.equal(observeRecoveryTombstones(storage.recoveryInventory().tombstones,new Map()),'absent');
    const host = new SessionHostServer({ storageRootDir: root, instanceConfigDir: root }) as any;
    host.restorePending=false; host.fullRestoreState='ready'; host.partialRestoreCount=0;
    assert.equal(host.collectRecoveryCensus(nonce,fenceDigest).verdict,'UNKNOWN');
    writeFileSync(join(root,'tombstones',id+'.json'),'{');
    host.upgradeLease={proof(){throw Error('native proof must not be reached');}};
    assert.throws(() => host.recoveryControl.installOperatorRecoveryFence({},{}),/full_restore_required/);
  }
});

// Synthetic binding only: no socket, native guardian or process is contacted.
import crypto from 'node:crypto';
import { mock } from 'node:test';
import { OPERATOR_RECOVERY_TARGET as target, SessionHostRegistry } from '@adhdev/session-host-core';
function savedRuntime(id = 'fixture'): import('../src/storage.js').PersistedRuntimeState {
  const registry = new SessionHostRegistry();
  const record = registry.createSession({ sessionId: id, category: 'cli', providerType: 'fixture',
    workspace: '/fixture', launchCommand: { command: 'never-executed', args: [] } });
  record.lifecycle = 'stopped';
  return { record, snapshot: { seq: 0, text: '', truncated: false }, updatedAt: 100 };
}
function collectorFixture(root: string) {
  const host = new SessionHostServer({ storageRootDir: root, instanceConfigDir: root }) as any;
  host.restorePending = false; host.fullRestoreState = 'ready'; host.partialRestoreCount = 0;
  host.workerDaemonId = target.workerDaemonId;
  host.endpoint = { path: `/fixture/adhdev-preview-session-host-${target.namespace}.sock` };
  host.upgradeLease = { assertHealthy() {}, recoveryCoverage() { return { verdict: 'UNKNOWN' }; },
    proof() { return { bootId: 'synthetic-host' }; } };
  host.recoveryFence.witness = () => ({ digest: fenceDigest });
  // Bind only the disposable config path to the pinned namespace. All other
  // hashing stays real; this is a collector test, never native acceptance.
  const createHash = crypto.createHash;
  const binding = mock.method(crypto, 'createHash', (...args: Parameters<typeof createHash>) => {
    const hash = createHash(...args);
    const update = hash.update.bind(hash);
    hash.update = ((data: any, ...rest: any[]) => {
      if (data === root || data === fs.realpathSync(root)) hash.digest = (() => target.namespace) as any;
      return (update as any)(data, ...rest);
    }) as any;
    return hash;
  });
  return { host, binding };
}
const corruptRuntime: Record<string, (s: any) => void> = {
  'reported counterexample': s => { s.record.launchCommand = { args: [] }; s.record.meta = true; s.snapshot = true; },
  'missing command': s => { delete s.record.launchCommand.command; },
  'empty command': s => { s.record.launchCommand.command = ''; },
  'non-string argument': s => { s.record.launchCommand.args = [1]; },
  'invalid environment': s => { s.record.launchCommand.env = { BAD: false }; },
  'unknown environment mode': s => { s.record.launchCommand.envMode = 'inherited'; },
  'boolean metadata': s => { s.record.meta = true; },
  'array metadata': s => { s.record.meta = []; },
  'boolean snapshot': s => { s.snapshot = true; },
  'invalid snapshot seq': s => { s.snapshot.seq = '0'; },
  'invalid snapshot text': s => { s.snapshot.text = 1; },
  'invalid snapshot truncated': s => { s.snapshot.truncated = 1; },
  'invalid lifecycle': s => { s.record.lifecycle = 'gone'; },
  'missing runtime key': s => { delete s.record.runtimeKey; },
  'invalid workspace': s => { s.record.workspace = null; },
  'invalid provider': s => { s.record.providerType = 1; },
  'invalid timestamp': s => { s.record.createdAt = '100'; },
  'invalid attached clients': s => { s.record.attachedClients = [true]; },
  'invalid owner': s => { s.record.writeOwner = {}; },
  'invalid buffer': s => { s.record.buffer.snapshotSeq = false; },
  'invalid input provenance': s => { s.record.inputSeq = -1; },
  'invalid termination': s => { s.record.termination = { exitCode: 0 }; },
  'contradictory termination': s => { s.record.termination = { exitCode: null, signal: null, reason: 'exit', lifecycle: 'stopped', terminatedAt: 100 }; },
  'unknown schema': s => { s.version = 99; },
};
for (const [name, corrupt] of Object.entries(corruptRuntime)) {
  for (const id of ['fixture', target.sessionId, target.providerSessionId]) {
  test(`malformed runtime refuses real inventory, collector and install: ${name} (${id})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-runtime-negative-'));
    const storage = new SessionHostStorage({ rootDir: root });
    mkdirSync(join(root, 'runtimes'));
    // Identity alone is insufficient, including either immutable UUID.
    {
      const state = savedRuntime(id); corrupt(state);
      writeFileSync(join(root, 'runtimes', id+'.json'), JSON.stringify(state));
      assert.equal(storage.loadAll().length > 0, true, 'ordinary tolerant reader unchanged');
      const { host, binding } = collectorFixture(root);
      try {
        assert.equal(host.collectRecoveryCensus(nonce, fenceDigest).reason, 'restore_or_launch_closure_unproved');
        host.upgradeLease.proof = () => { throw Error('native proof reached'); };
        assert.throws(() => host.recoveryControl.installOperatorRecoveryFence({}, {}), /full_restore_required/);
        assert.equal(storage.recoveryInventory().complete, false);
      } finally { binding.mock.restore(); }
    }
  });
  }
}
test('validated current and known legacy runtimes preserve dual UUID aliases, live and unknown semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-runtime-valid-'));
  const storage = new SessionHostStorage({ rootDir: root });
  const { host, binding } = collectorFixture(root);
  try {
    for (const id of [target.sessionId, target.providerSessionId, 'metadata-alias', 'argv-alias']) {
      for (const legacy of [false, true]) {
        const state = savedRuntime(id);
        if (id === 'metadata-alias') state.record.meta.providerSessionId = target.providerSessionId;
        if (id === 'argv-alias') state.record.launchCommand.args = ['resume', target.sessionId];
        state.snapshot.cols = 80; state.snapshot.rows = 24;
        state.record.writeOwner = { clientId: 'fixture', ownerType: 'agent', acquiredAt: 100 };
        state.record.attachedClients = [{ clientId: 'fixture', type: 'daemon', readOnly: false, attachedAt: 100, lastSeenAt: 100 }];
        if (legacy) { delete state.record.inputSeq; delete state.record.inputEpoch; }
        state.record.launchCommand.env = { FIXTURE: 'value' }; // legacy unmarked full env remains supported
        if (!legacy) state.record.launchCommand.envMode = 'launch_overrides';
        storage.save(state.record, state.snapshot);
        assert.equal(storage.recoveryInventory().complete, true);
        assert.equal(host.collectRecoveryCensus(nonce, fenceDigest).reason, 'native_guardian_coverage_missing');
        state.record.lifecycle = 'running'; storage.save(state.record, state.snapshot);
        assert.equal(host.collectRecoveryCensus(nonce, fenceDigest).verdict, 'LIVE');
        state.record.lifecycle = 'stopped'; storage.save(state.record, state.snapshot);
        host.runtimes.set(id, {});
        assert.equal(host.collectRecoveryCensus(nonce, fenceDigest).verdict, 'LIVE');
        host.runtimes.delete(id);
      }
      storage.remove(id);
      if (id === 'metadata-alias' || id === 'argv-alias') continue;
      storage.saveTombstone(id, { exitCode: null, signal: null, reason: 'unknown', lifecycle: 'failed', terminatedAt: 100 });
      assert.equal(host.collectRecoveryCensus(nonce, fenceDigest).reason, 'runtime_census_unproved');
      storage.saveTombstone(id, { exitCode: 0, signal: null, reason: 'exit', lifecycle: 'stopped', terminatedAt: 100 });
      assert.equal(host.collectRecoveryCensus(nonce, fenceDigest).reason, 'native_guardian_coverage_missing');
      storage.removeTombstone(id);
    }
  } finally { binding.mock.restore(); }
});
