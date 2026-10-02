import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalTransport } from '../src/transports/local.js';
import { normalizeCommandEnvelope } from '../../daemon-standalone/src/standalone-command-envelope.js';

// The local (standalone) transport spread args into the body; the standalone
// envelope then dropped reserved top-level keys — `id` among them — so
// mission_upsert never saw the mission id and "close this mission" created a new
// mission each time (2026-10-02 demo mesh).
test('local transport args survive the standalone envelope, including reserved keys', async () => {
  let sentBody: any = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  try {
    const t = new LocalTransport({ port: 3847 } as any);
    await t.command('mission_upsert', { v: 1, meshId: 'm1', id: 'mission-1', title: 'T', status: 'completed', command: 'x', args: { a: 1 } });
  } finally {
    globalThis.fetch = realFetch;
  }
  const { type, payload } = normalizeCommandEnvelope(sentBody);
  assert.equal(type, 'mission_upsert');
  assert.equal(payload.id, 'mission-1');
  assert.equal(payload.command, 'x');
  assert.deepEqual(payload.args, { a: 1 });
  assert.equal(payload.status, 'completed');
});
