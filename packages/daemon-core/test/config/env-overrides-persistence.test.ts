import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, updateConfig } from '../../src/config/config.js';

// Covers the "restart persistence" leg of the contract: envOverrides written
// via updateConfig() must round-trip through a FRESH loadConfig() call, which
// is what a real daemon restart does (a new process, no in-memory state).

let tempDir = '';
let savedConfigDir: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-env-overrides-'));
    savedConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tempDir;
});

afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
});

describe('config.envOverrides persistence', () => {
    it('defaults to an empty map on a fresh config', () => {
        expect(loadConfig().envOverrides).toEqual({});
    });

    it('round-trips a set value across a fresh loadConfig() (simulated restart)', () => {
        updateConfig({ envOverrides: { ADHDEV_WORKER_MCP: 'on' } });

        // Simulates the next daemon boot: a brand-new read from disk, no
        // reliance on any in-process cache.
        const reloaded = loadConfig();
        expect(reloaded.envOverrides).toEqual({ ADHDEV_WORKER_MCP: 'on' });
    });

    it('supports unset (removing a single key while preserving others)', () => {
        updateConfig({ envOverrides: { ADHDEV_WORKER_MCP: 'on', ADHDEV_OTHER_FLAG: 'x' } });

        const current = loadConfig();
        const { ADHDEV_WORKER_MCP: _drop, ...rest } = current.envOverrides ?? {};
        updateConfig({ envOverrides: rest });

        expect(loadConfig().envOverrides).toEqual({ ADHDEV_OTHER_FLAG: 'x' });
    });

    it('strips secret-shaped keys at normalize time, so they never round-trip through config.json', () => {
        fs.writeFileSync(
            path.join(tempDir, 'config.json'),
            JSON.stringify({
                envOverrides: {
                    ADHDEV_WORKER_MCP: 'on',
                    LEAKED_API_TOKEN: 'should-not-survive',
                },
            }),
            'utf-8',
        );

        const config = loadConfig();
        expect(config.envOverrides).toEqual({ ADHDEV_WORKER_MCP: 'on' });

        // And the stripped value never gets written back to disk either —
        // loadConfig() re-saves the normalized form when it differs.
        const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'config.json'), 'utf-8'));
        expect(onDisk.envOverrides).toEqual({ ADHDEV_WORKER_MCP: 'on' });
    });

    it('drops non-string values from a malformed envOverrides map', () => {
        fs.writeFileSync(
            path.join(tempDir, 'config.json'),
            JSON.stringify({
                envOverrides: {
                    ADHDEV_WORKER_MCP: 'on',
                    ADHDEV_NUMERIC: 123,
                    ADHDEV_NESTED: { nope: true },
                },
            }),
            'utf-8',
        );

        expect(loadConfig().envOverrides).toEqual({ ADHDEV_WORKER_MCP: 'on' });
    });

    it('ignores a non-object envOverrides value entirely', () => {
        fs.writeFileSync(
            path.join(tempDir, 'config.json'),
            JSON.stringify({ envOverrides: 'not-an-object' }),
            'utf-8',
        );

        expect(loadConfig().envOverrides).toEqual({});
    });
});
