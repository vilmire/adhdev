import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderModule } from '../../src/providers/contracts.js';
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import sampleSnapshot from './fixtures/driver-browser-playwright.v1.json';

// G1a-1 e3d8b3e4c sample. Prefer the owner copy in the cloud workspace;
// the snapshot keeps this OSS test runnable without the sibling submodule.
const samplePath = new URL('../../../../../adhdev-providers/examples/driver/browser-playwright/provider.v1.json', import.meta.url);
const sample = existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, 'utf8')) : sampleSnapshot;

class DriverTestLoader extends ProviderLoader {
  constructor(userDir: string) { super({ userDir, disableUpstream: true }); }
  protected override readConfig() { return {}; }
}

describe('driver provider loading', () => {
  let root: string;
  let configBefore: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adhdev-driver-loader-'));
    configBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = join(root, 'config');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (configBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configBefore;
    rmSync(root, { recursive: true, force: true });
  });

  it('loads the G1a-1 sample as a ProviderModule without creating a process or session instance', () => {
    expect(sample).toEqual(sampleSnapshot);
    const dir = join(root, 'providers', 'driver', sample.type);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'provider.v1.json'), JSON.stringify(sample));
    const addInstance = vi.spyOn(ProviderInstanceManager.prototype, 'addInstance');
    const spawn = vi.spyOn(childProcess, 'spawn');
    const fork = vi.spyOn(childProcess, 'fork');
    const execFile = vi.spyOn(childProcess, 'execFile');
    const loader = new DriverTestLoader(join(root, 'providers'));
    loader.loadAll();
    const module: ProviderModule | undefined = loader.getMeta(sample.type);
    expect(module).toMatchObject(sample);
    expect(loader.getByCategory('driver')).toEqual([module]);
    expect(loader.getCliDetectionList({ includeDisabled: true })).toEqual([]);
    expect(module?.scripts).toBeUndefined();
    expect(loader.resolve(sample.type, { version: '1.0.0' })).toMatchObject(sample);
    expect(addInstance).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['provider.v1.json', 'provider.json'])(
    'never requires a driver scripts.js during %s loading or resolution', (filename) => {
      const dir = join(root, 'providers', 'driver', sample.type);
      const marker = join(root, 'scripts-required');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename), JSON.stringify(sample));
      // The loader catches require errors, so successful loading alone is
      // insufficient: assert both the side effect and error log are absent.
      writeFileSync(join(dir, 'scripts.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'required'); throw new Error('driver scripts must not execute');`);
      const logs = vi.spyOn(console, 'log');
      const loader = new DriverTestLoader(join(root, 'providers'));
      loader.loadAll();
      expect(loader.getMeta(sample.type)).toMatchObject(sample);
      expect(loader.resolve(sample.type)).toMatchObject(sample);
      expect(loader.resolve(sample.type, { version: '1.0.0' })?.scripts).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
      expect(logs.mock.calls.flat().join('\n')).not.toContain('Failed to load scripts');
    },
  );
});
