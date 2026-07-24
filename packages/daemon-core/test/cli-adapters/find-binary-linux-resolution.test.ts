import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/**
 * findBinary is the install-detection primitive shared with the spawn layer.
 * On Linux/macOS the daemon frequently runs under a minimal non-login PATH (the
 * systemd unit ships no PATH pin), so it never sees the user's interactive PATH.
 * findBinary must therefore probe well-known Unix global-bin dirs the inherited
 * PATH misses — notably `~/.local/bin` (the Claude Code native-installer default,
 * `curl … install.sh | bash`) and the npm global prefix bin (nvm / custom
 * `npm config set prefix`). ESM can't spy on os.platform/os.homedir, so we mock
 * the `os` module (matching the repo's launch/*.test.ts pattern) to force linux +
 * a controlled homedir, and stub child_process.execSync so `npm config get
 * prefix` is deterministic.
 */
const mocks = vi.hoisted(() => ({
    platform: vi.fn(() => 'linux'),
    homedir: vi.fn(() => '/tmp/fake-home'),
    execSync: vi.fn(() => 'undefined'),
}));

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, default: actual, platform: mocks.platform, homedir: mocks.homedir };
});

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, default: actual, execSync: mocks.execSync };
});

// Import AFTER mocks are registered.
const { findBinary, __resetNpmPrefixCacheForTests } = await import('../../src/cli-adapters/provider-cli-shared.js');

describe('findBinary linux resolution', () => {
    let tmpDir: string;
    let home: string;
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = ['PATH'];

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findbinary-linux-'));
        home = path.join(tmpDir, 'home');
        fs.mkdirSync(home, { recursive: true });
        for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
        mocks.platform.mockReturnValue('linux');
        mocks.homedir.mockReturnValue(home);
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

    const writeExecutable = (dir: string, name: string): string => {
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, name);
        fs.writeFileSync(p, '#!/usr/bin/env node\n');
        fs.chmodSync(p, 0o755);
        return p;
    };

    it('resolves the Claude Code native installer default at ~/.local/bin when not on PATH', () => {
        const localBin = path.join(home, '.local', 'bin');
        const bin = writeExecutable(localBin, 'claude');

        // PATH deliberately excludes ~/.local/bin — only the extraDirs probe finds it.
        process.env.PATH = path.join(tmpDir, 'somewhere-else');

        const resolved = findBinary('claude');
        expect(resolved).toBe(bin);
        expect(path.isAbsolute(resolved)).toBe(true);
    });

    it('resolves the alternate native location ~/.claude/local/bin', () => {
        const altBin = path.join(home, '.claude', 'local', 'bin');
        const bin = writeExecutable(altBin, 'claude');
        process.env.PATH = '';

        const resolved = findBinary('claude');
        expect(resolved).toBe(bin);
    });

    it('consults `npm config get prefix` and probes <prefix>/bin (nvm / custom prefix)', () => {
        const prefixDir = path.join(tmpDir, 'nvm-prefix');
        const prefixBin = path.join(prefixDir, 'bin');
        const bin = writeExecutable(prefixBin, 'codex');
        // The active npm prefix is surfaced only by `npm config get prefix`.
        mocks.execSync.mockReturnValue(`${prefixDir}\n`);

        // Not on PATH and not in any hard-coded extraDir.
        process.env.PATH = '';

        const resolved = findBinary('codex');
        expect(resolved).toBe(bin);
    });

    it('returns the bare name sentinel when nothing resolves', () => {
        process.env.PATH = '';

        const resolved = findBinary('definitely-not-installed-xyz');
        expect(resolved).toBe('definitely-not-installed-xyz');
        expect(path.isAbsolute(resolved)).toBe(false);
    });
});
