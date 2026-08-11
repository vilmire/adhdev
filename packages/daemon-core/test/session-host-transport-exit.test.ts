import { describe, expect, it } from 'vitest';

import { SessionHostPtyTransportFactory } from '../src/cli-adapters/session-host-transport.js';
import type { PtyRuntimeExitInfo, PtyRuntimeTransport } from '../src/cli-adapters/pty-transport.js';
import type { SessionHostEvent, SessionTermination } from '@adhdev/session-host-core';

const RUNTIME_ID = 'runtime-under-test';

/**
 * Build a live transport instance and drive its private `handleEvent` directly
 * with a `session_exit` event, capturing what reaches the registered onExit
 * callbacks. We spawn through the real factory (so the class wiring is real),
 * then neutralize the outbound IPC teardown so the test stays offline and
 * deterministic — only the event→callback transformation is exercised.
 */
function driveExit(event: Extract<SessionHostEvent, { type: 'session_exit' }>): PtyRuntimeExitInfo[] {
  const factory = new SessionHostPtyTransportFactory({
    clientId: 'test-client',
    runtimeId: RUNTIME_ID,
    providerType: 'codex-cli',
    workspace: '/tmp/ws',
  });
  const transport = factory.spawn('/bin/sh', ['-lc', 'true'], {
    cwd: '/tmp/ws',
    env: {},
    cols: 80,
    rows: 24,
  }) as PtyRuntimeTransport & { handleEvent(e: SessionHostEvent): void; closeClient(destroy?: boolean): Promise<void> };

  // Keep the test offline: swallow the boot promise and stub client teardown.
  (transport as any).ready?.catch?.(() => {});
  (transport as any).closeClient = async () => {};

  const seen: PtyRuntimeExitInfo[] = [];
  transport.onExit((info) => seen.push(info));
  (transport as any).handleEvent(event);
  return seen;
}

describe('session-host transport session_exit propagation', () => {
  it('forwards exit code 0 unchanged', () => {
    const seen = driveExit({ type: 'session_exit', sessionId: RUNTIME_ID, exitCode: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0].exitCode).toBe(0);
    expect(seen[0].signal ?? null).toBeNull();
  });

  it('forwards a nonzero exit code unchanged', () => {
    const seen = driveExit({ type: 'session_exit', sessionId: RUNTIME_ID, exitCode: 137 });
    expect(seen[0].exitCode).toBe(137);
  });

  it('preserves a null exitCode and MUST NOT collapse it to 0 (regression)', () => {
    const seen = driveExit({ type: 'session_exit', sessionId: RUNTIME_ID, exitCode: null });
    expect(seen).toHaveLength(1);
    // Old behavior was `event.exitCode ?? 0`, which made this indistinguishable
    // from a clean exit. It must stay null.
    expect(seen[0].exitCode).toBeNull();
    expect(seen[0].exitCode).not.toBe(0);
  });

  it('forwards the signal alongside a null exitCode (SIGHUP scenario)', () => {
    const seen = driveExit({ type: 'session_exit', sessionId: RUNTIME_ID, exitCode: null, signal: 1 });
    expect(seen[0].exitCode).toBeNull();
    expect(seen[0].signal).toBe(1);
  });

  it('ignores exit events for other runtimes', () => {
    const seen = driveExit({ type: 'session_exit', sessionId: 'some-other-runtime', exitCode: null });
    expect(seen).toHaveLength(0);
  });

  // TOMBSTONE-LEDGER-BRIDGE: the transport used to narrow the exit payload to
  // {exitCode, signal} and drop `termination` on the floor. That drop is the
  // reason an externally-killed mesh session never reached the mesh ledger —
  // the tombstone data existed here and went nowhere.
  it('forwards the host termination classification to exit subscribers', () => {
    const termination: SessionTermination = {
      exitCode: 143,
      signal: 0,
      reason: 'failed',
      lifecycle: 'failed',
      terminatedAt: Date.parse('2026-08-11T05:06:34.099Z'),
      previousLifecycle: 'running',
      lastOutputAt: Date.parse('2026-08-11T05:06:33.986Z'),
    };
    const seen = driveExit({ type: 'session_exit', sessionId: RUNTIME_ID, exitCode: 143, signal: 0, termination });
    expect(seen).toHaveLength(1);
    expect(seen[0].termination).toBeDefined();
    expect(seen[0].termination?.exitCode).toBe(143);
    // previousLifecycle is what distinguishes "died mid-work" from "died idle".
    expect(seen[0].termination?.previousLifecycle).toBe('running');
    expect(seen[0].termination?.lastOutputAt).toBe(Date.parse('2026-08-11T05:06:33.986Z'));
  });

  it('leaves termination undefined when the host did not supply one', () => {
    // Back-compat: an older host (or the raw node-pty transport) reports no
    // tombstone, and consumers must tolerate that rather than assume one.
    const seen = driveExit({ type: 'session_exit', sessionId: RUNTIME_ID, exitCode: 0 });
    expect(seen[0].termination).toBeUndefined();
  });
});
