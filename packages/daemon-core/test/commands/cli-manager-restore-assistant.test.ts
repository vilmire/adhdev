/**
 * Assistant restore (design 2026-10-07-assistant-layer.md §4.5, §4.8): a hosted
 * runtime re-binds to the assistant by EXACT runtimeId only — it gets
 * `assistant: true` and stays off auto-approve even when the provider default
 * turns it on; nothing else is marked; and the full boot restore clears a
 * binding whose runtime is gone (`pruneAfterRestore`, full set only).
 */
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';

class TestProviderLoader extends ProviderLoader {
  constructor(userDir: string, private readonly testConfig: any) {
    super({ userDir, disableUpstream: true });
  }
  protected override readConfig(): any | null { return this.testConfig; }
  protected override writeConfig(config: any): void { Object.assign(this.testConfig, config); }
}

let root = '';
let workspace = '';
let configDir = '';
let prevConfigDir: string | undefined;
let registry: AssistantRegistry;

function setupLoader(): ProviderLoader {
  const dir = join(root, 'cli', 'sample-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({
    type: 'sample-cli', name: 'Sample CLI', category: 'cli', spawn: { command: 'sample-cli-definitely-missing' },
    patterns: ['sample'], settings: { autoApprove: { type: 'boolean', default: false, public: true } },
  }), 'utf-8');
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    $schema: 'adhdev:cli/spec@4', id: 'sample-cli', name: 'sample-cli', binary: 'sample-cli',
    send_message: { submit_key: '\r' }, sections: {},
    states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }], transitions: [],
  }), 'utf-8');
  const executable = join(root, 'bin', 'sample-cli');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(executable, 0o755);
  const loader = new TestProviderLoader(root, {
    machineProviders: { 'sample-cli': { enabled: true, executable } },
    providerSettings: { 'sample-cli': { autoApprove: true } },
  });
  loader.loadAll();
  return loader;
}

function manager(loader: ProviderLoader, addInstance: ReturnType<typeof vi.fn>, listHosted?: () => Promise<any[]>) {
  return new DaemonCliManager({
    getServerConn: () => null,
    getP2p: () => null,
    onStatusChange: vi.fn(),
    removeAgentTracking: vi.fn(),
    getInstanceManager: () => ({ addInstance, removeInstance: vi.fn(), getInstance: () => null }),
    getSessionRegistry: () => ({ register: vi.fn() }),
    ...(listHosted ? { listHostedCliRuntimes: listHosted } : {}),
  } as any, loader);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adhdev-restore-asst-providers-'));
  workspace = mkdtempSync(join(tmpdir(), 'adhdev-restore-asst-ws-'));
  configDir = mkdtempSync(join(tmpdir(), 'adhdev-restore-asst-config-'));
  prevConfigDir = process.env.ADHDEV_CONFIG_DIR;
  process.env.ADHDEV_CONFIG_DIR = configDir;
  registry = new AssistantRegistry({ configDir });
  setAssistantRegistryForTests(registry);
  registry.bindSession({ sessionId: 'asst-runtime-1', cliType: 'sample-cli', workspace, at: 1 });
});

afterEach(() => {
  setAssistantRegistryForTests(null);
  if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
  else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
  for (const d of [root, workspace, configDir]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('restoreHostedSessions — assistant re-bind', () => {
  it('marks only the exact-runtimeId record, with auto-approve forced off', async () => {
    const addInstance = vi.fn();
    const restored = await manager(setupLoader(), addInstance).restoreHostedSessions([
      { runtimeId: 'asst-runtime-1', cliType: 'sample-cli', workspace },
      { runtimeId: 'ASST-RUNTIME-1', cliType: 'sample-cli', workspace: `${workspace}-other` },
    ] as any);
    expect(restored).toBe(2);
    const settings = addInstance.mock.calls.map((c) => (c[2] as any).settings);
    const asst = settings.find((s) => s.assistant === true);
    expect(asst).toMatchObject({ assistant: true, autoApprove: false });
    expect(asst.autoApproveMode).toBeUndefined();
    expect(settings.filter((s) => s.assistant === true)).toHaveLength(1);
    expect(settings.find((s) => s.assistant !== true)).toMatchObject({ autoApprove: true });
    expect(registry.read()?.sessionId).toBe('asst-runtime-1');
  }, 15000);

  it('keeps an approval mode the assistant session itself carried', async () => {
    const addInstance = vi.fn();
    await manager(setupLoader(), addInstance).restoreHostedSessions([
      { runtimeId: 'asst-runtime-1', cliType: 'sample-cli', workspace, autoApproveMode: 'accept-edits' },
    ] as any);
    expect((addInstance.mock.calls[0][2] as any).settings).toMatchObject({ assistant: true, autoApproveMode: 'accept-edits' });
  }, 15000);

  it('full boot restore clears a binding whose runtime is not live; a partial restore never prunes', async () => {
    const other = [{ runtimeId: 'someone-else', cliType: 'sample-cli', workspace }];
    await manager(setupLoader(), vi.fn(), async () => other).restoreHostedSessions(other as any);
    expect(registry.read()?.sessionId).toBe('asst-runtime-1');
    await manager(setupLoader(), vi.fn(), async () => other).restoreHostedSessions();
    expect(registry.read()?.sessionId).toBeNull();
    expect(registry.read()?.cliType).toBe('sample-cli'); // entry (settings/history) kept
  }, 15000);
});
