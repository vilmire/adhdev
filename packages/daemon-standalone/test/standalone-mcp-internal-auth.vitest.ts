/**
 * Loopback-only credentials for the MCP servers a token- / password-gated
 * standalone daemon launches (daemon-core standalone-mcp-auth.ts).
 *
 * Live repro (2026-10-08, two-machine standalone mesh on Linux): a daemon
 * started with `--token` answered 401 to the worker's adhdev-mesh MCP, which
 * printed "Cannot reach local daemon" and exited 1 — task_failed session_exit.
 * The coordinator / assistant MCP hit the same wall.
 *
 * Worker scope = the worker's own session bind: worker verbs + a liveness-only
 * status, nothing else. Coordinator scope = the per-boot internal token:
 * status + the command API, nothing else. Both refused from a non-loopback
 * peer; no credential is still 401. Real HTTP server over a real
 * StandaloneHttpApi.
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-mcp-auth-'));

let mod: typeof import('../src/standalone-http.js');
let authFileMod: typeof import('../src/standalone-mcp-internal-auth.js');

beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
  authFileMod = await import('../src/standalone-mcp-internal-auth.js');
});

const DASHBOARD_TOKEN = 'dashboard-token';
const INTERNAL = 'adi_internal_token_for_test';
const LIVE_BIND = 'wsb_live_bind';

const WORKER_HEADER = 'x-adhdev-worker-credential';
const INTERNAL_HEADER = 'x-adhdev-internal-auth';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

async function startServer(opts: { remoteAddress?: string } = {}): Promise<{ base: string; calls: string[] }> {
  const calls: string[] = [];
  const http = new mod.StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({ full: 'snapshot', sessions: ['s1'] }) as any,
    executeCommand: async (type) => {
      calls.push(type);
      return { success: true, type };
    },
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
    verifyWorkerCredential: (credential) => credential === LIVE_BIND,
  });
  http.configureAuth(DASHBOARD_TOKEN);
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
  return { base: `http://127.0.0.1:${addr.port}`, calls };
}

function status(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/status`, { headers });
}

function command(base: string, type: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type, payload: { bind: LIVE_BIND } }),
  });
}

describe('standalone HTTP gate — daemon-launched MCP credentials', () => {
  it('no credential is still 401 on a gated daemon', async () => {
    const { base, calls } = await startServer();
    expect((await status(base)).status).toBe(401);
    expect((await command(base, 'worker_progress_update')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('the dashboard token still works unchanged', async () => {
    const { base, calls } = await startServer();
    const res = await status(base, { Authorization: `Bearer ${DASHBOARD_TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ full: 'snapshot', sessions: ['s1'] });
    expect((await command(base, 'launch_cli', { Authorization: `Bearer ${DASHBOARD_TOKEN}` })).status).toBe(200);
    expect(calls).toEqual(['launch_cli']);
  });

  it('worker credential: worker verbs pass, status is liveness-only', async () => {
    const { base, calls } = await startServer();
    const h = { [WORKER_HEADER]: LIVE_BIND };
    const st = await status(base, h);
    expect(st.status).toBe(200);
    expect(await st.json()).toEqual({ ok: true, scope: 'worker' });
    for (const verb of ['worker_report_completion', 'worker_progress_update', 'worker_peer_context_pull', 'worker_drain_mailbox', 'git_status', 'git_diff_summary', 'git_diff_file', 'git_log']) {
      expect((await command(base, verb, h)).status, verb).toBe(200);
    }
    expect(calls).toEqual(['worker_report_completion', 'worker_progress_update', 'worker_peer_context_pull', 'worker_drain_mailbox', 'git_status', 'git_diff_summary', 'git_diff_file', 'git_log']);
  });

  it('worker credential: every other verb and route is refused', async () => {
    const { base, calls } = await startServer();
    const h = { [WORKER_HEADER]: LIVE_BIND };
    for (const verb of ['launch_cli', 'mesh_status', 'mesh_relay_command', 'send_chat', 'git_push']) {
      const res = await command(base, verb, h);
      expect(res.status, verb).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('worker_scope_forbidden');
    }
    expect((await fetch(`${base}/api/v1/providers/installed`, { headers: h })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('an unknown / revoked worker bind is 401', async () => {
    const { base, calls } = await startServer();
    const h = { [WORKER_HEADER]: 'wsb_forged' };
    expect((await status(base, h)).status).toBe(401);
    expect((await command(base, 'worker_progress_update', h)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('coordinator credential: full status and the command API, nothing else', async () => {
    const { base, calls } = await startServer();
    const h = { [INTERNAL_HEADER]: INTERNAL };
    const st = await status(base, h);
    expect(st.status).toBe(200);
    expect(await st.json()).toEqual({ full: 'snapshot', sessions: ['s1'] });
    expect((await command(base, 'mesh_status', h)).status).toBe(200);
    expect((await command(base, 'mesh_relay_command', h)).status).toBe(200);
    expect(calls).toEqual(['mesh_status', 'mesh_relay_command']);
    expect((await fetch(`${base}/api/v1/providers/installed`, { headers: h })).status).toBe(403);
    // Settings routes keep their own dashboard-only check.
    const prefs = await fetch(`${base}/api/v1/standalone/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...h },
      body: JSON.stringify({ standaloneBindHost: '0.0.0.0' }),
    });
    expect(prefs.status).toBe(401);
  });

  it('a wrong internal token is 401', async () => {
    const { base } = await startServer();
    expect((await status(base, { [INTERNAL_HEADER]: `${INTERNAL}x` })).status).toBe(401);
  });

  it('both credentials are refused from a non-loopback peer', async () => {
    const { base, calls } = await startServer({ remoteAddress: '10.0.0.5' });
    expect((await status(base, { [INTERNAL_HEADER]: INTERNAL })).status).toBe(401);
    expect((await command(base, 'mesh_status', { [INTERNAL_HEADER]: INTERNAL })).status).toBe(401);
    expect((await status(base, { [WORKER_HEADER]: LIVE_BIND })).status).toBe(401);
    expect((await command(base, 'worker_progress_update', { [WORKER_HEADER]: LIVE_BIND })).status).toBe(401);
    expect(calls).toEqual([]);
    // The dashboard token is not a loopback-only credential.
    expect((await status(base, { Authorization: `Bearer ${DASHBOARD_TOKEN}` })).status).toBe(200);
  });

  it('an IPv4-mapped loopback peer counts as loopback', async () => {
    const { base } = await startServer({ remoteAddress: '::ffff:127.0.0.1' });
    expect((await status(base, { [INTERNAL_HEADER]: INTERNAL })).status).toBe(200);
  });
});

describe('per-boot MCP auth file', () => {
  it('is written owner-only and replaced atomically per boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-sa-mcp-auth-file-'));
    const file = authFileMod.standaloneMcpAuthFilePath(dir, 3847);
    const first = authFileMod.mintStandaloneMcpInternalToken();
    const second = authFileMod.mintStandaloneMcpInternalToken();
    expect(first).not.toBe(second);
    authFileMod.writeStandaloneMcpAuthFile(file, first);
    expect(readFileSync(file, 'utf8')).toBe(first);
    authFileMod.writeStandaloneMcpAuthFile(file, second);
    expect(readFileSync(file, 'utf8')).toBe(second);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
