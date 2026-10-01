import { describe, expect, it } from 'vitest';

import { SessionHostPtyTransportFactory } from '../src/cli-adapters/session-host-transport.js';
import type { PtyRuntimeExitInfo } from '../src/cli-adapters/pty-transport.js';

// 2026-10-01: a stale session-host whose install had been deleted answered every
// create_session with `posix_spawn failed: No such file or directory`. Nothing
// awaited the transport's `ready`, so the runtime never reported an exit and the
// session fell through startup-grace into 'idle' — a dead agent shown as healthy.
// A runtime that fails to start must reach its exit subscribers as a failure.
function spawnFailing(message: string) {
  const factory = new SessionHostPtyTransportFactory({
    clientId: 'test-client',
    runtimeId: 'boot-failure-runtime',
    providerType: 'claude-cli',
    workspace: '/tmp/ws',
    // Offline and deterministic: the host is "unusable" before any connect.
    ensureReady: async () => { throw new Error(message); },
  });
  return factory.spawn('/bin/sh', ['-lc', 'true'], { cwd: '/tmp/ws', env: {}, cols: 80, rows: 24 });
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('session-host transport boot failure', () => {
  it('reports a failed exit to subscribers when the runtime never starts', async () => {
    const transport = spawnFailing('posix_spawn failed: No such file or directory');
    const seen: PtyRuntimeExitInfo[] = [];
    transport.onExit((info) => seen.push(info));
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].exitCode).toBeNull();
    expect(seen[0].termination?.lifecycle).toBe('failed');
    expect(seen[0].termination?.reason).toBe('failed');
  });

  it('replays the failure to a subscriber that registers after boot already failed', async () => {
    const transport = spawnFailing('host unusable');
    await settle();
    await settle();
    const seen: PtyRuntimeExitInfo[] = [];
    transport.onExit((info) => seen.push(info));
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].termination?.lifecycle).toBe('failed');
  });
});
