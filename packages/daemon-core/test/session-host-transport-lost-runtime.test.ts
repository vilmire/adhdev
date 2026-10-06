import { describe, expect, it } from 'vitest';

import { SessionHostPtyTransportFactory, isLostRuntimeError } from '../src/cli-adapters/session-host-transport.js';
import type { PtyRuntimeExitInfo } from '../src/cli-adapters/pty-transport.js';

// 2026-10-06: a Windows session host exited with code 1 and was later respawned.
// Its PTYs died with it, but nothing ever sent `session_exit`, so an antigravity
// session stayed 'generating' for hours (re-injecting focus every 2 s) and blocked
// the daemon's own restart as a busy session. A write the respawned host answers
// with "Runtime not found" / "Unknown session" now ends the session as failed.
function transportAnswering(error: string) {
  const factory = new SessionHostPtyTransportFactory({
    clientId: 'test-client',
    runtimeId: 'lost-runtime',
    providerType: 'antigravity-cli',
    workspace: '/tmp/ws',
    // Boot never settles: the test drives the write path against a stub client.
    ensureReady: () => new Promise<never>(() => {}),
  });
  const transport = factory.spawn('/bin/sh', ['-lc', 'true'], { cwd: '/tmp/ws', env: {}, cols: 80, rows: 24 }) as any;
  transport.ready = Promise.resolve();
  const requests: string[] = [];
  transport.client = { request: async (req: any) => { requests.push(req.type); return { success: false, error }; } };
  const seen: PtyRuntimeExitInfo[] = [];
  transport.onExit((info: PtyRuntimeExitInfo) => seen.push(info));
  return { transport, seen, requests };
}

describe('session-host transport — runtime lost from a respawned host', () => {
  it('ends the session once when the host no longer has the runtime', async () => {
    const { transport, seen } = transportAnswering('Runtime not found for session: lost-runtime');
    await expect(transport.write('\x1b[I')).rejects.toThrow(/Runtime not found/);
    await expect(transport.write('\x1b[I')).rejects.toThrow(/Runtime not found/);
    expect(seen).toHaveLength(1);
    expect(seen[0].exitCode).toBeNull();
    expect(seen[0].termination?.lifecycle).toBe('failed');
  });

  it('treats an unknown session the same way', async () => {
    const { transport, seen } = transportAnswering('Unknown session: lost-runtime');
    await expect(transport.write('x')).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('does NOT end the session for an ordinary write refusal', async () => {
    const { transport, seen } = transportAnswering('Client test-client is read-only');
    await expect(transport.write('x')).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('matches only the host\'s lost-runtime errors', () => {
    expect(isLostRuntimeError('Runtime not found for session: a')).toBe(true);
    expect(isLostRuntimeError('Unknown session: a')).toBe(true);
    expect(isLostRuntimeError('connect ENOENT \\\\.\\pipe\\x')).toBe(false);
    expect(isLostRuntimeError(undefined)).toBe(false);
  });
});
