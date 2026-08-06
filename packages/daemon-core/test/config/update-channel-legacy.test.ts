import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../../src/config/config.js';
import { TRACK } from '../../src/track-identity.js';

// Phase 3 hard-fail prohibition: a config.json carrying a legacy or unknown
// `updateChannel` must NEVER crash or be rejected. The runtime channel switch
// is gone (the channel is a build-time identity), so the field is read-only:
// an explicit preview/next value is still honored (it feeds the provider-
// channel derivation union in providers/channel/contract.ts) and anything
// absent or unknown resolves to this binary's build track.

let tempDir = '';
let savedConfigDir: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-legacy-channel-'));
    savedConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = tempDir;
});

afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
});

function writeConfig(config: Record<string, unknown>) {
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(config), 'utf-8');
}

describe('legacy updateChannel config handling (Phase 3)', () => {
    it('accepts updateChannel:"preview" without failing and keeps it', () => {
        writeConfig({ updateChannel: 'preview' });
        expect(() => loadConfig()).not.toThrow();
        expect(loadConfig().updateChannel).toBe('preview');
    });

    it('honors the "next" dist-tag alias as preview', () => {
        writeConfig({ updateChannel: 'next' });
        expect(loadConfig().updateChannel).toBe('preview');
    });

    it('resolves an unknown value to the build track instead of failing', () => {
        writeConfig({ updateChannel: 'nightly' });
        expect(() => loadConfig()).not.toThrow();
        expect(loadConfig().updateChannel).toBe(TRACK);
    });

    it('resolves a missing field to the build track', () => {
        writeConfig({});
        expect(loadConfig().updateChannel).toBe(TRACK);
    });

    it('survives a non-string updateChannel without failing', () => {
        writeConfig({ updateChannel: 42 });
        expect(() => loadConfig()).not.toThrow();
        expect(loadConfig().updateChannel).toBe(TRACK);
    });

    it('survives a malformed config.json without failing', () => {
        fs.writeFileSync(path.join(tempDir, 'config.json'), '{not json', 'utf-8');
        expect(() => loadConfig()).not.toThrow();
        // catch-path falls back to DEFAULT_CONFIG (stable literal).
        expect(loadConfig().updateChannel).toBe('stable');
    });
});
