/**
 * Artifact "View full" on an UNAUTHENTICATED standalone (no --token, no password).
 *
 * Live repro (2026-10-23, isolated standalone): the dashboard's `artifact_fetch`
 * (and the chip's `artifact_list`) came back `COMMAND_SOURCE_REJECTED: Artifact
 * command rejected: downgraded unverified owner ingress`, because owner
 * authority requires a configured credential, so a no-auth daemon demoted every
 * dashboard command to an unverified `ipc` source and the artifact read verbs
 * refuse that source. Every other read endpoint on a no-auth daemon serves the
 * open dashboard, so the read verbs get the same treatment — and ONLY the read
 * verbs: `artifact_register` (a write) and every other command keep the
 * unverified `ipc` source, and a gated daemon is unchanged.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { hostname as osHostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-artifact-noauth-'));

let mod: typeof import('../src/standalone-http.js');
let authMod: typeof import('../src/standalone-auth.js');
let upgradeMod: typeof import('../src/standalone-seqscribe-upgrade.js');
let indexMod: typeof import('../src/index.js');
let core: typeof import('@adhdev/daemon-core');

beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
  authMod = await import('../src/standalone-auth.js');
  upgradeMod = await import('../src/standalone-seqscribe-upgrade.js');
  indexMod = await import('../src/index.js');
  core = await import('@adhdev/daemon-core');
});

const TOKEN = 'dashboard-token';
const INTERNAL = 'adi_internal_token_for_test';
const LIVE_BIND = 'wsb_live_worker_bind';
const INTERNAL_HEADER = 'x-adhdev-internal-auth';
const WORKER_HEADER = 'x-adhdev-worker-credential';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

interface Call { type: string; payload: Record<string, unknown>; source: string; opts: any }

async function startServer(opts: { token?: string; listenHost?: string; remoteAddress?: string } = {}): Promise<{ base: string; port: number; calls: Call[]; http: InstanceType<typeof mod.StandaloneHttpApi>; server: Server }> {
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
    verifyWorkerCredential: (credential) => credential === LIVE_BIND,
  });
  http.passwordConfig = null;
  if (opts.listenHost) http.listenHost = opts.listenHost;
  if (opts.token) http.configureAuth(opts.token);
  http.internalAuthToken = INTERNAL;
  const server = createServer((req, res) => {
    if (opts.remoteAddress) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: opts.remoteAddress, configurable: true });
    }
    http.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, port: addr.port, calls, http, server };
}

function rawHttp(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/api/v1/command',
        headers: {
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(opts.body)) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function post(base: string, type: string, headers: Record<string, string> = {}, payload: Record<string, unknown> = { sessionId: 's1', artifactId: 'art_1' }) {
  return fetch(`${base}/api/v1/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type, payload }),
  });
}

describe('no-auth standalone — artifact read verbs', () => {
  it.each(['artifact_fetch', 'artifact_read', 'session_artifact_fetch', 'artifact_list', 'session_artifact_list'])(
    '%s reaches the router as a verified standalone owner read',
    async (verb) => {
      const { base, calls } = await startServer();
      expect((await post(base, verb)).status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].source).toBe('standalone');
      expect(calls[0].opts.ownerVerified).toBe(true);
      expect(core.readTrustedOwnerIngressProof(calls[0].payload, 'standalone')).not.toBeNull();
    },
  );

  it('artifact_register (a write) keeps the unverified ipc source', async () => {
    const { base, calls } = await startServer();
    await post(base, 'artifact_register', {}, { sessionId: 's1', path: 'a.md' });
    expect(calls[0].source).toBe('ipc');
    expect(calls[0].opts.ownerVerified).toBe(false);
    expect(core.readTrustedOwnerIngressProof(calls[0].payload, 'standalone')).toBeNull();
  });

  it('other commands are not promoted', async () => {
    const { base, calls } = await startServer();
    await post(base, 'launch_cli', {}, {});
    expect(calls[0].source).toBe('ipc');
    expect(calls[0].opts.ownerVerified).toBe(false);
  });

  it('a coordinator-scope credential is not promoted to owner', async () => {
    const { base, calls } = await startServer();
    await post(base, 'artifact_fetch', { [INTERNAL_HEADER]: INTERNAL });
    expect(calls[0].source).toBe('ipc');
    expect(core.readTrustedOwnerIngressProof(calls[0].payload, 'standalone')).toBeNull();
  });

  it('a cross-origin browser request is still refused before any command runs', async () => {
    const { base, calls } = await startServer();
    const res = await post(base, 'artifact_fetch', { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('a gated daemon is unchanged: no credential is 401, the token is a real owner', async () => {
    const { base, calls } = await startServer({ token: TOKEN });
    expect((await post(base, 'artifact_fetch')).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await post(base, 'artifact_fetch', { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(calls[0].source).toBe('standalone');
  });

  it('the no-auth read grant is revoked the moment auth is configured', async () => {
    const { http } = await startServer();
    const req: any = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/ws' };
    const guard = http.captureUnauthenticatedArtifactReadGuard(req, 'artifact_fetch');
    expect(guard && guard()).toBe(true);
    http.configureAuth(TOKEN);
    expect(guard && guard()).toBe(false);
  });

  it('Finding 1: an invalid, rotated, or expired MCP credential header returns 401 and never falls back to the anonymous owner read grant', async () => {
    const { base, calls, http } = await startServer();
    const readVerbs = ['artifact_fetch', 'artifact_read', 'session_artifact_fetch', 'artifact_list', 'session_artifact_list'] as const;

    // A valid worker credential is denied artifact reads (403 worker_scope_forbidden)
    for (const verb of readVerbs) {
      const validWorkerRes = await post(base, verb, { [WORKER_HEADER]: LIVE_BIND });
      expect(validWorkerRes.status, `valid worker ${verb}`).toBe(403);
    }

    // An invalid, rotated, or expired MCP header (coordinator or worker) must return 401 and never get owner reads
    for (const badHeaders of [
      { [INTERNAL_HEADER]: 'adi_rotated_or_invalid' },
      { [INTERNAL_HEADER]: '' },
      { [WORKER_HEADER]: 'wsb_expired_or_rotated' },
      { [WORKER_HEADER]: '' },
    ] as Array<Record<string, string>>) {
      for (const verb of readVerbs) {
        const res = await post(base, verb, badHeaders);
        expect(res.status, `${JSON.stringify(badHeaders)} ${verb}`).toBe(401);
      }
      const fakeReq: any = { headers: { host: '127.0.0.1:3847', ...badHeaders }, socket: { remoteAddress: '127.0.0.1' }, url: '/api/v1/command' };
      expect(http.captureUnauthenticatedArtifactReadGuard(fakeReq, 'artifact_fetch')).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('Finding 2: refuses DNS rebinding Host headers across HTTP and WS while keeping localhost, LAN IP, and bound interface IPs working', async () => {
    const { port, calls, http, server } = await startServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const route = upgradeMod.routeStandaloneUpgrade(req, http, {
        seqscribePath: '/ws/seqscribe',
        seqscribeLaneAvailable: true,
      });
      if (route.kind === 'dashboard' || route.kind === 'seqscribe') {
        wss.handleUpgrade(req, socket, head, (ws) => ws.close());
        return;
      }
      if (route.kind === 'reject') {
        upgradeMod.rejectStandaloneUpgrade(socket, route.status);
        return;
      }
      socket.destroy();
    });

    const cmdBody = JSON.stringify({ type: 'artifact_fetch', payload: { sessionId: 's1', artifactId: 'art_1' } });

    // 1. DNS rebinding: Host: rebind.example:<port> is refused with 403 even when Origin matches Host or is omitted
    const rebindWithOrigin = await rawHttp(port, {
      headers: { Host: `rebind.example:${port}`, Origin: `http://rebind.example:${port}` },
      body: cmdBody,
    });
    expect(rebindWithOrigin.status).toBe(403);

    const rebindNoOrigin = await rawHttp(port, {
      headers: { Host: `rebind.example:${port}` },
      body: cmdBody,
    });
    expect(rebindNoOrigin.status).toBe(403);

    const rebindStatusGet = await rawHttp(port, {
      method: 'GET',
      path: '/api/v1/status',
      headers: { Host: `rebind.example:${port}` },
    });
    expect(rebindStatusGet.status).toBe(403);
    expect(calls).toEqual([]);

    // WS upgrade with rebinding Host header is also refused with 403
    const dialStatus = (headers: Record<string, string>, path = '/ws') =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        ws.on('open', () => { resolve('open'); ws.close(); });
        ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
        ws.on('error', () => resolve(0));
      });
    expect(await dialStatus({ Host: `rebind.example:${port}`, Origin: `http://rebind.example:${port}` })).toBe(403);
    expect(await dialStatus({ Host: `rebind.example:${port}` })).toBe(403);
    expect(await dialStatus({ Host: `rebind.example:${port}`, Origin: `http://rebind.example:${port}` }, '/ws/seqscribe')).toBe(403);

    // 2. Loopback Host headers (localhost, 127.0.0.1, [::1]) and machine hostname still work
    for (const allowedHost of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${osHostname()}:${port}`]) {
      const okRes = await rawHttp(port, {
        headers: { Host: allowedHost, Origin: `http://${allowedHost}` },
        body: cmdBody,
      });
      expect(okRes.status, allowedHost).toBe(200);
    }

    // Vite dev server origin on loopback bind (127.0.0.1) still works
    const viteLoopback = await rawHttp(port, {
      headers: { Host: `127.0.0.1:${port}`, Origin: 'http://localhost:3000' },
      body: cmdBody,
    });
    expect(viteLoopback.status).toBe(200);

    // 3. When bound to 0.0.0.0, Origin: http://localhost:* spoofing is refused, while LAN IP and local localhost work
    const lanIfaceIp = Object.values(networkInterfaces())
      .flat()
      .find((info) => info && info.family === 'IPv4' && !info.internal)?.address ?? '192.168.1.50';
    http.listenHost = '0.0.0.0';
    http.allowedHosts.add(lanIfaceIp);

    const spoofedLocalhostOriginOnLanHost = await rawHttp(port, {
      headers: { Host: `${lanIfaceIp}:${port}`, Origin: 'http://localhost:3000' },
      body: cmdBody,
    });
    expect(spoofedLocalhostOriginOnLanHost.status).toBe(403);
    expect(await dialStatus({ Host: `${lanIfaceIp}:${port}`, Origin: 'http://localhost:3000' })).toBe(403);

    // Same-origin LAN IP access works when bound to 0.0.0.0
    const lanOk = await rawHttp(port, {
      headers: { Host: `${lanIfaceIp}:${port}`, Origin: `http://${lanIfaceIp}:${port}` },
      body: cmdBody,
    });
    expect(lanOk.status).toBe(200);
    expect(await dialStatus({ Host: `${lanIfaceIp}:${port}`, Origin: `http://${lanIfaceIp}:${port}` })).toBe('open');

    // Local loopback access via localhost:<port> still works when bound to 0.0.0.0
    const localOnZeroBind = await rawHttp(port, {
      headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` },
      body: cmdBody,
    });
    expect(localOnZeroBind.status).toBe(200);

    // A non-loopback LAN peer spoofing Host/Origin localhost when bound to 0.0.0.0 is refused
    const { port: lanPeerPort, http: lanPeerHttp } = await startServer({ listenHost: '0.0.0.0', remoteAddress: '192.168.1.99' });
    lanPeerHttp.allowedHosts.add(lanIfaceIp);
    const lanPeerSpoofLocalhost = await rawHttp(lanPeerPort, {
      headers: { Host: `localhost:${lanPeerPort}`, Origin: `http://localhost:${lanPeerPort}` },
      body: cmdBody,
    });
    expect(lanPeerSpoofLocalhost.status).toBe(403);
    const lanPeerLegitIp = await rawHttp(lanPeerPort, {
      headers: { Host: `${lanIfaceIp}:${lanPeerPort}`, Origin: `http://${lanIfaceIp}:${lanPeerPort}` },
      body: cmdBody,
    });
    expect(lanPeerLegitIp.status).toBe(200);

    // Bound interface IP (e.g. Tailscale 100.64.0.42) works
    http.listenHost = '100.64.0.42';
    const tailscaleOk = await rawHttp(port, {
      headers: { Host: `100.64.0.42:${port}`, Origin: `http://100.64.0.42:${port}` },
      body: cmdBody,
    });
    expect(tailscaleOk.status).toBe(200);
  });

  it('Finding 3: a /ws opened while authenticated falls back per message to the read guard after the password is cleared at runtime', async () => {
    const { base, port, calls, http, server } = await startServer();
    http.passwordConfig = authMod.createPasswordRecord('secret-pass');
    const wss = new WebSocketServer({ noServer: true });

    // Wire the real StandaloneServer.handleWsConnection on the upgrade path
    const standaloneServer = new indexMod.StandaloneServer() as any;
    standaloneServer.http = http;
    standaloneServer.executeCommand = (type: string, payload: any, source: any, opts: any) =>
      (http as any).deps.executeCommand(type, payload, source, opts);

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const route = upgradeMod.routeStandaloneUpgrade(req, http, {
        seqscribePath: '/ws/seqscribe',
        seqscribeLaneAvailable: true,
      });
      if (route.kind === 'dashboard') {
        const ownerGuard = http.captureOwnerAuthGuard(req, req.url || '/');
        wss.handleUpgrade(req, socket, head, (ws) => {
          standaloneServer.handleWsConnection(
            ws,
            ownerGuard ? 'standalone' : 'ipc',
            ownerGuard ?? undefined,
            (commandType: string) => http.captureUnauthenticatedArtifactReadGuard(req, commandType),
          );
        });
        return;
      }
      if (route.kind === 'reject') {
        upgradeMod.rejectStandaloneUpgrade(socket, route.status);
        return;
      }
      socket.destroy();
    });

    // 1. Log in with password and open /ws while authenticated
    const loginRes = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret-pass' }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0] || '';

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const sendWsCommand = (requestId: string, commandType: string) =>
      new Promise<any>((resolve) => {
        const onMessage = (raw: WebSocket.RawData) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'command_result' && msg.requestId === requestId) {
            ws.off('message', onMessage);
            resolve(msg);
          }
        };
        ws.on('message', onMessage);
        ws.send(JSON.stringify({
          type: 'command',
          requestId,
          data: { type: commandType, payload: { sessionId: 's1', artifactId: 'art_1' } },
        }));
      });

    try {
      // While authenticated, both reads and writes over /ws execute as owner ('standalone')
      await sendWsCommand('req-1', 'artifact_fetch');
      expect(calls.at(-1)?.source).toBe('standalone');
      expect(calls.at(-1)?.opts?.ownerVerified).toBe(true);

      await sendWsCommand('req-2', 'artifact_register');
      expect(calls.at(-1)?.source).toBe('standalone');
      expect(calls.at(-1)?.opts?.ownerVerified).toBe(true);

      // 2. Clear the password at runtime while /ws remains open
      const clearRes = await fetch(`${base}/auth/password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ currentPassword: 'secret-pass', clear: true }),
      });
      expect(clearRes.status).toBe(200);
      expect(http.hasPasswordAuth()).toBe(false);

      // 3. On the same open /ws, artifact_fetch falls back per message to the read guard
      await sendWsCommand('req-3', 'artifact_fetch');
      expect(calls.at(-1)?.source).toBe('standalone');
      expect(calls.at(-1)?.opts?.ownerVerified).toBe(true);

      // Writes on the same open /ws do NOT get the read guard and fall back to 'ipc'
      await sendWsCommand('req-4', 'artifact_register');
      expect(calls.at(-1)?.source).toBe('ipc');
      expect(calls.at(-1)?.opts?.ownerVerified).toBe(false);
    } finally {
      ws.close();
    }
  });
});
