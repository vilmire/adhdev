import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ProviderLoader } from '../../src/providers/provider-loader.js';

function writeProvider(root: string, category: string, type: string, data: Record<string, unknown>) {
  const dir = join(root, category, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'provider.json'), JSON.stringify(data, null, 2), 'utf-8');
}

function byKey(settings: Array<{ key: string } & Record<string, unknown>>) {
  return Object.fromEntries(settings.map((setting) => [setting.key, setting]));
}

class TestProviderLoader extends ProviderLoader {
  constructor(
    userDir: string,
    private readonly testConfig: { providerSettings?: Record<string, Record<string, unknown>> },
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

describe('ProviderLoader settings schema', () => {
  let userDir = '';
  let testConfig: { providerSettings?: Record<string, Record<string, unknown>> };

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'adhdev-provider-loader-'));
    testConfig = { providerSettings: {} };
  });

  afterEach(() => {
    if (userDir) {
      rmSync(userDir, { recursive: true, force: true });
    }
    userDir = '';
    testConfig = { providerSettings: {} };
  });

  it('adds synthetic autoApprove for providers that do not declare it', () => {
    writeProvider(userDir, 'cli', 'foo-cli', {
      type: 'foo-cli',
      name: 'Foo CLI',
      displayName: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const settings = byKey(loader.getPublicSettings('foo-cli'));
    expect(settings.autoApprove).toMatchObject({
      type: 'boolean',
      default: true,
      public: true,
      label: 'Auto Approve',
    });
    expect(loader.getSettingValue('foo-cli', 'autoApprove')).toBe(true);
  });

  it('normalizes declared autoApprove to default-on public schema and respects user override', () => {
    writeProvider(userDir, 'cli', 'bar-cli', {
      type: 'bar-cli',
      name: 'Bar CLI',
      displayName: 'Bar CLI',
      category: 'cli',
      spawn: { command: 'bar' },
      settings: {
        autoApprove: {
          type: 'boolean',
          default: false,
          public: false,
        },
      },
    });

    testConfig.providerSettings = {
      'bar-cli': {
        autoApprove: false,
      },
    };

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const settings = byKey(loader.getPublicSettings('bar-cli'));
    expect(settings.autoApprove).toMatchObject({
      type: 'boolean',
      default: true,
      public: true,
      label: 'Auto Approve',
    });
    expect(loader.getSettingValue('bar-cli', 'autoApprove')).toBe(false);
  });

  it('adds executablePath synthetic setting for CLI and ACP providers with spawn commands', () => {
    writeProvider(userDir, 'cli', 'foo-cli', {
      type: 'foo-cli',
      name: 'Foo CLI',
      displayName: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
    });
    writeProvider(userDir, 'acp', 'foo-acp', {
      type: 'foo-acp',
      name: 'Foo ACP',
      displayName: 'Foo ACP',
      category: 'acp',
      spawn: { command: 'foo-acp' },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const cliSettings = byKey(loader.getPublicSettings('foo-cli'));
    const acpSettings = byKey(loader.getPublicSettings('foo-acp'));

    expect(cliSettings.executablePath).toMatchObject({
      type: 'string',
      default: '',
      public: true,
      label: 'Executable path',
    });
    expect(acpSettings.executablePath).toMatchObject({
      type: 'string',
      default: '',
      public: true,
      label: 'Executable path',
    });
  });

  it('adds IDE override path settings when CLI launcher and app paths exist', () => {
    writeProvider(userDir, 'ide', 'cursor', {
      type: 'cursor',
      name: 'Cursor',
      displayName: 'Cursor',
      category: 'ide',
      cli: 'cursor',
      paths: {
        darwin: ['/Applications/Cursor.app'],
      },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const settings = byKey(loader.getPublicSettings('cursor'));
    expect(settings.cliPathOverride).toMatchObject({
      type: 'string',
      default: '',
      public: true,
      label: 'CLI path override',
    });
    expect(settings.appPathOverride).toMatchObject({
      type: 'string',
      default: '',
      public: true,
      label: 'App path override',
    });
  });

  it('returns merged settings with user overrides applied on top of defaults', () => {
    writeProvider(userDir, 'cli', 'foo-cli', {
      type: 'foo-cli',
      name: 'Foo CLI',
      displayName: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
    });

    testConfig.providerSettings = {
      'foo-cli': {
        autoApprove: false,
        executablePath: '/custom/foo',
      },
    };

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    expect(loader.getSettings('foo-cli')).toMatchObject({
      autoApprove: false,
      executablePath: '/custom/foo',
    });
  });
});
