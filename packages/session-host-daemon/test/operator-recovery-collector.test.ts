import test from 'node:test';
import assert from 'node:assert/strict';
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
