import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';

// IPC TIMEOUT DIAGNOSTICS: the mcp-server client had no logging at all for the
// timeout path, making it impossible to tell — after the fact — whether a
// daemon reply was ever sent, arrived late, or was lost outright. These tests
// cover:
//   1. a timeout logs a `[ipc] timeout: ...` line with requestId/command/elapsed.
//   2. a response that arrives AFTER the client already timed out (an "orphan"
//      response) is detected and logged instead of silently vanishing — this
//      is the decisive "lost vs late" signal from the diagnosis.
//   3. a response that arrives before timeout is NOT logged as an orphan.
//
// Harness note (same as ipc-probe-retry.test.ts): the connection pool is
// module-global and keyed by URL, so each test uses its own port.

const TIMEOUT_ENV = 'ADHDEV_IPC_COMMAND_TIMEOUT_MS';
const RETRY_MAX_ENV = 'ADHDEV_IPC_PROBE_RETRY_MAX';

function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/** Fake WS: answers register with a welcome; ext:command replies are scripted per-call. */
function makeFakeWebSocket(opts: {
  sent: any[];
  /** Return null to never answer (simulate a stall); a delayMs to answer later. */
  answerCommands: (parsed: any, sendIndex: number) => { reply: object; delayMs?: number } | null;
}) {
  return class {
    private listeners = new Map<string, Array<(event: any) => void>>();
    readyState = 1;

    constructor(_url: string) {
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(type: string, listener: (event: any) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    send(data: string): void {
      const parsed = JSON.parse(data);
      opts.sent.push(parsed);
      if (parsed.type === 'ext:register') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'daemon:welcome' }) }));
        return;
      }
      if (parsed.type === 'ext:command') {
        const sendIndex = opts.sent.filter(m => m.type === 'ext:command').length - 1;
        const scripted = opts.answerCommands(parsed, sendIndex);
        if (!scripted) return;
        const { reply, delayMs } = scripted;
        if (delayMs && delayMs > 0) {
          setTimeout(() => this.emit('message', { data: JSON.stringify(reply) }), delayMs);
        } else {
          queueMicrotask(() => this.emit('message', { data: JSON.stringify(reply) }));
        }
      }
    }

    close(): void { /* noop */ }

    private emit(type: string, event: any): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  };
}

function installFakeWs(fake: unknown): () => void {
  const previous = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = fake;
  return () => {
    if (previous === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = previous;
  };
}

function captureConsoleError(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args.map(String).join(' '));
  };
  return { calls, restore: () => { console.error = original; } };
}

test('timeout: logs requestId, command, and elapsed time on client-side timeout', async () => {
  await withEnv({ [TIMEOUT_ENV]: '60', [RETRY_MAX_ENV]: '0' }, async () => {
    const sent: any[] = [];
    const FakeWS = makeFakeWebSocket({ sent, answerCommands: () => null }); // never answers
    const restoreWs = installFakeWs(FakeWS);
    const { calls, restore: restoreConsole } = captureConsoleError();
    try {
      const transport = new IpcTransport({ port: 19991 });
      await assert.rejects(transport.command('git_push', { workspace: '/repo' }), /timed out/);
      const timeoutLine = calls.find(line => line.includes('[ipc] timeout:'));
      assert.ok(timeoutLine, `expected a timeout log line, got: ${JSON.stringify(calls)}`);
      assert.match(timeoutLine!, /command='git_push'/);
      assert.match(timeoutLine!, /requestId=mcp_/);
      assert.match(timeoutLine!, /elapsedMs=\d+/);
      assert.match(timeoutLine!, /pendingBeforeRemoval=\d+/);
      assert.match(timeoutLine!, /ts=\d{4}-\d{2}-\d{2}T/);
    } finally {
      restoreConsole();
      restoreWs();
    }
  });
});

test('orphan response: a reply arriving after the client already timed out is logged, not silently dropped', async () => {
  await withEnv({ [TIMEOUT_ENV]: '60', [RETRY_MAX_ENV]: '0' }, async () => {
    const sent: any[] = [];
    const FakeWS = makeFakeWebSocket({
      sent,
      // Answer arrives 150ms after send — well after the 60ms client timeout.
      answerCommands: (parsed) => ({
        reply: { type: 'ext:command_result', payload: { requestId: parsed.payload.requestId, success: true, result: { ok: true } } },
        delayMs: 150,
      }),
    });
    const restoreWs = installFakeWs(FakeWS);
    const { calls, restore: restoreConsole } = captureConsoleError();
    try {
      const transport = new IpcTransport({ port: 19992 });
      await assert.rejects(transport.command('git_push', { workspace: '/repo' }), /timed out/);
      // Wait past the scripted 150ms reply delay for the orphan to arrive.
      await new Promise(resolve => setTimeout(resolve, 200));
      const orphanLine = calls.find(line => line.includes('[ipc] orphan response:'));
      assert.ok(orphanLine, `expected an orphan response log line, got: ${JSON.stringify(calls)}`);
      assert.match(orphanLine!, /command='git_push'/);
      assert.match(orphanLine!, /requestId=mcp_/);
      assert.match(orphanLine!, /arrived \d+ms after client timeout/);
    } finally {
      restoreConsole();
      restoreWs();
    }
  });
});

test('a response that arrives before timeout resolves normally and is NEVER logged as an orphan', async () => {
  await withEnv({ [TIMEOUT_ENV]: '500', [RETRY_MAX_ENV]: '0' }, async () => {
    const sent: any[] = [];
    const FakeWS = makeFakeWebSocket({
      sent,
      answerCommands: (parsed) => ({
        reply: { type: 'ext:command_result', payload: { requestId: parsed.payload.requestId, success: true, result: { ok: true } } },
      }),
    });
    const restoreWs = installFakeWs(FakeWS);
    const { calls, restore: restoreConsole } = captureConsoleError();
    try {
      const transport = new IpcTransport({ port: 19993 });
      const result = await transport.command('get_mesh', { meshId: 'm1' });
      assert.deepEqual(result, { ok: true });
      assert.ok(!calls.some(line => line.includes('[ipc] orphan response:')), 'no orphan log expected on a timely reply');
      assert.ok(!calls.some(line => line.includes('[ipc] timeout:')), 'no timeout log expected on a timely reply');
    } finally {
      restoreConsole();
      restoreWs();
    }
  });
});
