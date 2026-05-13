import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getConfigDir } from '../../src/config/config.js';

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
