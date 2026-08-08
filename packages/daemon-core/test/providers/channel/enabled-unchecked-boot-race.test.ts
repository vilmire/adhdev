/**
 * Boot-race regression: a provider enabled with no `lastDetection` record yet
 * (first boot after `setMachineProviderEnabled`, e.g. from the setup wizard)
 * stayed stuck at machineStatus='enabled_unchecked' forever, because the
 * verified-channel first-sync's own `loadAll()` (provider-loader.ts) clears
 * `providerAvailability` AFTER boot's initial detection pass already ran:
 *
 *   enabled=true, no lastDetection
 *     → boot loadAll()            (providerAvailability empty)
 *     → [maybeFirstSyncVerifiedChannel activates N providers]
 *     → sync's internal loadAll() (providerAvailability cleared again)
 *     → nothing re-detects        (BUG: sits at enabled_unchecked forever)
 *
 * `getEffectiveProviderAvailability()` falls back to `lastDetection` in
 * config when the in-memory map is empty, so this only bites providers that
 * have never been detected before — which is exactly the fresh-enable case.
 *
 * Fix (boot/daemon-lifecycle.ts): after `maybeFirstSyncVerifiedChannel()`
 * resolves with `activated.length > 0`, re-run detection
 * (`registerToDetector()` + the same `refreshProviderAvailability()` used by
 * `onProviderSettingChanged`) so first-boot enables resolve to
 * detected/not_detected instead of sitting unchecked.
 *
 * This test exercises the underlying provider-loader contract the fix
 * depends on (mirrors the boot caller, same convention as the other channel
 * tests in this directory) rather than the full initDaemonComponents boot,
 * since detection here is deterministic and the race lives entirely in
 * provider-loader's loadAll()/providerAvailability interaction.
 *
 * Config is backed by an in-memory object via a readConfig/writeConfig
 * override (TestProviderLoader, same pattern as provider-loader.test.ts) —
 * ProviderLoader's real readConfig() lazily `require()`s config.js, which
 * does not resolve reliably from a vitest-transformed test module, so the
 * repo's convention is to inject config rather than round-trip real disk
 * config.json in loader-level tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProviderLoader } from '../../../src/providers/provider-loader.js';
import { ProviderChannelStore } from '../../../src/providers/channel/store.js';
import { buildRepoTree, digestFor, makeRegistryRow, makeTmp, type FixtureProviderSpec } from './helpers.js';

const PROVIDER_TYPE = 'race-cli';

describe('daemon-lifecycle wiring — re-detect fires after first-sync activation', () => {
  it('the maybeFirstSyncVerifiedChannel().then() callback re-detects when activated.length > 0', () => {
    // The behavioral tests below prove registerToDetector() +
    // refreshProviderAvailability() actually resolve enabled_unchecked ->
    // detected at the provider-loader level. This test is the missing link:
    // it proves boot/daemon-lifecycle.ts's real .then() callback — the only
    // place that observes the sync landing during boot — actually calls
    // them, so reverting the fix (removing the call site) is caught even
    // though it doesn't change provider-loader.ts itself.
    const source = readFileSync(join(import.meta.dirname, '../../../src/boot/daemon-lifecycle.ts'), 'utf-8');
    const callback = source.match(/void providerLoader\.maybeFirstSyncVerifiedChannel\(\)\s*\.then\(async \(report\) => \{([\s\S]*?)\n {8}\}\)/);
    expect(callback, 'maybeFirstSyncVerifiedChannel().then() callback not found').toBeTruthy();
    const activatedBranch = callback![1].match(/report\.activated\.length > 0\) \{([\s\S]*?)\n {12}\}/);
    expect(activatedBranch, 'activated.length > 0 branch not found').toBeTruthy();
    const body = activatedBranch![1];
    expect(body).toContain('providerLoader.registerToDetector()');
    expect(body).toMatch(/await\s+refreshProviderAvailability\(\)/);
    expect(body).toContain('config.onStatusChange?.()');
  });
});

type TestConfig = {
  machineProviders?: Record<string, {
    enabled?: boolean;
    lastDetection?: Record<string, unknown>;
    lastVerification?: Record<string, unknown>;
  }>;
};

class TestProviderLoader extends ProviderLoader {
  constructor(opts: ConstructorParameters<typeof ProviderLoader>[0], private readonly testConfig: TestConfig) {
    super(opts);
  }

  protected override readConfig(): any | null {
    return this.testConfig;
  }

  protected override writeConfig(config: any): void {
    Object.assign(this.testConfig, config);
  }
}

describe('enabled_unchecked boot race (maybeFirstSyncVerifiedChannel clears providerAvailability)', () => {
  let tmpRoot = '';
  let repoRoot = '';
  let configDirBefore: string | undefined;
  let store: ProviderChannelStore;
  let testConfig: TestConfig;
  let spec: FixtureProviderSpec;
  let digest: string;

  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-enabled-unchecked-');
    configDirBefore = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    testConfig = { machineProviders: {} };

    store = new ProviderChannelStore(ProviderChannelStore.defaultRoot());

    // The provider is already installed via .upstream — a previous
    // boot/upgrade, exactly like the rc.20 "installed but store empty"
    // targeted-sync case (see fresh-install-bootstrap.test.ts /
    // preview-derivation.test.ts sibling tests). What's new THIS boot is
    // that the channel store itself is empty (loadAll() below therefore
    // does not pin it via the store) while .upstream still has it on disk
    // from before — mirroring the real "installed set" first-sync target.
    spec = { category: 'cli', dirname: PROVIDER_TYPE, type: PROVIDER_TYPE, version: '1.0.0' };
    repoRoot = makeTmp('adhdev-enabled-unchecked-repo-');
    buildRepoTree(repoRoot, [spec]);
    digest = digestFor(repoRoot, 'cli', PROVIDER_TYPE);

    const upstreamDir = join(tmpRoot, 'providers', '.upstream', 'cli', PROVIDER_TYPE);
    mkdirSync(upstreamDir, { recursive: true });
    writeFileSync(
      join(upstreamDir, 'provider.json'),
      JSON.stringify({ type: PROVIDER_TYPE, name: `${PROVIDER_TYPE} name`, category: 'cli', version: '1.0.0', spawn: { command: PROVIDER_TYPE } }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    if (configDirBefore === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = configDirBefore;
    for (const dir of [tmpRoot, repoRoot]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    tmpRoot = repoRoot = '';
  });

  function newBootLoader() {
    return new TestProviderLoader({
      updateChannel: 'stable',
      channelStore: store,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
      // syncVerifiedChannel targets .upstream (hasUpstream() branch). The
      // registry row's digest must match the extracted bytes for the entry
      // to activate (digest-verified activation, not a legacy-unverified
      // skip) — same fixture shape as fresh-install-bootstrap.test.ts.
      channelSyncIO: {
        fetchJson: async () => ({ providers: [makeRegistryRow(spec, digest)] }),
        downloadFile: async () => {},
        extractTarball: async (_tarPath: string, destDir: string) => {
          const { cpSync, mkdirSync: mk } = await import('fs');
          const inner = join(destDir, 'adhdev-providers-test');
          mk(inner, { recursive: true });
          cpSync(repoRoot, inner, { recursive: true });
        },
      },
    }, testConfig);
  }

  it('reproduces the race: enabling before an empty-store sync leaves status stuck at enabled_unchecked', () => {
    const loader = newBootLoader();

    // Boot step 1: initial loadAll() loads the provider from .upstream
    // (channel store is empty). The provider itself IS visible via
    // .upstream at this point.
    loader.loadAll();
    expect(loader.getMeta(PROVIDER_TYPE)).toBeDefined();

    // The setup wizard enables the provider (separate CLI process, real
    // API) — no lastDetection exists yet.
    expect(loader.setMachineProviderEnabled(PROVIDER_TYPE, true)).toBe(true);
    expect(loader.isMachineProviderEnabled(PROVIDER_TYPE)).toBe(true);
    expect(loader.getMachineProviderConfig(PROVIDER_TYPE).lastDetection).toBeUndefined();

    // Before any sync/detect ever ran, status is legitimately unchecked.
    expect(loader.getMachineProviderStatus(PROVIDER_TYPE)).toBe('enabled_unchecked');

    // Boot step 2 (this boot, or the next restart before detection landed):
    // the channel store is empty (legacy-unverified .upstream row, as in
    // the rc.20 gap), so maybeFirstSyncVerifiedChannel's targeted sync
    // activates the provider and its own loadAll() clears
    // providerAvailability again.
    loader.loadAll();

    // Bug reproduction: enabled=true, providerAvailability just cleared by
    // the sync's loadAll(), and lastDetection is still absent — the
    // getEffectiveProviderAvailability() config fallback has nothing to
    // fall back to either.
    expect(loader.getMachineProviderStatus(PROVIDER_TYPE)).toBe('enabled_unchecked');
  });

  it('fix contract: re-detecting after activation (registerToDetector + setCliDetectionResults, as refreshProviderAvailability does) resolves enabled_unchecked -> detected', async () => {
    const loader = newBootLoader();
    loader.loadAll();
    expect(loader.setMachineProviderEnabled(PROVIDER_TYPE, true)).toBe(true);

    const report = await loader.maybeFirstSyncVerifiedChannel();
    expect(report?.activated.length).toBeGreaterThan(0);
    expect(loader.getMachineProviderStatus(PROVIDER_TYPE)).toBe('enabled_unchecked');

    // This is exactly what daemon-lifecycle.ts's refreshProviderAvailability()
    // does for the CLI/ACP branch (detectCLIs + setCliDetectionResults), and
    // what the fix now runs from the maybeFirstSyncVerifiedChannel().then()
    // callback when report.activated.length > 0.
    loader.registerToDetector();
    loader.setCliDetectionResults([{ id: PROVIDER_TYPE, installed: true, path: '/usr/bin/race-cli' }], true);

    expect(loader.getMachineProviderStatus(PROVIDER_TYPE)).toBe('detected');

    // And it persisted lastDetection, so a subsequent loadAll() (e.g. a
    // later restart before any new activation) no longer needs live
    // providerAvailability — the config fallback now has something to use.
    loader.loadAll();
    expect(loader.getMachineProviderStatus(PROVIDER_TYPE)).toBe('detected');
  });
});
