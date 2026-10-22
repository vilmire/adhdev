/**
 * Assistant restore (design 2026-10-07-assistant-layer.md §4.5, §4.8): a hosted
 * runtime re-binds by exact ID or unambiguous persisted assistant provenance.
 * Approval stays off by default; only its owning host may prune the binding.
 */
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { registerMeshCoordinator, unregisterMeshCoordinator, getCoordinatorForSession, loadMeshCoordinatorRegistry } from '../../src/mesh/coordinator-registry.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';

class TestProviderLoader extends ProviderLoader {
  constructor(userDir: string, private readonly testConfig: any) {
    super({ userDir, disableUpstream: true });
  }
  protected override readConfig(): any | null { return this.testConfig; }
  protected override writeConfig(config: any): void { Object.assign(this.testConfig, config); }
}

const previewOwner = { namespace: 'review-preview', endpoint: 'unix:/tmp/adhdev-preview.sock', managedBy: 'adhdev-cloud', clientId: 'daemon_test' };
const foreignOwner = { namespace: 'review-foreign', endpoint: 'unix:/tmp/adhdev-standalone.sock', managedBy: 'adhdev-standalone', clientId: 'standalone_test' };
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
    getHostedBindingOwner: () => previewOwner,
    hostedRuntimeManagerTag: previewOwner.managedBy,
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
  registry.bindSession({ sessionId: 'asst-runtime-1', cliType: 'sample-cli', workspace, hostOwner: previewOwner, at: 1 });
});

afterEach(() => {
  for (const id of ['coord-1', 'coord-2']) unregisterMeshCoordinator(id);
  setAssistantRegistryForTests(null);
  if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
  else process.env.ADHDEV_CONFIG_DIR = prevConfigDir;
  for (const d of [root, workspace, configDir]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('restoreHostedSessions — assistant re-bind', () => {
  it('prunes a dead self-owned binding before selecting one live marked assistant', async () => {
    const m = manager(setupLoader(), vi.fn(), async () => [{ runtimeId: 'live-replacement', cliType: 'sample-cli', workspace, assistant: true }]);
    vi.spyOn(m, 'registerCliInstance').mockResolvedValue(undefined);
    expect(await m.restoreHostedSessions()).toBe(1);
    expect(registry.reload()?.sessionId).toBe('live-replacement');
  });

  it.each(['starting', 'stopping'])('does not attach %s runtimes', async lifecycle => {
    const m = manager(setupLoader(), vi.fn());
    const attach = vi.spyOn(m, 'registerCliInstance').mockResolvedValue(undefined);
    expect(await m.restoreHostedSessions([{ runtimeId: 'asst-runtime-1', cliType: 'sample-cli', workspace, lifecycle } as any])).toBe(0);
    expect(attach).not.toHaveBeenCalled();
  });

  it('a partial restore cannot satisfy or finish the pending full restore', async () => {
    let finish!: (records: any[]) => void;
    const list = vi.fn(() => new Promise<any[]>(resolve => { finish = resolve; }));
    const m = manager(setupLoader(), vi.fn(), list);
    m.hostedRestoreState = 'pending';
    vi.spyOn(m, 'registerCliInstance').mockResolvedValue(undefined);
    const partial = m.restoreHostedSessions([{ runtimeId: 'partial', cliType: 'sample-cli', workspace }]);
    const full = m.restoreHostedSessions();
    await partial;
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(m.hostedRestoreState).toBe('pending');
    finish([]);
    await full;
    expect(m.hostedRestoreState).toBe('ready');
  });

  it('migrates a coordinator adopted through the workspace fallback', async () => {
    registerMeshCoordinator({ meshId: 'mesh-fallback', sessionId: 'coord-1', workspace, cliType: 'sample-cli', startedAt: 1 });
    const m = manager(setupLoader(), vi.fn());
    vi.spyOn(m, 'registerCliInstance').mockResolvedValue(undefined);
    await m.restoreHostedSessions([{ runtimeId: 'new-coordinator-id', cliType: 'sample-cli', workspace }]);
    expect(getCoordinatorForSession('coord-1')?.hostOwner).toEqual(previewOwner);
  });

  it.each([foreignOwner, { ...previewOwner, endpoint: foreignOwner.endpoint }])('a foreign empty inventory preserves assistant and both coordinator bindings across a fresh preview restore (%j)', async foreign => {
    for (const id of ['coord-1', 'coord-2']) registerMeshCoordinator({ meshId: id, sessionId: id,
      workspace, cliType: 'sample-cli', startedAt: 1, hostOwner: previewOwner });
    const standalone = manager(setupLoader(), vi.fn(), async () => []);
    standalone.deps.getHostedBindingOwner = () => foreign;
    standalone.deps.hostedRuntimeManagerTag = foreign.managedBy;
    await standalone.restoreHostedSessions();
    registry = new AssistantRegistry({ configDir });
    setAssistantRegistryForTests(registry);
    loadMeshCoordinatorRegistry();
    expect(registry.read()).toMatchObject({ sessionId: 'asst-runtime-1', hostOwner: previewOwner });
    for (const id of ['coord-1', 'coord-2']) expect(getCoordinatorForSession(id)?.sessionId).toBe(id);
    const addInstance = vi.fn();
    await manager(setupLoader(), addInstance, async () => [{ runtimeId: 'asst-runtime-1', cliType: 'sample-cli',
      workspace, assistant: true, providerSessionId: 'saved-native-conversation', managedBy: previewOwner.managedBy }]).restoreHostedSessions();
    expect(addInstance.mock.calls[0][0]).toBe('asst-runtime-1');
    expect(addInstance.mock.calls[0][2].settings).toMatchObject({ assistant: true, autoApprove: false });
    expect(registry.read()?.sessionId).toBe('asst-runtime-1');
  }, 15000);

  it('a foreign empty inventory cannot prune either coordinator when the assistant binding is already absent', async () => {
    registry.releaseSession('asst-runtime-1', 'pty_exit');
    for (const id of ['coord-1', 'coord-2']) registerMeshCoordinator({ meshId: id, sessionId: id,
      workspace, cliType: 'sample-cli', startedAt: 1, hostOwner: previewOwner });
    const standalone = manager(setupLoader(), vi.fn(), async () => []);
    standalone.deps.getHostedBindingOwner = () => foreignOwner;
    standalone.deps.hostedRuntimeManagerTag = foreignOwner.managedBy;
    await standalone.restoreHostedSessions();
    loadMeshCoordinatorRegistry();
    expect(['coord-1', 'coord-2'].map(id => getCoordinatorForSession(id)?.sessionId)).toEqual(['coord-1', 'coord-2']);
  }, 15000);

  it('unknown ownership and an unsuccessful inventory never prune shared bindings', async () => {
    registry.bindSession({ sessionId: 'asst-runtime-1', cliType: 'sample-cli', workspace, at: 1 });
    // Legacy disk record without host scope.
    const raw = JSON.parse(readFileSync(registry.path, 'utf8'));
    delete raw.hostOwner;
    writeFileSync(registry.path, JSON.stringify(raw));
    registry.reload();
    registerMeshCoordinator({ meshId: 'coord-1', sessionId: 'coord-1', workspace, startedAt: 1 });
    await manager(setupLoader(), vi.fn(), async () => []).restoreHostedSessions();
    expect(registry.reload()?.sessionId).toBe('asst-runtime-1');
    expect(getCoordinatorForSession('coord-1')).toBeDefined();
    const failed = manager(setupLoader(), vi.fn(), async () => { throw new Error('inventory failed'); });
    await expect(failed.restoreHostedSessions()).rejects.toThrow('inventory failed');
    expect(failed.hostedRestoreState).toBe('failed');
    expect(registry.reload()?.sessionId).toBe('asst-runtime-1');
    expect(getCoordinatorForSession('coord-1')).toBeDefined();
    const localTombstones = join(configDir, 'session-host', previewOwner.namespace, 'tombstones');
    mkdirSync(localTombstones, { recursive: true });
    for (const sessionId of ['asst-runtime-1', 'coord-1']) {
      writeFileSync(join(localTombstones, `${sessionId}.json`), JSON.stringify({ sessionId, termination: { lifecycle: 'stopped' } }));
    }
    await manager(setupLoader(), vi.fn(), async () => []).restoreHostedSessions();
    expect(registry.reload()?.sessionId).toBeNull();
    expect(getCoordinatorForSession('coord-1')).toBeUndefined();
  }, 15000);

  it('rebinds a cleared registry from persisted assistant provenance without marking an ordinary workspace sibling', async () => {
    registry.releaseSession('asst-runtime-1', 'pty_exit');
    registry = new AssistantRegistry({ configDir });
    setAssistantRegistryForTests(registry);
    const addInstance = vi.fn();
    await manager(setupLoader(), addInstance).restoreHostedSessions([
      { runtimeId: 'asst-runtime-1', cliType: 'sample-cli', workspace, assistant: true, providerSessionId: 'saved-native-conversation' },
      { runtimeId: 'ordinary', cliType: 'sample-cli', workspace },
    ]);
    expect(addInstance.mock.calls[0][2].settings).toMatchObject({ assistant: true, autoApprove: false });
    expect(addInstance.mock.calls[1][2].settings.assistant).toBeUndefined();
    expect(new AssistantRegistry({ configDir }).read()).toMatchObject({ sessionId: 'asst-runtime-1', hostOwner: previewOwner });
  }, 15000);

  it('accepts validated assistant launch provenance but rejects workspace/title and mismatched launch identities', async () => {
    registry.releaseSession('asst-runtime-1', 'pty_exit');
    const addInstance = vi.fn();
    const launchRecord = { sessionId: 'asst-runtime-1', providerType: 'sample-cli', launchedBy: 'assistant',
      launchedAt: 1, model: {}, thinkingLevel: {} };
    await manager(setupLoader(), addInstance).restoreHostedSessions([
      { runtimeId: 'asst-runtime-1', cliType: 'sample-cli', workspace, launchRecord },
      { runtimeId: 'ordinary', cliType: 'sample-cli', workspace, displayName: 'Assistant', launchRecord },
    ]);
    expect(addInstance.mock.calls[0][2].settings.assistant).toBe(true);
    expect(addInstance.mock.calls[1][2].settings.assistant).toBeUndefined();
    expect(registry.reload()?.sessionId).toBe('asst-runtime-1');
  }, 15000);

  it('does not bind failed attachments or conflicting assistant provenance', async () => {
    registry.releaseSession('asst-runtime-1', 'pty_exit');
    const m = manager(setupLoader(), vi.fn());
    vi.spyOn(m, 'registerCliInstance').mockRejectedValue(new Error('attach failed'));
    const record = { runtimeId: 'asst-runtime-1', cliType: 'sample-cli', workspace, assistant: true };
    await m.restoreHostedSessions([record]);
    expect(registry.reload()?.sessionId).toBeNull();
    await expect(m.restoreHostedSessions([record, { ...record, runtimeId: 'conflicting' }])).rejects.toThrow('assistant_identity_conflict');
    expect(registry.reload()?.sessionId).toBeNull();
  }, 15000);

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
