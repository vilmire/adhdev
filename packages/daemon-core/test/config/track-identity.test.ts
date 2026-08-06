/**
 * Track identity golden values + config-dir convergence guards.
 *
 * Pins the stable/preview track constants against the CODE DEFAULTS they
 * converge (config.ts DEFAULT_CONFIG, ipc-protocol.ts DEFAULT_DAEMON_PORT,
 * daemon-cloud service-commands.ts label/vbs/port constants, app-name.ts
 * session-host name, daemon-commands.ts npm tag map) — never against values
 * observed on a particular machine, which may be pinned to a non-default
 * channel via config.json or env overrides.
 *
 * The stable-track assertions are behavior-neutral guards: they must pass
 * identically before and after the track-identity refactor. The
 * preview-track assertions pin the new build-stamp axis (they fail on a tree
 * without the stamp, which is the point).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getConfigDir, getDaemonDataDir } from '../../src/config/config.js';
import { getDaemonLogDir } from '../../src/logging/logger.js';
import { ProviderChannelStore } from '../../src/providers/channel/store.js';
import { resolveInstanceDir } from '../../src/commands/upgrade-helper.js';
import { resolveInstanceContext } from '../../src/config/instance-context.js';
import { DEFAULT_DAEMON_PORT } from '../../src/ipc-protocol.js';
import {
  isDefaultInstanceConfigDir,
  resolveSessionHostIpcKey,
} from '@adhdev/session-host-core';

const ORIGINAL_ENV = {
  ADHDEV_CONFIG_DIR: process.env.ADHDEV_CONFIG_DIR,
  ADHDEV_BUILD_CHANNEL: process.env.ADHDEV_BUILD_CHANNEL,
  HOME: process.env.HOME,
};

let tempRoot = '';
let fakeHome = '';

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Re-import track-identity with a clean module registry so TRACK/IDENTITY re-snapshot. */
async function importIdentity() {
  vi.resetModules();
  return await import('../../src/track-identity.js');
}

describe('track identity', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'adhdev-track-identity-'));
    fakeHome = join(tempRoot, 'home');
    process.env.HOME = fakeHome;
    delete process.env.ADHDEV_CONFIG_DIR;
    delete process.env.ADHDEV_BUILD_CHANNEL;
  });

  afterEach(() => {
    restoreEnv();
    if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
    fakeHome = '';
  });

  it('stable track pins the current code defaults (behavior-neutral)', async () => {
    const { TRACK, IDENTITY } = await importIdentity();
    expect(TRACK).toBe('stable');
    expect(IDENTITY).toEqual({
      binaryName: 'adhdev',
      configDirName: '.adhdev',
      defaultPort: 19_222,
      serverUrl: 'https://api.adhf.dev',
      launchdLabel: 'dev.adhf.daemon',
      vbsFileName: 'adhdev-daemon.vbs',
      sessionHostName: 'adhdev',
      npmTag: 'latest',
    });
    // The port must stay glued to the daemon-core protocol default.
    expect(IDENTITY.defaultPort).toBe(DEFAULT_DAEMON_PORT);
  });

  it('preview track via ADHDEV_BUILD_CHANNEL env (the dev/test axis)', async () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    const { TRACK, IDENTITY } = await importIdentity();
    expect(TRACK).toBe('preview');
    expect(IDENTITY).toEqual({
      binaryName: 'adhdev-preview',
      configDirName: '.adhdev-preview',
      defaultPort: 19_223,
      serverUrl: 'https://api-preview.adhf.dev',
      launchdLabel: 'dev.adhf.daemon.preview',
      vbsFileName: 'adhdev-daemon-preview.vbs',
      sessionHostName: 'adhdev-preview',
      npmTag: 'next',
    });
  });

  it("accepts the npm dist-tag alias 'next' as preview; unknown values fail closed to stable", async () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'next';
    expect((await importIdentity()).TRACK).toBe('preview');
    process.env.ADHDEV_BUILD_CHANNEL = 'beta';
    expect((await importIdentity()).TRACK).toBe('stable');
    process.env.ADHDEV_BUILD_CHANNEL = '   ';
    expect((await importIdentity()).TRACK).toBe('stable');
  });

  it('install origin: stable keeps the historical adhf.dev host (behavior-neutral)', async () => {
    const { getInstallOrigin } = await importIdentity();
    // The exact host every pre-track-axis reinstall guidance hardcoded.
    expect(getInstallOrigin()).toBe('https://adhf.dev');
    expect(getInstallOrigin('stable')).toBe('https://adhf.dev');
  });

  it('install origin: preview tracks to dev.adhf.dev so reinstall advice cannot cross tracks', async () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    const { getInstallOrigin } = await importIdentity();
    expect(getInstallOrigin()).toBe('https://dev.adhf.dev');
    expect(getInstallOrigin('preview')).toBe('https://dev.adhf.dev');
  });

  it('config dir: no env resolves the stable home dir (code default)', () => {
    expect(getConfigDir()).toBe(join(fakeHome, '.adhdev'));
  });

  it('config dir: ADHDEV_CONFIG_DIR override wins on either track', () => {
    const override = join(tempRoot, 'override-config');
    process.env.ADHDEV_CONFIG_DIR = override;
    expect(getConfigDir()).toBe(override);
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    expect(getConfigDir()).toBe(override);
  });

  it('config dir: a preview build track defaults to ~/.adhdev-preview', () => {
    process.env.ADHDEV_BUILD_CHANNEL = 'preview';
    expect(getConfigDir()).toBe(join(fakeHome, '.adhdev-preview'));
  });

  it('derived paths assemble relative to the config dir', () => {
    const override = join(tempRoot, 'instance-a');
    process.env.ADHDEV_CONFIG_DIR = override;
    const configDir = getConfigDir();
    expect(getDaemonDataDir()).toBe(join(configDir, 'daemon'));
    expect(getDaemonLogDir()).toBe(join(configDir, 'logs'));
    // Verified provider channel store root (<configDir>/providers/.store).
    expect(ProviderChannelStore.defaultRoot()).toBe(join(configDir, 'providers', '.store'));
  });

  it('instance discrimination: config-dir basename splits stable from preview', () => {
    expect(resolveInstanceDir(join(fakeHome, '.adhdev'))).toBe('.adhdev');
    expect(resolveInstanceDir(join(fakeHome, '.adhdev-preview'))).toBe('.adhdev-preview');
    expect(isDefaultInstanceConfigDir(join(fakeHome, '.adhdev'), fakeHome)).toBe(true);
    expect(isDefaultInstanceConfigDir(join(fakeHome, '.adhdev-preview'), fakeHome)).toBe(false);
    // The stable default keeps the legacy empty IPC key; preview gets its own
    // namespace so the two session hosts can never attach to each other.
    expect(resolveSessionHostIpcKey(join(fakeHome, '.adhdev'), fakeHome)).toBe('');
    expect(resolveSessionHostIpcKey(join(fakeHome, '.adhdev-preview'), fakeHome)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('instance context: no-env default follows the build track', () => {
    expect(resolveInstanceContext({ env: {}, homeDir: fakeHome }).configDir)
      .toBe(join(fakeHome, '.adhdev'));
    expect(resolveInstanceContext({ env: { ADHDEV_BUILD_CHANNEL: 'preview' }, homeDir: fakeHome }).configDir)
      .toBe(join(fakeHome, '.adhdev-preview'));
  });
});
