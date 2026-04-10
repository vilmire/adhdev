import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderModule } from '../../src/providers/contracts.js';

const execSyncMock = vi.fn<(cmd: string) => string>();

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    platform: () => 'darwin',
    homedir: () => '/tmp/adhdev-test-home',
  };
});

function createLoader(providers: ProviderModule[]) {
  return {
    getAll: () => providers,
  } as Pick<import('../../src/providers/provider-loader.js').ProviderLoader, 'getAll'>;
}

describe('detectAllVersions', () => {
  afterEach(() => {
    execSyncMock.mockReset();
  });

  it('uses the platform-specific versionCommand override when detecting CLI versions', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'which codex') return '/usr/local/bin/codex\n';
      if (cmd === 'codex version') return 'codex version 1.2.3\n';
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const { detectAllVersions } = await import('../../src/providers/version-archive.js');
    const results = await detectAllVersions(createLoader([
      {
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex' },
        versionCommand: {
          darwin: 'codex version',
          linux: 'codex --version',
        },
        testedVersions: ['1.2.3'],
      },
    ]) as import('../../src/providers/provider-loader.js').ProviderLoader);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'codex-cli',
      installed: true,
      binary: '/usr/local/bin/codex',
      version: '1.2.3',
    });
    expect(results[0].warning).toBeUndefined();
  });

  it('warns when the detected version is outside testedVersions', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'which foo') return '/usr/local/bin/foo\n';
      if (cmd === 'foo --version') return 'foo 2.0.0\n';
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const { detectAllVersions } = await import('../../src/providers/version-archive.js');
    const results = await detectAllVersions(createLoader([
      {
        type: 'foo-cli',
        name: 'Foo CLI',
        category: 'cli',
        spawn: { command: 'foo' },
        versionCommand: 'foo --version',
        testedVersions: ['1.9.0'],
      },
    ]) as import('../../src/providers/provider-loader.js').ProviderLoader);

    expect(results[0].warning).toContain('testedVersions [1.9.0]');
  });
});
