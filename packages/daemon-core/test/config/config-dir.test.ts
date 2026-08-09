import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join, win32, posix } from 'path';
import { tmpdir } from 'os';
import { getConfigDir } from '../../src/config/config.js';
import { resolveConfigDir, resolveConfigLogsDir, isCrossTrackConfigDirOverride } from '../../src/config/config-dir.js';

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
    process.env.ADHDEV_CONFIG_DIR = '   ';
    const expected = join(fakeHome, '.adhdev');

    expect(getConfigDir()).toBe(expected);
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
    expect(resolveConfigDir()).toBe(join(fakeHome, '.adhdev'));
    expect(existsSync(join(fakeHome, '.adhdev'))).toBe(false);

    process.env.ADHDEV_CONFIG_DIR = overrideDir;
    expect(resolveConfigDir()).toBe(overrideDir);
    expect(existsSync(overrideDir)).toBe(false);
  });

  it('resolves logs/ under the same base and re-reads the env on every call', () => {
    expect(resolveConfigLogsDir()).toBe(join(fakeHome, '.adhdev', 'logs'));
    process.env.ADHDEV_CONFIG_DIR = overrideDir;
    expect(resolveConfigLogsDir()).toBe(join(overrideDir, 'logs'));
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
