import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import {
  registerMeshCoordinator,
  unregisterMeshCoordinator,
  getCoordinatorForSession,
  pruneDeadMeshCoordinators,
} from '../../src/mesh/coordinator-registry.js';

// Regression: unregisterMeshCoordinator only runs on explicit stop/exit paths
// (auto-clean, stopSessionWithMode, orphan force-remove). A daemon upgrade
// restart takes none of them, so dead coordinator entries accumulated in
// mesh-coordinators.json across boot generations. Those stale entries made the
// workspace rebind fallback's "exactly one registered coordinator" condition
// (restoreHostedSessions) permanently false → the coordinator badge and mesh
// event routing never recovered after a restart. The boot-time full restore
// now prunes entries whose sessionId is not among the live hosted runtimes
// reported by the session-host — while NEVER touching a live coordinator's
// entry (including one adopted via the workspace rebind fallback after its
// runtimeId changed).
//
// Isolation: ADHDEV_CONFIG_DIR is pinned to a fresh tmp dir per test so the
// persisted registry (mesh-coordinators.json) never touches the real
// ~/.adhdev — a 2026-08-21 incident had an unisolated test overwrite the live
// file.

function writeProvider(root: string, category: string, type: string, data: Record<string, unknown>) {
  const dir = join(root, category, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'provider.json'), JSON.stringify(data), 'utf-8');
  if (category === 'cli') {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({
      $schema: 'adhdev:cli/spec@4', id: type, name: type, binary: String((data as any).binary || type),
      send_message: { submit_key: '\r' }, sections: {},
      states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }], transitions: [],
    }), 'utf-8');
  }
}

class TestProviderLoader extends ProviderLoader {
  constructor(
    userDir: string,
    private readonly testConfig: {
      machineProviders?: Record<string, { enabled?: boolean; executable?: string; args?: string[] }>;
      providerSettings?: Record<string, Record<string, unknown>>;
    },
  ) {
    super({ userDir, disableUpstream: true });
  }

  protected override readConfig(): any | null {
    return this.testConfig;
  }

  protected override writeConfig(config: any): void {
    Object.assign(this.testConfig, config);
  }
}

function readPersistedRegistry(configDir: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(configDir, 'daemon', 'mesh-coordinators.json'), 'utf-8'));
}

describe('boot-time stale mesh coordinator pruning (restoreHostedSessions full restore)', () => {
  let providerRoot = '';
  let workingDir = '';
  let configDir = '';
  let prevConfigDir: string | undefined;
  let testConfig: { machineProviders: Record<string, { enabled?: boolean; executable?: string; args?: string[] }>; providerSettings: Record<string, Record<string, unknown>> };

  beforeEach(() => {
    providerRoot = mkdtempSync(join(tmpdir(), 'adhdev-prune-providers-'));
    workingDir = mkdtempSync(join(tmpdir(), 'adhdev-prune-workspace-'));
    configDir = mkdtempSync(join(tmpdir(), 'adhdev-prune-config-'));
    prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = configDir;
    // The registry is module-level state shared across tests in this file —
    // flush leftovers from a previous test before pinning a fresh fixture.
    pruneDeadMeshCoordinators(new Set());
    testConfig = { machineProviders: {}, providerSettings: {} };
  });

  afterEach(() => {
    pruneDeadMeshCoordinators(new Set());
    if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
    if (providerRoot) rmSync(providerRoot, { recursive: true, force: true });
    if (workingDir) rmSync(workingDir, { recursive: true, force: true });
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  function setupLoader() {
    const executable = join(providerRoot, 'bin', 'sample-cli');
    mkdirSync(join(providerRoot, 'bin'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf-8');
    chmodSync(executable, 0o755);

    writeProvider(providerRoot, 'cli', 'sample-cli', {
      type: 'sample-cli',
      name: 'Sample CLI',
      displayName: 'Sample CLI',
      category: 'cli',
      spawn: { command: 'sample-cli-definitely-missing' },
      patterns: ['sample'],
      settings: {
        autoApprove: { type: 'boolean', default: false, public: true },
      },
    });
    testConfig.machineProviders['sample-cli'] = { enabled: true, executable };
    const loader = new TestProviderLoader(providerRoot, testConfig);
    loader.loadAll();
    return loader;
  }

  function createManager(loader: ProviderLoader, hostedRuntimes: Array<Record<string, unknown>>) {
    return new DaemonCliManager({
      getServerConn: () => null,
      getP2p: () => null,
      onStatusChange: vi.fn(),
      removeAgentTracking: vi.fn(),
      getInstanceManager: () => ({ addInstance: vi.fn(), removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
      listHostedCliRuntimes: async () => hostedRuntimes as any,
    }, loader);
  }

  it('prunes dead entries from previous daemon generations while keeping the live coordinator entry (mixed fixture)', async () => {
    // The reported leak: each daemon upgrade restart left its coordinator entry
    // behind, so the registry accumulated dead entries next to the live one.
    // The fixture MUST mix dead and live entries — an all-dead fixture cannot
    // prove the live entry survives.
    const loader = setupLoader();
    registerMeshCoordinator({ meshId: 'mesh-dead-1', sessionId: 'dead-gen-1', workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });
    registerMeshCoordinator({ meshId: 'mesh-dead-2', sessionId: 'dead-gen-2', workspace: workingDir, startedAt: 2, cliType: 'sample-cli' });
    registerMeshCoordinator({ meshId: 'mesh-dead-3', sessionId: 'dead-gen-3', workspace: workingDir, startedAt: 3, cliType: 'sample-cli' });
    registerMeshCoordinator({ meshId: 'mesh-live', sessionId: 'live-coordinator', workspace: workingDir, startedAt: 4, cliType: 'sample-cli' });

    const restored = await createManager(loader, [
      { runtimeId: 'live-coordinator', cliType: 'sample-cli', workspace: workingDir },
    ]).restoreHostedSessions();

    expect(restored).toBe(1);
    // Dead entries are reclaimed from the in-memory registry…
    expect(getCoordinatorForSession('dead-gen-1')).toBeUndefined();
    expect(getCoordinatorForSession('dead-gen-2')).toBeUndefined();
    expect(getCoordinatorForSession('dead-gen-3')).toBeUndefined();
    // …the live entry survives…
    expect(getCoordinatorForSession('live-coordinator')?.meshId).toBe('mesh-live');
    // …and the reclamation is persisted, so the next boot does not reload them.
    const persisted = readPersistedRegistry(configDir);
    expect(persisted.map(e => e.sessionId)).toEqual(['live-coordinator']);
  }, 15000);

  it('reclaims stale fixture residue even when the session-host reports zero live runtimes', async () => {
    // Leftover entries pointing at long-deleted tmp workspaces (test-fixture
    // contamination) have no live runtime at all — they must still be reclaimed
    // on the next boot.
    const loader = setupLoader();
    registerMeshCoordinator({ meshId: 'mesh-fixture-1', sessionId: 'fixture-1', workspace: '/tmp/adhdev-dead-fixture-a', startedAt: 1, cliType: 'sample-cli' });
    registerMeshCoordinator({ meshId: 'mesh-fixture-2', sessionId: 'fixture-2', workspace: '/tmp/adhdev-dead-fixture-b', startedAt: 2, cliType: 'sample-cli' });

    const restored = await createManager(loader, []).restoreHostedSessions();

    expect(restored).toBe(0);
    expect(getCoordinatorForSession('fixture-1')).toBeUndefined();
    expect(getCoordinatorForSession('fixture-2')).toBeUndefined();
    expect(readPersistedRegistry(configDir)).toEqual([]);
  }, 15000);

  it('does NOT prune during an ad-hoc restore with an explicit record list', async () => {
    // session-host.ts restores single hosted runtimes ad-hoc by passing
    // [hosted]. A partial batch is not the live-runtime census — pruning
    // against it would wipe live coordinators that simply were not in it.
    const loader = setupLoader();
    registerMeshCoordinator({ meshId: 'mesh-elsewhere', sessionId: 'coordinator-elsewhere', workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });

    const restored = await createManager(loader, []).restoreHostedSessions([
      { runtimeId: 'unrelated-runtime', cliType: 'sample-cli', workspace: workingDir },
    ]);

    expect(restored).toBe(1);
    expect(getCoordinatorForSession('coordinator-elsewhere')?.meshId).toBe('mesh-elsewhere');
  }, 15000);

  it('keeps a live coordinator entry adopted via the workspace rebind fallback (runtimeId changed across restart)', async () => {
    // The entry's registered sessionId no longer matches any live runtime (the
    // coordinator re-attached under a NEW runtimeId), yet the entry belongs to
    // a LIVE coordinator: the workspace rebind fallback adopts it during this
    // very restore. A naive "not in the live list → prune" rule would delete
    // the entry the fallback just used and reintroduce the badge loss on the
    // next restart.
    const loader = setupLoader();
    registerMeshCoordinator({ meshId: 'mesh-renamed', sessionId: 'old-coordinator-id', workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });

    const manager = new DaemonCliManager({
      getServerConn: () => null,
      getP2p: () => null,
      onStatusChange: vi.fn(),
      removeAgentTracking: vi.fn(),
      getInstanceManager: () => ({ addInstance: vi.fn(), removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
      listHostedCliRuntimes: async () => [
        { runtimeId: 'new-coordinator-runtimeid', cliType: 'sample-cli', workspace: workingDir },
      ] as any,
    }, loader);

    const restored = await manager.restoreHostedSessions();

    expect(restored).toBe(1);
    // Fallback adopted the entry (single unambiguous coordinator for the
    // workspace) — and the adopted entry is exempt from the post-loop prune.
    expect(getCoordinatorForSession('old-coordinator-id')?.meshId).toBe('mesh-renamed');
    expect(readPersistedRegistry(configDir).map(e => e.sessionId)).toEqual(['old-coordinator-id']);
  }, 15000);
});
