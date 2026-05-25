import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProviderModule } from '../../src/providers/contracts.js';

const execSyncMock = vi.fn<(cmd: string) => string>();
const originalPath = process.env.PATH;
let binDir: string | null = null;

function addTestBinary(name: string) {
  if (!binDir) {
    binDir = mkdtempSync(join(tmpdir(), 'adhdev-version-bin-'));
    process.env.PATH = `${binDir}:${originalPath || ''}`;
  }
  const filePath = join(binDir, name);
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return filePath;
}

vi.mock('child_process', () => ({
  execSync: execSyncMock,
  exec: (cmd: string, _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    try {
      callback(null, execSyncMock(cmd), '');
    } catch (error) {
      callback(error as Error, '', '');
    }
    return {};
  },
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
    process.env.PATH = originalPath;
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true });
      binDir = null;
    }
  });

  it('uses the platform-specific versionCommand override when detecting CLI versions', async () => {
    const codexPath = addTestBinary('codex');
    execSyncMock.mockImplementation((cmd: string) => {
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
      binary: codexPath,
      version: '1.2.3',
    });
    expect(results[0].warning).toBeUndefined();
  });

  it('warns when the detected version is outside testedVersions', async () => {
    addTestBinary('foo');
    execSyncMock.mockImplementation((cmd: string) => {
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
