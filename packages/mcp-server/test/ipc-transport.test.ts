import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { CloudTransport } from '../src/transports/cloud.js';
import { LocalTransport } from '../src/transports/local.js';
import { isLocalTransport } from '../src/transports/mode.js';

test('isLocalTransport treats IPC transport as command-routed and keeps cloud separate', () => {
  assert.equal(isLocalTransport(new LocalTransport()), true);
  assert.equal(isLocalTransport(new IpcTransport()), true);
  assert.equal(isLocalTransport(new CloudTransport({ apiKey: 'adk_test' })), false);
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
