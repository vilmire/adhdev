import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

// A3: when the legacy beads.db → mesh-runtime.db rename fails (win32 EPERM when a
// handle to the legacy DB is still open), the store must keep using the existing
// legacy DB IN-PLACE rather than silently opening a fresh empty store and stranding
// all existing data (split-brain / silent data loss).

const testTmpDir = join(tmpdir(), `adhdev-mesh-migfail-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');
const runtimeRequire = createRequire(import.meta.url);

// Toggle that forces renameSync to throw an EPERM, simulating win32's behaviour
// when the source file still has an open handle.
const renameState = vi.hoisted(() => ({ failRename: false }));

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
}));

// Override ONLY renameSync; every other fs export stays real. better-sqlite3 opens
// files through its native binding (not Node fs), so DB reads/writes are unaffected.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        default: actual,
        renameSync: (...args: Parameters<typeof actual.renameSync>) => {
            if (renameState.failRename) {
                const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
                err.code = 'EPERM';
                throw err;
            }
            return actual.renameSync(...args);
        },
    };
});

import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';

describe('mesh-runtime-store — legacy migration failure (win32 EPERM)', () => {
    beforeEach(() => {
        renameState.failRename = false;
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        MeshRuntimeStore.resetForTests();
        renameState.failRename = false;
        try {
            rmSync(testTmpDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    it('keeps using the legacy DB in-place (no empty store, no data loss) when the rename fails', () => {
        const Database = runtimeRequire('better-sqlite3') as any;
        const ledgerDir = join(testConfigDir, 'mesh-ledger');
        mkdirSync(ledgerDir, { recursive: true });
        const legacyDbPath = join(ledgerDir, 'beads.db');
        const nextDbPath = join(ledgerDir, 'mesh-runtime.db');
        const fingerprint = `legacy-fp-${randomUUID()}`;

        // Seed the legacy DB with a fingerprint row, then close it.
        const legacyDb = new Database(legacyDbPath);
        legacyDb.exec(`
            CREATE TABLE mesh_completion_fingerprints (
                fingerprint TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            );
        `);
        legacyDb.prepare('INSERT INTO mesh_completion_fingerprints (fingerprint, expires_at) VALUES (?, ?)')
            .run(fingerprint, Date.now() + 60_000);
        legacyDb.close();

        // Force the migration rename to fail.
        renameState.failRename = true;

        const db = MeshRuntimeStore.getInstance();

        // The legacy data must still be reachable — proving the store opened the
        // legacy file in-place rather than a fresh EMPTY mesh-runtime.db.
        expect(db.hasCompletionFingerprint(fingerprint)).toBe(true);
        // The legacy file is retained; the new path was NOT adopted as the active store.
        expect(existsSync(legacyDbPath)).toBe(true);
        expect(existsSync(nextDbPath)).toBe(false);
    });

    it('still migrates successfully (new path adopted) when the rename succeeds', () => {
        const Database = runtimeRequire('better-sqlite3') as any;
        const ledgerDir = join(testConfigDir, 'mesh-ledger');
        mkdirSync(ledgerDir, { recursive: true });
        const legacyDbPath = join(ledgerDir, 'beads.db');
        const nextDbPath = join(ledgerDir, 'mesh-runtime.db');
        const fingerprint = `legacy-fp-${randomUUID()}`;

        const legacyDb = new Database(legacyDbPath);
        legacyDb.exec(`
            CREATE TABLE mesh_completion_fingerprints (
                fingerprint TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            );
        `);
        legacyDb.prepare('INSERT INTO mesh_completion_fingerprints (fingerprint, expires_at) VALUES (?, ?)')
            .run(fingerprint, Date.now() + 60_000);
        legacyDb.close();

        renameState.failRename = false; // happy path

        const db = MeshRuntimeStore.getInstance();
        expect(db.hasCompletionFingerprint(fingerprint)).toBe(true);
        expect(existsSync(legacyDbPath)).toBe(false);
        expect(existsSync(nextDbPath)).toBe(true);
    });
});
