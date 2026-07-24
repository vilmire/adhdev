import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/**
 * findBinary is the install-detection primitive shared with the spawn layer.
 * On win32 it must (a) derive executable extensions from %PATHEXT% (+ .ps1) so a
 * PowerShell-shim CLI resolves, and (b) probe non-default npm-prefix dirs
 * (%LOCALAPPDATA%\npm, nvm/custom prefix, Scoop shims) that the daemon's
 * inherited PATH frequently misses. ESM can't spy on os.platform, so we mock the
 * `os` module (matching the repo's launch/*.test.ts pattern) to force win32, and
 * stub child_process.execSync so `npm config get prefix` is deterministic.
 */
const mocks = vi.hoisted(() => ({
    platform: vi.fn(() => 'win32'),
    execSync: vi.fn(() => 'undefined'),
}));

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, default: actual, platform: mocks.platform };
});

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, default: actual, execSync: mocks.execSync };
});

// Import AFTER mocks are registered.
const { findBinary, __resetNpmPrefixCacheForTests } = await import('../../src/cli-adapters/provider-cli-shared.js');

describe('findBinary win32 resolution', () => {
    let tmpDir: string;
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = ['PATH', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'];

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findbinary-win32-'));
        for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
        mocks.platform.mockReturnValue('win32');
        mocks.execSync.mockReturnValue('undefined');
        __resetNpmPrefixCacheForTests();
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('resolves a .ps1 shim found only via PATHEXT in a non-default npm prefix (%LOCALAPPDATA%\\npm)', () => {
        // Non-default npm prefix bin dir: %LOCALAPPDATA%\npm
        const npmDir = path.join(tmpDir, 'localappdata', 'npm');
        fs.mkdirSync(npmDir, { recursive: true });
        const shim = path.join(npmDir, 'mycli.ps1');
        fs.writeFileSync(shim, '# powershell shim');

        // PATH deliberately does NOT include npmDir → only the extraDirs probe
        // can find it. PATHEXT lacks .PS1 on purpose to prove the explicit add.
        process.env.PATH = path.join(tmpDir, 'somewhere-else');
        process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
        process.env.LOCALAPPDATA = path.join(tmpDir, 'localappdata');
        delete process.env.APPDATA;
        delete process.env.USERPROFILE;

        const resolved = findBinary('mycli');
        expect(resolved).toBe(shim);
        expect(path.isAbsolute(resolved)).toBe(true);
    });

    it('honors a PATHEXT-derived extension for a Scoop shim (%USERPROFILE%\\scoop\\shims)', () => {
        const shimsDir = path.join(tmpDir, 'userprofile', 'scoop', 'shims');
        fs.mkdirSync(shimsDir, { recursive: true });
        const shim = path.join(shimsDir, 'scoopcli.cmd');
        fs.writeFileSync(shim, '@echo off');

        process.env.PATH = '';
        process.env.PATHEXT = '.EXE;.CMD;.BAT';
        process.env.USERPROFILE = path.join(tmpDir, 'userprofile');
        delete process.env.APPDATA;
        delete process.env.LOCALAPPDATA;

        const resolved = findBinary('scoopcli');
        expect(resolved).toBe(shim);
    });

    it('resolves via a non-default prefix reported by `npm config get prefix`', () => {
        const prefixDir = path.join(tmpDir, 'nvm-prefix');
        fs.mkdirSync(prefixDir, { recursive: true });
        const shim = path.join(prefixDir, 'nvmcli.cmd');
        fs.writeFileSync(shim, '@echo off');
        // The nvm/custom prefix is surfaced only by `npm config get prefix`.
        mocks.execSync.mockReturnValue(`${prefixDir}\n`);

        process.env.PATH = '';
        process.env.PATHEXT = '.EXE;.CMD';
        delete process.env.APPDATA;
        delete process.env.LOCALAPPDATA;
        delete process.env.USERPROFILE;

        const resolved = findBinary('nvmcli');
        expect(resolved).toBe(shim);
    });

    it('falls back to the default extension list when PATHEXT is unset', () => {
        const npmDir = path.join(tmpDir, 'appdata', 'npm');
        fs.mkdirSync(npmDir, { recursive: true });
        const shim = path.join(npmDir, 'codex.cmd');
        fs.writeFileSync(shim, '@echo off');

        process.env.PATH = '';
        delete process.env.PATHEXT;
        process.env.APPDATA = path.join(tmpDir, 'appdata');
        delete process.env.LOCALAPPDATA;
        delete process.env.USERPROFILE;

        const resolved = findBinary('codex');
        expect(resolved).toBe(shim);
    });

    it('returns the bare "<name>.cmd" sentinel when nothing resolves', () => {
        process.env.PATH = '';
        process.env.PATHEXT = '.EXE;.CMD';
        delete process.env.APPDATA;
        delete process.env.LOCALAPPDATA;
        delete process.env.USERPROFILE;

        const resolved = findBinary('definitely-not-installed-xyz');
        expect(resolved).toBe('definitely-not-installed-xyz.cmd');
        expect(path.isAbsolute(resolved)).toBe(false);
    });
});
