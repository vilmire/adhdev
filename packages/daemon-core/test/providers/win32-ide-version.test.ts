import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isKnownWin32GuiExe,
  readWin32IdeVersionFromDisk,
} from '../../src/detection/win32-ide-version.js';

let tmp: string | null = null;

function makeTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), 'adhdev-win32-ver-'));
  return tmp;
}

describe('readWin32IdeVersionFromDisk', () => {
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it('reads version from resources/app/product.json next to the exe (no spawn)', () => {
    const dir = makeTmp();
    const appDir = join(dir, 'resources', 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'product.json'), JSON.stringify({ version: '1.99.3' }));

    const exePath = join(dir, 'Cursor.exe');
    writeFileSync(exePath, 'fake');

    expect(readWin32IdeVersionFromDisk(exePath)).toBe('1.99.3');
  });

  it('falls back to resources/app/package.json when product.json is absent', () => {
    const dir = makeTmp();
    const appDir = join(dir, 'resources', 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ version: '2.0.1' }));

    const exePath = join(dir, 'Antigravity.exe');
    writeFileSync(exePath, 'fake');

    expect(readWin32IdeVersionFromDisk(exePath)).toBe('2.0.1');
  });

  it('returns null when no manifest can be found', () => {
    const dir = makeTmp();
    const exePath = join(dir, 'Cursor.exe');
    writeFileSync(exePath, 'fake');
    expect(readWin32IdeVersionFromDisk(exePath)).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(readWin32IdeVersionFromDisk('')).toBeNull();
  });
});

describe('isKnownWin32GuiExe', () => {
  const names = { cursor: ['Cursor.exe'], antigravity: ['Antigravity.exe'] };

  it('matches a GUI exe case-insensitively', () => {
    expect(isKnownWin32GuiExe('C:\\Programs\\cursor\\cursor.exe', names)).toBe(true);
    expect(isKnownWin32GuiExe('C:\\Programs\\cursor\\Cursor.exe', names)).toBe(true);
    expect(isKnownWin32GuiExe('C:\\x\\Antigravity.exe', names)).toBe(true);
  });

  it('does not match a real CLI wrapper', () => {
    expect(isKnownWin32GuiExe('C:\\Programs\\cursor\\bin\\cursor.cmd', names)).toBe(false);
    expect(isKnownWin32GuiExe('C:\\Programs\\cursor\\bin\\cursor', names)).toBe(false);
  });

  it('returns false for null/empty and empty maps', () => {
    expect(isKnownWin32GuiExe(null, names)).toBe(false);
    expect(isKnownWin32GuiExe('', names)).toBe(false);
    expect(isKnownWin32GuiExe('C:\\x\\Cursor.exe', {})).toBe(false);
  });
});
