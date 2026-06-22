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
});
