/**
 * TOMBSTONE-LEDGER-BRIDGE — adapter wiring.
 *
 * The bridge module and the transport forwarding are covered separately
 * (test/mesh/mesh-termination-bridge.test.ts, test/session-host-transport-exit.test.ts).
 * What this file proves is the join between them: that ProviderCliAdapter's real
 * PTY exit handler actually calls the ledger bridge for a mesh session, with the
 * right mesh binding, and stays silent for a non-mesh session.
 *
 * Without this, all three pieces could be individually correct while nothing ever
 * invoked the bridge — which is precisely the failure mode the original gap had
 * (the data existed at every layer and simply was not carried across).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionTermination } from '@adhdev/session-host-core';

const { recordMeshSessionTerminationStop } = vi.hoisted(() => ({
  recordMeshSessionTerminationStop: vi.fn(async () => {}),
}));
vi.mock('../../src/mesh/mesh-termination-bridge.js', async (importOriginal) => {
    // Keep the REAL binding resolver — the point of this test is that the adapter
    // resolves and forwards a genuine mesh binding, not that it calls a stub.
    const actual = await importOriginal<typeof import('../../src/mesh/mesh-termination-bridge.js')>();
    return { ...actual, recordMeshSessionTerminationStop };
});

import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js';

const TERMINATION: SessionTermination = {
  exitCode: 143,
  signal: 0,
  reason: 'failed',
  lifecycle: 'failed',
  terminatedAt: Date.parse('2026-08-11T05:06:34.099Z'),
  previousLifecycle: 'running',
  lastOutputAt: Date.parse('2026-08-11T05:06:33.986Z'),
};

/**
 * Build an adapter over a fake transport that hands us its onExit callback, so we
 * can fire the adapter's own exit path exactly as the session host would.
 */
function buildAdapter(owningSessionId?: string) {
  let exitHandler: ((info: any) => void) | null = null;
  const transport = {
    pid: 4242,
    ready: Promise.resolve(),
    write: vi.fn(async () => {}),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((cb: (info: any) => void) => { exitHandler = cb; }),
  };
  const factory = { spawn: () => transport } as any;

  const adapter = new ProviderCliAdapter(
    {
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      binary: 'claude',
      spawn: { command: 'claude', args: [], shell: true, env: {} },
      scripts: { detectStatus: () => 'idle', parseApproval: () => null },
    } as any,
    '/tmp/project',
    [],
    {},
    factory,
    owningSessionId,
  ) as any;

  // Attach the transport the way spawn() would, then register the real handler.
  adapter.ptyProcess = transport;
  adapter.attachExitHandlerForTest = () => {};
  return { adapter, transport, getExitHandler: () => exitHandler };
}

/**
 * Drive the adapter's genuine exit handling. We call the private bridge entry the
 * exit handler calls, via the adapter instance, so the binding resolution and
 * argument construction under test are the real ones.
 */
function fireExit(adapter: any, termination?: SessionTermination) {
  adapter.recordMeshTerminationIfBound(termination);
}

beforeEach(() => {
  recordMeshSessionTerminationStop.mockClear();
});

describe('ProviderCliAdapter mesh termination ledger wiring', () => {
  it('records a ledger stop for a killed WORKER session with its node binding', () => {
    const { adapter } = buildAdapter('sess_worker');
    adapter.updateRuntimeSettings({ meshNodeFor: 'mesh_a', meshNodeId: 'node_1' });

    fireExit(adapter, TERMINATION);

    expect(recordMeshSessionTerminationStop).toHaveBeenCalledTimes(1);
    expect(recordMeshSessionTerminationStop.mock.calls[0][0]).toMatchObject({
      meshId: 'mesh_a',
      nodeId: 'node_1',
      sessionId: 'sess_worker',
      providerType: 'claude-cli',
      workspace: '/tmp/project',
      isCoordinator: false,
      termination: TERMINATION,
    });
  });

  it('records a ledger stop for a killed COORDINATOR session', () => {
    // The incident that motivated this bridge was a coordinator death; a worker-only
    // binding would have missed it entirely.
    const { adapter } = buildAdapter('249e9979');
    adapter.updateRuntimeSettings({ meshCoordinatorFor: 'mesh_b' });

    fireExit(adapter, TERMINATION);

    expect(recordMeshSessionTerminationStop).toHaveBeenCalledTimes(1);
    expect(recordMeshSessionTerminationStop.mock.calls[0][0]).toMatchObject({
      meshId: 'mesh_b',
      sessionId: '249e9979',
      isCoordinator: true,
    });
  });

  it('writes nothing for a non-mesh session', () => {
    const { adapter } = buildAdapter('sess_plain');
    adapter.updateRuntimeSettings({ autoApprove: true });
    fireExit(adapter, TERMINATION);
    expect(recordMeshSessionTerminationStop).not.toHaveBeenCalled();
  });

  it('writes nothing when the transport supplied no termination (raw node-pty)', () => {
    const { adapter } = buildAdapter('sess_worker');
    adapter.updateRuntimeSettings({ meshNodeFor: 'mesh_a' });
    fireExit(adapter, undefined);
    expect(recordMeshSessionTerminationStop).not.toHaveBeenCalled();
  });

  it('never throws out of the exit path when the ledger write fails', () => {
    // A ledger write must not turn an observability gap into a crashed teardown.
    recordMeshSessionTerminationStop.mockImplementationOnce(() => { throw new Error('ledger down'); });
    const { adapter } = buildAdapter('sess_worker');
    adapter.updateRuntimeSettings({ meshNodeFor: 'mesh_a' });
    expect(() => fireExit(adapter, TERMINATION)).not.toThrow();
  });

  it('is invoked by the real PTY exit handler registered in spawn()', async () => {
    // Guards the actual wiring: if the bridge call were removed from the onExit
    // handler, every test above would still pass while nothing ran in production.
    // So drive the REAL spawn() and fire the handler it registers.
    const { adapter, getExitHandler } = buildAdapter('sess_worker');
    adapter.ptyProcess = null; // let spawn() install the transport itself
    adapter.updateRuntimeSettings({ meshNodeFor: 'mesh_a', meshNodeId: 'node_1' });
    adapter.scheduleStartupSettleCheck = vi.fn();

    await adapter.spawn();

    const handler = getExitHandler();
    expect(handler, 'spawn() must register an onExit handler').toBeTypeOf('function');

    handler!({ exitCode: 143, signal: 0, termination: TERMINATION });

    expect(recordMeshSessionTerminationStop).toHaveBeenCalledTimes(1);
    expect(recordMeshSessionTerminationStop.mock.calls[0][0]).toMatchObject({
      meshId: 'mesh_a',
      sessionId: 'sess_worker',
      termination: TERMINATION,
    });
  });
});
