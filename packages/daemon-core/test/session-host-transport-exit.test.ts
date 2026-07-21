import { describe, expect, it } from 'vitest';

import { SessionHostPtyTransportFactory } from '../src/cli-adapters/session-host-transport.js';
import type { PtyRuntimeTransport } from '../src/cli-adapters/pty-transport.js';
import type { SessionHostEvent } from '@adhdev/session-host-core';

const RUNTIME_ID = 'runtime-under-test';

/**
 * Build a live transport instance and drive its private `handleEvent` directly
 * with a `session_exit` event, capturing what reaches the registered onExit
 * callbacks. We spawn through the real factory (so the class wiring is real),
 * then neutralize the outbound IPC teardown so the test stays offline and
 * deterministic — only the event→callback transformation is exercised.
 */
function driveExit(event: Extract<SessionHostEvent, { type: 'session_exit' }>): Array<{ exitCode: number | null; signal?: number | null }> {
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

  const seen: Array<{ exitCode: number | null; signal?: number | null }> = [];
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
});
