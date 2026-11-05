import { describe, it, expect, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  spawnHelper: vi.fn(),
}));

vi.mock('../../src/commands/upgrade-install-surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/commands/upgrade-install-surface.js')>()),
  resolveNpmPublishedVersionAsync: mocks.lookup,
  execNpmCommandAsync: async () => '{}',
  resolveCurrentGlobalInstallSurface: () => ({ npmExecutable: 'npm', npmArgsPrefix: [], packageRoot: null, installPrefix: null }),
}));
vi.mock('../../src/commands/upgrade-helper.js', () => ({ spawnDetachedDaemonUpgradeHelper: mocks.spawnHelper }));

import { daemonLifecycleHandlers } from '../../src/commands/low-family/daemon-lifecycle.js';

const ctx = { deps: { statusVersion: '1.0.0', packageName: 'adhdev' } } as any;

describe('daemon_upgrade single flight', () => {
  afterEach(() => vi.clearAllMocks());

  it('refuses a request that arrives while the version lookup is pending', async () => {
    let finish!: (version: string) => void;
    mocks.lookup.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = daemonLifecycleHandlers.daemon_upgrade(ctx, {});
    const second = await daemonLifecycleHandlers.daemon_upgrade(ctx, {});
    expect(second).toMatchObject({ success: false, code: 'upgrade_in_progress' });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    finish('1.0.0');
    await first;
  });

  it('allows a new attempt after a failed lookup', async () => {
    mocks.lookup.mockRejectedValueOnce(new Error('registry down'));
    expect(await daemonLifecycleHandlers.daemon_upgrade(ctx, {})).toMatchObject({ success: false, error: 'registry down' });
    mocks.lookup.mockRejectedValueOnce(new Error('registry still down'));
    expect(await daemonLifecycleHandlers.daemon_upgrade(ctx, {})).toMatchObject({ success: false, error: 'registry still down' });
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });
});
