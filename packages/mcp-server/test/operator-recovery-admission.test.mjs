import test from 'node:test';
import assert from 'node:assert/strict';
// Keep this fixture on the actual built tool dispatcher through the existing
// tsx runner. It never opens IPC, HTTP, a mesh endpoint, or a runtime store.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'operator-recovery-mcp-'));
process.env.HOME = join(root, 'home'); mkdirSync(process.env.HOME);
process.env.ADHDEV_CONFIG_DIR = join(root, 'config'); mkdirSync(process.env.ADHDEV_CONFIG_DIR);
const { resolveMeshToolHandler } = await import('../src/tools/mesh-tool-dispatch.ts');
test('ordinary worker/coordinator MCP cannot enroll or execute operator recovery', async () => {
  const handler = resolveMeshToolHandler('operator_recovery');
  assert.equal(typeof handler, 'function');
  const ctx = { transport: { command() { throw Error('MCP attempted owner delegation'); } } };
  for (const action of ['enroll', 'fence', 'execute']) {
    const r = JSON.parse(await handler(ctx, { action, ownerVerified: true }));
    assert.equal(r.success, false);
    assert.equal(r.code, 'recovery_nondelegated_local_owner_required');
  }
});
