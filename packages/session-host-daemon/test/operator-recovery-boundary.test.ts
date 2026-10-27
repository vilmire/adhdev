import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostServer } from '../src/server.js';
import { PtySessionRuntime } from '../src/runtime.js';

// Regression: current code ignores this final launch fence. No native spawn.
test('final spawn boundary refuses an installed recovery fence before constructing a writer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-boundary-'));
  const host = new SessionHostServer({ storageRootDir: dir }) as any;
  host.recoveryFence = { enterLaunch() { throw new Error('operator_recovery_fenced'); } };
  const payload = { sessionId: 'test-session', category: 'cli', providerType: 'test-cli', workspace: dir,
    launchCommand: { command: 'never-executed', args: [] }, meta: {} };
  const record = host.registry.createSession(payload);
  const previous = PtySessionRuntime.prototype.start;
  let spawns = 0;
  PtySessionRuntime.prototype.start = () => { spawns++; return 999; };
  try {
    assert.throws(() => host.startRuntime(record, payload, 'session_started'), /operator_recovery_fenced/);
    assert.equal(spawns, 0);
  } finally { PtySessionRuntime.prototype.start = previous; }
});

test('target create and metadata aliases are rejected before registry mutation', async () => {
  const { OPERATOR_RECOVERY_TARGET: t } = await import('@adhdev/session-host-core');
  const host = new SessionHostServer({ storageRootDir: mkdtempSync(join(tmpdir(), 'recovery-precheck-')) });
  const payload = { sessionId: t.sessionId.toUpperCase(), category: 'cli' as const, providerType: 'fake',
    workspace: '/fixture', launchCommand: { command: 'never', args: [] }, meta: {} };
  const result = await host.handleRequest({ type: 'create_session', payload });
  assert.equal(result.success, false); assert.match(result.error!, /recovery_fenced/);
  assert.equal(host.registry.listSessions().length, 0);
  const record = host.registry.createSession({ ...payload, sessionId: 'unrelated' });
  const update = await host.handleRequest({ type: 'update_session_meta', payload: {
    sessionId: record.sessionId, meta: { providerSessionId: t.providerSessionId.toUpperCase() } } });
  assert.equal(update.success, false); assert.equal(host.registry.getSession(record.sessionId)?.meta.providerSessionId, undefined);
});

test('restart reserves launch admission across asynchronous runtime exit', async () => {
  const host = new SessionHostServer({ storageRootDir: mkdtempSync(join(tmpdir(), 'recovery-restart-')) }) as any;
  const record = host.registry.createSession({ sessionId: 'unrelated', category: 'cli', providerType: 'fake',
    workspace: '/fixture', launchCommand: { command: 'never', args: [] }, meta: {} });
  let inFlight = 0; let release!: () => void;
  host.recoveryFence = { enterLaunch() { inFlight++; return () => { inFlight--; }; } };
  host.runtimes.set(record.sessionId, { stop() {} });
  host.waitForRuntimeExit = () => new Promise<void>(resolve => { release = resolve; });
  host.startRuntime = () => record;
  const restart = host.restartRuntime(record.sessionId);
  assert.equal(inFlight, 1); release(); await restart; assert.equal(inFlight, 0);
});
