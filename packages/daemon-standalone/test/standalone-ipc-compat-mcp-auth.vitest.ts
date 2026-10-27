import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-ipc-auth-'));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
  });
}

async function start() {
  const core = await import('@adhdev/daemon-core');
  const { createStandaloneIpcCommandHandler } = await import('../src/standalone-ipc-compat.js');
  const seen: Array<{ command: string; mcp: { present: boolean; valid: boolean } }> = [];
  const handler = createStandaloneIpcCommandHandler({
    host: () => ({
      execute: async (command: string, args: Record<string, unknown>) => {
        const copy = core.preserveTrustedOwnerTransportProof(args, { ...args });
        seen.push({ command, mcp: core.readAuthenticatedMcpCommand(copy, command) });
        return { success: true };
      },
    }) as any,
    relayMeshCommand: async () => ({ success: true }),
  });
  const port = await freePort();
  const handle = await core.startLocalIpcServer({
    port, buildStatusPayload: () => null, buildWelcomePayload: () => ({}), handleCommand: handler,
  });
  closers.push(async () => { await (handle as any).close?.(); });
  return { core, port, seen };
}

function connect(port: number, headers?: Record<string, string>) {
  return new Promise<WebSocket | null>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ipc`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', () => resolve(null));
    ws.on('unexpected-response', () => resolve(null));
  });
}

function call(ws: WebSocket, command: string, args: Record<string, unknown>, mcpAuth?: unknown) {
  return new Promise<any>((resolve) => {
    const requestId = `r-${Math.random()}`;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'ext:command_result' && m.payload.requestId === requestId) resolve(m.payload);
    });
    ws.send(JSON.stringify({ type: 'ext:command', payload: { command, args, requestId, ...(mcpAuth ? { mcpAuth } : {}) } }));
  });
}

describe('standalone IPC compat server MCP authority', () => {
  it('valid session credential grants artifact_list scope; forged / absent do not', async () => {
    const { core, port, seen } = await start();
    const cred = core.mintMcpSessionCredential({ sessionId: 'sa-sess-1', isCoordinator: false });
    const ws = (await connect(port))!;
    expect(ws).not.toBeNull();
    await call(ws, 'artifact_list', { callerSessionId: 'sa-sess-1' }, { sessionCredential: cred });
    await call(ws, 'artifact_list', { callerSessionId: 'sa-sess-1' }, { sessionCredential: 'mcp_sess_forged' });
    await call(ws, 'artifact_list', { callerSessionId: 'sa-sess-1' });
    expect(seen.map((s) => s.mcp)).toEqual([
      { present: true, valid: true },
      { present: true, valid: false },
      { present: false, valid: false },
    ]);
    ws.close();
  });

  it('refuses browser-origin upgrades, accepts native clients', async () => {
    const { port } = await start();
    expect(await connect(port, { Origin: 'https://evil.example' })).toBeNull();
    const ok = await connect(port);
    expect(ok).not.toBeNull();
    ok!.close();
  });
});
