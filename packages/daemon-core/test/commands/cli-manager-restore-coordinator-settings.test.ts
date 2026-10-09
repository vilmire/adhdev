import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { registerMeshCoordinator, unregisterMeshCoordinator } from '../../src/mesh/coordinator-registry.js';

// Regression: a daemon restart re-attaches hosted CLI runtimes via
// restoreHostedSessions. That path used to recreate instances with a bare {}
// settings object, diverging from a fresh launch (which seeds settings with
// providerLoader.getSettings(type) + the launch settingsOverride). The drop
// silently lost autoApprove (a provider/machine setting) AND meshCoordinatorFor
// (the coordinator launch override), so a restarted coordinator self-session
// lost auto-approve and stopped being recognized as a live coordinator. This
// asserts both launch settings are re-established on restore — provider-agnostic.

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

function createManager(loader: ProviderLoader, overrides: Partial<{
  getInstanceManager: () => any;
  getSessionRegistry: () => any;
}> = {}) {
  return new DaemonCliManager({
    getServerConn: () => null,
    getP2p: () => null,
    onStatusChange: vi.fn(),
    removeAgentTracking: vi.fn(),
    getInstanceManager: overrides.getInstanceManager || (() => null),
    getSessionRegistry: overrides.getSessionRegistry || (() => null),
  }, loader);
}

describe('DaemonCliManager.restoreHostedSessions re-establishes launch settings', () => {
  let providerRoot = '';
  let workingDir = '';
  let configDir = '';
  let prevConfigDir: string | undefined;
  let testConfig: { machineProviders: Record<string, { enabled?: boolean; executable?: string; args?: string[] }>; providerSettings: Record<string, Record<string, unknown>> };

  beforeEach(() => {
    providerRoot = mkdtempSync(join(tmpdir(), 'adhdev-restore-providers-'));
    workingDir = mkdtempSync(join(tmpdir(), 'adhdev-restore-workspace-'));
    configDir = mkdtempSync(join(tmpdir(), 'adhdev-restore-config-'));
    // Isolate the persisted coordinator registry writes (mesh-coordinators.json)
    // to a temp config dir so the test never touches the real ~/.adhdev.
    prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = configDir;
    testConfig = { machineProviders: {}, providerSettings: {} };
  });

  afterEach(() => {
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
    testConfig.providerSettings['sample-cli'] = { autoApprove: true };
    const loader = new TestProviderLoader(providerRoot, testConfig);
    loader.loadAll();
    return loader;
  }

  it('restores provider autoApprove and the coordinator mark for a registered coordinator session', async () => {
    const loader = setupLoader();
    const runtimeId = 'coordinator-runtime-1';
    const meshId = 'mesh-alpha';
    registerMeshCoordinator({ meshId, sessionId: runtimeId, workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });

    try {
      const addInstance = vi.fn();
      const removeInstance = vi.fn();
      const restored = await createManager(loader, {
        getInstanceManager: () => ({ addInstance, removeInstance, getInstance: () => null }),
        getSessionRegistry: () => ({ register: vi.fn() }),
      }).restoreHostedSessions([
        { runtimeId, cliType: 'sample-cli', workspace: workingDir },
      ]);

      expect(restored).toBe(1);
      expect(addInstance).toHaveBeenCalledTimes(1);
      const context = addInstance.mock.calls[0][2] as any;
      expect(context.settings).toMatchObject({ autoApprove: true, meshCoordinatorFor: meshId });
    } finally {
      unregisterMeshCoordinator(runtimeId);
    }
  }, 15000);

  it('restores the session\'s own auto-approve MODE persisted at launch (not just the provider default)', async () => {
    // A mode-declaring provider (claude-cli) launched with autoApproveMode came back
    // after a restart with only the provider default (auto-approve off) and asked
    // for every command (2026-10-02 standalone coordinator).
    const loader = setupLoader();
    testConfig.providerSettings['sample-cli'] = { autoApprove: false };
    const addInstance = vi.fn();
    const restored = await createManager(loader, {
      getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
    }).restoreHostedSessions([
      { runtimeId: 'session-with-mode', cliType: 'sample-cli', workspace: workingDir, autoApproveMode: 'pty-parse' },
    ]);
    expect(restored).toBe(1);
    const context = addInstance.mock.calls[0][2] as any;
    expect(context.settings).toMatchObject({ autoApproveMode: 'pty-parse' });
  }, 15000);

  it('CORDBADGE: rebinds the coordinator mark by workspace when the runtimeId no longer matches the registered sessionId', async () => {
    // The coordinator was registered under one sessionId, but on restart its runtime
    // re-attaches under a DIFFERENT runtimeId (registry survived, key no longer lines
    // up). The exact by-id lookup misses; the workspace-scoped fallback must recover the
    // mark from the single unambiguous coordinator registered for this workspace.
    const loader = setupLoader();
    const meshId = 'mesh-rebind';
    registerMeshCoordinator({ meshId, sessionId: 'old-coordinator-sessionid', workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });

    try {
      const addInstance = vi.fn();
      const restored = await createManager(loader, {
        getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
        getSessionRegistry: () => ({ register: vi.fn() }),
      }).restoreHostedSessions([
        // Restored under a NEW runtimeId that the registry has never seen.
        { runtimeId: 'new-coordinator-runtimeid', cliType: 'sample-cli', workspace: workingDir },
      ]);

      expect(restored).toBe(1);
      const context = addInstance.mock.calls[0][2] as any;
      expect(context.settings).toMatchObject({ autoApprove: true, meshCoordinatorFor: meshId });
    } finally {
      unregisterMeshCoordinator('old-coordinator-sessionid');
    }
  }, 15000);

  it('CORDBADGE guard: does NOT rebind by workspace when the registered coordinator cliType differs from the restored session', async () => {
    // A different provider is occupying the workspace — the persisted coordinator was a
    // hermes-cli, but the restored session is sample-cli. The cliType gate must refuse to
    // adopt the mark (rather than mis-mark a foreign session as the coordinator).
    const loader = setupLoader();
    registerMeshCoordinator({ meshId: 'mesh-other-provider', sessionId: 'hermes-coordinator', workspace: workingDir, startedAt: 1, cliType: 'hermes-cli' });

    try {
      const addInstance = vi.fn();
      const restored = await createManager(loader, {
        getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
        getSessionRegistry: () => ({ register: vi.fn() }),
      }).restoreHostedSessions([
        { runtimeId: 'sample-runtime', cliType: 'sample-cli', workspace: workingDir },
      ]);

      expect(restored).toBe(1);
      const context = addInstance.mock.calls[0][2] as any;
      expect(context.settings).toMatchObject({ autoApprove: true });
      expect(context.settings.meshCoordinatorFor).toBeUndefined();
    } finally {
      unregisterMeshCoordinator('hermes-coordinator');
    }
  }, 15000);

  it('CORDBADGE guard: does NOT rebind by workspace when two coordinators are registered for the same workspace (ambiguous)', async () => {
    // Two coordinator entries share the workspace → the fallback cannot tell which mesh
    // the restored session belongs to, so it must stay unbound rather than guess.
    const loader = setupLoader();
    registerMeshCoordinator({ meshId: 'mesh-one', sessionId: 'coord-one', workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });
    registerMeshCoordinator({ meshId: 'mesh-two', sessionId: 'coord-two', workspace: workingDir, startedAt: 2, cliType: 'sample-cli' });

    try {
      const addInstance = vi.fn();
      const restored = await createManager(loader, {
        getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
        getSessionRegistry: () => ({ register: vi.fn() }),
      }).restoreHostedSessions([
        { runtimeId: 'ambiguous-runtime', cliType: 'sample-cli', workspace: workingDir },
      ]);

      expect(restored).toBe(1);
      const context = addInstance.mock.calls[0][2] as any;
      expect(context.settings.meshCoordinatorFor).toBeUndefined();
    } finally {
      unregisterMeshCoordinator('coord-one');
      unregisterMeshCoordinator('coord-two');
    }
  }, 15000);

  it('CORDBADGE worker-overbind: a delegated worker sharing the coordinator workspace+cliType is NOT rebound while the real coordinator keeps its mark', async () => {
    // The reported bug: after a daemon restart, a delegated worker session that lives
    // in the SAME workspace+cliType as the real coordinator was painted as a coordinator.
    // The coordinator is registered and restores under its own (stable) runtimeId, so the
    // exact by-id match binds it. The worker's runtimeId is unknown to the registry, so it
    // hits the workspace fallback — which must refuse the mark because the coordinator is
    // already present under its own id (this record is therefore a worker).
    const loader = setupLoader();
    const meshId = 'mesh-coexist';
    const coordinatorRuntimeId = 'real-coordinator-runtime';
    const workerRuntimeId = 'delegated-worker-runtime';
    registerMeshCoordinator({ meshId, sessionId: coordinatorRuntimeId, workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });

    try {
      const addInstance = vi.fn();
      const restored = await createManager(loader, {
        getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
        getSessionRegistry: () => ({ register: vi.fn() }),
      }).restoreHostedSessions([
        { runtimeId: coordinatorRuntimeId, cliType: 'sample-cli', workspace: workingDir },
        { runtimeId: workerRuntimeId, cliType: 'sample-cli', workspace: workingDir },
      ]);

      expect(restored).toBe(2);
      const byRuntime = new Map<string, any>();
      for (const call of addInstance.mock.calls) byRuntime.set(call[0], call[2]);
      // Real coordinator keeps the mark (CORDBADGE regression preserved).
      expect(byRuntime.get(coordinatorRuntimeId).settings).toMatchObject({ autoApprove: true, meshCoordinatorFor: meshId });
      // Worker is restored but NOT marked as a coordinator.
      expect(byRuntime.get(workerRuntimeId).settings).toMatchObject({ autoApprove: true });
      expect(byRuntime.get(workerRuntimeId).settings.meshCoordinatorFor).toBeUndefined();
    } finally {
      unregisterMeshCoordinator(coordinatorRuntimeId);
    }
  }, 15000);

  it('CORDBADGE worker-overbind: when the coordinator id ALSO changed and a worker coexists, neither is rebound (ambiguous)', async () => {
    // Conservative tail: the coordinator re-attaches under a new runtimeId (registered id
    // is gone from the batch) AND a second same-workspace+cliType session is being restored.
    // We cannot tell which of the two is the renamed coordinator, so the fallback must stay
    // unbound for both rather than guess and risk marking the worker.
    const loader = setupLoader();
    registerMeshCoordinator({ meshId: 'mesh-ambig-batch', sessionId: 'gone-coordinator-id', workspace: workingDir, startedAt: 1, cliType: 'sample-cli' });

    try {
      const addInstance = vi.fn();
      const restored = await createManager(loader, {
        getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
        getSessionRegistry: () => ({ register: vi.fn() }),
      }).restoreHostedSessions([
        { runtimeId: 'unknown-runtime-a', cliType: 'sample-cli', workspace: workingDir },
        { runtimeId: 'unknown-runtime-b', cliType: 'sample-cli', workspace: workingDir },
      ]);

      expect(restored).toBe(2);
      for (const call of addInstance.mock.calls) {
        expect(call[2].settings.meshCoordinatorFor).toBeUndefined();
      }
    } finally {
      unregisterMeshCoordinator('gone-coordinator-id');
    }
  }, 15000);

  it('restores provider autoApprove but does not invent a coordinator mark for a plain session', async () => {
    const loader = setupLoader();
    const runtimeId = 'plain-runtime-1';

    const addInstance = vi.fn();
    const removeInstance = vi.fn();
    const restored = await createManager(loader, {
      getInstanceManager: () => ({ addInstance, removeInstance, getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
    }).restoreHostedSessions([
      { runtimeId, cliType: 'sample-cli', workspace: workingDir },
    ]);

    expect(restored).toBe(1);
    expect(addInstance).toHaveBeenCalledTimes(1);
    const context = addInstance.mock.calls[0][2] as any;
    expect(context.settings).toMatchObject({ autoApprove: true });
    expect(context.settings.meshCoordinatorFor).toBeUndefined();
  }, 15000);

  it('RC20 REBOUND RELAY ENVELOPE: restores session-level mesh membership from the runtime record (never task-level markers)', async () => {
    // A rebound LOCAL mesh worker must keep its relay/routing envelope across the
    // daemon restart: meshNodeFor/meshNodeId/launchedByCoordinator were persisted
    // into the session-host record meta at launch/dispatch time and are the
    // DURABLE authority for session membership. Without the restore the worker's
    // first post-restart event failed resolveWorkerDelegateRouting
    // (no_worker_envelope) and the post-completion detach did a full clear.
    // TASK-level markers (meshActiveTaskId/attemptId/nonce) stay OUT — they are
    // re-derived with causal guards by restampReboundMeshWorkerAssignment.
    const loader = setupLoader();
    const addInstance = vi.fn();
    const restored = await createManager(loader, {
      getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
    }).restoreHostedSessions([
      {
        runtimeId: 'mesh-worker-runtime-1',
        cliType: 'sample-cli',
        workspace: workingDir,
        meshNodeFor: 'mesh-w',
        meshNodeId: 'nodeA',
        launchedByCoordinator: true,
      },
    ]);

    expect(restored).toBe(1);
    const context = addInstance.mock.calls[0][2] as any;
    expect(context.settings).toMatchObject({
      autoApprove: true,
      meshNodeFor: 'mesh-w',
      meshNodeId: 'nodeA',
      meshLastNodeId: 'nodeA',
      launchedByCoordinator: true,
    });
    // Membership is not the coordinator mark, and no task envelope is resurrected.
    expect(context.settings.meshCoordinatorFor).toBeUndefined();
    expect(context.settings.meshActiveTaskId).toBeUndefined();
    expect(context.settings.meshActiveAttemptId).toBeUndefined();
    expect(context.settings.meshActiveDispatchNonce).toBeUndefined();
  }, 15000);

  // Live 2026-10-08 (preview 1.0.79-rc.1): a claude-cli worker on Jupiter whose
  // task the Mac owned survived a forced restart of Jupiter's daemon with its
  // bind intact, but its report_completion was refused "the bind is live, but its
  // session holds no assigned task here" — the restored settings had membership
  // and no meshCoordinatorDaemonId, so the remote-owner forward path could not
  // name the owner. The owner id persisted in the record meta is restored with
  // the membership (and never without it).
  it('restores the work-owner daemon id with the mesh membership, never on its own', async () => {
    const loader = setupLoader();
    const addInstance = vi.fn();
    const restored = await createManager(loader, {
      getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
    }).restoreHostedSessions([
      { runtimeId: 'remote-owned-worker-1', cliType: 'sample-cli', workspace: workingDir, meshNodeFor: 'mesh-w', meshNodeId: 'nodeA', meshCoordinatorDaemonId: 'daemon_mach_owner', launchedByCoordinator: true },
      { runtimeId: 'plain-with-stray-owner-2', cliType: 'sample-cli', workspace: workingDir, meshCoordinatorDaemonId: 'daemon_mach_owner' },
    ]);
    expect(restored).toBe(2);
    const contexts = addInstance.mock.calls.map((c: any[]) => c[2] as any);
    const worker = contexts.find((c) => c.settings.meshNodeFor === 'mesh-w');
    expect(worker?.settings.meshCoordinatorDaemonId).toBe('daemon_mach_owner');
    expect(worker?.settings.meshActiveTaskId).toBeUndefined();
    const plain = contexts.find((c) => c.settings.meshNodeFor === undefined);
    expect(plain?.settings.meshCoordinatorDaemonId).toBeUndefined();
  }, 15000);

  // Live 2026-10-09 (preview): the same Jupiter worker restarted MID-TURN. The
  // restored session had membership + owner but no attempt ref, so its idle edge
  // was an untagged turn_end the worker ledger refused to forward
  // (forward_without_attempt_ref) and the Mac logged "no idle edge within 60s of
  // the worker report". The persisted attempt ref is restored with membership +
  // owner (never without them), and the task markers still stay out.
  it('restores the evidence attempt ref with membership + owner, never on its own', async () => {
    const loader = setupLoader();
    const addInstance = vi.fn();
    const ref = { attemptId: 'mesh_direct:task-8e69', generation: 2 };
    const restored = await createManager(loader, {
      getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
    }).restoreHostedSessions([
      { runtimeId: 'remote-owned-worker-1', cliType: 'sample-cli', workspace: workingDir, meshNodeFor: 'mesh-w', meshNodeId: 'nodeA', meshCoordinatorDaemonId: 'daemon_mach_owner', meshActiveAttemptRef: ref, launchedByCoordinator: true },
      { runtimeId: 'member-without-owner-2', cliType: 'sample-cli', workspace: workingDir, meshNodeFor: 'mesh-x', meshNodeId: 'nodeB', meshActiveAttemptRef: ref, launchedByCoordinator: true },
      { runtimeId: 'plain-with-stray-ref-3', cliType: 'sample-cli', workspace: workingDir, meshActiveAttemptRef: ref },
    ]);
    expect(restored).toBe(3);
    const contexts = addInstance.mock.calls.map((c: any[]) => c[2] as any);
    const worker = contexts.find((c) => c.settings.meshNodeFor === 'mesh-w');
    expect(worker?.settings).toMatchObject({ meshActiveAttemptId: ref.attemptId, meshActiveAttemptGeneration: 2 });
    expect(worker?.settings.meshActiveTaskId).toBeUndefined();
    expect(worker?.settings.meshActiveDispatchNonce).toBeUndefined();
    const ownerless = contexts.find((c) => c.settings.meshNodeFor === 'mesh-x');
    expect(ownerless?.settings.meshActiveAttemptId).toBeUndefined();
    const plain = contexts.find((c) => c.settings.meshNodeFor === undefined);
    expect(plain?.settings.meshActiveAttemptId).toBeUndefined();
  }, 15000);

  it('RC20 REBOUND RELAY ENVELOPE: does not invent mesh membership for a plain session', async () => {
    const loader = setupLoader();
    const addInstance = vi.fn();
    const restored = await createManager(loader, {
      getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
      getSessionRegistry: () => ({ register: vi.fn() }),
    }).restoreHostedSessions([
      { runtimeId: 'plain-runtime-2', cliType: 'sample-cli', workspace: workingDir },
    ]);

    expect(restored).toBe(1);
    const context = addInstance.mock.calls[0][2] as any;
    expect(context.settings.meshNodeFor).toBeUndefined();
    expect(context.settings.meshNodeId).toBeUndefined();
    expect(context.settings.meshLastNodeId).toBeUndefined();
    expect(context.settings.launchedByCoordinator).toBeUndefined();
  }, 15000);
});
