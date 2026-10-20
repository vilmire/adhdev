import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IpcTransport,
  getTimeoutMs,
  isRetryableProbeCommand,
  resolveProbeRetryBackoffMs,
  resolveProbeRetryMax,
} from '../src/transports/ipc.js';

// IPC-PROBE-TIMEOUT-RETRY (2026-08-18 RCA, verdict D): a frozen daemon made
// read-only probes false-time-out; a manual retry 1–2 min later succeeded.
// The transport now automates exactly one bounded retry for allowlisted
// read-only probes — and MUST NOT retry mutating verbs (dispatch/merge/push).
//
// Harness note: the connection pool is module-global and keyed by URL, so each
// test below uses its OWN port to get a fresh pool entry. Short deadlines come
// from the P5 env override (ADHDEV_IPC_COMMAND_TIMEOUT_MS), which exists for
// exactly this kind of control.

const TIMEOUT_ENV = 'ADHDEV_IPC_COMMAND_TIMEOUT_MS';
const RETRY_MAX_ENV = 'ADHDEV_IPC_PROBE_RETRY_MAX';
const BACKOFF_ENV = 'ADHDEV_IPC_PROBE_RETRY_BACKOFF_MS';

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

/** Fake WS: answers register with a welcome; ext:command answers are scripted. */
function makeFakeWebSocket(opts: {
  sent: any[];
  answerCommands: (parsed: any, sendIndex: number) => object | null;
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
        const sendIndex = opts.sent.filter(m => m.type === 'ext:command').length;
        const reply = opts.answerCommands(parsed, sendIndex);
        if (reply) queueMicrotask(() => this.emit('message', { data: JSON.stringify(reply) }));
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

test('probe retry: a timed-out read-only probe is retried once and resolves on the retry', async () => {
  await withEnv({ [TIMEOUT_ENV]: '80', [BACKOFF_ENV]: '10' }, async () => {
    const sent: any[] = [];
    const FakeWS = makeFakeWebSocket({
      sent,
      // First ext:command: never answered (simulates the frozen daemon). The
      // RETRY (second ext:command) is answered, as the resumed daemon would.
      answerCommands: (parsed, sendIndex) => sendIndex === 1 ? null : ({
        type: 'ext:command_result',
        payload: { requestId: parsed.payload.requestId, success: true, result: { ok: true, retried: true } },
      }),
    });
    const restore = installFakeWs(FakeWS);
    try {
      const transport = new IpcTransport({ port: 19981 });
      const result = await transport.command('get_status_metadata');
      assert.deepEqual(result, { ok: true, retried: true });
      const commands = sent.filter(m => m.type === 'ext:command');
      assert.equal(commands.length, 2, 'exactly one retry (2 sends total)');
      assert.equal(commands[0].payload.command, 'get_status_metadata');
      assert.equal(commands[1].payload.command, 'get_status_metadata');
      assert.notEqual(commands[0].payload.requestId, commands[1].payload.requestId);
    } finally {
      restore();
    }
  });
});

test('probe retry: a mutating command is NEVER retried — it rejects after a single send', async () => {
  await withEnv({ [TIMEOUT_ENV]: '80', [BACKOFF_ENV]: '10' }, async () => {
    const sent: any[] = [];
    const FakeWS = makeFakeWebSocket({ sent, answerCommands: () => null }); // daemon never answers
    const restore = installFakeWs(FakeWS);
    try {
      const transport = new IpcTransport({ port: 19982 });
      // git_push is mutating and has no per-command table entry, so the env
      // default deadline applies and the allowlist keeps it un-retried.
      await assert.rejects(transport.command('git_push', { workspace: '/repo' }), /timed out/);
      const commands = sent.filter(m => m.type === 'ext:command');
      assert.equal(commands.length, 1, 'no retry for a mutating verb');
    } finally {
      restore();
    }
  });
});

test('probe retry: a semantic failure reply (not a timeout) is NOT retried even for a probe', async () => {
  await withEnv({ [TIMEOUT_ENV]: '80', [BACKOFF_ENV]: '10' }, async () => {
    const sent: any[] = [];
    const FakeWS = makeFakeWebSocket({
      sent,
      answerCommands: (parsed) => ({
        type: 'ext:command_result',
        payload: { requestId: parsed.payload.requestId, success: false, error: 'boom' },
      }),
    });
    const restore = installFakeWs(FakeWS);
    try {
      const transport = new IpcTransport({ port: 19983 });
      await assert.rejects(transport.command('get_mesh', { meshId: 'm1' }), /boom/);
      assert.equal(sent.filter(m => m.type === 'ext:command').length, 1, 'no retry on a semantic failure');
    } finally {
      restore();
    }
  });
});

test('probe retry: retry count is bounded by ADHDEV_IPC_PROBE_RETRY_MAX (0 disables)', async () => {
  await withEnv({ [TIMEOUT_ENV]: '80', [BACKOFF_ENV]: '10', [RETRY_MAX_ENV]: '0' }, async () => {
    const sent: any[] = [];
    const FakeWS = makeFakeWebSocket({ sent, answerCommands: () => null });
    const restore = installFakeWs(FakeWS);
    try {
      const transport = new IpcTransport({ port: 19984 });
      await assert.rejects(transport.command('get_status_metadata'), /timed out/);
      assert.equal(sent.filter(m => m.type === 'ext:command').length, 1, 'retry disabled via env');
    } finally {
      restore();
    }
  });
});

test('allowlist: probe-class commands are retryable, mutating verbs and mesh_status_view with inbox drain/write are not', () => {
  for (const probe of [
    'get_status_metadata', 'get_mesh', 'mesh_status', 'mesh_status_view',
    'git_status', 'git_diff_summary', 'ledger_query', 'mission_list_query',
    'mission_query', 'queue_query', 'active_work_query', 'recovery_context_query',
    'task_stats_query', 'mesh_node_route', 'mesh_dispatch_route',
  ]) {
    assert.ok(isRetryableProbeCommand(probe), `${probe} must be retryable`);
  }
  // mesh_status_view with pendingEvents (inbox drain) or toolCall (rate-limit write) must NOT auto-retry
  assert.ok(!isRetryableProbeCommand('mesh_status_view', { pendingEvents: { sessionKey: 's1' } }));
  assert.ok(!isRetryableProbeCommand('mesh_status_view', { toolCall: { toolName: 'mesh_status' } }));
  assert.ok(isRetryableProbeCommand('mesh_status_view', { refresh: false, compact: true }));

  for (const mutating of [
    'git_push', 'refine_mesh_node', 'batch_refine_mesh_nodes', 'agent_command',
    'trigger_mesh_queue', 'mesh_forward_event', 'mesh_relay_command',
    'fast_forward_mesh_node', 'remove_mesh_node', 'clone_mesh_node',
    'record_local', 'tool_call_record', 'direct_dispatch_record',
    'queue_enqueue', 'queue_enqueue_batch', 'queue_cancel', 'queue_requeue',
  ]) {
    assert.ok(!isRetryableProbeCommand(mutating), `${mutating} must NOT be retryable`);
  }
  assert.equal(resolveProbeRetryMax(), 1);
  assert.equal(resolveProbeRetryBackoffMs(), 2_000);
});

test('pre-welcome timeout: a command that times out before daemon:welcome is removed from commandQueue, settles once on teardown, and is never sent late', async () => {
  await withEnv({ [TIMEOUT_ENV]: '50', [RETRY_MAX_ENV]: '0' }, async () => {
    const sent: any[] = [];
    let emitWelcome: (() => void) | undefined;
    let emitClose: (() => void) | undefined;
    class DelayedWelcomeWS {
      private listeners = new Map<string, Array<(event: any) => void>>();
      readyState = 1;
      constructor(_url: string) {
        queueMicrotask(() => this.emit('open', {}));
        emitClose = () => this.emit('close', {});
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
          emitWelcome = () => this.emit('message', { data: JSON.stringify({ type: 'daemon:welcome' }) });
        }
      }
      close(): void { /* noop */ }
      private emit(type: string, event: any): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const restore = installFakeWs(DelayedWelcomeWS);
    try {
      const transport = new IpcTransport({ port: 19985 });
      let rejections = 0;
      await transport.command('ledger_query', { meshId: 'm1' }).catch((err) => {
        rejections += 1;
        assert.match(String(err?.message ?? err), /timed out/);
      });
      assert.equal(rejections, 1, 'request rejected exactly once on timeout');
      // Now daemon:welcome arrives after the client already timed out, followed by close/teardown:
      // the timed-out request must have been pruned from commandQueue and must not settle again.
      emitWelcome?.();
      emitClose?.();
      assert.equal(rejections, 1, 'teardown after timeout must not re-settle the promise');
      const commands = sent.filter(m => m.type === 'ext:command');
      assert.equal(commands.length, 0, 'timed-out pre-welcome command must not be flushed after timeout');
    } finally {
      restore();
    }
  });
});

test('pool max-age grace: a healthy >10min connection does NOT tear down between immediate commands in an active turn, and rotates only after idle grace', async () => {
  const sent: any[] = [];
  let wsConstructions = 0;
  class CountingFakeWS {
    private listeners = new Map<string, Array<(event: any) => void>>();
    readyState = 1;
    constructor(_url: string) {
      wsConstructions += 1;
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
        return;
      }
      if (parsed.type === 'ext:command') {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({
            type: 'ext:command_result',
            payload: { requestId: parsed.payload.requestId, success: true, result: { ok: true } },
          }),
        }));
      }
    }
    close(): void {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', {}));
    }
    private emit(type: string, event: any): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  const realDateNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  const restore = installFakeWs(CountingFakeWS);
  try {
    const transport = new IpcTransport({ port: 19986 });
    await transport.command('ledger_query', { meshId: 'm1' });
    assert.equal(wsConstructions, 1);

    // Advance 6 minutes (keeps connection active, under 5-min idle eviction)
    fakeNow += 4 * 60_000;
    await transport.command('ledger_query', { meshId: 'm1' });
    assert.equal(wsConstructions, 1);

    fakeNow += 4 * 60_000;
    await transport.command('ledger_query', { meshId: 'm1' });
    assert.equal(wsConstructions, 1);
  } finally {
    Date.now = realDateNow;
    restore();
  }

  // Dedicated port for exact active-turn vs idle-grace boundary check, including a >30s
  // command on an aged (>10m) socket and delayed close-event eviction safety:
  wsConstructions = 0;
  let commandDurationMs = 0;
  class SlowAwareCountingFakeWS {
    private listeners = new Map<string, Array<(event: any) => void>>();
    readyState = 1;
    constructor(_url: string) {
      wsConstructions += 1;
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
        return;
      }
      if (parsed.type === 'ext:command') {
        queueMicrotask(() => {
          fakeNow += commandDurationMs;
          this.emit('message', {
            data: JSON.stringify({
              type: 'ext:command_result',
              payload: { requestId: parsed.payload.requestId, success: true, result: { ok: true } },
            }),
          });
        });
      }
    }
    close(): void {
      this.readyState = 3;
      // Realistic async close event fires AFTER getOrCreateConnection has already stored
      // the replacement PooledConnection in connectionPool.
      queueMicrotask(() => this.emit('close', {}));
    }
    private emit(type: string, event: any): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  fakeNow = 2_000_000;
  Date.now = () => fakeNow;
  const restore2 = installFakeWs(SlowAwareCountingFakeWS);
  try {
    const transport = new IpcTransport({ port: 19987 });
    await transport.command('ledger_query', { meshId: 'm1' });
    assert.equal(wsConstructions, 1);

    // Keep using socket so it doesn't hit 5-min idle eviction:
    fakeNow += 4 * 60_000;
    await transport.command('ledger_query', { meshId: 'm1' });
    fakeNow += 4 * 60_000;
    await transport.command('ledger_query', { meshId: 'm1' });
    fakeNow += 115_000; // age = 9m55s
    await transport.command('ledger_query', { meshId: 'm1' });
    fakeNow += 10_000; // age = 10m05s (> 10min POOL_MAX_AGE_MS), idle = 10s (< 30s grace)

    // Execute a slow 35s git_status command (> 30s POOL_MAX_AGE_IDLE_GRACE_MS) on the aged socket.
    // Because lastUsedAt is updated when the response arrives, a follow-up command 1s after
    // completion must see 1s idle (NOT 36s since send) and reuse connection #1!
    commandDurationMs = 35_000;
    await transport.command('git_status', { workspace: '/repo' });
    commandDurationMs = 0;
    assert.equal(wsConstructions, 1);

    fakeNow += 1_000;
    await transport.command('ledger_query', { meshId: 'm1' });
    assert.equal(
      wsConstructions,
      1,
      'aged socket completing a >30s command must update lastUsedAt on response receipt and not rotate on immediate follow-up',
    );

    // Now wait 35s (> 30s idle grace after response completion): next command rotates to connection #2.
    fakeNow += 35_000;
    await transport.command('ledger_query', { meshId: 'm1' });
    assert.equal(wsConstructions, 2, 'aged pool rotates once quiet past POOL_MAX_AGE_IDLE_GRACE_MS');

    // Flush microtasks so connection #1's async 'close' event has definitely run teardown().
    // Connection #1's teardown must NOT have deleted connection #2 from connectionPool!
    await new Promise(resolve => setImmediate(resolve));
    fakeNow += 1_000;
    await transport.command('ledger_query', { meshId: 'm1' });
    assert.equal(
      wsConstructions,
      2,
      'delayed close event from evicted connection #1 must not delete replacement connection #2 from connectionPool',
    );
  } finally {
    Date.now = realDateNow;
    restore2();
  }
});

test('P5: ADHDEV_IPC_COMMAND_TIMEOUT_MS overrides only the default, table entries still win', async () => {
  await withEnv({ [TIMEOUT_ENV]: '45_000'.replace('_', '') }, async () => {
    assert.equal(getTimeoutMs('some_unknown_command', ''), 45_000, 'default overridden');
    assert.equal(getTimeoutMs('clone_mesh_node', ''), 120_000, 'table entry unaffected');
  });
  // Env unset: the documented defaults hold (guards the existing timeout-chain contract).
  assert.equal(getTimeoutMs('some_unknown_command', ''), 15_000);
});
