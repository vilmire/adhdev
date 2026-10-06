/**
 * POST /api/v1/mesh/join — the member → host pairing endpoint
 * (docs/design/2026-10-07-standalone-multi-machine-mesh.md §4.4 step 2).
 *
 * It is the ONE /api route exempt from the dashboard token / password gate:
 * the pairing token in the body is the credential (apply_mesh_host_join
 * verifies it). The exemption must stay narrow — exact path, POST only,
 * bounded JSON body, 5 attempts per minute per remote IP — and the handler
 * must receive only the join fields through the same command path
 * /api/v1/command uses. These tests drive a real HTTP server over a real
 * StandaloneHttpApi.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// standalone-auth resolves the password config path through daemon-core —
// pin a tmp config dir BEFORE loading it, never the developer's live one.
process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-mesh-join-'));

let mod: typeof import('../src/standalone-http.js');

beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
});

const TOKEN = 'dashboard-token';
const JOIN = '/api/v1/mesh/join';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

interface Call { type: string; payload: Record<string, unknown> }

async function startServer(opts: {
  token?: string | null;
  result?: (call: Call) => unknown;
  clock?: { now: number };
} = {}): Promise<{ base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const http = new mod.StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({ ok: true }) as any,
    executeCommand: async (type, payload) => {
      const call = { type, payload };
      calls.push(call);
      return opts.result ? opts.result(call) : { success: true, code: 'mesh_host_join_accepted', peerSecret: 'S' };
    },
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
    ...(opts.clock ? { now: () => opts.clock!.now } : {}),
  });
  http.configureAuth(opts.token === undefined ? TOKEN : opts.token);
  const server = createServer((req, res) => http.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, calls };
}

const validBody = {
  meshId: 'mesh_host',
  token: 'mhj_pairing',
  memberMeshId: 'mesh_member',
  memberNode: { workspace: '/member/repo', daemonId: 'mach_member' },
};

async function postJoin(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${JOIN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/v1/mesh/join', () => {
  it('pins the path daemon-core members POST to', () => {
    expect(mod.MESH_JOIN_PATH).toBe('/api/v1/mesh/join');
    expect(mod.MESH_JOIN_RATE_LIMIT).toBe(5);
    expect(mod.MESH_JOIN_MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it('is reachable without the dashboard token while other /api routes still answer 401', async () => {
    const { base, calls } = await startServer();

    const status = await fetch(`${base}/api/v1/status`);
    expect(status.status).toBe(401);
    const command = await fetch(`${base}/api/v1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'apply_mesh_host_join', payload: validBody }),
    });
    expect(command.status).toBe(401);
    // GET on the join path is NOT exempt.
    const getJoin = await fetch(`${base}${JOIN}`);
    expect(getJoin.status).toBe(401);
    // A sibling path is NOT exempt either.
    const sibling = await fetch(`${base}${JOIN}/x`, { method: 'POST', body: '{}' });
    expect(sibling.status).toBe(401);
    expect(calls).toEqual([]);

    const joined = await postJoin(base, validBody);
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ success: true, code: 'mesh_host_join_accepted', peerSecret: 'S' });
    expect(calls).toEqual([{ type: 'apply_mesh_host_join', payload: validBody }]);
  });

  it('forwards only the join fields — extra keys never reach the handler', async () => {
    const { base, calls } = await startServer();
    const res = await postJoin(base, { ...validBody, inlineMesh: { id: 'evil' }, type: 'delete_mesh', payload: { x: 1 } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('apply_mesh_host_join');
    expect(Object.keys(calls[0].payload).sort()).toEqual(['memberMeshId', 'memberNode', 'meshId', 'token']);
  });

  it('returns the handler rejection as 403 / other handler failures as 400', async () => {
    const rejected = await startServer({ result: () => ({ success: false, code: 'mesh_host_join_rejected', error: 'invalid pairing token' }) });
    const res = await postJoin(rejected.base, validBody);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false, code: 'mesh_host_join_rejected' });

    const missing = await startServer({ result: () => ({ success: false, error: 'Mesh not found' }) });
    const res2 = await postJoin(missing.base, validBody);
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ success: false, error: 'Mesh not found' });
  });

  it('rejects non-JSON and incomplete bodies with 400 without calling the handler', async () => {
    const { base, calls } = await startServer();
    expect((await postJoin(base, 'not json{')).status).toBe(400);
    expect((await postJoin(base, '[1,2]')).status).toBe(400);
    expect((await postJoin(base, { meshId: 'm', token: 't' })).status).toBe(400);
    expect((await postJoin(base, { meshId: 'm', memberNode: {} })).status).toBe(400);
    expect((await postJoin(base, { ...validBody, memberNode: ['x'] })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects an oversized body with 413 (declared length and streamed)', async () => {
    const { base, calls } = await startServer({ token: null });
    const big = JSON.stringify({ ...validBody, pad: 'x'.repeat(70 * 1024) });
    const declared = await postJoin(base, big);
    expect(declared.status).toBe(413);

    // Chunked (no Content-Length): the bound is enforced while reading.
    const streamedStatus = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}${JOIN}`);
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      for (let i = 0; i < 10; i += 1) req.write('x'.repeat(8 * 1024));
      req.end();
    });
    expect(streamedStatus).toBe(413);
    expect(calls).toEqual([]);
  });

  it('allows 5 attempts per minute per remote IP, answers 429 to the 6th, and recovers after the window', async () => {
    const clock = { now: 1_000_000 };
    const { base, calls } = await startServer({ clock });
    for (let i = 0; i < 5; i += 1) {
      const res = await postJoin(base, validBody);
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const sixth = await postJoin(base, validBody);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await sixth.json()).toMatchObject({ success: false, code: 'mesh_join_rate_limited' });
    expect(calls).toHaveLength(5);

    // Malformed attempts count too (a guesser cannot bypass by sending junk).
    clock.now += 60_001;
    for (let i = 0; i < 5; i += 1) expect((await postJoin(base, 'junk')).status).toBe(400);
    expect((await postJoin(base, validBody)).status).toBe(429);

    clock.now += 60_001;
    expect((await postJoin(base, validBody)).status).toBe(200);
  });

  it('a browser request from a foreign Origin is refused before the route', async () => {
    const { base, calls } = await startServer({ token: null });
    const res = await postJoin(base, validBody, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('MeshJoinRateLimiter', () => {
  it('keys attempts per address independently', () => {
    const limiter = new mod.MeshJoinRateLimiter(2, 1000);
    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 1).allowed).toBe(true);
    expect(limiter.hit('a', 2)).toMatchObject({ allowed: false, retryAfterMs: 998 });
    expect(limiter.hit('b', 2).allowed).toBe(true);
    expect(limiter.hit('a', 1001).allowed).toBe(true);
  });
});
