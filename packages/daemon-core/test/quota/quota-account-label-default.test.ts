import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// QUOTA ACCOUNT LABEL — default OFF, with a migration that can tell a user's
// choice from a value this codebase wrote on its own.
//
// The default has moved twice: opt-in (false) in 1.0.35-rc.7, ON from
// 2026-08-05, and back OFF on 2026-08-11 (owner decision). codex-cli is the
// only provider that reports an account label, so this default governs
// codex-cli and nothing else — see the config.ts SCOPE note.
//
// What makes moving it safe in EITHER direction: `normalizeConfig` fills
// missing keys from DEFAULT_CONFIG and `loadConfig` writes the result back when
// it differs from disk, so merely STARTING a daemon stamps the then-current
// default into every config.json. Those stamped values are an artefact, not a
// preference — honouring them would strand existing users on whatever default
// they happened to boot once.
//
// So an explicit choice is recorded separately (`quotaShowAccountEmailSetByUser`,
// written only by setQuotaShowAccountEmail) and only that marker makes a stored
// boolean authoritative. The cases below pin both directions, so a future
// default flip cannot quietly start overriding real user choices.

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
    it('is OFF when the key has never been written', async () => {
        const { loadConfig } = await freshConfigModule();
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({}), 'utf-8');
        expect(loadConfig().quotaShowAccountEmail).toBe(false);
    });

    it('is OFF for a brand-new install (no config file at all)', async () => {
        const { loadConfig } = await freshConfigModule();
        expect(loadConfig().quotaShowAccountEmail).toBe(false);
    });
});

describe('quota account label — unmarked stored values are not preferences', () => {
    it('ignores a stored true that no human chose', async () => {
        // THE 2026-08-11 migration case, mirroring the rc.7 one below: the
        // ON-default builds stamped `true` on first start. Treating that as an
        // opt-in would leave the new OFF default unreachable for everyone who
        // ran those builds.
        const { loadConfig } = await freshConfigModule();
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({ quotaShowAccountEmail: true }), 'utf-8');
        expect(loadConfig().quotaShowAccountEmail).toBe(false);
    });

    it('ignores a stored false that no human chose', async () => {
        // The rc.7 case. Kept because it pins the same rule in the other
        // direction: unmarked means "artefact", regardless of which way it points.
        const { loadConfig } = await freshConfigModule();
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({ quotaShowAccountEmail: false }), 'utf-8');
        expect(loadConfig().quotaShowAccountEmail).toBe(false);
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
