/**
 * End to end: the REAL mcp-server process (src, via tsx) against a token-gated
 * standalone HTTP API — the exact failure of the 2026-10-08 two-machine test,
 * where the worker's adhdev-mesh MCP printed "Cannot reach local daemon" and
 * exited 1 because the daemon answered its ping with 401.
 *
 * - worker MCP (`--worker`, bind in env): boots, and `progress_update`
 *   reaches the daemon as `worker_progress_update`.
 * - coordinator-scope MCP (`--daemon-auth-file`): boots, and keeps working
 *   after the daemon "restarts" (new per-boot token written to the same file).
 * - no credential: exits 1 saying authentication failed, not "cannot reach".
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-mcp-e2e-'));

const MCP_ENTRY = resolve(__dirname, '../../mcp-server/src/index.ts');
const DASHBOARD_TOKEN = 'dashboard-token';
const LIVE_BIND = 'wsb_e2e_live_bind';

let mod: typeof import('../src/standalone-http.js');
beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
});

const servers: Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => {
    s.closeAllConnections?.();
    s.close(() => done());
  })));
});

async function startDaemon(): Promise<{ port: number; http: InstanceType<typeof mod.StandaloneHttpApi>; calls: string[] }> {
  const calls: string[] = [];
  const http = new mod.StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({ sessions: [], daemons: [] }) as any,
    executeCommand: async (type) => {
      calls.push(type);
      return { success: true };
    },
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
    verifyWorkerCredential: (credential) => credential === LIVE_BIND,
  });
  http.configureAuth(DASHBOARD_TOKEN);
  const server = createServer((req, res) => http.handle(req, res));
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { port: addr.port, http, calls };
}

class McpChild {
  private buffer = '';
  private nextId = 1;
  private readonly waiters = new Map<number, (msg: any) => void>();
  stderr = '';
  readonly exited: Promise<number | null>;

  constructor(readonly child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined;
          if (waiter) { this.waiters.delete(msg.id); waiter(msg); }
        } catch { /* non-JSON stdout line */ }
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { this.stderr += chunk; });
    this.exited = new Promise((done) => child.on('exit', (code) => done(code)));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${method} timed out; stderr:\n${this.stderr}`)), 30_000);
      this.waiters.set(id, (msg) => { clearTimeout(timer); done(msg); });
      void this.exited.then((code) => fail(new Error(`mcp-server exited (${code}) during ${method}; stderr:\n${this.stderr}`)));
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'gated-daemon-e2e', version: '0' },
    });
    expect(init.error).toBeUndefined();
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
}

function spawnMcp(args: string[], env: Record<string, string> = {}): McpChild {
  const isolated = mkdtempSync(join(tmpdir(), 'adhdev-sa-mcp-e2e-child-'));
  const child = spawn(process.execPath, ['--import', 'tsx', MCP_ENTRY, ...args], {
    cwd: resolve(__dirname, '../../mcp-server'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: isolated,
      USERPROFILE: isolated,
      ADHDEV_CONFIG_DIR: join(isolated, '.adhdev-standalone'),
      ADHDEV_WORKER_OUTBOX_DIR: join(isolated, 'outbox'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  return new McpChild(child);
}

describe('daemon-launched MCP servers against a token-gated standalone daemon', () => {
  it('worker MCP boots with its session bind and reports through worker verbs', async () => {
    const { port, calls } = await startDaemon();
    const mcp = spawnMcp(['--mode', 'local', '--port', String(port), '--worker'], {
      ADHDEV_WORKER_SESSION_BIND: LIVE_BIND,
    });
    await mcp.initialize();
    const res = await mcp.request('tools/call', { name: 'progress_update', arguments: { note: 'halfway' } });
    expect(res.error, mcp.stderr).toBeUndefined();
    expect(calls).toContain('worker_progress_update');
    expect(mcp.stderr).not.toMatch(/Cannot reach/);
  }, 60_000);

  it('coordinator-scope MCP boots from the auth file and survives a token rotation', async () => {
    const { port, http, calls } = await startDaemon();
    const authFile = join(mkdtempSync(join(tmpdir(), 'adhdev-sa-mcp-e2e-auth-')), 'standalone-mcp-auth');
    http.internalAuthToken = 'adi_boot_one';
    writeFileSync(authFile, 'adi_boot_one', { mode: 0o600 });
    const mcp = spawnMcp(['--mode', 'local', '--port', String(port), '--daemon-auth-file', authFile]);
    await mcp.initialize();
    const first = await mcp.request('tools/call', { name: 'list_sessions', arguments: {} });
    expect(first.error, mcp.stderr).toBeUndefined();
    expect(first.result?.isError, JSON.stringify(first.result)).not.toBe(true);

    // Daemon restart: a new per-boot token, rewritten to the same path.
    http.internalAuthToken = 'adi_boot_two';
    writeFileSync(authFile, 'adi_boot_two', { mode: 0o600 });
    const second = await mcp.request('tools/call', { name: 'list_sessions', arguments: {} });
    expect(second.error, mcp.stderr).toBeUndefined();
    expect(second.result?.isError, JSON.stringify(second.result)).not.toBe(true);
    expect(calls).toEqual([]);
  }, 60_000);

  it('without a credential the MCP exits saying authentication failed', async () => {
    const { port } = await startDaemon();
    const mcp = spawnMcp(['--mode', 'local', '--port', String(port), '--worker'], {
      ADHDEV_WORKER_SESSION_BIND: 'wsb_forged',
    });
    expect(await mcp.exited).toBe(1);
    expect(mcp.stderr).toMatch(/Authentication to the local daemon failed/);
    expect(mcp.stderr).not.toMatch(/Cannot reach/);
  }, 60_000);
});
