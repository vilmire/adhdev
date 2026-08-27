import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { join } from 'path';
import { ProviderLoader } from '../../src/providers/provider-loader.js';
import { getConfigDir } from '../../src/config/config.js';

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

function writeV1Provider(root: string, category: string, type: string, data: Record<string, unknown>) {
  const dir = join(root, category, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'provider.v1.json'), JSON.stringify(data, null, 2), 'utf-8');
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

    expect(loader.getUserDir()).toBe(path.join(getConfigDir(), 'providers'));
    expect(loader.getSourceConfig().userDirSource).toBe('home-default');
  });

  it('adopts a sibling checkout when the .adhdev-provider-root marker is present', () => {
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });
    writeFileSync(join(siblingDir, '.adhdev-provider-root'), '', 'utf-8');

    // Sibling adoption is a development-only path: it requires a non-stable
    // channel. A stable runtime refuses it (see channel policy tests).
    const loader = new ProviderLoader({ probeStarts: [projectDir], channel: 'preview' });

    expect(loader.getUserDir()).toBe(siblingDir);
    expect(loader.getSourceConfig().userDirSource).toBe('sibling-marker');
  });

  it('adopts a sibling checkout when ADHDEV_USE_SIBLING_PROVIDERS=1 is exported', () => {
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });
    process.env.ADHDEV_USE_SIBLING_PROVIDERS = '1';

    const loader = new ProviderLoader({ probeStarts: [projectDir], channel: 'preview' });

    expect(loader.getUserDir()).toBe(siblingDir);
    expect(loader.getSourceConfig().userDirSource).toBe('sibling-env');
  });

  it('prefers marker-source annotation when both env opt-in and marker are present', () => {
    mkdirSync(join(siblingDir, 'cli'), { recursive: true });
    writeFileSync(join(siblingDir, '.adhdev-provider-root'), '', 'utf-8');
    process.env.ADHDEV_USE_SIBLING_PROVIDERS = '1';

    const loader = new ProviderLoader({ probeStarts: [projectDir], channel: 'preview' });

    expect(loader.getSourceConfig().userDirSource).toBe('sibling-marker');
  });

  it('falls back to {configDir}/providers when no sibling adhdev-providers checkout exists', () => {
    const loader = new ProviderLoader({ probeStarts: [projectDir] });

    expect(loader.getUserDir()).toBe(path.join(getConfigDir(), 'providers'));
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
      userDir: path.join(getConfigDir(), 'providers'),
      upstreamDir: path.join(getConfigDir(), 'providers', '.upstream'),
      providerRoots: [
        path.join(getConfigDir(), 'providers'),
        path.join(getConfigDir(), 'external'),
        path.join(getConfigDir(), 'providers', '.upstream'),
      ],
    });
  });
});

describe('ProviderLoader source dir instance isolation (ADHDEV_CONFIG_DIR)', () => {
  let tmpRoot = '';
  let projectDir = '';
  let configDir = '';
  let envBefore: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'adhdev-loader-configdir-'));
    projectDir = join(tmpRoot, 'project');
    configDir = join(tmpRoot, 'preview-config');
    mkdirSync(projectDir, { recursive: true });
    envBefore = process.env.ADHDEV_CONFIG_DIR;
  });

  afterEach(() => {
    if (envBefore === undefined) {
      delete process.env.ADHDEV_CONFIG_DIR;
    } else {
      process.env.ADHDEV_CONFIG_DIR = envBefore;
    }
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
    tmpRoot = '';
    projectDir = '';
    configDir = '';
  });

  it('scopes providers/upstream/external roots to ADHDEV_CONFIG_DIR when set', () => {
    process.env.ADHDEV_CONFIG_DIR = configDir;

    const loader = new ProviderLoader({ probeStarts: [projectDir] });
    const snapshot = loader.getSourceConfig();

    expect(loader.getUserDir()).toBe(path.join(configDir, 'providers'));
    expect(loader.getUpstreamDir()).toBe(path.join(configDir, 'providers', '.upstream'));
    expect(snapshot.userDir).toBe(path.join(configDir, 'providers'));
    expect(snapshot.upstreamDir).toBe(path.join(configDir, 'providers', '.upstream'));
    expect(snapshot.providerRoots).toEqual([
      path.join(configDir, 'providers'),
      path.join(configDir, 'external'),
      path.join(configDir, 'providers', '.upstream'),
    ]);
  });

  it('falls back to ~/.adhdev roots when ADHDEV_CONFIG_DIR is unset', () => {
    // The production fallback goes through process.env, which the test-runtime
    // fail-fast gate (resolveConfigDir) rejects when un-pinned — step out of
    // the gate explicitly, with HOME/USERPROFILE pinned to tmpRoot first so
    // ProviderLoader's dir resolution/creation lands in this suite's tmp dir,
    // never the real home.
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      VITEST: process.env.VITEST,
      NODE_ENV: process.env.NODE_ENV,
    };
    delete process.env.ADHDEV_CONFIG_DIR;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      const loader = new ProviderLoader({ probeStarts: [projectDir] });
      const snapshot = loader.getSourceConfig();

      expect(loader.getUserDir()).toBe(path.join(tmpRoot, '.adhdev', 'providers'));
      expect(snapshot.providerRoots).toEqual([
        path.join(tmpRoot, '.adhdev', 'providers'),
        path.join(tmpRoot, '.adhdev', 'external'),
        path.join(tmpRoot, '.adhdev', 'providers', '.upstream'),
      ]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

    // The fixture's versionCommand only defines darwin/linux (no win32, no
    // default) — getPlatformVersionCommand() falls through to `undefined`
    // for any other platform rather than reusing the linux string, so mirror
    // that per-platform lookup instead of assuming a binary darwin/"else"
    // split.
    const expectedVersionCommand: string | undefined =
      process.platform === 'darwin' ? 'codex --version'
      : process.platform === 'linux' ? 'codex version'
      : undefined;
    const entries = loader.getCliDetectionList();
    expect(entries).toEqual([
      expect.objectContaining({
        id: 'codex-cli',
        command: '/custom/bin/codex',
        args: ['agent', '--sandbox', 'workspace'],
        category: 'cli',
        enabled: true,
        // getPlatformVersionCommand() omits the key entirely rather than
        // setting it to undefined — only assert it when one is expected.
        ...(expectedVersionCommand !== undefined ? { versionCommand: expectedVersionCommand } : {}),
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

  // Regression: a fresh machine's machineProviders is always {} — nothing is
  // enabled yet — so the gated getCliDetectionList() is unconditionally empty
  // on first run. That starved setup's first-run detection step, which used
  // this same gated list: it could never show what was actually installed on
  // disk, only what had ALREADY been enabled (impossible on a fresh machine).
  // includeDisabled surfaces every cli/acp provider with a spawn command
  // regardless of the enabled flag, and reports each entry's REAL enabled
  // state instead of the gated list's implied-always-true.
  it('includeDisabled surfaces not-yet-enabled providers with their real enabled state', () => {
    writeProvider(userDir, 'cli', 'codex-cli', {
      type: 'codex-cli',
      name: 'Codex CLI',
      displayName: 'Codex CLI',
      category: 'cli',
      spawn: { command: 'codex' },
    });
    writeProvider(userDir, 'cli', 'claude-cli', {
      type: 'claude-cli',
      name: 'Claude Code',
      displayName: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude' },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    // Fresh machine: nothing enabled yet. The default (gated) list is empty,
    // exactly like before — includeDisabled must not change that contract.
    expect(loader.getCliDetectionList()).toEqual([]);

    const all = loader.getCliDetectionList({ includeDisabled: true });
    expect(all.map((e) => e.id).sort()).toEqual(['claude-cli', 'codex-cli']);
    expect(all.every((e) => e.enabled === false)).toBe(true);

    expect(loader.setMachineProviderEnabled('codex-cli', true)).toBe(true);

    const afterEnable = loader.getCliDetectionList({ includeDisabled: true });
    const codex = afterEnable.find((e) => e.id === 'codex-cli');
    const claude = afterEnable.find((e) => e.id === 'claude-cli');
    expect(codex?.enabled).toBe(true);
    expect(claude?.enabled).toBe(false);

    // The gated (default) list now reflects only the one that was enabled —
    // unaffected by the includeDisabled probe above.
    expect(loader.getCliDetectionList().map((e) => e.id)).toEqual(['codex-cli']);
  });

  // Regression: provider types and aliases share one namespace across
  // categories, so `extension/codex` (type 'codex') shadowed the `codex` alias
  // of `cli/codex-cli` on a plain resolveAlias. That made `adhdev launch codex`
  // resolve to the IDE webview provider and fail with "IDE 'codex' not found".
  it('scopes alias resolution to the requested categories without changing the default order', () => {
    writeProvider(userDir, 'extension', 'codex', {
      type: 'codex',
      name: 'Codex',
      displayName: 'Codex (IDE)',
      category: 'extension',
      extensionIdPattern: 'openai.codex',
    });
    writeProvider(userDir, 'cli', 'codex-cli', {
      type: 'codex-cli',
      name: 'Codex CLI',
      displayName: 'Codex CLI',
      category: 'cli',
      aliases: ['codex'],
      spawn: { command: 'codex' },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    // Default (unscoped) behaviour is deliberately unchanged: the direct type
    // match still wins, so the existing IDE/webview consumers keep resolving.
    expect(loader.resolveAlias('codex')).toBe('codex');
    expect(loader.getByAlias('codex')?.category).toBe('extension');

    // Launch-scoped resolution skips the out-of-category direct match and
    // follows the alias to the CLI provider.
    expect(loader.resolveAlias('codex', ['cli', 'acp'])).toBe('codex-cli');
    expect(loader.getByAlias('codex', ['cli', 'acp'])?.type).toBe('codex-cli');

    // A direct type match is still honoured when it is inside the scope.
    expect(loader.resolveAlias('codex-cli', ['cli', 'acp'])).toBe('codex-cli');
    expect(loader.resolveAlias('codex', ['extension'])).toBe('codex');

    // Nothing in scope → input returned as-is, and getByAlias hands back
    // undefined rather than an out-of-scope provider.
    expect(loader.resolveAlias('codex', ['ide'])).toBe('codex');
    expect(loader.getByAlias('codex', ['ide'])).toBeUndefined();
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
      // visible_when_state must survive synthesis so the web bar can mirror the
      // daemon's click-time gating (FsmDriver.handleClickControl).
      visibleWhenState: ['idle'],
    });

    const stop = controls.find((c) => c.id === 'stop');
    expect(stop).toMatchObject({
      id: 'stop',
      type: 'action',
      placement: 'bar',
      invokeScript: 'stop',
      order: 0,
      visibleWhenState: ['busy'],
    });

    // A control_bar entry without visible_when_state stays ungated.
    const cycleMode = controls.find((c) => c.id === 'cycle_mode');
    expect(cycleMode).toMatchObject({ id: 'cycle_mode', type: 'action' });
    expect(cycleMode?.visibleWhenState).toEqual(['idle']);

    // The invoke-gate stub still exists alongside the web controls.
    expect(typeof (resolved?.scripts as any)?.set_model).toBe('function');
  });

  it('omits visibleWhenState when the control_bar entry does not declare visible_when_state', () => {
    writeProvider(userDir, 'cli', 'codex', {
      type: 'codex',
      name: 'Codex',
      displayName: 'Codex',
      category: 'cli',
      spawn: { command: 'codex' },
    });
    writeSpecJson(userDir, 'cli', 'codex', {
      control_bar: [
        // No visible_when_state — must stay always-visible (regression guard).
        { id: 'set_model', label: 'Model', action: { type: 'open_picker', trigger_keys: '/model\r', wait_for: { section: 'modal', regex: 'x' }, extract_choices: { section: 'modal', pattern: 'x' }, submit_key: '{index}\r' } },
      ],
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const model = loader.resolve('codex')?.controls?.find((c) => c.id === 'set_model');
    expect(model).toBeDefined();
    expect(model?.visibleWhenState).toBeUndefined();
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

describe('ProviderLoader v1-manifest inline nativeHistory.source wiring', () => {
  let userDir = '';
  let testConfig: { providerSettings?: Record<string, Record<string, unknown>> };

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'adhdev-provider-v1nh-'));
    testConfig = { providerSettings: {} };
  });

  afterEach(() => {
    if (userDir) rmSync(userDir, { recursive: true, force: true });
    userDir = '';
    testConfig = { providerSettings: {} };
  });

  // Regression: a v1-manifest-only provider (provider.v1.json, no specs/*.json)
  // that declares its native history INLINE via the camelCase `nativeHistory`
  // block with a `source` (opencode's sqlite source) must get its declarative
  // executor wired to scripts.readNativeHistory. The wiring used to be gated on
  // a separate spec file whose snake_case `native_history` block it read, so a
  // v1-inline nativeHistory.source was silently ignored → read_chat returned
  // native-unavailable, the assistant reply was dropped and the session wedged.
  it('wires readNativeHistory from an inline nativeHistory.source when no spec.json exists', () => {
    writeV1Provider(userDir, 'cli', 'opencode-fixture', {
      type: 'opencode-fixture',
      name: 'Opencode Fixture',
      displayName: 'Opencode Fixture',
      category: 'cli',
      spawn: { command: 'opencode' },
      transcriptAuthority: 'provider',
      nativeHistory: {
        mode: 'native-source',
        source: {
          kind: 'sqlite',
          path: '~/.local/share/opencode/opencode.db',
          session_query: 'SELECT id FROM session LIMIT 1',
          message_query: 'SELECT role, content FROM message WHERE session_id = ?',
          message_map: { role: '$.role', content: '$.content' },
        },
      },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const resolved = loader.resolve('opencode-fixture');
    expect(typeof (resolved?.scripts as any)?.readNativeHistory).toBe('function');
    expect((resolved as any)?.nativeHistory?.mode).toBe('native-source');
    expect((resolved as any)?.nativeHistory?.format).toBe('spec-sqlite');
    expect((resolved as any)?.nativeHistory?.scripts?.readSession).toBe('readNativeHistory');
    // sqlite enumerates through its own session_query, not a directory walk, so
    // the loader must NOT advertise a listSessions marker (that would surface an
    // always-empty enumerator).
    expect((resolved as any)?.nativeHistory?.scripts?.listSessions).toBeUndefined();
    expect((resolved?.scripts as any)?.listNativeHistory).toBeUndefined();
  });

  // Regression for the "history list always empty" defect: a declarative jsonl
  // source must wire BOTH the reader AND the enumerator. The loader previously
  // hardcoded `scripts: { readSession: 'readNativeHistory' }`, dropping the
  // listSessions marker, so `getProviderNativeHistoryScript(...,'listSessions')`
  // resolved to undefined and `list_saved_sessions` returned [] for every
  // declarative-source provider regardless of on-disk transcripts.
  it('wires listNativeHistory (listSessions) from an inline nativeHistory jsonl source', () => {
    const store = mkdtempSync(join(tmpdir(), 'adhdev-nh-jsonl-store-'));
    const projectDir = join(store, 'projects', '-workspaces-alpha');
    mkdirSync(projectDir, { recursive: true });
    const sessionId = 'deadbeef-1111-4111-8111-111111111111';
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'user', timestamp: 1_800_000_001_000, message: { role: 'user', content: 'q' } }),
        JSON.stringify({ type: 'assistant', timestamp: 1_800_000_002_000, message: { role: 'assistant', content: 'a' } }),
      ].join('\n') + '\n',
      'utf8',
    );

    writeV1Provider(userDir, 'cli', 'claudeish-fixture', {
      type: 'claudeish-fixture',
      name: 'Claudeish Fixture',
      displayName: 'Claudeish Fixture',
      category: 'cli',
      spawn: { command: 'claudeish' },
      transcriptAuthority: 'provider',
      nativeHistory: {
        mode: 'native-source',
        source: {
          kind: 'jsonl',
          path: join(store, 'projects', '{cwd_claude_project}', '{session_id}.jsonl'),
          session_id_from: 'filename_uuid',
          message_filter: { where: "$.type == 'user' || $.type == 'assistant'" },
          message_map: { role: '$.message.role', content: '$.message.content', timestamp_ms: '$.timestamp' },
        },
      },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const resolved = loader.resolve('claudeish-fixture');
    expect((resolved as any)?.nativeHistory?.format).toBe('spec-jsonl');
    expect((resolved as any)?.nativeHistory?.scripts?.readSession).toBe('readNativeHistory');
    expect((resolved as any)?.nativeHistory?.scripts?.listSessions).toBe('listNativeHistory');
    expect(typeof (resolved?.scripts as any)?.listNativeHistory).toBe('function');

    // End-to-end: the wired lister enumerates the on-disk session.
    const listed = (resolved?.scripts as any).listNativeHistory({});
    expect(listed.sessions.map((s: any) => s.historySessionId)).toEqual([sessionId]);
    expect(listed.sessions[0].messageCount).toBe(2);
    expect(listed.sessions[0].preview).toBe('a');

    rmSync(store, { recursive: true, force: true });
  });

  // A v1 manifest whose nativeHistory only names scripts.readSession (the shape
  // claude/codex/antigravity ship, with the real reader wired from their
  // specs/*.json) must NOT be mistaken for a declarative source and get a
  // no-op executor bound over it.
  it('does not wire a source reader for a bare nativeHistory marker (no source/reader/override_path)', () => {
    writeV1Provider(userDir, 'cli', 'bare-nh-fixture', {
      type: 'bare-nh-fixture',
      name: 'Bare NH Fixture',
      displayName: 'Bare NH Fixture',
      category: 'cli',
      spawn: { command: 'bare' },
      nativeHistory: {
        mode: 'native-source',
        scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
      },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const resolved = loader.resolve('bare-nh-fixture');
    expect(typeof (resolved?.scripts as any)?.readNativeHistory).not.toBe('function');
  });

  // Regression (rc.29 production-shape gap): the legacy resolve path used to
  // REWRITE resolved.nativeHistory to {format, watchPath, scripts, mode},
  // dropping the declarative `source` (and contractVersion). Unit tests that
  // passed the manifest shape straight to the detector kept passing, but a
  // loader-resolved provider (production kimi) always reported background
  // detection inactive. Resolving the shipped kimi manifest shape through the
  // ProviderLoader must preserve source.kind=jsonl alongside the runtime
  // format/scripts/mode fields.
  it('preserves the declarative nativeHistory.source when resolving the shipped kimi manifest shape', () => {
    writeV1Provider(userDir, 'cli', 'kimi', {
      type: 'kimi',
      name: 'Kimi',
      displayName: 'Kimi',
      category: 'cli',
      spawn: { command: 'kimi' },
      transcriptAuthority: 'provider',
      // Mirrors adhdev-providers/cli/kimi/provider.v1.json (shipped shape).
      nativeHistory: {
        mode: 'native-source',
        contractVersion: '2.0',
        source: {
          kind: 'jsonl',
          path: '~/.kimi-code/sessions/*/session_*/agents/main',
          file_pattern: 'wire.jsonl',
          session_id_from: 'dir_uuid',
          workspace_from_sidecar: {
            rel_path: '../../state.json',
            workspace_path: '$.workDir',
          },
          records: [
            {
              where: '$.type == "turn.prompt"',
              message_map: { role: 'user', content: '$.input', timestamp_ms: '$.time' },
            },
            {
              where: '$.type == "context.append_loop_event" && $.event.type == "content.part" && $.event.part.type == "text"',
              message_map: { role: 'assistant', content: '$.event.part.text', timestamp_ms: '$.time' },
            },
          ],
        },
      },
    });

    const loader = new TestProviderLoader(userDir, testConfig);
    loader.loadAll();

    const resolved = loader.resolve('kimi');
    const nh = (resolved as any)?.nativeHistory;
    // Declarative fields survive…
    expect(nh?.source?.kind).toBe('jsonl');
    expect(nh?.source?.file_pattern).toBe('wire.jsonl');
    expect(nh?.source?.session_id_from).toBe('dir_uuid');
    expect(nh?.contractVersion).toBe('2.0');
    // …and the runtime wiring is unchanged.
    expect(nh?.mode).toBe('native-source');
    expect(nh?.format).toBe('spec-jsonl');
    expect(nh?.scripts?.readSession).toBe('readNativeHistory');
    expect(nh?.scripts?.listSessions).toBe('listNativeHistory');
    expect(typeof (resolved?.scripts as any)?.readNativeHistory).toBe('function');
  });
});
