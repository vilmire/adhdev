import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TURN_REASONS, isMeshTopicEntry } from '@adhdev/mesh-shared';
import type { Database as DatabaseHandle } from 'better-sqlite3';
// The fixture generator is a checked-in, deterministic script (C8 harness spec §1c: synthetic,
// auditable in git, no live-DB copy). It lives in oss/scripts so the OSS repo carries it.
// @ts-expect-error — plain .mjs without a declaration file
import { FIXTURE_COUNTS, buildLegacyTurnLedgerFixture } from '../../../../scripts/gen-turn-ledger-fixture.mjs';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';
import { LEGACY_TURN_TABLES, ensureTurnLedgerSchema, readUserVersion, tableExists } from '../../src/mesh/turn-ledger/schema.js';
import { formatTurnLedgerMigrationLine, isFoldReason, mapLegacyTerminal, migrateTurnLedgerV1 } from '../../src/mesh/turn-ledger/migrate-v1.js';
import { DEFAULT_TURN_POLICY } from '../../src/mesh/turn-ledger/policy.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const dirs: string[] = [];

function fixtureDb(): DatabaseHandle {
    const Database = loadBetterSqlite3();
    const db = new Database(':memory:');
    db.transaction(() => buildLegacyTurnLedgerFixture(db, { nowMs: NOW }))();
    return db;
}

function exportPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-turn-ledger-export-'));
    dirs.push(dir);
    return join(dir, 'turn-ledger-premigrate.jsonl');
}

function count(db: DatabaseHandle, sql: string, ...args: unknown[]): number {
    return (db.prepare(sql).get(...args) as { n: number }).n;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migrate-v1 on the synthetic preview-shaped fixture', () => {
    it('folds, orphans, merges and drops with the exact counts the fixture was built for', () => {
        const db = fixtureDb();
        const legacyRows = LEGACY_TURN_TABLES.reduce((n, t) => n + count(db, `SELECT COUNT(*) AS n FROM ${t}`), 0);
        const path = exportPath();
        const r = migrateTurnLedgerV1(db, { ownerDaemonId: 'daemon-local', nowMs: NOW, exportPath: path });

        expect(r).toMatchObject({
            skipped: false,
            meshes: 2,
            legacyAttempts: FIXTURE_COUNTS.legacyAttempts,
            attempts: FIXTURE_COUNTS.attempts,
            folds: FIXTURE_COUNTS.folds,
            retries: FIXTURE_COUNTS.retries,
            orphans: FIXTURE_COUNTS.orphans,
            openAttempts: FIXTURE_COUNTS.openAttempts,
            unmappedReasons: FIXTURE_COUNTS.freeTextReasons,
            events: FIXTURE_COUNTS.events,
            eventCollisions: 0,
            heldSuspensions: FIXTURE_COUNTS.heldSuspensions,
            holdsActive: FIXTURE_COUNTS.holdsActive,
            inflightHolds: FIXTURE_COUNTS.inflightHolds,
            inflightHoldsDropped: FIXTURE_COUNTS.inflightHoldsDropped,
            deliveries: FIXTURE_COUNTS.deliveries,
            deliveriesDropped: FIXTURE_COUNTS.deliveriesDropped,
            deliveriesMerged: FIXTURE_COUNTS.deliveries - FIXTURE_COUNTS.deliveriesDropped,
            directDispatches: FIXTURE_COUNTS.directDispatches,
            directDispatchesMerged: FIXTURE_COUNTS.directDispatches,
            directDispatchesDropped: 0,
            fingerprintsDropped: FIXTURE_COUNTS.fingerprints,
            pendingEvents: FIXTURE_COUNTS.pendingEvents,
            pendingUndrained: FIXTURE_COUNTS.pendingUndrained,
            pendingNotified: FIXTURE_COUNTS.pendingUndrained,
            pendingDrainedAcked: FIXTURE_COUNTS.pendingDrainedAcks,
            ledgerRows: FIXTURE_COUNTS.ledgerRows,
            operatingNotes: FIXTURE_COUNTS.operatingNotes,
            operatingNoteTombstones: FIXTURE_COUNTS.operatingNoteTombstones,
            ledgerRowsDropped: FIXTURE_COUNTS.ledgerRows,
            exportedRows: legacyRows,
            exportPath: path,
        });
        expect([...r.droppedTables].sort()).toEqual([...LEGACY_TURN_TABLES].sort());
        expect(readUserVersion(db)).toBe(1);
        for (const table of LEGACY_TURN_TABLES) expect(tableExists(db, table)).toBe(false);

        // table contents
        expect(count(db, 'SELECT COUNT(*) AS n FROM turn_attempts')).toBe(FIXTURE_COUNTS.attempts);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_attempts WHERE terminal_reason = 'migration_orphan'`)).toBe(FIXTURE_COUNTS.orphans);
        expect(count(db, 'SELECT SUM(generation) AS n FROM turn_attempts')).toBe(FIXTURE_COUNTS.folds);
        expect(count(db, 'SELECT SUM(reclaim_count) AS n FROM turn_attempts')).toBe(FIXTURE_COUNTS.folds);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_attempts WHERE owner_daemon_id != 'daemon-local'`)).toBe(0);
        expect(count(db, `SELECT COUNT(*) AS n FROM mesh_operating_notes WHERE tombstoned_at IS NOT NULL`)).toBe(32);
        expect(count(db, `SELECT COUNT(*) AS n FROM mesh_operating_notes WHERE category IS NOT NULL`)).toBe(100);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_attempts WHERE notified_at IS NOT NULL`)).toBe(FIXTURE_COUNTS.notifiedAttempts);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_attempts WHERE input_json IS NOT NULL`)).toBeGreaterThan(0);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_attempts WHERE via IS NOT NULL`)).toBe(FIXTURE_COUNTS.directDispatches);

        // closed vocabularies only; free text survives in the export, nowhere else
        const reasons = (db.prepare('SELECT DISTINCT terminal_reason AS r FROM turn_attempts WHERE terminal_reason IS NOT NULL').all() as Array<{ r: string }>).map((x) => x.r);
        for (const reason of reasons) expect(TURN_REASONS as readonly string[]).toContain(reason);
        const exported = readFileSync(path, 'utf8');
        expect(exported.trim().split('\n')).toHaveLength(legacyRows);
        expect(exported).toContain('free text that must not survive into a closed column');
        expect(JSON.stringify(db.prepare('SELECT * FROM turn_attempts').all())).not.toContain('free text that must not survive');

        // undrained → pending turn.notify entries, content-free, local payload kept
        const pending = db.prepare(`SELECT payload_json FROM turn_events WHERE publish_state = 'pending'`).all() as Array<{ payload_json: string }>;
        expect(pending).toHaveLength(FIXTURE_COUNTS.pendingUndrained);
        for (const row of pending) {
            const payload = JSON.parse(row.payload_json);
            expect(isMeshTopicEntry(payload.entry)).toBe(true);
            expect(payload.entry).toMatchObject({ k: 'turn.notify', notify: 'mesh_event' });
            expect(JSON.stringify(payload.entry)).not.toContain('UNDRAINED-TEXT');
            expect(payload.local.payload.summary).toBe('UNDRAINED-TEXT stays local');
        }
        const byEvent = db.prepare(`SELECT json_extract(payload_json, '$.event') AS e, COUNT(*) AS n FROM turn_events WHERE publish_state = 'pending' GROUP BY 1 ORDER BY 1`).all();
        expect(byEvent).toEqual([{ e: 'refine:completed', n: 41 }, { e: 'refine:failed', n: 23 }, { e: 'worktree_bootstrap_complete', n: 6 }]);

        // invariants the ledger relies on: ≤1 open attempt per session, every open non-plain attempt holds a hard ceiling
        const open = db.prepare(`SELECT attempt_id, state, suspension FROM turn_attempts WHERE terminal_outcome IS NULL ORDER BY attempt_id`).all() as Array<{ attempt_id: string; state: string; suspension: string | null }>;
        expect(open.map((o) => [o.state, o.suspension])).toEqual(expect.arrayContaining([['suspended', 'approval'], ['generating', null]]));
        for (const o of open) {
            expect(count(db, `SELECT COUNT(*) AS n FROM turn_holds WHERE attempt_id = ? AND reason = 'hard_ceiling' AND status = 'active' AND until_ms = ?`, o.attempt_id, NOW + DEFAULT_TURN_POLICY.hardCeilingMs)).toBe(1);
        }
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_holds WHERE reason = 'liveness' AND status = 'active'`)).toBe(1);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_holds WHERE reason = 'suspension_before_consumed' AND status = 'active'`)).toBe(FIXTURE_COUNTS.holdsActive);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_holds WHERE status = 'resolved'`)).toBe(FIXTURE_COUNTS.heldSuspensions - FIXTURE_COUNTS.holdsActive);

        expect(formatTurnLedgerMigrationLine(r)).toMatch(/attempts 2295→2182 \(113 folds, 3 retries, 41 orphans/);
    });

    it('is one-way and idempotent: a second run is skipped', () => {
        const db = fixtureDb();
        migrateTurnLedgerV1(db, { ownerDaemonId: 'd', nowMs: NOW, exportPath: null });
        expect(migrateTurnLedgerV1(db, { ownerDaemonId: 'd', nowMs: NOW, exportPath: null })).toMatchObject({ skipped: true });
    });

    it('a failure inside one mesh rolls back that mesh only; the re-run finishes with the same totals', () => {
        const db = fixtureDb();
        ensureTurnLedgerSchema(db);
        db.exec(`CREATE TRIGGER boom BEFORE INSERT ON turn_attempts WHEN NEW.mesh_id = 'mesh-beta' BEGIN SELECT RAISE(ABORT, 'injected mid-migration crash'); END;`);
        expect(() => migrateTurnLedgerV1(db, { ownerDaemonId: 'd', nowMs: NOW, exportPath: null })).toThrow(/injected/);
        // mesh-alpha moved, mesh-beta untouched, nothing dropped, still v0
        expect(readUserVersion(db)).toBe(0);
        expect(count(db, `SELECT COUNT(*) AS n FROM mesh_turn_attempts WHERE mesh_id = 'mesh-alpha'`)).toBe(0);
        expect(count(db, `SELECT COUNT(*) AS n FROM mesh_turn_attempts WHERE mesh_id = 'mesh-beta'`)).toBeGreaterThan(0);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_attempts WHERE mesh_id = 'mesh-beta'`)).toBe(0);
        db.exec('DROP TRIGGER boom');
        const second = migrateTurnLedgerV1(db, { ownerDaemonId: 'd', nowMs: NOW, exportPath: null });
        expect(second.skipped).toBe(false);
        expect(readUserVersion(db)).toBe(1);
        expect(count(db, 'SELECT COUNT(*) AS n FROM turn_attempts')).toBe(FIXTURE_COUNTS.attempts);
        expect(count(db, 'SELECT SUM(generation) AS n FROM turn_attempts')).toBe(FIXTURE_COUNTS.folds);
        expect(count(db, `SELECT COUNT(*) AS n FROM turn_events WHERE publish_state = 'pending'`)).toBe(FIXTURE_COUNTS.pendingUndrained);
    });
});

describe('legacy reason mapping', () => {
    it('folds only reassigned/superseded predecessors', () => {
        expect(isFoldReason('reassigned:dispatch_failed')).toBe(true);
        expect(isFoldReason('superseded_by_queue_terminal')).toBe(true);
        expect(isFoldReason('provider_event')).toBe(false);
        expect(isFoldReason(null)).toBe(false);
    });

    it('maps every live reason family to a closed TurnReason and flags free text', () => {
        expect(mapLegacyTerminal('worker_reported:completed', 'completed')).toMatchObject({ reason: 'worker_reported', strength: 'tool_report', mapped: true });
        expect(mapLegacyTerminal('task_status_terminal:failed', 'failed')).toMatchObject({ reason: 'operator_update', source: 'operator', mapped: true });
        expect(mapLegacyTerminal('중복 정리 — operator prose', 'cancelled')).toMatchObject({ reason: 'operator_cancel', mapped: false });
        expect(mapLegacyTerminal(null, 'failed')).toMatchObject({ reason: 'session_error', mapped: true });
    });
});
