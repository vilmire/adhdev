/**
 * Owner-decision inbox on a password-less standalone: the owner's chat in the
 * assistant must be attributable so the assistant may answer decisions, WITHOUT
 * any owner authority. A no-auth dashboard `send_chat` / `pty_input` keeps the
 * unverified `ipc` source and `ownerVerified: false`; the only addition is the
 * trusted `unverifiedDashboardInput` option (never a payload field).
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-unverified-input-'));

let mod: typeof import('../src/standalone-http.js');
let upgradeMod: typeof import('../src/standalone-seqscribe-upgrade.js');
let indexMod: typeof import('../src/index.js');

beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
  upgradeMod = await import('../src/standalone-seqscribe-upgrade.js');
  indexMod = await import('../src/index.js');
});

const TOKEN = 'dashboard-token';
const INTERNAL = 'adi_internal_token_for_test';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

interface Call { type: string; payload: Record<string, any>; source: string; opts: any }

async function startServer(opts: { token?: string } = {}) {
  const calls: Call[] = [];
  const http = new mod.StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({ ok: true }) as any,
    executeCommand: async (type: string, payload: any, source: any, o: any) => {
      calls.push({ type, payload, source, opts: o });
      return { success: true };
    },
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
  });
  http.passwordConfig = null;
  if (opts.token) http.configureAuth(opts.token);
  http.internalAuthToken = INTERNAL;
  const server = createServer((req, res) => { http.handle(req, res); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, port: addr.port, calls, http, server };
}

function post(base: string, type: string, headers: Record<string, string> = {}, payload: Record<string, unknown> = { sessionId: 's1', message: 'hi' }) {
  return fetch(`${base}/api/v1/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type, payload }),
  });
}

describe('no-auth standalone — unverified dashboard input attribution (HTTP)', () => {
  it.each(['send_chat', 'pty_input'])('%s carries the flag with source ipc and ownerVerified false', async (verb) => {
    const { base, calls } = await startServer();
    expect((await post(base, verb)).status).toBe(200);
    expect(calls[0].source).toBe('ipc');
    expect(calls[0].opts.ownerVerified).toBe(false);
    expect(calls[0].opts.unverifiedDashboardInput).toBe(true);
    expect(calls[0].opts.ownerProof ?? null).toBeNull();
  });

  it('other commands never get the flag', async () => {
    const { base, calls } = await startServer();
    await post(base, 'launch_cli', {}, {});
    await post(base, 'mission_decision_answer', {}, {});
    for (const c of calls) expect(c.opts.unverifiedDashboardInput).toBeUndefined();
  });

  it('an MCP / internal credential header gets no flag', async () => {
    const { base, calls } = await startServer();
    await post(base, 'send_chat', { 'x-adhdev-internal-auth': INTERNAL });
    expect(calls[0].opts.unverifiedDashboardInput).toBeUndefined();
    await post(base, 'send_chat', { 'x-adhdev-worker-credential': 'wsb_whatever' });
    expect(calls).toHaveLength(1); // rejected before any command ran
  });

  it('a cross-origin browser request is refused before any command runs', async () => {
    const { base, calls } = await startServer();
    const res = await post(base, 'send_chat', { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('a configured token means a real owner, not the unverified flag', async () => {
    const { base, calls } = await startServer({ token: TOKEN });
    expect((await post(base, 'send_chat')).status).toBe(401);
    expect((await post(base, 'send_chat', { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe('standalone');
    expect(calls[0].opts.unverifiedDashboardInput).toBeUndefined();
  });

  it('a caller-supplied _unverifiedDashboardInput in the payload is stripped', async () => {
    const { base, calls } = await startServer({ token: TOKEN });
    await post(base, 'send_chat', { Authorization: `Bearer ${TOKEN}` }, { sessionId: 's1', message: 'x', _unverifiedDashboardInput: true });
    expect('_unverifiedDashboardInput' in calls[0].payload).toBe(false);
    const open = await startServer();
    await post(open.base, 'launch_cli', {}, { _unverifiedDashboardInput: true });
    expect('_unverifiedDashboardInput' in open.calls[0].payload).toBe(false);
    expect(open.calls[0].opts.unverifiedDashboardInput).toBeUndefined();
  });
});

describe('no-auth standalone — unverified dashboard input attribution (WS)', () => {
  async function openWs(token?: string) {
    const { port, calls, http, server } = await startServer({ token });
    const wss = new WebSocketServer({ noServer: true });
    const standalone = new indexMod.StandaloneServer() as any;
    standalone.http = http;
    standalone.executeCommand = (type: string, payload: any, source: any, opts: any) =>
      (http as any).deps.executeCommand(type, payload, source, opts);
    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const route = upgradeMod.routeStandaloneUpgrade(req, http, { seqscribePath: '/ws/seqscribe', seqscribeLaneAvailable: true });
      if (route.kind === 'dashboard') {
        const ownerGuard = http.captureOwnerAuthGuard(req, req.url || '/');
        wss.handleUpgrade(req, socket, head, (ws) => {
          standalone.handleWsConnection(
            ws,
            ownerGuard ? 'standalone' : 'ipc',
            ownerGuard ?? undefined,
            (t: string) => http.captureUnauthenticatedArtifactReadGuard(req, t),
            (t: string) => http.isUnverifiedDashboardInput(req, t),
          );
        });
        return;
      }
      socket.destroy();
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: `http://127.0.0.1:${port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const send = (requestId: string, commandType: string, payload: Record<string, unknown> = { sessionId: 's1', message: 'hi' }) =>
      new Promise<void>((resolve) => {
        const onMessage = (raw: WebSocket.RawData) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'command_result' && msg.requestId === requestId) { ws.off('message', onMessage); resolve(); }
        };
        ws.on('message', onMessage);
        ws.send(JSON.stringify({ type: 'command', requestId, data: { type: commandType, payload } }));
      });
    return { ws, calls, send, http };
  }

  it('send_chat / pty_input over /ws carry the flag; others and a payload copy do not', async () => {
    const { ws, calls, send } = await openWs();
    try {
      await send('1', 'send_chat');
      expect(calls.at(-1)).toMatchObject({ type: 'send_chat', source: 'ipc' });
      expect(calls.at(-1)!.opts.ownerVerified).toBe(false);
      expect(calls.at(-1)!.opts.unverifiedDashboardInput).toBe(true);
      await send('2', 'pty_input');
      expect(calls.at(-1)!.opts.unverifiedDashboardInput).toBe(true);
      await send('3', 'launch_cli', { _unverifiedDashboardInput: true });
      expect(calls.at(-1)!.opts.unverifiedDashboardInput).toBeUndefined();
      expect('_unverifiedDashboardInput' in calls.at(-1)!.payload).toBe(false);
    } finally { ws.close(); }
  });

  it('configuring auth at runtime revokes the flag on the already-open socket', async () => {
    const { ws, calls, send, http } = await openWs();
    try {
      await send('1', 'send_chat');
      expect(calls.at(-1)!.opts.unverifiedDashboardInput).toBe(true);
      http.configureAuth(TOKEN);
      await send('2', 'send_chat');
      expect(calls.at(-1)!.opts.unverifiedDashboardInput).toBeUndefined();
    } finally { ws.close(); }
  });

  it('an authenticated owner socket gets no flag', async () => {
    const { ws, calls, send } = await openWs(TOKEN);
    try {
      await send('1', 'send_chat');
      expect(calls.at(-1)!.source).toBe('standalone');
      expect(calls.at(-1)!.opts.unverifiedDashboardInput).toBeUndefined();
    } finally { ws.close(); }
  });
});
