import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHostRegistry } from '../src/registry.js';

function setup() {
  const registry = new SessionHostRegistry();
  const record = registry.createSession({ sessionId: 'retained', providerType: 'test', category: 'cli', workspace: '/fixture',
    launchCommand: { command: 'fixture', args: [] }, clientId: 'original', clientType: 'daemon' });
  registry.restoreSession({ ...record, startedAt: 123, lifecycle: 'running' });
  registry.acquireWrite({ sessionId: 'retained', clientId: 'original', ownerType: 'agent', force: false });
  return registry;
}

for (const field of ['sessionId', 'runtimeKey', 'startedAt'] as const) {
  test(`guarded attach refuses changed ${field} without evicting the replacement writer`, () => {
    const registry = setup();
    const original = registry.getSession('retained')!;
    const expectedIncarnation = { sessionId: original.sessionId, runtimeKey: original.runtimeKey, startedAt: original.startedAt! };
    if (field !== 'sessionId') registry.restoreSession({ ...original, [field]: field === 'startedAt' ? 456 : 'replacement' });
    else expectedIncarnation.sessionId = 'other';
    const before = registry.getSession('retained');
    assert.throws(() => registry.attachClientIfIncarnation({ sessionId: 'retained', clientId: 'new-daemon', clientType: 'daemon', expectedIncarnation }), /incarnation changed/);
    assert.deepEqual(registry.getSession('retained'), before);
  });
}

test('guarded attach accepts the exact original and ordinary attach callers remain compatible', () => {
  const registry = setup(); const original = registry.getSession('retained')!;
  const result = registry.attachClientIfIncarnation({ sessionId: 'retained', clientId: 'original', clientType: 'daemon',
    expectedIncarnation: { sessionId: original.sessionId, runtimeKey: original.runtimeKey, startedAt: original.startedAt! } });
  assert.equal(result.writeOwner?.clientId, 'original');
  assert.equal(result.attachedClients.length, 1);
  assert.ok(registry.attachClient({ sessionId: 'retained', clientId: 'viewer', clientType: 'local-terminal', readOnly: true }).attachedClients.some(c => c.clientId === 'viewer'));
});

test('malformed/missing expected incarnation fails closed', () => {
  const registry = setup(); const before = registry.getSession('retained');
  for (const expectedIncarnation of [undefined, {}, { sessionId: 'retained', runtimeKey: before!.runtimeKey, startedAt: NaN }]) {
    assert.throws(() => registry.attachClientIfIncarnation({ sessionId: 'retained', clientId: 'new-daemon', clientType: 'daemon', expectedIncarnation } as any), /incarnation changed/);
    assert.deepEqual(registry.getSession('retained'), before);
  }
});
