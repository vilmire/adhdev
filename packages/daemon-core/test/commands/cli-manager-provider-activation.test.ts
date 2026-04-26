import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';

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

describe('DaemonCliManager provider activation', () => {
  let providerRoot = '';
  let workingDir = '';
  let testConfig: { machineProviders: Record<string, { enabled?: boolean; executable?: string; args?: string[] }>; providerSettings: Record<string, Record<string, unknown>> };

  beforeEach(() => {
    providerRoot = mkdtempSync(join(tmpdir(), 'adhdev-cli-manager-providers-'));
    workingDir = mkdtempSync(join(tmpdir(), 'adhdev-cli-manager-workspace-'));
    testConfig = { machineProviders: {}, providerSettings: {} };
  });

  afterEach(() => {
    if (providerRoot) rmSync(providerRoot, { recursive: true, force: true });
    if (workingDir) rmSync(workingDir, { recursive: true, force: true });
  });

  it('rejects a direct CLI runtime launch when the provider is not machine-enabled', async () => {
    writeProvider(providerRoot, 'cli', 'sample-cli', {
      type: 'sample-cli',
      name: 'Sample CLI',
      displayName: 'Sample CLI',
      category: 'cli',
      patterns: ['sample'],
      spawn: { command: 'sample-cli-definitely-missing' },
    });
    const loader = new TestProviderLoader(providerRoot, testConfig);
    loader.loadAll();

    await expect(createManager(loader).startSession('sample-cli', workingDir)).rejects.toThrow(
      /Sample CLI is disabled/i,
    );
  });

  it('rejects a direct ACP runtime launch when the provider is not machine-enabled', async () => {
    writeProvider(providerRoot, 'acp', 'sample-acp', {
      type: 'sample-acp',
      name: 'Sample ACP',
      displayName: 'Sample ACP',
      category: 'acp',
      spawn: { command: 'sample-acp-definitely-missing', args: ['--stdio'] },
    });
    const loader = new TestProviderLoader(providerRoot, testConfig);
    loader.loadAll();

    await expect(createManager(loader).startSession('sample-acp', workingDir)).rejects.toThrow(
      /Sample ACP is disabled/i,
    );
  });

  it('uses machine executable and argv overrides for enabled ACP runtime launches', async () => {
    const executable = join(providerRoot, 'bin', 'sample-acp');
    mkdirSync(join(providerRoot, 'bin'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf-8');
    chmodSync(executable, 0o755);

    writeProvider(providerRoot, 'acp', 'sample-acp', {
      type: 'sample-acp',
      name: 'Sample ACP',
      displayName: 'Sample ACP',
      category: 'acp',
      spawn: { command: 'sample-acp-definitely-missing', args: ['--stdio'] },
    });
    testConfig.machineProviders['sample-acp'] = {
      enabled: true,
      executable,
      args: ['agent', '--profile', 'work tree'],
    };
    const loader = new TestProviderLoader(providerRoot, testConfig);
    loader.loadAll();

    const addInstance = vi.fn();
    const removeInstance = vi.fn();
    await createManager(loader, {
      getInstanceManager: () => ({ addInstance, removeInstance }),
      getSessionRegistry: () => ({ register: vi.fn() }),
    }).startSession('sample-acp', workingDir);

    expect(addInstance).toHaveBeenCalledTimes(1);
    const acpInstance = addInstance.mock.calls[0][1] as any;
    expect(acpInstance.provider.spawn.command).toBe(executable);
    expect(acpInstance.provider.spawn.args).toEqual(['agent', '--profile', 'work tree']);
  });
});
