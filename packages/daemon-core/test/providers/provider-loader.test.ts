import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import * as path from 'path';
import { join } from 'path';
import { ProviderLoader } from '../../src/providers/provider-loader.js';

function writeProvider(root: string, category: string, type: string, data: Record<string, unknown>) {
  const dir = join(root, category, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'provider.json'), JSON.stringify(data, null, 2), 'utf-8');
}

function writeScriptsJs(root: string, category: string, type: string, scriptDir: string, source: string) {
  const dir = join(root, category, type, scriptDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scripts.js'), source, 'utf-8');
}

function writeSpecJson(root: string, category: string, type: string, spec: Record<string, unknown>) {
  const dir = join(root, category, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf-8');
}

function byKey(settings: Array<{ key: string } & Record<string, unknown>>) {
  return Object.fromEntries(settings.map((setting) => [setting.key, setting]));
}

class TestProviderLoader extends ProviderLoader {
  constructor(
    userDir: string,
    private readonly testConfig: {
      providerSettings?: Record<string, Record<string, unknown>>;
      machineProviders?: Record<string, {
        enabled?: boolean;
        executable?: string;
        args?: string[];
        lastDetection?: Record<string, unknown>;
        lastVerification?: Record<string, unknown>;
      }>;
      ideSettings?: Record<string, { extensions?: Record<string, { enabled: boolean }> }>;
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

describe('ProviderLoader source root selection', () => {
  let tmpRoot = '';
  let projectDir = '';
  let siblingDir = '';
  let envBefore: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'adhdev-loader-probe-'));
    projectDir = join(tmpRoot, 'project');
    siblingDir = join(tmpRoot, 'adhdev-providers');
    mkdirSync(projectDir, { recursive: true });
    envBefore = process.env.ADHDEV_USE_SIBLING_PROVIDERS;
    delete process.env.ADHDEV_USE_SIBLING_PROVIDERS;
  });

  afterEach(() => {
    if (envBefore === undefined) {
      delete process.env.ADHDEV_USE_SIBLING_PROVIDERS;
    } else {
      process.env.ADHDEV_USE_SIBLING_PROVIDERS = envBefore;
    }
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
    tmpRoot = '';
    projectDir = '';
    siblingDir = '';
  });

  it('ignores a sibling adhdev-providers checkout by default (no marker, no env opt-in)', () => {
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });

    const loader = new ProviderLoader({ probeStarts: [projectDir] });

    expect(loader.getUserDir()).toBe(path.join(homedir(), '.adhdev', 'providers'));
    expect(loader.getSourceConfig().userDirSource).toBe('home-default');
  });

  it('adopts a sibling checkout when the .adhdev-provider-root marker is present', () => {
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });
    writeFileSync(join(siblingDir, '.adhdev-provider-root'), '', 'utf-8');

    const loader = new ProviderLoader({ probeStarts: [projectDir] });

    expect(loader.getUserDir()).toBe(siblingDir);
    expect(loader.getSourceConfig().userDirSource).toBe('sibling-marker');
  });

  it('adopts a sibling checkout when ADHDEV_USE_SIBLING_PROVIDERS=1 is exported', () => {
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });
    process.env.ADHDEV_USE_SIBLING_PROVIDERS = '1';

    const loader = new ProviderLoader({ probeStarts: [projectDir] });

    expect(loader.getUserDir()).toBe(siblingDir);
    expect(loader.getSourceConfig().userDirSource).toBe('sibling-env');
  });

  it('prefers marker-source annotation when both env opt-in and marker are present', () => {
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });
    writeFileSync(join(siblingDir, '.adhdev-provider-root'), '', 'utf-8');
    process.env.ADHDEV_USE_SIBLING_PROVIDERS = '1';

    const loader = new ProviderLoader({ probeStarts: [projectDir] });

    expect(loader.getSourceConfig().userDirSource).toBe('sibling-marker');
  });

  it('falls back to ~/.adhdev/providers when no sibling adhdev-providers checkout exists', () => {
    const loader = new ProviderLoader({ probeStarts: [projectDir] });

    expect(loader.getUserDir()).toBe(path.join(homedir(), '.adhdev', 'providers'));
    expect(loader.getSourceConfig().userDirSource).toBe('home-default');
  });

  it('tags userDirSource as "explicit" when config.providerDir is set', () => {
    const loader = new ProviderLoader({
      probeStarts: [projectDir],
      userDir: '/tmp/explicit-root',
    });

    expect(loader.getSourceConfig().userDirSource).toBe('explicit');
  });

  it('applies provider source config live and resets to the default override root when providerDir is cleared', () => {
    const loader = new ProviderLoader({
      probeStarts: [projectDir],
      userDir: '/tmp/custom-provider-root',
      sourceMode: 'no-upstream',
    });

    expect(loader.getSourceConfig()).toMatchObject({
      sourceMode: 'no-upstream',
      disableUpstream: true,
      explicitProviderDir: '/tmp/custom-provider-root',
      userDir: '/tmp/custom-provider-root',
    });

    const applied = loader.applySourceConfig({
      sourceMode: 'normal',
      userDir: undefined,
    });

    expect(applied).toMatchObject({
      sourceMode: 'normal',
      disableUpstream: false,
      explicitProviderDir: null,
      userDir: path.join(homedir(), '.adhdev', 'providers'),
      upstreamDir: path.join(homedir(), '.adhdev', 'providers', '.upstream'),
      providerRoots: [
        path.join(homedir(), '.adhdev', 'providers'),
        path.join(homedir(), '.adhdev', 'external'),
        path.join(homedir(), '.adhdev', 'providers', '.upstream'),
      ],
    });
  });
});

describe('ProviderLoader settings schema', () => {
  let userDir = '';
  let testConfig: {
    providerSettings?: Record<string, Record<string, unknown>>;
    machineProviders?: Record<string, {
      enabled?: boolean;
      executable?: string;
      args?: string[];
      lastDetection?: Record<string, unknown>;
      lastVerification?: Record<string, unknown>;
    }>;
    ideSettings?: Record<string, { extensions?: Record<string, { enabled: boolean }> }>;
  };

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'adhdev-provider-loader-'));
    testConfig = { providerSettings: {}, machineProviders: {}, ideSettings: {} };
  });

  afterEach(() => {
    if (userDir) {
      rmSync(userDir, { recursive: true, force: true });
    }
    userDir = '';
    testConfig = { providerSettings: {}, machineProviders: {}, ideSettings: {} };
  });

  it('adds synthetic autoApprove (default off) for providers that do not declare it', () => {
    // (note) synthetic default flipped from true → false: auto-approving
    // every modal without an explicit opt-in caused "Auto-approved: ..."
    // floods for CLIs (notably AGY) whose modal could be misclassified by
    // the parser, and could silently run unsafe commands. Default is now
    // off; users opt in via the UI toggle.
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
      default: false,
      public: true,
      label: 'Auto Approve',
    });
    expect(loader.getSettingValue('foo-cli', 'autoApprove')).toBe(false);
  });

  it('normalizes a declared autoApprove and honors the provider-defined default + user override', () => {
    // (note) Previously getSettingsSchema force-rewrote autoApprove.default
    // to true even when the provider.json explicitly set false. That hid
    // the maintainer's intent and silently turned on auto-approval for
    // providers that wanted it off by default. The loader now trusts the
    // declared default.
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
      default: false,
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
      },
    };
    testConfig.machineProviders = {
      'foo-cli': {
        executable: '/custom/foo',
      },
    };

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    expect(loader.getSettings('foo-cli')).toMatchObject({
      autoApprove: false,
      executablePath: '/custom/foo',
    });
  });

  it('setSetting persists valid public values and rejects invalid writes', () => {
    writeProvider(userDir, 'cli', 'foo-cli', {
      type: 'foo-cli',
      name: 'Foo CLI',
      displayName: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
      settings: {
        displayMode: {
          type: 'select',
          public: true,
          default: 'compact',
          options: ['compact', 'full'],
        },
        retries: {
          type: 'number',
          public: true,
          default: 1,
          min: 0,
          max: 3,
        },
        secretToken: {
          type: 'string',
          public: false,
          default: '',
        },
      },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    expect(loader.setSetting('foo-cli', 'displayMode', 'full')).toBe(true);
    expect(loader.setSetting('foo-cli', 'retries', 2)).toBe(true);
    expect(loader.setSetting('foo-cli', 'retries', 9)).toBe(false);
    expect(loader.setSetting('foo-cli', 'displayMode', 'invalid')).toBe(false);
    expect(loader.setSetting('foo-cli', 'secretToken', 'abc')).toBe(false);

    expect(testConfig.providerSettings?.['foo-cli']).toMatchObject({
      displayMode: 'full',
      retries: 2,
    });
  });

  it('keeps CLI and ACP providers out of active detection until they are machine-enabled', () => {
    writeProvider(userDir, 'cli', 'codex-cli', {
      type: 'codex-cli',
      name: 'Codex CLI',
      displayName: 'Codex CLI',
      category: 'cli',
      aliases: ['codex'],
      icon: '📦',
      spawn: { command: 'codex', args: ['agent'] },
      versionCommand: {
        darwin: 'codex --version',
        linux: 'codex version',
      },
    });
    writeProvider(userDir, 'acp', 'agent-acp', {
      type: 'agent-acp',
      name: 'Agent ACP',
      displayName: 'Agent ACP',
      category: 'acp',
      spawn: { command: 'agent-acp' },
    });

    testConfig.machineProviders = {
      'codex-cli': {
        executable: '/custom/bin/codex',
        args: ['agent', '--sandbox', 'workspace'],
      },
    };

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    expect(loader.resolveAlias('codex')).toBe('codex-cli');
    expect(loader.getByAlias('codex')?.type).toBe('codex-cli');
    expect(loader.isMachineProviderEnabled('codex-cli')).toBe(false);
    expect(loader.getCliDetectionList()).toEqual([]);

    expect(loader.setMachineProviderEnabled('codex-cli', true)).toBe(true);
    expect(loader.isMachineProviderEnabled('codex')).toBe(true);
    expect(testConfig.providerSettings?.['codex-cli']).toBeUndefined();
    expect(testConfig.machineProviders?.['codex-cli']).toMatchObject({
      enabled: true,
      executable: '/custom/bin/codex',
      args: ['agent', '--sandbox', 'workspace'],
    });

    const entries = loader.getCliDetectionList();
    expect(entries).toEqual([
      expect.objectContaining({
        id: 'codex-cli',
        command: '/custom/bin/codex',
        args: ['agent', '--sandbox', 'workspace'],
        category: 'cli',
        enabled: true,
        versionCommand: process.platform === 'darwin' ? 'codex --version' : 'codex version',
      }),
    ]);

    loader.setCliDetectionResults([{ id: 'codex-cli', installed: true, path: '/custom/bin/codex' }]);
    expect(testConfig.machineProviders?.['codex-cli']?.lastDetection).toMatchObject({
      ok: true,
      stage: 'detection',
      command: '/custom/bin/codex',
      path: '/custom/bin/codex',
    });
  });

  it('stores machine executable and argv overrides outside providerSettings', () => {
    writeProvider(userDir, 'cli', 'foo-cli', {
      type: 'foo-cli',
      name: 'Foo CLI',
      displayName: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo', args: ['default'] },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    expect(loader.setSetting('foo-cli', 'enabled', true)).toBe(true);
    expect(loader.setSetting('foo-cli', 'executablePath', '/opt/foo/bin/foo')).toBe(true);
    expect(loader.setSetting('foo-cli', 'executableArgs', 'agent --profile "work tree"')).toBe(true);

    expect(testConfig.providerSettings?.['foo-cli']).toBeUndefined();
    expect(testConfig.machineProviders?.['foo-cli']).toMatchObject({
      enabled: true,
      executable: '/opt/foo/bin/foo',
      args: ['agent', '--profile', 'work tree'],
    });
    expect(loader.getSettingValue('foo-cli', 'executablePath')).toBe('/opt/foo/bin/foo');
    expect(loader.getSettingValue('foo-cli', 'executableArgs')).toBe('agent --profile "work tree"');
    expect(loader.getCliDetectionList()).toEqual([
      expect.objectContaining({
        id: 'foo-cli',
        command: '/opt/foo/bin/foo',
        args: ['agent', '--profile', 'work tree'],
      }),
    ]);
    expect(loader.resolve('foo-cli')?.spawn).toMatchObject({
      command: '/opt/foo/bin/foo',
      args: ['agent', '--profile', 'work tree'],
    });
  });

  it('surfaces passive catalog providers separately from machine-enabled provider state', () => {
    writeProvider(userDir, 'cli', 'foo-cli', {
      type: 'foo-cli',
      name: 'Foo CLI',
      displayName: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    expect(loader.getAvailableProviderInfos()).toEqual([
      expect.objectContaining({
        type: 'foo-cli',
        enabled: false,
        machineStatus: 'disabled',
      }),
    ]);

    expect(loader.setMachineProviderEnabled('foo-cli', true)).toBe(true);
    expect(loader.getAvailableProviderInfos()).toEqual([
      expect.objectContaining({
        type: 'foo-cli',
        enabled: true,
        machineStatus: 'enabled_unchecked',
      }),
    ]);

    loader.setProviderAvailability('foo-cli', { installed: true, detectedPath: '/usr/local/bin/foo' });
    expect(loader.getAvailableProviderInfos()).toEqual([
      expect.objectContaining({
        type: 'foo-cli',
        enabled: true,
        installed: true,
        detectedPath: '/usr/local/bin/foo',
        machineStatus: 'detected',
      }),
    ]);
  });

  it('hydrates enabled CLI machine status from persisted last detection after reload', () => {
    writeProvider(userDir, 'cli', 'foo-cli', {
      type: 'foo-cli',
      name: 'Foo CLI',
      displayName: 'Foo CLI',
      category: 'cli',
      spawn: { command: 'foo' },
    });
    testConfig.machineProviders = {
      'foo-cli': {
        enabled: true,
        lastDetection: {
          ok: true,
          stage: 'detection',
          checkedAt: '2026-04-27T00:00:00.000Z',
          command: 'foo',
          path: '/usr/local/bin/foo',
          message: 'Provider command detected',
        },
      },
    };

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    expect(loader.getAvailableProviderInfos()).toEqual([
      expect.objectContaining({
        type: 'foo-cli',
        enabled: true,
        installed: true,
        detectedPath: '/usr/local/bin/foo',
        machineStatus: 'detected',
        lastDetection: expect.objectContaining({ ok: true, path: '/usr/local/bin/foo' }),
      }),
    ]);
  });

  it('normalizes IDE type prefixes when reading and writing extension enabled state', () => {
    testConfig.ideSettings = {
      cursor: {
        extensions: {
          cline: { enabled: true },
        },
      },
    };

    const loader = new TestProviderLoader(userDir, testConfig);

    expect(loader.getIdeExtensionEnabledState('cursor_12345', 'cline')).toBe(true);
    expect(loader.getIdeExtensionEnabledState('cursor_12345', 'roo-code')).toBe(false);

    expect(loader.setIdeExtensionEnabled('cursor_12345', 'roo-code', true)).toBe(true);
    expect(testConfig.ideSettings?.cursor?.extensions?.['roo-code']?.enabled).toBe(true);
  });

  it('resolves compatibility script directories and falls back to defaultScriptDir on version misses', () => {
    writeProvider(userDir, 'ide', 'cursor', {
      type: 'cursor',
      name: 'Cursor',
      displayName: 'Cursor',
      category: 'ide',
      compatibility: [
        { ideVersion: '>=1.107.0', scriptDir: 'scripts/modern' },
      ],
      defaultScriptDir: 'scripts/fallback',
    });
    writeScriptsJs(userDir, 'ide', 'cursor', 'scripts/modern', 'module.exports = { readChat: () => "modern-script" };');
    writeScriptsJs(userDir, 'ide', 'cursor', 'scripts/fallback', 'module.exports = { readChat: () => "fallback-script" };');

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const modern = loader.resolve('cursor', { version: '1.108.0' });
    expect(modern?._resolvedScriptDir).toBe('scripts/modern');
    expect(modern?._resolvedScriptsSource).toBe('compatibility:>=1.107.0');
    expect(modern?.scripts?.readChat?.({})).toBe('modern-script');

    const fallback = loader.resolve('cursor', { version: '1.100.0' });
    expect(fallback?._resolvedScriptDir).toBe('scripts/fallback');
    expect(fallback?._resolvedScriptsSource).toBe('defaultScriptDir:version_miss');
    expect(fallback?._versionWarning).toContain('not in compatibility matrix');
    expect(fallback?.scripts?.readChat?.({})).toBe('fallback-script');

    const noVersion = loader.resolve('cursor');
    expect(noVersion?._resolvedScriptDir).toBe('scripts/fallback');
    expect(noVersion?._resolvedScriptsSource).toBe('defaultScriptDir:no_version');
  });

  it('restores extensionIdPattern regex flags from provider JSON metadata', () => {
    writeProvider(userDir, 'extension', 'test-extension', {
      type: 'test-extension',
      name: 'Test Extension',
      displayName: 'Test Extension',
      category: 'extension',
      extensionIdPattern: '^publisher\\.test-extension$',
      extensionIdPattern_flags: 'i',
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const provider = loader.getExtensionProviders().find((entry) => entry.type === 'test-extension');
    expect(provider?.extensionIdPattern?.test('PUBLISHER.TEST-EXTENSION')).toBe(true);
  });
});

describe('ProviderLoader spec control_bar → web controls translation', () => {
  let userDir = '';
  let testConfig: { providerSettings?: Record<string, Record<string, unknown>> };

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'adhdev-provider-controlbar-'));
    testConfig = { providerSettings: {} };
  });

  afterEach(() => {
    if (userDir) {
      rmSync(userDir, { recursive: true, force: true });
    }
    userDir = '';
    testConfig = { providerSettings: {} };
  });

  it('synthesizes web controls from a spec control_bar (open_picker → select, send_keys → action)', () => {
    writeProvider(userDir, 'cli', 'claude-cli', {
      type: 'claude-cli',
      name: 'Claude CLI',
      displayName: 'Claude CLI',
      category: 'cli',
      spawn: { command: 'claude' },
    });
    writeSpecJson(userDir, 'cli', 'claude-cli', {
      control_bar: [
        { id: 'stop', label: 'Stop', visible_when_state: ['busy'], action: { type: 'send_keys', keys: '' } },
        {
          id: 'set_model', label: 'Model', visible_when_state: ['idle'],
          action: {
            type: 'open_picker',
            trigger_keys: '/model\r',
            wait_for: { section: 'modal', regex: 'Select a model' },
            extract_choices: { section: 'modal', pattern: '^\\s*(\\d+)\\.\\s+(.+)$' },
            submit_key: '{index}\r',
          },
        },
        { id: 'cycle_mode', label: 'Mode', visible_when_state: ['idle'], action: { type: 'send_keys', keys: '[Z' } },
        { id: 'attach_image', label: '📎', visible_when_state: ['idle'], action: { type: 'attach_image', method: 'tempfile_then_keys', keys_template: '{path}\r' } },
      ],
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const resolved = loader.resolve('claude-cli');
    const controls = resolved?.controls ?? [];
    // attach_image is intentionally skipped (needs a blob from a file picker).
    expect(controls.map((c) => c.id)).toEqual(['stop', 'set_model', 'cycle_mode']);

    const model = controls.find((c) => c.id === 'set_model');
    expect(model).toMatchObject({
      id: 'set_model',
      type: 'select',
      label: 'Model',
      placement: 'bar',
      dynamic: true,
      // Script names MUST equal the control id so invoke routes to control_bar.
      listScript: 'set_model',
      setScript: 'set_model',
      order: 1,
    });

    const stop = controls.find((c) => c.id === 'stop');
    expect(stop).toMatchObject({
      id: 'stop',
      type: 'action',
      placement: 'bar',
      invokeScript: 'stop',
      order: 0,
    });

    // The invoke-gate stub still exists alongside the web controls.
    expect(typeof (resolved?.scripts as any)?.set_model).toBe('function');
  });

  it('does not overwrite controls a provider already declares in provider.json', () => {
    writeProvider(userDir, 'cli', 'hermes-cli', {
      type: 'hermes-cli',
      name: 'Hermes CLI',
      displayName: 'Hermes CLI',
      category: 'cli',
      spawn: { command: 'hermes' },
      controls: [
        { id: 'provider', type: 'select', label: 'Provider', placement: 'bar', order: 10, setScript: 'setProvider', readFrom: 'provider', options: [{ value: 'auto', label: 'Auto' }] },
      ],
    });
    writeSpecJson(userDir, 'cli', 'hermes-cli', {
      control_bar: [
        { id: 'set_model', label: 'Model', visible_when_state: ['idle'], action: { type: 'open_picker', trigger_keys: '/model\r', wait_for: { section: 'modal', regex: 'x' }, extract_choices: { section: 'modal', pattern: 'x' }, submit_key: '{index}\r' } },
      ],
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const resolved = loader.resolve('hermes-cli');
    // The declared controls win — no synthesized set_model is injected.
    expect((resolved?.controls ?? []).map((c) => c.id)).toEqual(['provider']);
  });
});
