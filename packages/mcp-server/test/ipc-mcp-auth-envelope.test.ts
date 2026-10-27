import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';

// The IPC transport carries MCP authority in an `mcpAuth` envelope NEXT TO args
// (cloud daemon local IPC), never inside args, and sends nothing when it has no
// credential (backward compatible with daemons that predate the field).

async function capture(opts: ConstructorParameters<typeof IpcTransport>[0], port: number, env?: string) {
  const previousWebSocket = (globalThis as any).WebSocket;
  const previousEnv = process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
  if (env === undefined) delete process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
  else process.env.ADHDEV_MCP_SESSION_CREDENTIAL = env;
  const sent: any[] = [];
  class FakeWebSocket {
    private listeners = new Map<string, Array<(event: any) => void>>();
    constructor(_url: string) { queueMicrotask(() => this.emit('open', {})); }
    addEventListener(type: string, l: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]); }
    send(data: string) {
      const p = JSON.parse(data);
      sent.push(p);
      if (p.type === 'ext:register') queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'daemon:welcome' }) }));
      if (p.type === 'ext:command') queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'ext:command_result', payload: { requestId: p.payload.requestId, success: true, result: { ok: true } } }) }));
    }
    close() {}
    private emit(type: string, event: any) { for (const l of this.listeners.get(type) ?? []) l(event); }
  }
  try {
    (globalThis as any).WebSocket = FakeWebSocket;
    await new IpcTransport({ port, ...opts }).command('artifact_list', { callerSessionId: 's1' });
    return sent.find((m) => m.type === 'ext:command').payload;
  } finally {
    (globalThis as any).WebSocket = previousWebSocket;
    if (previousEnv === undefined) delete process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
    else process.env.ADHDEV_MCP_SESSION_CREDENTIAL = previousEnv;
  }
}

test('session credential from the launch env is sent as mcpAuth, not inside args', async () => {
  const payload = await capture({}, 19991, 'mcp_sess_env');
  assert.deepEqual(payload.mcpAuth, { sessionCredential: 'mcp_sess_env' });
  assert.deepEqual(payload.args, { callerSessionId: 's1' });
});

test('explicit worker credential wins and is the only credential sent', async () => {
  const payload = await capture({ workerCredential: 'wsb_x' }, 19992, 'mcp_sess_env');
  assert.deepEqual(payload.mcpAuth, { workerCredential: 'wsb_x' });
});

test('no credential: no mcpAuth field at all (old behaviour)', async () => {
  const payload = await capture({}, 19993);
  assert.equal('mcpAuth' in payload, false);
});
