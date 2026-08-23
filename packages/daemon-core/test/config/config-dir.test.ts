import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, win32, posix } from 'path';
import { tmpdir } from 'os';
import { getConfigDir } from '../../src/config/config.js';
import {
  resolveConfigDir,
  resolveConfigLogsDir,
  isCrossTrackConfigDirOverride,
  configDirChannelMismatch,
  detectOccupiedConfigDir,
  formatOccupiedConfigDirWarning,
  ALLOW_TRACK_MISMATCH_ENV_VAR,
} from '../../src/config/config-dir.js';

const ORIGINAL_ENV = {
  ADHDEV_CONFIG_DIR: process.env.ADHDEV_CONFIG_DIR,
  HOME: process.env.HOME,
};

let tempRoot = '';
let fakeHome = '';
let overrideDir = '';

describe('getConfigDir', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'adhdev-config-dir-'));
    fakeHome = join(tempRoot, 'home');
    overrideDir = join(tempRoot, 'override-config');
    process.env.HOME = fakeHome;
    delete process.env.ADHDEV_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV.ADHDEV_CONFIG_DIR === undefined) {
      delete process.env.ADHDEV_CONFIG_DIR;
    } else {
      process.env.ADHDEV_CONFIG_DIR = ORIGINAL_ENV.ADHDEV_CONFIG_DIR;
    }
    if (ORIGINAL_ENV.HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_ENV.HOME;
    }
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoot = '';
    fakeHome = '';
    overrideDir = '';
  });

  it('uses ADHDEV_CONFIG_DIR without creating the default home config directory', () => {
    process.env.ADHDEV_CONFIG_DIR = overrideDir;

    expect(getConfigDir()).toBe(overrideDir);
    expect(existsSync(overrideDir)).toBe(true);
    expect(existsSync(join(fakeHome, '.adhdev'))).toBe(false);
  });

  it('falls back to HOME/.adhdev when ADHDEV_CONFIG_DIR is blank', () => {
    // Inject the env explicitly: the test-runtime fail-fast gate in
    // resolveConfigDir guards the default process-env call (a blank override
    // there means an un-pinned test), so the suite covering the fallback rule
    // itself must go through the injected-env path.
    const expected = join(fakeHome, '.adhdev');

    expect(getConfigDir({ ADHDEV_CONFIG_DIR: '   ' }, fakeHome)).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });
});

describe('resolveConfigDir / resolveConfigLogsDir (shared pure helper)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'adhdev-config-dir-'));
    fakeHome = join(tempRoot, 'home');
    overrideDir = join(tempRoot, 'override-config');
    process.env.HOME = fakeHome;
    delete process.env.ADHDEV_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV.ADHDEV_CONFIG_DIR === undefined) {
      delete process.env.ADHDEV_CONFIG_DIR;
    } else {
      process.env.ADHDEV_CONFIG_DIR = ORIGINAL_ENV.ADHDEV_CONFIG_DIR;
    }
    if (ORIGINAL_ENV.HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_ENV.HOME;
    }
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoot = '';
    fakeHome = '';
    overrideDir = '';
  });

  it('matches the getConfigDir rule but performs NO mkdir', () => {
    // Injected (env, homeDir) — see the getConfigDir blank-fallback case above.
    expect(resolveConfigDir({}, fakeHome)).toBe(join(fakeHome, '.adhdev'));
    expect(existsSync(join(fakeHome, '.adhdev'))).toBe(false);

    process.env.ADHDEV_CONFIG_DIR = overrideDir;
    expect(resolveConfigDir()).toBe(overrideDir);
    expect(existsSync(overrideDir)).toBe(false);
  });

  it('resolves logs/ under the same base and re-reads the env on every call', () => {
    expect(resolveConfigLogsDir({}, fakeHome)).toBe(join(fakeHome, '.adhdev', 'logs'));
    process.env.ADHDEV_CONFIG_DIR = overrideDir;
    expect(resolveConfigLogsDir()).toBe(join(overrideDir, 'logs'));
  });
});

// ─── test-runtime fail-fast gate ────────────────────────────────────────────
//
// The gate guards ONLY the default process-env call: under a test runtime
// (VITEST=true — always set by this runner — or NODE_ENV=test) a process-env
// call that reaches the real-home fallback means a test forgot to pin
// ADHDEV_CONFIG_DIR and is about to write the LIVE ~/.adhdev(-preview) state
// dir. Revert-sensitive: deleting the gate from resolveConfigDir turns the
// first two cases red.
describe('resolveConfigDir test-runtime fail-fast gate', () => {
  const ORIGINAL_GATE_ENV = {
    ADHDEV_CONFIG_DIR: process.env.ADHDEV_CONFIG_DIR,
    VITEST: process.env.VITEST,
    NODE_ENV: process.env.NODE_ENV,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
  };

  afterEach(() => {
    for (const key of ['ADHDEV_CONFIG_DIR', 'VITEST', 'NODE_ENV', 'NODE_TEST_CONTEXT'] as const) {
      const original = ORIGINAL_GATE_ENV[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('throws when a process-env call reaches the real-home fallback under vitest with no pin', () => {
    delete process.env.ADHDEV_CONFIG_DIR;
    expect(process.env.VITEST).toBeTruthy(); // the runner really is a test runtime
    expect(() => resolveConfigDir()).toThrow(/real-home fallback in a test runtime/);
  });

  it('throws for a blank override too (blank is treated as unset)', () => {
    process.env.ADHDEV_CONFIG_DIR = '   ';
    expect(() => resolveConfigDir()).toThrow(/real-home fallback in a test runtime/);
  });

  it('does NOT throw when ADHDEV_CONFIG_DIR is pinned (the ordinary isolated suite)', () => {
    process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-config-dir-gate-'));
    expect(() => resolveConfigDir()).not.toThrow();
    rmSync(process.env.ADHDEV_CONFIG_DIR!, { recursive: true, force: true });
  });

  it('does NOT throw for an injected env without a pin (fallback-rule unit tests stay pure)', () => {
    delete process.env.ADHDEV_CONFIG_DIR;
    expect(resolveConfigDir({}, '/nonexistent-home')).toBe(join('/nonexistent-home', '.adhdev'));
  });

  it('does NOT throw outside a test runtime (no VITEST, NODE_ENV != test)', () => {
    delete process.env.ADHDEV_CONFIG_DIR;
    delete process.env.VITEST;
    delete process.env.NODE_TEST_CONTEXT;
    process.env.NODE_ENV = 'production';
    expect(() => resolveConfigDir()).not.toThrow();
  });

  it('throws under NODE_TEST_CONTEXT even when VITEST and NODE_ENV=test are absent (node --test)', () => {
    delete process.env.ADHDEV_CONFIG_DIR;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    process.env.NODE_TEST_CONTEXT = 'child';
    expect(() => resolveConfigDir()).toThrow(/real-home fallback in a test runtime/);
  });

  // TMP-HOME-NOT-LIVE: the gate resolves the "live" dirs against homedir(),
  // which follows $HOME on POSIX. A test that relocates $HOME to a tmp dir —
  // the correct way to stay isolated — then stages <tmpHome>/.adhdev under it,
  // and the gate used to match that as the developer's live dir and throw. It
  // fired on exactly the tests doing the right thing: 45 failures across 10
  // files (2026-08-23). A path under the temp root is never live state.
  it('does NOT throw for <tmpHome>/.adhdev when a test has relocated $HOME to a tmp dir', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'adhdev-cfgdir-gate-'));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tmpHome;
      process.env.ADHDEV_CONFIG_DIR = join(tmpHome, '.adhdev');
      expect(() => resolveConfigDir()).not.toThrow();
      expect(resolveConfigDir()).toBe(join(tmpHome, '.adhdev'));
      // The preview name under a tmp home is equally not live.
      process.env.ADHDEV_CONFIG_DIR = join(tmpHome, '.adhdev-preview');
      expect(() => resolveConfigDir()).not.toThrow();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // Same class as TMP-HOME-NOT-LIVE, other branch: the UNSET-pin throw used to
  // fire without looking at where the fallback would land. A suite that
  // relocated $HOME to a tmp dir resolves to <tmpHome>/.adhdev — isolated by
  // construction, and the only way to exercise the fallback RULE itself
  // (daemon-cloud service-instance descriptors, daemon pid paths). Judge the
  // destination, not the mere absence of a pin.
  it('does NOT throw with an unset pin when $HOME is a tmp dir (fallback lands outside live state)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'adhdev-cfgdir-unset-'));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tmpHome;
      delete process.env.ADHDEV_CONFIG_DIR;
      expect(() => resolveConfigDir()).not.toThrow();
      expect(resolveConfigDir()).toBe(join(tmpHome, '.adhdev'));
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('throws when ADHDEV_CONFIG_DIR is pinned to the live ~/.adhdev-preview home', () => {
    const { homedir } = require('os') as typeof import('os');
    const livePreview = join(homedir(), '.adhdev-preview');
    process.env.ADHDEV_CONFIG_DIR = livePreview;
    expect(() => resolveConfigDir()).toThrow(/pinned to the LIVE/);
  });

  it('throws when ADHDEV_CONFIG_DIR is pinned to the live ~/.adhdev home', () => {
    const { homedir } = require('os') as typeof import('os');
    const liveStable = join(homedir(), '.adhdev');
    process.env.ADHDEV_CONFIG_DIR = liveStable;
    expect(() => resolveConfigDir()).toThrow(/pinned to the LIVE/);
  });

  it('does NOT throw for an injected env whose ADHDEV_CONFIG_DIR looks like a live home (fallback-rule tests stay pure)', () => {
    const { homedir } = require('os') as typeof import('os');
    const livePreview = join(homedir(), '.adhdev-preview');
    expect(resolveConfigDir({ ADHDEV_CONFIG_DIR: livePreview }, '/nonexistent-home')).toBe(livePreview);
  });
});

// ─── isCrossTrackConfigDirOverride ──────────────────────────────────────────
//
// Every case here uses the fully-injected (env, homeDir, platform) signature
// — no process.env mutation, no temp dirs — so these are pure and order-
// independent from the process.env-mutating describe blocks above.
//
// Fixture paths are built with the EXPLICIT path.win32 / path.posix modules,
// never the ambient platform-native `path` import, precisely because this
// suite is a path-comparison suite: on a POSIX test runner, feeding a
// backslash-laden Windows fixture through the ambient (POSIX-flavored) join
// does NOT throw or visibly fail — Node's posix.join treats the whole
// backslash string as one opaque path segment and happily concatenates it,
// producing a string that still "looks like" a path. A test asserting
// inequality against a subtly-wrong fixture built that way would then pass
// for the wrong reason (vacuously) on POSIX CI while meaning something
// different on an actual Windows machine. Pinning path.win32/path.posix
// explicitly makes every fixture identical regardless of which OS runs the
// suite.
describe('isCrossTrackConfigDirOverride (cross-track uninstall-guard predicate)', () => {
  const homeWin = 'C:\\Users\\vilmi';
  const homePosix = '/home/vilmi';

  it('returns false when ADHDEV_CONFIG_DIR is unset', () => {
    expect(isCrossTrackConfigDirOverride({}, homePosix, 'linux')).toBe(false);
  });

  it('returns false for a blank ADHDEV_CONFIG_DIR', () => {
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: '   ' }, homePosix, 'linux')).toBe(false);
  });

  it('does NOT flag a /tmp test-isolation dir as cross-track (legitimate isolation must stay unaffected)', () => {
    const isolation = posix.join('/tmp', 'adhdev-test-abc123');
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: isolation }, homePosix, 'linux')).toBe(false);
    // Same isolation dir under a preview build must also stay unflagged.
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: isolation, ADHDEV_BUILD_CHANNEL: 'preview' }, homePosix, 'linux')).toBe(false);
  });

  it('does NOT flag daemon-standalone\'s own .adhdev-standalone dir (a third, distinct name)', () => {
    const standaloneDir = win32.join(homeWin, '.adhdev-standalone');
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: standaloneDir }, homeWin, 'win32')).toBe(false);
  });

  it('does NOT flag a same-named sibling dir living somewhere OTHER than this homeDir (full-path, not basename, comparison)', () => {
    const lookalike = posix.join('/mnt/other-user-home', '.adhdev-preview');
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: lookalike }, homePosix, 'linux')).toBe(false);
  });

  it('flags stable binary + ADHDEV_CONFIG_DIR pointed at the preview track\'s own dir', () => {
    const siblingPreview = win32.join(homeWin, '.adhdev-preview');
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: siblingPreview }, homeWin, 'win32')).toBe(true);
  });

  it('flags preview binary + ADHDEV_CONFIG_DIR pointed at the stable track\'s own dir (reverse direction)', () => {
    const siblingStable = win32.join(homeWin, '.adhdev');
    expect(isCrossTrackConfigDirOverride(
      { ADHDEV_CONFIG_DIR: siblingStable, ADHDEV_BUILD_CHANNEL: 'preview' },
      homeWin,
      'win32',
    )).toBe(true);
  });

  it('is case-insensitive on win32 (NTFS semantics)', () => {
    const siblingPreview = win32.join(homeWin, '.adhdev-preview');
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: siblingPreview.toUpperCase() }, homeWin, 'win32')).toBe(true);
  });

  it('is case-SENSITIVE on posix (so the win32 lowering above is a real behavior change, not a no-op)', () => {
    const siblingPreview = posix.join(homePosix, '.adhdev-preview');
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: siblingPreview.toUpperCase() }, homePosix, 'linux')).toBe(false);
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: siblingPreview }, homePosix, 'linux')).toBe(true);
  });

  it('normalizes a trailing slash and mixed forward-slash override against a native win32 join', () => {
    const withTrailingSlashAndForwardSlashes = 'C:/Users/vilmi/.adhdev-preview/';
    expect(isCrossTrackConfigDirOverride({ ADHDEV_CONFIG_DIR: withTrailingSlashAndForwardSlashes }, homeWin, 'win32')).toBe(true);
  });
});

// ─── configDirChannelMismatch ───────────────────────────────────────────────
//
// Pure (resolvedConfigDir, resolvedChannel, hasExplicitChannelSignal) inputs
// — same fully-injected style as isCrossTrackConfigDirOverride above — so no
// process.env mutation or temp dirs are needed here either.
describe('configDirChannelMismatch (config-dir/provider-channel axis warning)', () => {
  const previewDir = posix.join('/home/vilmi', '.adhdev-preview');
  const stableDir = posix.join('/home/vilmi', '.adhdev');
  const customDir = posix.join('/home/vilmi', 'my-custom-config');

  it('is silent when the config dir implies stable and the channel is stable', () => {
    expect(configDirChannelMismatch(stableDir, 'stable', false)).toBeNull();
  });

  it('is silent when the config dir implies preview and the channel is preview', () => {
    expect(configDirChannelMismatch(previewDir, 'preview', false)).toBeNull();
  });

  it('flags a preview-named config dir resolving to the stable channel (the tsx/no-build-stamp case)', () => {
    expect(configDirChannelMismatch(previewDir, 'stable', false)).toEqual({
      impliedTrack: 'preview',
      channel: 'stable',
    });
  });

  it('flags a stable-named config dir resolving to the preview channel (reverse direction)', () => {
    expect(configDirChannelMismatch(stableDir, 'preview', false)).toEqual({
      impliedTrack: 'stable',
      channel: 'preview',
    });
  });

  it('is silent when an explicit channel signal explains the divergence, even for a mismatched name', () => {
    expect(configDirChannelMismatch(previewDir, 'stable', true)).toBeNull();
    expect(configDirChannelMismatch(stableDir, 'preview', true)).toBeNull();
  });

  it('is silent for a config dir whose basename implies neither track (custom/self-host path)', () => {
    expect(configDirChannelMismatch(customDir, 'stable', false)).toBeNull();
    expect(configDirChannelMismatch(customDir, 'preview', false)).toBeNull();
  });

  it('is silent for a /tmp test-isolation dir regardless of channel (matches isCrossTrackConfigDirOverride\'s treatment of isolation dirs)', () => {
    const isolation = posix.join('/tmp', 'adhdev-test-abc123');
    expect(configDirChannelMismatch(isolation, 'stable', false)).toBeNull();
    expect(configDirChannelMismatch(isolation, 'preview', false)).toBeNull();
  });
});

// ─── detectOccupiedConfigDir ────────────────────────────────────────────────
//
// Guards the ADHDEV_CONFIG_DIR INHERITANCE hazard: a dev process handed a live
// daemon's config dir writes that daemon's meshes.json / mesh-coordinators.json
// / config.json / mesh-ledger. Inheritance itself is deliberate
// (bootstrap-config-dir.ts honors it on purpose), so the contract under test is
// detect-and-warn, never refuse.
//
// Every case uses a mkdtemp fixture dir and an INJECTED liveness probe — the
// real process table and the live ~/.adhdev(-preview) dirs are never touched.
describe('detectOccupiedConfigDir (inherited-config-dir occupancy)', () => {
  let occupiedRoot = '';
  const ALIVE = () => true;
  const DEAD = () => false;

  beforeEach(() => {
    occupiedRoot = mkdtempSync(join(tmpdir(), 'adhdev-occupancy-'));
  });

  afterEach(() => {
    rmSync(occupiedRoot, { recursive: true, force: true });
  });

  const writePid = (name: string, body: string): void => {
    writeFileSync(join(occupiedRoot, name), body, 'utf-8');
  };

  it('detects a live PREVIEW daemon (daemon-19223.pid) owning the dir', () => {
    writePid('daemon-19223.pid', '24845');
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 999_999, ALIVE)).toEqual({
      configDir: occupiedRoot,
      pid: 24845,
      track: 'preview',
    });
  });

  it('detects a live STABLE daemon (bare daemon.pid) owning the dir', () => {
    writePid('daemon.pid', '4242');
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 999_999, ALIVE)).toEqual({
      configDir: occupiedRoot,
      pid: 4242,
      track: 'stable',
    });
  });

  // ── The over-correction guards. Each of these is a case where warning would
  // ── nag a legitimate workflow, so they must stay silent.

  it('stays silent for an unoccupied dir — the ordinary override case', () => {
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 999_999, ALIVE)).toBeNull();
  });

  it('stays silent when the PID file is stale (owner is dead) — leftovers are not occupancy', () => {
    writePid('daemon-19223.pid', '24845');
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 999_999, DEAD)).toBeNull();
  });

  it('stays silent when the live PID is our OWN — a daemon re-resolving its own dir must not warn about itself', () => {
    writePid('daemon-19223.pid', '777');
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 777, ALIVE)).toBeNull();
  });

  it('stays silent when ADHDEV_ALLOW_TRACK_MISMATCH=1 — the documented opt-in for a deliberate shared dir', () => {
    writePid('daemon-19223.pid', '24845');
    expect(detectOccupiedConfigDir(
      occupiedRoot,
      { [ALLOW_TRACK_MISMATCH_ENV_VAR]: '1' },
      999_999,
      ALIVE,
    )).toBeNull();
  });

  it('stays silent on a garbage/empty PID file rather than guessing (fail-open)', () => {
    writePid('daemon.pid', 'not-a-pid');
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 999_999, ALIVE)).toBeNull();
    writePid('daemon.pid', '   ');
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 999_999, ALIVE)).toBeNull();
    writePid('daemon.pid', '0');
    expect(detectOccupiedConfigDir(occupiedRoot, {}, 999_999, ALIVE)).toBeNull();
  });

  it('stays silent for an empty/blank configDir argument', () => {
    expect(detectOccupiedConfigDir('', {}, 999_999, ALIVE)).toBeNull();
    expect(detectOccupiedConfigDir('   ', {}, 999_999, ALIVE)).toBeNull();
  });

  it('names the occupant, the dir, the risk and the escape hatch in the warning', () => {
    const message = formatOccupiedConfigDirWarning({
      configDir: '/home/vilmi/.adhdev-preview',
      pid: 24845,
      track: 'preview',
    });
    // The whole point of the fix: the 2026-08-21/22 incidents were misdiagnosed
    // because the cross-track write was silent. An unattributable warning would
    // repeat that failure, so pin the parts an operator needs.
    expect(message).toContain('/home/vilmi/.adhdev-preview');
    expect(message).toContain('24845');
    expect(message).toContain('meshes.json');
    expect(message).toContain(ALLOW_TRACK_MISMATCH_ENV_VAR);
    expect(message).toContain('env -u ADHDEV_CONFIG_DIR');
  });
});
