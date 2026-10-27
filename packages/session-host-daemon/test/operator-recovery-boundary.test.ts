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
  host.recoveryFence = { assertLaunchAllowed() { throw new Error('operator_recovery_fenced'); } };
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
