import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { buildSessionLaunchRecord } from '../../src/sessions/launch-record.js';

// Phase E (wiring-unification §7 E1, RC5): every launch path writes a
// SessionLaunchRecord whose `source` says where the model / thinking value came
// from. These drive the real startSession / launchCli / restoreHostedSessions
// against a real SessionRegistry; only the provider instance is faked.

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
  constructor(userDir: string, private readonly testConfig: Record<string, any>) {
    super({ userDir, disableUpstream: true });
  }
  protected override readConfig(): any | null { return this.testConfig; }
  protected override writeConfig(config: any): void { Object.assign(this.testConfig, config); }
}

describe('Phase E — launch record on every cli-manager launch path', () => {
  let providerRoot = '';
  let workingDir = '';
  let configDir = '';
  let prevConfigDir: string | undefined;
  let registry: SessionRegistry;
  let addInstance: ReturnType<typeof vi.fn>;

  function setupLoader() {
    const testConfig: Record<string, any> = { machineProviders: {}, providerSettings: {} };
    for (const [category, type] of [['cli', 'sample-cli'], ['acp', 'sample-acp']] as const) {
      const executable = join(providerRoot, 'bin', type);
      mkdirSync(join(providerRoot, 'bin'), { recursive: true });
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf-8');
      chmodSync(executable, 0o755);
      testConfig.machineProviders[type] = { enabled: true, executable };
      writeProvider(providerRoot, category, type, {
        type,
        name: type,
        displayName: type,
        category,
        spawn: { command: `${type}-definitely-missing` },
        patterns: ['sample'],
        modelOptions: ['Opus Label', 'sonnet'],
        ...(category === 'cli'
          ? {
            modelLaunchArgs: ['--model', '{{model}}'],
            modelLaunchValueMap: { 'Opus Label': 'opus' },
            thinkingLaunchArgs: ['--effort', '{{level}}'],
          }
          : {}),
      });
    }
    const loader = new TestProviderLoader(providerRoot, testConfig);
    loader.loadAll();
    return loader;
  }

  function createManager(loader: ProviderLoader) {
    return new DaemonCliManager({
      getServerConn: () => null,
      getP2p: () => null,
      onStatusChange: vi.fn(),
      removeAgentTracking: vi.fn(),
      getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }) as any,
      getSessionRegistry: () => registry,
    }, loader);
  }

  beforeEach(() => {
    providerRoot = mkdtempSync(join(tmpdir(), 'adhdev-launch-record-providers-'));
    workingDir = mkdtempSync(join(tmpdir(), 'adhdev-launch-record-workspace-'));
    configDir = mkdtempSync(join(tmpdir(), 'adhdev-launch-record-config-'));
    prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = configDir;
    registry = new SessionRegistry();
    addInstance = vi.fn();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
    for (const dir of [providerRoot, workingDir, configDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('CLI, dashboard pick: source user, launchValue after modelLaunchValueMap', async () => {
    const result = await createManager(setupLoader()).launchCli({
      cliType: 'sample-cli',
      dir: workingDir,
      initialModel: 'Opus Label',
      initialThinkingLevel: 'high',
      modelSource: 'user',
      thinkingLevelSource: 'user',
      launchedBy: 'dashboard',
    });
    const launch = registry.get(result.sessionId as string)?.launch;
    expect(launch).toMatchObject({ providerType: 'sample-cli', launchedBy: 'dashboard', workspace: expect.any(String) });
    expect(launch?.model).toMatchObject({ requested: 'Opus Label', source: 'user', launchValue: 'opus' });
    expect(launch?.thinkingLevel).toMatchObject({ requested: 'high', source: 'user', launchValue: 'high' });
  }, 15000);

  it('CLI, remembered value: the dialog-declared source is kept verbatim', async () => {
    const result = await createManager(setupLoader()).launchCli({
      cliType: 'sample-cli', dir: workingDir, initialModel: 'sonnet', modelSource: 'remembered', launchedBy: 'dashboard',
    });
    expect(registry.get(result.sessionId as string)?.launch?.model.source).toBe('remembered');
  }, 15000);

  it('CLI, a model with no declared source is unspecified (old caller)', async () => {
    const result = await createManager(setupLoader()).launchCli({ cliType: 'sample-cli', dir: workingDir, initialModel: 'sonnet' });
    const launch = registry.get(result.sessionId as string)?.launch;
    expect(launch?.model.source).toBe('unspecified');
    expect(launch?.launchedBy).toBe('api');
  }, 15000);

  it('CLI, nothing requested: provider_default resolved from the manifest (label → slug)', async () => {
    const result = await createManager(setupLoader()).launchCli({ cliType: 'sample-cli', dir: workingDir, launchedBy: 'cli' });
    const launch = registry.get(result.sessionId as string)?.launch;
    expect(launch?.launchedBy).toBe('cli');
    expect(launch?.model).toEqual({
      source: 'provider_default',
      resolvedDefault: 'opus',
      history: [{ at: expect.any(Number), value: 'opus', via: 'launch' }],
    });
    expect(launch?.thinkingLevel).toEqual({ source: 'unspecified', history: [] });
  }, 15000);

  it('CLI, mesh settings without an explicit launcher → launchedBy mesh', async () => {
    const result = await createManager(setupLoader()).launchCli({
      cliType: 'sample-cli', dir: workingDir, initialModel: 'sonnet', modelSource: 'mesh_slot',
      settings: { meshCoordinatorFor: 'mesh-1' },
    });
    const launch = registry.get(result.sessionId as string)?.launch;
    expect(launch?.launchedBy).toBe('mesh');
    expect(launch?.model.source).toBe('mesh_slot');
  }, 15000);

  it('CLI, the record is seeded into the session-host meta for restore', async () => {
    const updateRuntimeMeta = vi.fn();
    addInstance.mockImplementation(async (_key: string, instance: any) => {
      instance.getAdapter = () => ({ updateRuntimeMeta });
    });
    const result = await createManager(setupLoader()).launchCli({
      cliType: 'sample-cli', dir: workingDir, initialModel: 'sonnet', modelSource: 'user', launchedBy: 'dashboard',
    });
    const meta = updateRuntimeMeta.mock.calls.map((call) => call[0]).find((m) => m.launchRecord);
    expect(meta?.launchRecord).toMatchObject({ sessionId: result.sessionId, launchedBy: 'dashboard', model: { source: 'user' } });
  }, 15000);

  it('ACP: a failed setConfigOption leaves launchValue absent but keeps the requested value + source', async () => {
    const result = await createManager(setupLoader()).launchCli({
      cliType: 'sample-acp', dir: workingDir, initialModel: 'sonnet', modelSource: 'user', launchedBy: 'dashboard',
    });
    const launch = registry.get(result.sessionId as string)?.launch;
    expect(launch).toMatchObject({ providerType: 'sample-acp', launchedBy: 'dashboard' });
    expect(launch?.model).toMatchObject({ requested: 'sonnet', source: 'user' });
    expect(launch?.model).not.toHaveProperty('launchValue');
  }, 15000);

  it('restore: axis sources survive, launchedBy becomes restore', async () => {
    const stored = buildSessionLaunchRecord({
      sessionId: 'runtime-restore-1',
      providerType: 'sample-cli',
      launchedBy: 'dashboard',
      launchedAt: 100,
      model: { requested: 'sonnet', declaredSource: 'remembered', launchValue: 'sonnet' },
      thinkingLevel: { requested: 'high', declaredSource: 'user', launchValue: 'high' },
    });
    const restored = await createManager(setupLoader()).restoreHostedSessions([
      { runtimeId: 'runtime-restore-1', cliType: 'sample-cli', workspace: workingDir, launchRecord: JSON.parse(JSON.stringify(stored)) },
    ]);
    expect(restored).toBe(1);
    const launch = registry.get('runtime-restore-1')?.launch;
    expect(launch?.launchedBy).toBe('restore');
    expect(launch?.model).toEqual(stored.model);
    expect(launch?.thinkingLevel.source).toBe('user');
  }, 15000);

  it('restore of a pre-Phase-E runtime: an unspecified record, not none', async () => {
    await createManager(setupLoader()).restoreHostedSessions([
      { runtimeId: 'runtime-legacy', cliType: 'sample-cli', workspace: workingDir },
    ]);
    const launch = registry.get('runtime-legacy')?.launch;
    expect(launch).toMatchObject({ launchedBy: 'restore', model: { source: 'unspecified' } });
  }, 15000);
});
