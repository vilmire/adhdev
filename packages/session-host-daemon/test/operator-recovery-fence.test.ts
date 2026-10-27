import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OPERATOR_RECOVERY_TARGET as target, RecoveryOwnerAdmission } from '@adhdev/session-host-core';
import { OperatorRecoveryFence } from '../src/operator-recovery-fence.js';
import { evaluateRecoveryCensus, readLegacyGuardianCoverage, type RecoveryCensusSnapshot } from '../src/operator-recovery-census.js';
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'operator-recovery-fence-'));
  const keys = generateKeyPairSync('ed25519');
  const owner = new RecoveryOwnerAdmission({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    enrollmentId: 'fixture-private-owner', coordinatorBootId: 'fixture-coordinator-boot', authEpoch: '1', verifyCurrent: () => true });
  const grant = () => { const c = owner.challenge(); return owner.authorize(c.message, sign(null, Buffer.from(c.message), keys.privateKey).toString('hex')); };
  const binding = { namespace: target.namespace, workerDaemonId: target.workerDaemonId, hostBootId: 'fixture-host-boot',
    endpoint: `/fixture/adhdev-preview-session-host-${target.namespace}.sock` };
  return { root, owner, grant, binding, fence: new OperatorRecoveryFence(root) };
}
const launch = (sessionId: string, providerSessionId?: string) => ({ sessionId, category: 'cli' as const, providerType: 'fake-cli',
  workspace: '/fixture', launchCommand: { command: 'never-executed', args: [] as string[] }, meta: providerSessionId ? { providerSessionId } : {} });

test('permanent fence rejects original session, aliased provider, and saved resume argv before and after journal loss', () => {
  const f = fixture();
  const inputs = [launch(target.sessionId), launch('fresh-runtime', target.providerSessionId),
    { ...launch('other'), launchCommand: { command: 'never', args: ['resume', target.providerSessionId] } }];
  for (const p of inputs) assert.throws(() => f.fence.assertLaunchAllowed(p), /recovery_fenced/);
  f.fence.assertLaunchAllowed(launch('unrelated-runtime', 'unrelated-provider'));
  const digest = f.fence.install(f.owner, f.grant(), f.binding, () => {}, () => false);
  assert.equal(f.fence.witness().digest, digest);
  const restarted = new OperatorRecoveryFence(f.root);
  assert.throws(() => restarted.witness(), /rollback/);
  assert.equal(restarted.witness(digest).digest, digest);
  fs.unlinkSync(join(f.root, 'operator-recovery-v1.json'));
  for (const p of inputs) assert.throws(() => new OperatorRecoveryFence(f.root).assertLaunchAllowed(p), /recovery_fenced/);
  assert.throws(() => f.fence.witness());
});
for (const mode of ['inflight', 'live', 'native-exclusion', 'wrong-namespace', 'wrong-boot-binding', 'forged-grant']) {
  test(`fence installation refuses ${mode}`, () => {
    const f = fixture();
    let leave: (() => void) | undefined;
    if (mode === 'inflight') leave = f.fence.enterLaunch(launch('unrelated'));
    const binding = { ...f.binding, ...(mode === 'wrong-namespace' ? { namespace: '' } : {}),
      ...(mode === 'wrong-boot-binding' ? { hostBootId: '' } : {}) };
    assert.throws(() => f.fence.install(f.owner, mode === 'forged-grant' ? {} : f.grant(), binding,
      () => { if (mode === 'native-exclusion') throw Error('not excluded'); }, () => mode === 'live'));
    assert.equal(fs.existsSync(join(f.root, 'operator-recovery-v1.json')), false);
    leave?.();
  });
}
test('fence persists once, rejects duplicate install and refuses corrupt or rolled back witnesses', () => {
  const f = fixture();
  const digest = f.fence.install(f.owner, f.grant(), f.binding, () => {}, () => false);
  assert.throws(() => f.fence.install(f.owner, f.grant(), f.binding, () => {}, () => false));
  assert.throws(() => f.fence.witness(digest)); // Failed persistence poisons this incarnation.
  const fresh = new OperatorRecoveryFence(f.root);
  assert.equal(fresh.witness(digest).digest, digest);
  fs.writeFileSync(join(f.root, 'operator-recovery-v1.json'), '{}');
  assert.throws(() => fresh.witness(digest));
});

test('guardian/1 lock never supplies historical physical coverage; unverified namespace stays UNKNOWN', () => {
  const f = fixture();
  const snapshot: RecoveryCensusSnapshot = { binding: f.binding, instanceConfigDir: f.root, nonce: 'a'.repeat(64), fenceDigest: 'b'.repeat(64),
    restoreState: 'ready', fullRestoreState: 'ready', partialRestoreCount: 0, storageCensus: 'complete',
    targetRuntime: 'absent', inFlightLaunches: 0, guardian: readLegacyGuardianCoverage() };
  const proof = evaluateRecoveryCensus(snapshot);
  assert.equal(proof.verdict, 'UNKNOWN');
  assert.equal(proof.reason, 'native_instance_binding_unproved');
  assert.equal(proof.providerSessionId, target.providerSessionId);
  assert.equal(readLegacyGuardianCoverage(), null);
});

test('read-only native coverage request fails closed without guardian and never starts a provider', async () => {
  const { SessionHostServer } = await import('../src/server.js');
  const f = fixture();
  const host = new SessionHostServer({ storageRootDir: f.root });
  const before = fs.readdirSync(f.root);
  const reply = await host.handleRequest({ type: 'get_operator_recovery_coverage_v1', payload: { nonce: 'c'.repeat(64) } });
  assert.deepEqual(reply.result, { protocol: 1, verdict: 'UNKNOWN', reason: 'native_guardian_coverage_missing', nonce: 'c'.repeat(64) });
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.equal(host.registry.listSessions().length, 0);
  assert.equal((await host.handleRequest({ type: 'get_operator_recovery_coverage_v1', payload: { nonce: '' } })).success, false);
});
