import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseHandle } from 'better-sqlite3';

// C-W9a: user_version 2 → 3 retires `mesh_event_ledger`, the last legacy table.
// Pinned twice: on a raw handle (exact fold / JSONL import / export / drop), and
// through the live boot path (MeshRuntimeStore open → v1 → v2 → v3) on the
// synthetic legacy fixture — and, when ADHDEV_CW9A_LIVE_DB_COPY names a COPY of a
// real preview mesh-runtime.db (made with `sqlite3 <live> ".backup <copy>"`, never
// the live file), on that too — then the readers that replaced the ledger
// (Stage 6, refine, MAGI, briefing summary, recovery context) run over it.

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
import { ensureTurnLedgerSchema, readUserVersion, tableExists, LEGACY_TURN_TABLES, TURN_LEDGER_SCHEMA_VERSION } from '../../src/mesh/turn-ledger/schema.js';
import { TURN_LEDGER_V3, V3_RETIRED_TABLE, formatTurnLedgerMigrationV3Line, migrateTurnLedgerV3 } from '../../src/mesh/turn-ledger/migrate-v3.js';
import { LocalRecordStore } from '../../src/mesh/mesh-local-record-store.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { resolveSessionTurnPresentation } from '../../src/mesh/mesh-turn-presentation.js';
import { getActiveDirectDispatches } from '../../src/mesh/mesh-direct-dispatch.js';
import { readOperatingNotes } from '../../src/mesh/mesh-operating-notes.js';
import {
    getLocalRecordSummary,
    getSessionRecoveryContext,
    readActiveWorkRecords,
    readLocalRecords,
    readRefineJobRecords,
} from '../../src/mesh/mesh-local-records.js';
import { buildMeshAsyncRefineJobs } from '../../src/mesh/mesh-refine-status.js';
import { buildMeshMagiActivity } from '../../src/mesh/mesh-magi-status.js';
import { buildMeshActiveWork } from '../../src/mesh/mesh-active-work.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const MESH = 'mesh_alpha';
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

const iso = (ms: number) => new Date(ms).toISOString();

/** A post-v2 DB (user_version 2) whose event ledger still holds rows — every C-landed install. */
function postV2Db(): DatabaseHandle {
    const db = new (loadBetterSqlite3())(':memory:');
    ensureTurnLedgerSchema(db);
    db.pragma('user_version = 2');
    db.exec(`CREATE TABLE mesh_event_ledger (id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, timestamp TEXT NOT NULL, kind TEXT NOT NULL,
        node_id TEXT, session_id TEXT, provider_type TEXT, task_id TEXT, payload TEXT NOT NULL DEFAULT '{}')`);
    const put = db.prepare(`INSERT INTO mesh_event_ledger (id, mesh_id, timestamp, kind, node_id, session_id, provider_type, task_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A refine job in flight: nested payload (the reason these rows must stay local + whole).
    put.run('refine-dispatch', MESH, iso(NOW - 60_000), 'task_dispatched', 'node-wt', null, null, null,
        JSON.stringify({ source: 'refine_mesh_node_async_job', refineJob: { jobId: 'job-1', nodeId: 'node-wt', status: 'accepted' } }));
    // A legacy row with task_id only inside the payload (pre-column writer).
    put.run('dispatch-legacy', MESH, iso(NOW - 2 * DAY_MS), 'dispatch_failed', 'node-a', 's-1', 'claude-cli', null,
        JSON.stringify({ taskId: 't-legacy', error: 'CLI agent not running: kimi' }));
    // MAGI synthesis with free text.
    put.run('magi-synth', MESH, iso(NOW - DAY_MS), 'magi_synthesis', null, null, null, null,
        JSON.stringify({ source: 'magi', consensusGroupId: 'g-1', synthesis: { verdict: 'agree', notes: ['free text'] } }));
    // Past the 30-day window: exported, not folded.
    put.run('old-row', MESH, iso(NOW - 40 * DAY_MS), 'session_launched', 'node-a', null, null, null, '{}');
    // A (post-v2 impossible, defensive) operating note: never folded as a record.
    put.run('stray-note', MESH, iso(NOW - 1000), 'coordinator_operating_note', null, null, null, null, JSON.stringify({ text: 'x' }));
    return db;
}

function ledgerDirWithJsonl(): string {
    const dir = tempDir('adhdev-v3-jsonl-');
    // The active per-mesh mirror: one row the SQLite table never re-imported, one duplicate.
    writeFileSync(join(dir, `${MESH}.jsonl`), [
        JSON.stringify({ id: 'jsonl-only', meshId: MESH, timestamp: iso(NOW - 3 * DAY_MS), kind: 'node_cloned', nodeId: 'node-wt', payload: {} }),
        JSON.stringify({ id: 'refine-dispatch', meshId: MESH, timestamp: iso(NOW - 60_000), kind: 'task_dispatched', nodeId: 'node-wt', payload: { refineJob: { jobId: 'job-1' } } }),
        '{not json',
    ].join('\n') + '\n');
    // Files that are NOT an active mirror of their own mesh: ignored.
    writeFileSync(join(dir, 'mesh-node-approval.jsonl'), JSON.stringify({ id: 'x1', meshId: 'other', timestamp: iso(NOW), kind: 'task_dispatched', payload: {} }) + '\n');
    writeFileSync(join(dir, `${MESH}.archive.jsonl`), JSON.stringify({ id: 'archived', meshId: MESH, timestamp: iso(NOW), kind: 'task_completed', payload: {} }) + '\n');
    writeFileSync(join(dir, 'turn-ledger-premigrate-1.jsonl'), JSON.stringify({ _table: 'mesh_event_ledger', id: 'exp', mesh_id: MESH }) + '\n');
    return dir;
}

describe('migrate-v3 on a raw post-v2 handle', () => {
    it('imports the active JSONL mirror, folds the recent rows (nested payloads + backfilled task ids), exports all, drops the table', () => {
        const db = postV2Db();
        const exportPath = join(tempDir('adhdev-v3-export-'), 'v3.jsonl');
        const report = migrateTurnLedgerV3(db, { exportPath, jsonlDir: ledgerDirWithJsonl(), nowMs: NOW });

        expect(report).toMatchObject({ skipped: false, jsonlFilesScanned: 3, jsonlRowsImported: 2, foldedRows: 2, expiredRows: 1, exportedRows: 5, droppedTables: [V3_RETIRED_TABLE] });
        expect(readUserVersion(db)).toBe(TURN_LEDGER_V3);
        expect(TURN_LEDGER_SCHEMA_VERSION).toBe(TURN_LEDGER_V3);
        expect(tableExists(db, 'mesh_event_ledger')).toBe(false);
        for (const table of LEGACY_TURN_TABLES) expect(tableExists(db, table), table).toBe(false);

        const rows = new LocalRecordStore(db).query(MESH);
        expect(rows.map((r) => r.id).sort()).toEqual(['dispatch-legacy', 'jsonl-only', 'magi-synth', 'refine-dispatch']);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get('dispatch-legacy')).toMatchObject({ kind: 'dispatch_failed', nodeId: 'node-a', sessionId: 's-1', providerType: 'claude-cli', taskId: 't-legacy' });
        expect((byId.get('magi-synth')!.payload as any).synthesis.notes).toEqual(['free text']);
        expect((byId.get('refine-dispatch')!.payload as any).refineJob.jobId).toBe('job-1');
        expect(byId.get('refine-dispatch')!.timestamp).toBe(iso(NOW - 60_000));

        const exported = readFileSync(exportPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(exported).toHaveLength(5);
        expect(exported.every((r) => r._table === 'mesh_event_ledger' && r._migration === 'v3')).toBe(true);
        expect(formatTurnLedgerMigrationV3Line(report)).toContain('user_version=3');

        // Idempotent.
        expect(migrateTurnLedgerV3(db, { exportPath: null, nowMs: NOW }).skipped).toBe(true);
    });

    it('a fresh v2 store with no event ledger just advances the version', () => {
        const db = new (loadBetterSqlite3())(':memory:');
        ensureTurnLedgerSchema(db);
        db.pragma('user_version = 2');
        expect(migrateTurnLedgerV3(db, { exportPath: null, nowMs: NOW })).toMatchObject({ skipped: false, foldedRows: 0, droppedTables: [] });
        expect(readUserVersion(db)).toBe(3);
    });

    it('refuses to run before v2', () => {
        const db = new (loadBetterSqlite3())(':memory:');
        ensureTurnLedgerSchema(db);
        db.pragma('user_version = 1');
        expect(() => migrateTurnLedgerV3(db, { exportPath: null })).toThrow(/run v1 and v2 first/);
    });
});

/**
 * Open the process store over `dbFile` (copied into a fresh config dir, with the
 * optional active per-mesh JSONL mirrors copied next to it — what v3 imports)
 * and run every boot migration.
 */
function bootStoreOver(dbFile: string, jsonlDir?: string): MeshRuntimeStore {
    state.configDir = join(tempDir('adhdev-v3-boot-'), '.adhdev');
    const ledgerDir = join(state.configDir, 'mesh-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    copyFileSync(dbFile, join(ledgerDir, 'mesh-runtime.db'));
    if (jsonlDir) {
        for (const name of readdirSync(jsonlDir)) {
            if (/^[A-Za-z0-9_-]+\.jsonl$/.test(name)) copyFileSync(join(jsonlDir, name), join(ledgerDir, name));
        }
    }
    MeshRuntimeStore.resetForTests();
    const store = MeshRuntimeStore.getInstance();
    store.runTurnLedgerMigrationV1({ ownerDaemonId: 'daemon-local', exportPath: null });
    store.runTurnLedgerMigrationV2({ exportPath: null });
    store.runTurnLedgerMigrationV3({ exportPath: null });
    return store;
}

function assertNoLegacyTableAndReadersWork(store: MeshRuntimeStore): void {
    expect(readUserVersion(store.db)).toBe(TURN_LEDGER_V3);
    const legacy = (store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map((r) => r.name)
        .filter((name) => (LEGACY_TURN_TABLES as readonly string[]).includes(name));
    expect(legacy).toEqual([]);
    expect(tableExists(store.db, 'mesh_local_records')).toBe(true);

    // Stage 6 over whatever open mesh attempt the DB holds.
    const open = store.turnStore().listOpenAttempts().find((a) => a.scope !== 'plain');
    const p = resolveSessionTurnPresentation({ sessionId: open?.sessionId ?? `sess-${randomUUID().slice(0, 6)}`, legacyStatus: 'idle', surface: 'session_status' });
    expect(p.authority).toBe(open ? 'turn_reducer' : 'provider_fsm_fallback');

    const meshIds = new Set<string>([
        ...(store.db.prepare(`SELECT DISTINCT mesh_id FROM mesh_local_records`).all() as Array<{ mesh_id: string }>).map((r) => r.mesh_id),
        ...store.turnStore().listOpenAttempts().map((a) => a.meshId).filter((m): m is string => !!m),
    ]);
    for (const meshId of meshIds) {
        // Refine readers (status / resume / in-flight guard all fold these).
        expect(Array.isArray(buildMeshAsyncRefineJobs({ meshId, ledgerEntries: readRefineJobRecords(meshId) }))).toBe(true);
        // MAGI readers.
        expect(Array.isArray(buildMeshMagiActivity({ meshId, ledgerEntries: readLocalRecords(meshId, { kind: ['magi_dispatched', 'magi_synthesis'], tail: 200 }) }))).toBe(true);
        // Active work (idle reminder / notification line / mesh_status).
        const activeWork = buildMeshActiveWork({ meshId, queue: [], directDispatches: getActiveDirectDispatches(meshId), ledgerEntries: readActiveWorkRecords(meshId, ['task_dispatched', 'task_completed', 'task_failed']), nodes: [] });
        expect(activeWork.summary).toBeTypeOf('object');
        // Briefing summary + recovery context + notes.
        expect(getLocalRecordSummary(meshId).meshId).toBe(meshId);
        expect(typeof getSessionRecoveryContext(meshId, { nodeId: 'any-node' }).consecutiveNodeFailures).toBe('number');
        expect(Array.isArray(readOperatingNotes(meshId))).toBe(true);
    }
}

describe('boot migrations (v1 → v2 → v3) through MeshRuntimeStore, then the replacement readers', () => {
    it('on the synthetic legacy fixture', () => {
        const file = join(tempDir('adhdev-v3-fixture-'), 'fixture.db');
        const db = new (loadBetterSqlite3())(file);
        db.transaction(() => buildLegacyTurnLedgerFixture(db, { nowMs: Date.now() }))();
        db.close();
        const store = bootStoreOver(file);
        assertNoLegacyTableAndReadersWork(store);
    });

    // ADHDEV_CW9A_LIVE_JSONL_DIR (optional): a copy of that install's active
    // `<meshId>.jsonl` mirrors. A pre-v1 (user_version 0) install loses its
    // event-ledger ROWS to v1 by design (C3: the topic holds their projection),
    // so its recent history reaches `mesh_local_records` through the JSONL import.
    const liveCopy = process.env.ADHDEV_CW9A_LIVE_DB_COPY;
    const liveJsonl = process.env.ADHDEV_CW9A_LIVE_JSONL_DIR;
    it.skipIf(!liveCopy || !existsSync(liveCopy))('on a COPY of a real preview mesh-runtime.db (ADHDEV_CW9A_LIVE_DB_COPY)', () => {
        const store = bootStoreOver(liveCopy!, liveJsonl && existsSync(liveJsonl) ? liveJsonl : undefined);
        assertNoLegacyTableAndReadersWork(store);
        if (liveJsonl) {
            const folded = (store.db.prepare(`SELECT COUNT(*) AS n FROM mesh_local_records`).get() as { n: number }).n;
            expect(folded).toBeGreaterThan(0);
        }
    }, 300_000);
});
