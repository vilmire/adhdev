import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('IpcTransport sends only one command when daemon sends duplicate welcome messages', async () => {
  const previousWebSocket = (globalThis as any).WebSocket;
  const sent: any[] = [];

  class FakeWebSocket {
    private listeners = new Map<string, Array<(event: any) => void>>();

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
      sent.push(parsed);
      if (parsed.type === 'ext:register') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'daemon:welcome' }) }));
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'daemon:welcome' }) }));
      }
      if (parsed.type === 'ext:command') {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({
            type: 'ext:command_result',
            payload: {
              requestId: parsed.payload.requestId,
              success: true,
              result: { ok: true },
            },
          }),
        }));
      }
    }

    close(): void {
      // noop
    }

    private emit(type: string, event: any): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  try {
    (globalThis as any).WebSocket = FakeWebSocket;
    const transport = new IpcTransport({ port: 19999 });
    const result = await transport.command('git_checkpoint', { workspace: '/repo', message: 'checkpoint' });

    assert.deepEqual(result, { ok: true });
    assert.equal(sent.filter((msg) => msg.type === 'ext:register').length, 1);
    assert.equal(sent.filter((msg) => msg.type === 'ext:command').length, 1);
    assert.equal(sent.find((msg) => msg.type === 'ext:command')?.payload.command, 'git_checkpoint');
  } finally {
    if (previousWebSocket === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = previousWebSocket;
  }
});

test('IpcTransport.meshCommand sends daemon mesh relay command over local IPC websocket', async () => {
  const previousWebSocket = (globalThis as any).WebSocket;
  const sent: any[] = [];
  const urls: string[] = [];

  class FakeWebSocket {
    private listeners = new Map<string, Array<(event: any) => void>>();

    constructor(url: string) {
      urls.push(url);
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(type: string, listener: (event: any) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    send(data: string): void {
      const parsed = JSON.parse(data);
      sent.push(parsed);
      if (parsed.type === 'ext:register') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'daemon:welcome' }) }));
      }
      if (parsed.type === 'ext:command') {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({
            type: 'ext:command_result',
            payload: {
              requestId: parsed.payload.requestId,
              success: true,
              result: { ok: true, command: parsed.payload.command, args: parsed.payload.args },
            },
          }),
        }));
      }
    }

    close(): void {
      // noop
    }

    private emit(type: string, event: any): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  try {
    (globalThis as any).WebSocket = FakeWebSocket;
    const transport = new IpcTransport({ port: 19999 });
    const result = await transport.meshCommand('daemon-target', 'git_status', { workspace: '/repo' });

    assert.equal(urls[0], 'ws://127.0.0.1:19999/ipc');
    assert.deepEqual(result, {
      ok: true,
      command: 'mesh_relay_command',
      args: {
        targetDaemonId: 'daemon-target',
        command: 'git_status',
        args: { workspace: '/repo' },
      },
    });
    assert.equal(sent[0].type, 'ext:register');
    assert.equal(sent[1].type, 'ext:command');
    assert.equal(sent[1].payload.command, 'mesh_relay_command');
  } finally {
    if (previousWebSocket === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = previousWebSocket;
  }
});

test('IpcTransport gives ff-only and relayed mesh commands long timeouts with diagnostic context', () => {
  const source = readFileSync(join(__dirname, '../src/transports/ipc.ts'), 'utf8');

  assert.match(source, /fast_forward_mesh_node:\s*120_000/);
  assert.match(source, /mesh_relay_command:\s*120_000/);
  assert.match(source, /relayedCommand=/);
  assert.match(source, /targetDaemonId=/);
  assert.match(source, /requestId=/);
});
