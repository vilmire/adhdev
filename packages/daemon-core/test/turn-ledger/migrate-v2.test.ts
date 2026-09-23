import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseHandle } from 'better-sqlite3';

// C-W8: user_version 1 → 2 drops the legacy tables whose last writer was retired,
// exporting their post-v1 rows and folding post-v1 operating notes out of the
// event ledger. Pinned twice: on a raw handle (exact fold/drop/export shape) and
// through the live boot path (MeshRuntimeStore open → v1 → v2 → Stage 6 reads) on
// the synthetic fixture — and, when ADHDEV_CW8_LIVE_DB_COPY names a COPY of a
// real preview mesh-runtime.db, on that too (never the live file).

const state = vi.hoisted(() => ({ configDir: '' }));
vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(state.configDir)) mkdirSync(state.configDir, { recursive: true });
        return state.configDir;
    },
    loadConfig: () => ({ machineId: 'test-machine' } as any),
    getMachineId: () => 'test-machine',
    getMachineNickname: () => null,
}));

// @ts-expect-error — plain .mjs without a declaration file
import { buildLegacyTurnLedgerFixture } from '../../../../scripts/gen-turn-ledger-fixture.mjs';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';
import { ensureTurnLedgerSchema, readUserVersion, tableExists } from '../../src/mesh/turn-ledger/schema.js';
import { migrateTurnLedgerV1 } from '../../src/mesh/turn-ledger/migrate-v1.js';
import { TURN_LEDGER_V2, V2_RETIRED_TABLES, formatTurnLedgerMigrationV2Line, migrateTurnLedgerV2 } from '../../src/mesh/turn-ledger/migrate-v2.js';
import { TurnStore } from '../../src/mesh/turn-ledger/store.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { resolveSessionTurnPresentation } from '../../src/mesh/mesh-turn-presentation.js';
import { getActiveDirectDispatches } from '../../src/mesh/mesh-direct-dispatch.js';
import { readOperatingNotes } from '../../src/mesh/mesh-operating-notes.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const dirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    MeshRuntimeStore.resetForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A v1 DB that then kept receiving legacy writes (the shape every C-landed daemon has). */
function postV1Db(): DatabaseHandle {
    const Database = loadBetterSqlite3();
    const db = new Database(':memory:');
    db.transaction(() => buildLegacyTurnLedgerFixture(db, { nowMs: NOW }))();
    migrateTurnLedgerV1(db, { ownerDaemonId: 'daemon-local', nowMs: NOW, exportPath: null });
    expect(readUserVersion(db)).toBe(1);
    // The pre-C-W8 schema step re-created these EMPTY on every open; its writers
    // then kept landing shadow rows.
    db.exec(`
        CREATE TABLE mesh_session_delivery (id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, task_id TEXT, status TEXT);
        CREATE TABLE mesh_direct_dispatches (task_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, status TEXT);
        CREATE TABLE mesh_turn_attempts (attempt_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, task_id TEXT NOT NULL);
        CREATE TABLE mesh_event_ledger (id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, timestamp TEXT NOT NULL, kind TEXT NOT NULL,
            node_id TEXT, session_id TEXT, provider_type TEXT, task_id TEXT, payload TEXT NOT NULL DEFAULT '{}');
    `);
    db.prepare(`INSERT INTO mesh_session_delivery VALUES ('d1', 'mesh-alpha', 't-post', 'delivered')`).run();
    db.prepare(`INSERT INTO mesh_direct_dispatches VALUES ('t-post', 'mesh-alpha', 'acked')`).run();
    db.prepare(`INSERT INTO mesh_turn_attempts VALUES ('legacy-post', 'mesh-alpha', 't-post')`).run();
    const ledger = db.prepare(`INSERT INTO mesh_event_ledger (id, mesh_id, timestamp, kind, session_id, payload) VALUES (?, ?, ?, ?, ?, ?)`);
    ledger.run('note-pinned', 'mesh-alpha', '2026-09-23T13:00:00.000Z', 'coordinator_operating_note', 'coord-1',
        JSON.stringify({ text: 'pin me', category: 'recovery_lesson', createdAt: '2026-09-23T13:00:00.000Z', pinned: true, subjectKey: 'subj', sourceCoordinator: 'coord-1' }));
    ledger.run('note-forgotten', 'mesh-alpha', '2026-09-23T13:01:00.000Z', 'coordinator_operating_note', null,
        JSON.stringify({ text: 'forget me', createdAt: '2026-09-23T13:01:00.000Z' }));
    ledger.run('tomb-text', 'mesh-alpha', '2026-09-23T13:02:00.000Z', 'coordinator_operating_note_tombstone', null,
        JSON.stringify({ targetFingerprint: 'forget me', reason: 'obsolete' }));
    ledger.run('other', 'mesh-alpha', '2026-09-23T13:03:00.000Z', 'task_dispatched', null, JSON.stringify({ taskId: 't-post' }));
    return db;
}

describe('migrate-v2 on a raw post-v1 handle', () => {
    it('exports the shadows, folds post-v1 notes (lifecycle fields included), drops every retired table, keeps the event ledger', () => {
        const db = postV1Db();
        const exportPath = join(tempDir('adhdev-v2-export-'), 'v2.jsonl');
        const report = migrateTurnLedgerV2(db, { exportPath });

        expect(report).toMatchObject({ skipped: false, notesFolded: 2, noteTombstonesApplied: 1 });
        expect(readUserVersion(db)).toBe(TURN_LEDGER_V2);
        for (const table of V2_RETIRED_TABLES) expect(tableExists(db, table), table).toBe(false);
        expect(report.droppedTables).toEqual(expect.arrayContaining(['mesh_session_delivery', 'mesh_direct_dispatches', 'mesh_turn_attempts']));
        // The event ledger stays (its generic readers remain), minus the note rows.
        expect(db.prepare(`SELECT id FROM mesh_event_ledger ORDER BY id`).all()).toEqual([{ id: 'other' }]);

        const notes = new TurnStore(db).listOperatingNotes('mesh-alpha', { includeTombstoned: true });
        const pinned = notes.find((n) => n.noteId === 'note-pinned');
        expect(pinned).toMatchObject({ text: 'pin me', category: 'recovery_lesson', tombstonedAt: null, meta: { pinned: true, subjectKey: 'subj', sourceCoordinator: 'coord-1' } });
        expect(notes.find((n) => n.noteId === 'note-forgotten')?.tombstonedAt).not.toBeNull();
        // The text forget survives as a marker (a later 'forget me' is born retracted).
        expect(notes.find((n) => n.noteId === 'tomb-text')).toMatchObject({ text: 'forget me', meta: { textTombstone: true, forgetReason: 'obsolete' } });

        const exported = readFileSync(exportPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(exported.every((r) => r._migration === 'v2')).toBe(true);
        expect(new Set(exported.map((r) => r._table))).toEqual(new Set(['mesh_session_delivery', 'mesh_direct_dispatches', 'mesh_turn_attempts', 'mesh_event_ledger']));
        expect(exported.filter((r) => r._table === 'mesh_event_ledger')).toHaveLength(3); // the 3 note rows only
        expect(formatTurnLedgerMigrationV2Line(report)).toContain('user_version=2');

        // Idempotent.
        expect(migrateTurnLedgerV2(db, { exportPath: null }).skipped).toBe(true);
    });

    it('refuses to run before v1', () => {
        const Database = loadBetterSqlite3();
        const db = new Database(':memory:');
        ensureTurnLedgerSchema(db);
        expect(() => migrateTurnLedgerV2(db, { exportPath: null })).toThrow(/run v1 first/);
    });
});

/** Open the process store over `dbFile` (copied into a fresh config dir) and run the boot migrations. */
function bootStoreOver(dbFile: string | null): MeshRuntimeStore {
    state.configDir = join(tempDir('adhdev-v2-boot-'), '.adhdev');
    const ledgerDir = join(state.configDir, 'mesh-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    if (dbFile) copyFileSync(dbFile, join(ledgerDir, 'mesh-runtime.db'));
    MeshRuntimeStore.resetForTests();
    const store = MeshRuntimeStore.getInstance();
    store.runTurnLedgerMigrationV1({ ownerDaemonId: 'daemon-local', exportPath: null });
    store.runTurnLedgerMigrationV2({ exportPath: null });
    return store;
}

function assertMigratedAndReadable(store: MeshRuntimeStore): void {
    expect(readUserVersion(store.db)).toBe(TURN_LEDGER_V2);
    for (const table of V2_RETIRED_TABLES) expect(tableExists(store.db, table), table).toBe(false);
    // Stage 6 over whatever open mesh attempt the DB holds (the provider FSM
    // governs when there is none — either way the read must succeed).
    const open = store.turnStore().listOpenAttempts().find((a) => a.scope !== 'plain');
    const sessionId = open?.sessionId ?? `sess-${randomUUID().slice(0, 6)}`;
    const p = resolveSessionTurnPresentation({ sessionId, legacyStatus: 'idle', surface: 'session_status' });
    expect(p.authority).toBe(open ? 'turn_reducer' : 'provider_fsm_fallback');
    for (const meshId of new Set(store.turnStore().listOpenAttempts().map((a) => a.meshId).filter((m): m is string => !!m))) {
        expect(Array.isArray(getActiveDirectDispatches(meshId))).toBe(true);
        expect(Array.isArray(readOperatingNotes(meshId))).toBe(true);
    }
}

describe('boot migrations (v1 → v2) through MeshRuntimeStore, then Stage 6 reads', () => {
    it('on the synthetic preview-shaped fixture', () => {
        const Database = loadBetterSqlite3();
        const file = join(tempDir('adhdev-v2-fixture-'), 'fixture.db');
        const db = new Database(file);
        db.transaction(() => buildLegacyTurnLedgerFixture(db, { nowMs: Date.now() }))();
        db.close();
        const store = bootStoreOver(file);
        assertMigratedAndReadable(store);
        // The fixture's operating notes (folded by v1) are readable through the new path.
        expect(readOperatingNotes('mesh-alpha').length).toBeGreaterThan(0);
    });

    const liveCopy = process.env.ADHDEV_CW8_LIVE_DB_COPY;
    it.skipIf(!liveCopy || !existsSync(liveCopy))('on a COPY of a real preview mesh-runtime.db (ADHDEV_CW8_LIVE_DB_COPY)', () => {
        const store = bootStoreOver(liveCopy!);
        assertMigratedAndReadable(store);
    });
});
