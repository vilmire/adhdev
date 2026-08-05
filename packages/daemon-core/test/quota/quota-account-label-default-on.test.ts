import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// QUOTA ACCOUNT LABEL — default ON, with a migration that can tell a user's
// choice from a value this codebase wrote on its own.
//
// The option shipped opt-in (default false) in 1.0.35-rc.7. `normalizeConfig`
// fills missing keys from DEFAULT_CONFIG and `loadConfig` writes the result back
// when it differs from disk, so merely STARTING an rc.7 daemon stamped
// `"quotaShowAccountEmail": false` into every config.json. Flipping the default
// to true without handling that would leave the new default unreachable for
// exactly the users who already ran the previous build — their stored `false`
// would look like an opt-out it never was.
//
// So an explicit choice is recorded separately (`quotaShowAccountEmailSetByUser`,
// written only by setQuotaShowAccountEmail) and only that marker makes a stored
// boolean authoritative.

let configDir: string;
let previousConfigDir: string | undefined;

// A plain static import is enough: getConfigDir() reads ADHDEV_CONFIG_DIR on
// every call (config.ts), so each test's temp dir is picked up without needing
// to defeat the module cache.
async function freshConfigModule() {
    return import('../../src/config/config.js');
}

beforeEach(() => {
    configDir = join(tmpdir(), `adhdev-quota-label-${randomUUID().slice(0, 8)}`);
    mkdirSync(configDir, { recursive: true });
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR;
    process.env.ADHDEV_CONFIG_DIR = configDir;
});

afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir;
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('quota account label — default', () => {
    it('is ON when the key has never been written', async () => {
        const { loadConfig } = await freshConfigModule();
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({}), 'utf-8');
        expect(loadConfig().quotaShowAccountEmail).toBe(true);
    });

    it('is ON for a brand-new install (no config file at all)', async () => {
        const { loadConfig } = await freshConfigModule();
        expect(loadConfig().quotaShowAccountEmail).toBe(true);
    });
});

describe('quota account label — rc.7 migration', () => {
    it('ignores a stored false that no human chose', async () => {
        // THE migration case: rc.7 stamped this automatically on first start.
        // Treating it as an opt-out would strand every existing user on OFF.
        const { loadConfig } = await freshConfigModule();
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({ quotaShowAccountEmail: false }), 'utf-8');
        expect(loadConfig().quotaShowAccountEmail).toBe(true);
    });

    it('honours a false the user actually chose', async () => {
        const { loadConfig } = await freshConfigModule();
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            quotaShowAccountEmail: false,
            quotaShowAccountEmailSetByUser: true,
        }), 'utf-8');
        expect(loadConfig().quotaShowAccountEmail).toBe(false);
    });

    it('honours a true the user actually chose', async () => {
        const { loadConfig } = await freshConfigModule();
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
            quotaShowAccountEmail: true,
            quotaShowAccountEmailSetByUser: true,
        }), 'utf-8');
        expect(loadConfig().quotaShowAccountEmail).toBe(true);
    });
});

describe('setQuotaShowAccountEmail', () => {
    it('records the intent marker so the choice survives a reload', async () => {
        const { loadConfig, setQuotaShowAccountEmail } = await freshConfigModule();
        setQuotaShowAccountEmail(false);

        // Persisted, marker included…
        const onDisk = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'));
        expect(onDisk.quotaShowAccountEmail).toBe(false);
        expect(onDisk.quotaShowAccountEmailSetByUser).toBe(true);

        // …and NOT reverted to the ON default on the next read. Without the
        // marker this is exactly where a deliberate opt-out would be lost.
        expect(loadConfig().quotaShowAccountEmail).toBe(false);
        expect(loadConfig().quotaShowAccountEmail).toBe(false);
    });

    it('can turn it back on, and that also sticks', async () => {
        const { loadConfig, setQuotaShowAccountEmail } = await freshConfigModule();
        setQuotaShowAccountEmail(false);
        setQuotaShowAccountEmail(true);
        expect(loadConfig().quotaShowAccountEmail).toBe(true);
        expect(loadConfig().quotaShowAccountEmailSetByUser).toBe(true);
    });
});
