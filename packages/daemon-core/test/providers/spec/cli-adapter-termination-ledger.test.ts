/**
 * TOMBSTONE-LEDGER-BRIDGE — spec adapter wiring.
 *
 * The legacy ProviderCliAdapter used to join the session-host `session_exit`
 * tombstone to the mesh ledger. All production CLI providers now take this
 * path instead, so drive the real TerminalAdapter -> FsmDriver ->
 * SpecCliAdapter exit chain and prove the join still exists here.
 *
 * The join is deliberately indirect: `providers/**` may not value-import
 * `mesh/**` (scripts/check-import-boundaries.mjs), so the adapter reports to its
 * instance → session port → registry → lifecycle bus, and the mesh bridge subscribes. These tests install the REAL
 * subscriber and assert against the REAL ledger rather than stubbing the seam —
 * a break anywhere along publish -> observe -> resolve binding -> write fails
 * here. (Mocking the writer would not work anyway: the subscriber calls it
 * intra-module, where a module mock does not intercept. Asserting on the row is
 * both the stronger check and the honest one.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import type { SessionTermination } from '@adhdev/session-host-core';
import type {
  PtyRuntimeExitInfo,
  PtyRuntimeTransport,
  PtySpawnOptions,
  PtyTransportFactory,
} from '../../../src/cli-adapters/pty-transport.js';
import { minimalSpecPath } from '../../helpers/minimal-spec.js';

// Isolate ledger file I/O to a per-run temp dir.
const testTmpDir = path.join(tmpdir(), `adhdev-spec-termination-${randomUUID().slice(0, 8)}`);
const testConfigDir = path.join(testTmpDir, '.adhdev');
vi.mock('../../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
    return testConfigDir;
  },
  loadConfig: () => ({ machineId: 'test-host-machine' }),
  getMachineId: () => (({ machineId: 'test-host-machine' }) as any).machineId,
  getMachineNickname: () => (({ machineId: 'test-host-machine' }) as any).machineNickname ?? null,
}));

import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { subscribeMeshTermination } from '../../../src/mesh/mesh-termination-bridge.js';
import { createSessionLifecycleBus, type SessionLifecycleBus } from '../../../src/sessions/lifecycle-bus.js';
import { createSessionEventPort } from '../../../src/sessions/session-port.js';
import { SessionRegistry } from '../../../src/sessions/registry.js';
import { readLocalRecords } from '../../../src/mesh/mesh-local-records.js';
import { seedLocalRecord } from '../../helpers/local-records.js';

const EXTERNAL_SIGTERM: SessionTermination = {
  exitCode: 143,
  signal: 0,
  reason: 'failed',
  lifecycle: 'failed',
  terminatedAt: Date.parse('2026-08-11T05:06:34.099Z'),
  previousLifecycle: 'running',
  lastOutputAt: Date.parse('2026-08-11T05:06:33.986Z'),
};

class DrivablePty implements PtyRuntimeTransport {
  readonly pid = 4242;
  readonly ready = Promise.resolve();
  private exitCallback: ((info: PtyRuntimeExitInfo) => void) | null = null;

  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): void {}
  onExit(callback: (info: PtyRuntimeExitInfo) => void): void {
    this.exitCallback = callback;
  }
  exit(info: PtyRuntimeExitInfo): void {
    this.exitCallback?.(info);
  }
}

class DrivableFactory implements PtyTransportFactory {
  last: DrivablePty | null = null;

  spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
    this.last = new DrivablePty();
    return this.last;
  }
}

/** The bus's async lane + the ledger's dynamic import: let both settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

let bus: SessionLifecycleBus;
let registry: SessionRegistry;

function spawnMeshAdapter(settings: Record<string, unknown>, sessionId = 'sess_worker') {
  const factory = new DrivableFactory();
  const adapter = new SpecCliAdapter(
    minimalSpecPath(),
    '/tmp/project',
    [],
    {},
    factory,
    sessionId,
  );
  adapter.updateRuntimeSettings(settings);
  // Exactly what CliProviderInstance.init wires (B4): the adapter's exit report
  // goes to the session port, which turns it into registry.terminate('pty_exit').
  const port = createSessionEventPort(bus, registry);
  registry.register({
    sessionId, parentSessionId: null, providerType: adapter.cliType, transport: 'pty', instanceKey: sessionId, workspace: '/tmp/project',
  }, 'launch');
  adapter.setOnExit(({ termination, runtimeSettings }) => port.exited(sessionId, termination, runtimeSettings));
  void adapter.spawn();
  return { adapter, pty: factory.last! };
}

const stopEntries = (meshId: string) =>
  readLocalRecords(meshId).filter(e => e.kind === 'session_stopped');

let unsubscribe: () => void = () => {};
beforeEach(() => {
  // Boot subscribes this (S7); without it the exit reaches the bus with no
  // listener and every assertion below would vacuously "pass" as a no-write.
  bus = createSessionLifecycleBus();
  registry = new SessionRegistry(bus);
  unsubscribe = subscribeMeshTermination(bus);
});

afterEach(() => {
  unsubscribe();
  bus.close();
});

describe('SpecCliAdapter mesh termination ledger wiring', () => {
  it('records an externally-killed worker from the real spec PTY exit chain', async () => {
    const meshId = `mesh_worker_${randomUUID().slice(0, 8)}`;
    const { pty } = spawnMeshAdapter({ meshNodeFor: meshId, meshNodeId: 'node_1' });

    pty.exit({ exitCode: 143, signal: 0, termination: EXTERNAL_SIGTERM });
    await flush();

    const [entry] = stopEntries(meshId);
    expect(entry).toBeDefined();
    expect(entry.sessionId).toBe('sess_worker');
    expect(entry.nodeId).toBe('node_1');
    expect(entry.providerType).toBe('test-minimal');
    expect(entry.payload.workspace).toBe('/tmp/project');
    expect(entry.payload.intentional).toBe(false);
    expect(entry.payload.reason).toBe('external_signal');
    expect(entry.payload.signalName).toBe('SIGTERM');
    expect(entry.payload.coordinatorSession).toBeUndefined();
  });

  it('records an externally-killed coordinator from its coordinator binding', async () => {
    const meshId = `mesh_coord_${randomUUID().slice(0, 8)}`;
    const { pty } = spawnMeshAdapter({ meshCoordinatorFor: meshId }, '249e9979');

    pty.exit({ exitCode: 143, signal: 0, termination: EXTERNAL_SIGTERM });
    await flush();

    const [entry] = stopEntries(meshId);
    expect(entry).toBeDefined();
    expect(entry.sessionId).toBe('249e9979');
    expect(entry.payload.coordinatorSession).toBe(true);
    expect(entry.payload.reason).toBe('external_signal');
  });

  it('stays silent without a mesh binding or an authoritative tombstone', async () => {
    const noBinding = `mesh_plain_${randomUUID().slice(0, 8)}`;
    const plain = spawnMeshAdapter({ autoApprove: true }, 'sess_plain');
    plain.pty.exit({ exitCode: 143, signal: 0, termination: EXTERNAL_SIGTERM });
    await flush();
    expect(stopEntries(noBinding)).toHaveLength(0);

    // A bare exit with no session-host tombstone carries no authoritative
    // classification, so there is nothing trustworthy to record.
    const rawMesh = `mesh_raw_${randomUUID().slice(0, 8)}`;
    const raw = spawnMeshAdapter({ meshNodeFor: rawMesh }, 'sess_raw');
    raw.pty.exit({ exitCode: 143, signal: 0 });
    await flush();
    expect(stopEntries(rawMesh)).toHaveLength(0);
  });

  /**
   * Double-write prevention: a host-requested stop already has an
   * `operator_cleanup` row from the mesh cleanup path, so the tombstone that
   * follows must not add a second `session_stopped` for one death. The guard
   * lives with the writer (single home for the policy), and this drives it
   * through the full adapter chain to prove the move did not lose it.
   */
  it('does not add a second row for a host-requested stop', async () => {
    const meshId = `mesh_reqstop_${randomUUID().slice(0, 8)}`;
    seedLocalRecord(meshId, {
      kind: 'session_stopped',
      nodeId: 'node_1',
      sessionId: 'sess_worker',
      payload: {
        intentional: true,
        reason: 'operator_cleanup',
        source: 'mesh_cleanup_sessions',
      },
    });

    const { pty } = spawnMeshAdapter({ meshNodeFor: meshId, meshNodeId: 'node_1' });
    pty.exit({
      exitCode: 143,
      signal: 0,
      termination: { ...EXTERNAL_SIGTERM, requestedStop: 'stop' },
    });
    await flush();

    const stops = stopEntries(meshId);
    expect(stops).toHaveLength(1);
    expect(stops[0].payload.source).toBe('mesh_cleanup_sessions');
  });
});
