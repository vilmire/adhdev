/**
 * `/ws/seqscribe` — the standalone transcript replica lane's upgrade gate
 * (wiring-unification G6 prerequisite).
 *
 * The lane must be exactly as protected as `/ws`: same Origin allow-list, same
 * `--token` / password-cookie check, evaluated BEFORE the upgrade completes.
 * These tests stand up a real HTTP server + `ws` server wired the way
 * `index.ts` wires it (`routeStandaloneUpgrade` over a real
 * `StandaloneHttpApi` gate) and dial it with a real `ws` client.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

// standalone-auth resolves the config dir (password config path) through
// daemon-core — pin a tmp dir BEFORE loading it, never the developer's live one.
process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-seqscribe-upgrade-'));

let StandaloneHttpApi: typeof import('../src/standalone-http.js').StandaloneHttpApi;
let upgrade: typeof import('../src/standalone-seqscribe-upgrade.js');

beforeAll(async () => {
  ({ StandaloneHttpApi } = await import('../src/standalone-http.js'));
  upgrade = await import('../src/standalone-seqscribe-upgrade.js');
});

/** daemon-core `STANDALONE_SEQSCRIBE_WS_PATH` — known-answer pinned (the browser dials this literal). */
const SEQSCRIBE_PATH = '/ws/seqscribe';
const TOKEN = 'lane-test-token';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

interface Harness {
  base: string;
  accepted: string[];
  dashboard: number;
}

async function startServer(opts: { token: string | null; laneAvailable?: boolean }): Promise<Harness> {
  const http = new StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({}) as any,
    executeCommand: async () => ({}),
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
  });
  http.configureAuth(opts.token);
  const wss = new WebSocketServer({ noServer: true });
  const harness: Harness = { base: '', accepted: [], dashboard: 0 };
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const route = upgrade.routeStandaloneUpgrade(req, http, {
      seqscribePath: SEQSCRIBE_PATH,
      seqscribeLaneAvailable: opts.laneAvailable ?? true,
    });
    switch (route.kind) {
      case 'dashboard':
        wss.handleUpgrade(req, socket, head, () => { harness.dashboard += 1; });
        return;
      case 'seqscribe':
        // Stand-in for StandaloneTranscriptLane.accept — records the lane.
        wss.handleUpgrade(req, socket, head, (ws) => {
          harness.accepted.push(req.url || '');
          ws.on('message', (m) => ws.send(`echo:${m.toString()}`));
        });
        return;
      case 'reject':
        upgrade.rejectStandaloneUpgrade(socket, route.status);
        return;
      default:
        socket.destroy();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  harness.base = `ws://127.0.0.1:${address.port}`;
  return harness;
}

/** Resolves 'open' or the HTTP status the upgrade was refused with (or 'destroyed'). */
function dial(url: string, headers: Record<string, string> = {}): Promise<{ outcome: 'open' | number | 'destroyed'; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    const done = (outcome: 'open' | number | 'destroyed') => {
      if (settled) return;
      settled = true;
      resolve({ outcome, ws });
    };
    ws.on('open', () => done('open'));
    ws.on('unexpected-response', (_req, res) => {
      done(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('error', () => done('destroyed'));
  });
}

describe('/ws/seqscribe upgrade gate', () => {
  it('refuses an unauthenticated upgrade with 401 when a token is configured — never reaching the lane', async () => {
    const h = await startServer({ token: TOKEN });
    const { outcome } = await dial(`${h.base}${SEQSCRIBE_PATH}`);
    expect(outcome).toBe(401);
    const wrong = await dial(`${h.base}${SEQSCRIBE_PATH}?token=nope`);
    expect(wrong.outcome).toBe(401);
    expect(h.accepted).toEqual([]);
  });

  it('upgrades with the same token /ws accepts (query token and bearer header)', async () => {
    const h = await startServer({ token: TOKEN });
    const q = await dial(`${h.base}${SEQSCRIBE_PATH}?token=${TOKEN}`);
    expect(q.outcome).toBe('open');
    const echoed = await new Promise<string>((resolve) => {
      q.ws.on('message', (m) => resolve(m.toString()));
      q.ws.send('HELLO');
    });
    expect(echoed).toBe('echo:HELLO');
    q.ws.close();
    const b = await dial(`${h.base}${SEQSCRIBE_PATH}`, { Authorization: `Bearer ${TOKEN}` });
    expect(b.outcome).toBe('open');
    b.ws.close();
    expect(h.accepted).toHaveLength(2);
  });

  it('applies the same gate to /ws (parity: the lane is never weaker than the dashboard lane)', async () => {
    const h = await startServer({ token: TOKEN });
    expect((await dial(`${h.base}/ws`)).outcome).toBe(401);
    const ok = await dial(`${h.base}/ws?token=${TOKEN}`);
    expect(ok.outcome).toBe('open');
    ok.ws.close();
  });

  it('refuses a foreign Origin with 403 even when authenticated', async () => {
    const h = await startServer({ token: TOKEN });
    const { outcome } = await dial(`${h.base}${SEQSCRIBE_PATH}?token=${TOKEN}`, { Origin: 'https://evil.example' });
    expect(outcome).toBe(403);
    expect(h.accepted).toEqual([]);
  });

  it('answers 503 when the lane is unavailable (node closed / kill switch), after auth', async () => {
    const h = await startServer({ token: null, laneAvailable: false });
    expect((await dial(`${h.base}${SEQSCRIBE_PATH}`)).outcome).toBe(503);
    expect(h.accepted).toEqual([]);
  });

  it('with no auth configured (default local mode) the lane upgrades like /ws does', async () => {
    const h = await startServer({ token: null });
    const r = await dial(`${h.base}${SEQSCRIBE_PATH}`);
    expect(r.outcome).toBe('open');
    r.ws.close();
  });

  it('destroys unknown upgrade paths without a response', async () => {
    const h = await startServer({ token: null });
    expect((await dial(`${h.base}/ws/other`)).outcome).toBe('destroyed');
  });

  it('has no kill switch — the replica lane is the only chat path', () => {
    expect(upgrade).not.toHaveProperty('isStandaloneTranscriptLaneDisabled');
  });
});

/**
 * `/ws/mesh` and `/ws/mesh-seqscribe` — the daemon⇄daemon mesh lanes (design
 * 2026-10-07 §4.3). Peer daemons are not browsers: these paths must NOT run the
 * dashboard Origin/token gate (the HMAC handshake on the upgraded socket is
 * their door), and must refuse with 503 before upgrading when this daemon holds
 * nothing a dialer could prove.
 */
describe('mesh lane upgrade routing', () => {
  /** Known-answer pins: the member dials these literals (join response `meshTransport`). */
  const MESH_RPC_PATH = '/ws/mesh';
  const MESH_SEQSCRIBE_PATH = '/ws/mesh-seqscribe';

  function fakeReq(url: string, headers: Record<string, string> = {}) {
    return { url, headers: { host: '127.0.0.1:3847', ...headers } } as any;
  }

  function gate(calls: string[]) {
    return {
      isAllowedOrigin: () => { calls.push('origin'); return false; },
      isRequestAuthenticated: () => { calls.push('auth'); return false; },
    };
  }

  function meshOptions(available: Record<'rpc' | 'seqscribe', boolean>, seen: string[] = []) {
    return {
      seqscribePath: SEQSCRIBE_PATH,
      seqscribeLaneAvailable: true,
      mesh: {
        rpcPath: MESH_RPC_PATH,
        seqscribePath: MESH_SEQSCRIBE_PATH,
        isAvailable: (lane: 'rpc' | 'seqscribe') => { seen.push(lane); return available[lane]; },
      },
    };
  }

  it('routes both mesh lanes WITHOUT consulting the dashboard Origin/token gate', () => {
    const calls: string[] = [];
    const opts = meshOptions({ rpc: true, seqscribe: true });
    expect(upgrade.routeStandaloneUpgrade(fakeReq(MESH_RPC_PATH, { origin: 'https://evil.example' }), gate(calls), opts))
      .toEqual({ kind: 'mesh', lane: 'rpc' });
    expect(upgrade.routeStandaloneUpgrade(fakeReq(`${MESH_SEQSCRIBE_PATH}?x=1`), gate(calls), opts))
      .toEqual({ kind: 'mesh', lane: 'seqscribe' });
    expect(calls).toEqual([]);
  });

  it('answers 503 per lane when nothing could be proven there', () => {
    const seen: string[] = [];
    const opts = meshOptions({ rpc: false, seqscribe: false }, seen);
    expect(upgrade.routeStandaloneUpgrade(fakeReq(MESH_RPC_PATH), gate([]), opts)).toEqual({ kind: 'reject', status: 503 });
    expect(upgrade.routeStandaloneUpgrade(fakeReq(MESH_SEQSCRIBE_PATH), gate([]), opts)).toEqual({ kind: 'reject', status: 503 });
    expect(seen).toEqual(['rpc', 'seqscribe']);
  });

  it('keeps the dashboard lanes gated (and never asks the mesh availability for them)', () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const opts = meshOptions({ rpc: true, seqscribe: true }, seen);
    expect(upgrade.routeStandaloneUpgrade(fakeReq('/ws'), gate(calls), opts)).toEqual({ kind: 'reject', status: 403 });
    expect(upgrade.routeStandaloneUpgrade(fakeReq(SEQSCRIBE_PATH), gate(calls), opts)).toEqual({ kind: 'reject', status: 403 });
    expect(calls).toEqual(['origin', 'origin']);
    expect(seen).toEqual([]);
  });

  it('does not serve the mesh paths at all when the host wires no mesh lanes', () => {
    const opts = { seqscribePath: SEQSCRIBE_PATH, seqscribeLaneAvailable: true };
    expect(upgrade.routeStandaloneUpgrade(fakeReq(MESH_RPC_PATH), gate([]), opts)).toEqual({ kind: 'ignore' });
    expect(upgrade.routeStandaloneUpgrade(fakeReq(MESH_SEQSCRIBE_PATH), gate([]), opts)).toEqual({ kind: 'ignore' });
  });

  it('over a real server: a token-protected daemon still upgrades /ws/mesh for a token-less peer, /ws stays 401', async () => {
    const http = new StandaloneHttpApi({
      isReady: () => true,
      getStatus: () => ({}) as any,
      executeCommand: async () => ({}),
      rawTerminalService: () => ({}) as any,
      interactivePromptService: () => ({}) as any,
      isCliSession: () => false,
      createSessionHostClient: async () => ({}) as any,
    });
    http.configureAuth(TOKEN);
    const wss = new WebSocketServer({ noServer: true });
    const lanes: string[] = [];
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket, head) => {
      const route = upgrade.routeStandaloneUpgrade(req, http, meshOptions({ rpc: true, seqscribe: false }));
      if (route.kind === 'mesh') { wss.handleUpgrade(req, socket, head, () => { lanes.push(route.lane); }); return; }
      if (route.kind === 'dashboard') { wss.handleUpgrade(req, socket, head, () => {}); return; }
      if (route.kind === 'reject') { upgrade.rejectStandaloneUpgrade(socket, route.status); return; }
      socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `ws://127.0.0.1:${address.port}`;
    const rpc = await dial(`${base}${MESH_RPC_PATH}`);
    expect(rpc.outcome).toBe('open');
    rpc.ws.close();
    expect((await dial(`${base}${MESH_SEQSCRIBE_PATH}`)).outcome).toBe(503);
    expect((await dial(`${base}/ws`)).outcome).toBe(401);
    expect(lanes).toEqual(['rpc']);
  });
});
