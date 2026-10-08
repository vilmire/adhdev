import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { WORKER_MCP_DAEMON_VERBS } from '@adhdev/daemon-core';

import { parseArgs } from '../src/cli-args.js';
import { LocalDaemonAuthError, LocalTransport } from '../src/transports/local.js';

// A standalone daemon started with --token / a password answered 401 to the MCP
// servers it launched itself (2026-10-08 two-machine test: the worker's MCP said
// "Cannot reach local daemon" and exited). LocalTransport now presents a narrow
// loopback credential: the coordinator-scope token file (re-read per request) or
// the worker's own session bind.

type Seen = { url: string; headers: Record<string, string> };

async function withFetch<T>(status: number, fn: (seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    return new Response(JSON.stringify(status === 200 ? { success: true } : { error: 'Unauthorized' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('coordinator scope: sends the token from the auth file and re-reads it after a daemon restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adhdev-mcp-auth-')), 'standalone-mcp-auth-3847');
  writeFileSync(file, 'adi_boot_one\n');
  await withFetch(200, async (seen) => {
    const t = new LocalTransport({ port: 3847, authFile: file });
    await t.getStatus();
    writeFileSync(file, 'adi_boot_two');
    await t.command('mesh_status', {});
    assert.equal(seen[0].headers['x-adhdev-internal-auth'], 'adi_boot_one');
    assert.equal(seen[1].headers['x-adhdev-internal-auth'], 'adi_boot_two');
    assert.equal(seen[0].headers['x-adhdev-worker-credential'], undefined);
    assert.equal(seen[0].headers['Authorization'], undefined);
  });
});

test('coordinator scope: a missing auth file sends no internal header (unauthenticated daemon)', async () => {
  await withFetch(200, async (seen) => {
    const t = new LocalTransport({ port: 3847, authFile: join(tmpdir(), 'adhdev-mcp-auth-missing', 'nope') });
    await t.getStatus();
    assert.equal(seen[0].headers['x-adhdev-internal-auth'], undefined);
  });
});

test('worker scope: sends the session bind on status and commands', async () => {
  await withFetch(200, async (seen) => {
    const t = new LocalTransport({ port: 3847, workerCredential: 'wsb_bind' });
    assert.equal(await t.ping(), true);
    await t.command('worker_progress_update', { bind: 'wsb_bind', note: 'n' });
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.equal(s.headers['x-adhdev-worker-credential'], 'wsb_bind');
      assert.equal(s.headers['x-adhdev-internal-auth'], undefined);
    }
  });
});

test('a 401 is reported as an authentication failure, not as unreachable', async () => {
  await withFetch(401, async () => {
    const t = new LocalTransport({ port: 3847, workerCredential: 'wsb_bind' });
    await assert.rejects(t.getStatus(), LocalDaemonAuthError);
    assert.equal(await t.ping(), false);
    assert.equal(t.lastPingFailure?.kind, 'auth');
    assert.match(t.lastPingFailure!.message, /authentication to the local daemon failed/);
    await assert.rejects(t.command('worker_drain_mailbox', {}), /401 \(authentication to the local daemon failed\)/);
  });
});

test('a refused connection is reported as unreachable', async () => {
  const t = new LocalTransport({ port: 1 });
  assert.equal(await t.ping(), false);
  assert.equal(t.lastPingFailure?.kind, 'unreachable');
});

test('cli args: --daemon-auth-file / ADHDEV_DAEMON_AUTH_FILE for coordinator and assistant, dropped in worker mode', () => {
  const argv = (...rest: string[]) => ['node', 'adhdev-mcp', ...rest];
  assert.equal(parseArgs(argv('--mode', 'local', '--repo-mesh', 'm1', '--daemon-auth-file', '/f'), {}).daemonAuthFile, '/f');
  assert.equal(parseArgs(argv('--mode', 'local', '--assistant', '--daemon-auth-file=/g'), {}).daemonAuthFile, '/g');
  assert.equal(parseArgs(argv('--mode', 'local'), { ADHDEV_DAEMON_AUTH_FILE: '/h' }).daemonAuthFile, '/h');
  assert.equal(parseArgs(argv('--mode', 'local', '--worker', '--daemon-auth-file', '/f'), {}).daemonAuthFile, undefined);
  assert.equal(parseArgs(argv('--mode', 'local', '--worker'), { ADHDEV_DAEMON_AUTH_FILE: '/h' }).daemonAuthFile, undefined);
});

// The standalone worker-scope gate admits exactly WORKER_MCP_DAEMON_VERBS. A
// worker tool that starts sending a new verb must add it there, or the worker
// breaks on every gated daemon — this keeps the list in step with the sources.
test('every daemon verb the worker toolset sends is admitted by the worker-scope gate', () => {
  const sources = [
    'src/tools/worker-tools.ts',
    'src/tools/worker-report-outbox.ts',
    'src/tools/git-status.ts',
    'src/tools/git-log.ts',
    'src/tools/git-diff.ts',
  ];
  const verbs = new Set<string>();
  for (const rel of sources) {
    const text = readFileSync(resolve(__dirname, '..', rel), 'utf8');
    for (const m of text.matchAll(/transport\.command\(\s*'([a-z_]+)'/g)) verbs.add(m[1]);
    for (const m of text.matchAll(/^\s+(?:report|progress): '([a-z_]+)',$/gm)) verbs.add(m[1]);
  }
  assert.ok(verbs.size >= 8, `expected to find the worker verbs, found ${[...verbs].join(', ')}`);
  assert.deepEqual([...verbs].filter((v) => !WORKER_MCP_DAEMON_VERBS.includes(v)), []);
  assert.deepEqual(WORKER_MCP_DAEMON_VERBS.filter((v) => !verbs.has(v)), []);
});
