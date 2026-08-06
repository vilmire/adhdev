/**
 * Build-track stamp → provider channel derivation (track-identity phase).
 *
 * The silent regression this guards: a PREVIEW BUILD on a machine whose
 * config.json still says updateChannel=stable (or nothing) used to derive the
 * STABLE provider channel and quietly activate stable providers. contract.ts
 * now consults the build track stamp (resolveBuildTrack: build-time injection
 * > ADHDEV_BUILD_CHANNEL env > stable) as a second preview signal alongside
 * the runtime release channel. Explicit providerChannel config/env still
 * always wins, and a stable stamp with no release channel still resolves
 * stable (byte-compatible).
 *
 * vitest runs src without the tsup define, so the env axis stands in for the
 * build-time injection here — both feed the same resolveBuildTrack()
 * precedence, with injection outranking env by construction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveProviderChannel } from '../../../src/providers/channel/contract.js';
import { ProviderLoader } from '../../../src/providers/provider-loader.js';
import { loadConfig } from '../../../src/config/config.js';
import { makeTmp } from './helpers.js';

const ORIGINAL_ENV = {
  ADHDEV_CONFIG_DIR: process.env.ADHDEV_CONFIG_DIR,
  ADHDEV_PROVIDER_CHANNEL: process.env.ADHDEV_PROVIDER_CHANNEL,
  ADHDEV_BUILD_CHANNEL: process.env.ADHDEV_BUILD_CHANNEL,
};

let tmpRoot = '';

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('build track stamp → provider channel', () => {
  beforeEach(() => {
    tmpRoot = makeTmp('adhdev-channel-stamp-');
    process.env.ADHDEV_CONFIG_DIR = tmpRoot;
    delete process.env.ADHDEV_PROVIDER_CHANNEL;
    delete process.env.ADHDEV_BUILD_CHANNEL;
  });

  afterEach(() => {
    restoreEnv();
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = '';
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify(config), 'utf-8');
  }

  // Mirrors the boot caller (boot/daemon-lifecycle.ts initDaemonComponents).
  function newBootLoader() {
    const config = loadConfig();
    return new ProviderLoader({
      channel: config.providerChannel,
      updateChannel: config.updateChannel,
      logFn: () => {},
      probeStarts: [join(tmpRoot, 'no-sibling-here')],
    });
  }

  it('preview stamp derives preview even when updateChannel is stable/absent', () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    expect(resolveProviderChannel(undefined, process.env, 'stable')).toBe('preview');
    expect(resolveProviderChannel(undefined, process.env, undefined)).toBe('preview');
    expect(resolveProviderChannel(null, process.env, null)).toBe('preview');
  });

  it('explicit providerChannel always wins over the build stamp', () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    expect(resolveProviderChannel('stable', process.env, 'stable')).toBe('stable');
    expect(resolveProviderChannel('preview', process.env, 'stable')).toBe('preview');
  });

  it('ADHDEV_PROVIDER_CHANNEL env always wins over the build stamp', () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    process.env.ADHDEV_PROVIDER_CHANNEL = 'stable';
    expect(resolveProviderChannel(undefined, process.env, 'stable')).toBe('stable');
  });

  it('stable stamp stays behavior-neutral: release channel drives the derivation as before', () => {
    // No build stamp (stable build): identical results to the pre-stamp rule.
    expect(resolveProviderChannel(undefined, process.env, 'preview')).toBe('preview');
    expect(resolveProviderChannel(undefined, process.env, 'next')).toBe('preview');
    expect(resolveProviderChannel(undefined, process.env, 'stable')).toBe('stable');
    expect(resolveProviderChannel(undefined, process.env, undefined)).toBe('stable');
  });

  it('unrecognized stamp values fail closed to the release-channel rule', () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'beta';
    expect(resolveProviderChannel(undefined, process.env, 'stable')).toBe('stable');
    expect(resolveProviderChannel(undefined, process.env, 'preview')).toBe('preview');
  });

  it('loader level: preview build + stable/absent config no longer derives stable providers', () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    writeConfig({});
    expect(newBootLoader().channel).toBe('preview');
    writeConfig({ updateChannel: 'stable' });
    expect(newBootLoader().channel).toBe('preview');
  });

  it('loader level: explicit providerChannel=stable still wins on a preview build', () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    writeConfig({ providerChannel: 'stable' });
    expect(newBootLoader().channel).toBe('stable');
  });

  it('loader level: stable build keeps the updateChannel derivation unchanged', () => {
    writeConfig({});
    expect(newBootLoader().channel).toBe('stable');
    writeConfig({ updateChannel: 'preview' });
    expect(newBootLoader().channel).toBe('preview');
  });
});
