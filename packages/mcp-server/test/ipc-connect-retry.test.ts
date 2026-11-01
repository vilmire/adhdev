import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';

// IPC-CONNECT-RETRY: a daemon restart refuses connections for ~10-20 s. A
// command whose frame was never written is re-sent with backoff (any command);
// a command whose frame was written and then lost is NEVER re-sent.

const ENV = {
  ADHDEV_IPC_CONNECT_RETRY_BASE_MS: '10',
  ADHDEV_IPC_CONNECT_RETRY_BUDGET_MS: '2000',
  ADHDEV_IPC_COMMAND_TIMEOUT_MS: '2000',
};

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const prevWs = (globalThis as any).WebSocket;
  try { return await fn(); } finally {
    (globalThis as any).WebSocket = prevWs;
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

function makeWs(opts: { sent: any[]; constructed: { n: number }; downUntil: () => boolean; closeAfterCommand?: boolean }) {
  return class {
    private listeners = new Map<string, Array<(e: any) => void>>();
    readyState = 0;
    constructor(_url: string) {
      opts.constructed.n += 1;
      setTimeout(() => {
        if (opts.downUntil()) { this.readyState = 3; this.emit('error', {}); this.emit('close', {}); return; }
        this.readyState = 1;
        this.emit('open', {});
      }, 1);
    }
    addEventListener(t: string, l: (e: any) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]); }
    send(data: string) {
      const p = JSON.parse(data);
      opts.sent.push(p);
      if (p.type === 'ext:register') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'daemon:welcome' }) }));
      } else if (p.type === 'ext:command') {
        if (opts.closeAfterCommand) {
          queueMicrotask(() => { this.readyState = 3; this.emit('close', {}); });
        } else {
          queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'ext:command_result', payload: { requestId: p.payload.requestId, success: true, result: { ok: true } } }) }));
        }
      }
    }
    close() {}
    private emit(t: string, e: any) { for (const l of this.listeners.get(t) ?? []) l(e); }
  };
}

test('mutating command survives a daemon that is down for a few attempts', async () => {
  await withEnv(ENV, async () => {
    const sent: any[] = []; const constructed = { n: 0 };
    (globalThis as any).WebSocket = makeWs({ sent, constructed, downUntil: () => constructed.n <= 3 });
    const res = await new IpcTransport({ port: 59101 }).command('send_chat', { text: 'x' });
    assert.deepEqual(res, { ok: true });
    assert.ok(constructed.n >= 4);
    assert.equal(sent.filter(m => m.type === 'ext:command').length, 1, 'command frame sent exactly once');
  });
});

test('daemon down beyond the budget fails with an error naming the budget', async () => {
  await withEnv({ ...ENV, ADHDEV_IPC_CONNECT_RETRY_BUDGET_MS: '150' }, async () => {
    const sent: any[] = []; const constructed = { n: 0 };
    (globalThis as any).WebSocket = makeWs({ sent, constructed, downUntil: () => true });
    await assert.rejects(
      new IpcTransport({ port: 59102 }).command('send_chat', {}),
      /Cannot connect to daemon IPC.*reconnect budget/,
    );
    assert.ok(constructed.n >= 2);
    assert.equal(sent.length, 0);
  });
});

test('socket closed with a sent request pending is not retried', async () => {
  await withEnv(ENV, async () => {
    const sent: any[] = []; const constructed = { n: 0 };
    (globalThis as any).WebSocket = makeWs({ sent, constructed, downUntil: () => false, closeAfterCommand: true });
    await assert.rejects(
      new IpcTransport({ port: 59103 }).command('send_chat', {}),
      /Daemon IPC connection closed/,
    );
    assert.equal(constructed.n, 1);
    assert.equal(sent.filter(m => m.type === 'ext:command').length, 1);
  });
});
