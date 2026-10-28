/**
 * Explicit unauthenticated GET /health on standalone: answers 200 {ok:true}
 * even with auth configured and without a web bundle, while the Host allow-list
 * still applies and other routes stay gated.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-health-'));

let mod: typeof import('../src/standalone-http.js');
beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

async function startServer(token?: string): Promise<number> {
  const http = new mod.StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({ ok: true }) as any,
    executeCommand: async () => ({ success: true }),
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
  });
  http.passwordConfig = null;
  if (token) http.configureAuth(token);
  // No publicDir => no web bundle / SPA fallback.
  const server = createServer((req, res) => http.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('standalone /health', () => {
  it('GET /health returns 200 ok:true with no web bundle and no auth', async () => {
    const port = await startServer();
    const res = await raw(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, pid: process.pid });
  });

  it('answers without credentials even when a token is configured, and HEAD works', async () => {
    const port = await startServer('secret-token');
    const get = await raw(port, 'GET', '/health');
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body).ok).toBe(true);
    const head = await raw(port, 'HEAD', '/health');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('does not open other routes and still rejects untrusted Host', async () => {
    const port = await startServer('secret-token');
    expect((await raw(port, 'GET', '/api/v1/status')).status).toBe(401);
    expect((await raw(port, 'GET', '/health', { Host: 'evil.example.com' })).status).toBe(403);
  });
});
