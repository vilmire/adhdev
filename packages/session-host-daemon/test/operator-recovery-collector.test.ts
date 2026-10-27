import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostStorage } from '../src/storage.js';
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
