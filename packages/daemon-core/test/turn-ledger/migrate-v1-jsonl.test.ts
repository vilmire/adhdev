import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { importLegacyPendingEventsJsonl, migrateTurnLedgerV1 } from '../../src/mesh/turn-ledger/migrate-v1.js';

// migrate-v1 step 0 (C3, C-W3): the legacy `*.pending-events.jsonl` salvage,
// inlined from the deleted mesh-events-pending-migration.ts. Ported cases:
// import + unlink, corrupt-line salvage, empty file, coordinator-scoped file
// keeps its target, idempotent re-run — plus the end-to-end fold: an imported
// UNDRAINED event becomes exactly one pending `turn.notify{mesh_event}`.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledgerDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-jsonl-mig-'));
    dirs.push(dir);
    return dir;
}

/** A pre-migration DB: the turn tables + the legacy inbox table (as mesh-runtime-store-schema created it). */
function legacyDb(): DatabaseHandle {
    const Database = loadBetterSqlite3();
    const db = new Database(':memory:');
    ensureTurnLedgerSchema(db);
    db.exec(`CREATE TABLE mesh_pending_events (
        id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, coordinator_daemon_id TEXT, event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT, queued_at INTEGER NOT NULL, drained INTEGER NOT NULL DEFAULT 0, drained_at INTEGER,
        protocol_version TEXT, event_id TEXT, scope TEXT, dispatched_by TEXT, intended_for TEXT, drained_by TEXT)`);
    return db;
}

const event = (meshId: string, name: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    event: name, meshId, nodeLabel: 'node-1', metadataEvent: { taskId: `task-${name}` }, coordinatorMessage: `[System] ${name}`, queuedAt: 1_000, ...extra,
});

describe('importLegacyPendingEventsJsonl', () => {
    it('imports every readable line, skips corrupt ones, and unlinks the file', () => {
        const dir = ledgerDir();
        writeFileSync(join(dir, 'mesh_a.pending-events.jsonl'), [event('mesh_a', 'refine:completed'), '{not json', event('mesh_a', 'agent:stopped'), ''].join('\n'));
        const db = legacyDb();
        const r = importLegacyPendingEventsJsonl(db, dir);
        expect(r).toMatchObject({ filesScanned: 1, eventsImported: 2, linesSkipped: 1, filesRemoved: 1, filesRetained: 0 });
        expect(readdirSync(dir)).toEqual([]);
        expect((db.prepare('SELECT COUNT(*) AS n FROM mesh_pending_events').get() as { n: number }).n).toBe(2);
        expect((db.prepare(`SELECT queued_at FROM mesh_pending_events LIMIT 1`).get() as { queued_at: number }).queued_at).toBe(1_000);
    });

    it('an empty file is removed; a coordinator-scoped file keeps its target daemon; a re-run is a no-op', () => {
        const dir = ledgerDir();
        writeFileSync(join(dir, 'mesh_b.pending-events.jsonl'), '');
        writeFileSync(join(dir, 'mesh_c-daemon_x.pending-events.jsonl'), event('mesh_c', 'refine:failed', { targetCoordinatorDaemonId: 'daemon_x' }) + '\n');
        const db = legacyDb();
        expect(importLegacyPendingEventsJsonl(db, dir)).toMatchObject({ filesScanned: 2, eventsImported: 1, filesRemoved: 2 });
        expect((db.prepare('SELECT coordinator_daemon_id AS d FROM mesh_pending_events').get() as { d: string }).d).toBe('daemon_x');
        expect(importLegacyPendingEventsJsonl(db, dir)).toMatchObject({ filesScanned: 0, eventsImported: 0 });
    });

    it('no ledger dir / no inbox table → no-op', () => {
        expect(importLegacyPendingEventsJsonl(legacyDb(), join(ledgerDir(), 'missing'))).toMatchObject({ filesScanned: 0 });
        const Database = loadBetterSqlite3();
        const bare = new Database(':memory:');
        const dir = ledgerDir();
        writeFileSync(join(dir, 'mesh_a.pending-events.jsonl'), event('mesh_a', 'x'));
        expect(importLegacyPendingEventsJsonl(bare, dir)).toMatchObject({ filesScanned: 0 });
        expect(existsSync(join(dir, 'mesh_a.pending-events.jsonl'))).toBe(true);
    });

    it('end to end: a salvaged undrained event folds into exactly one pending turn.notify{mesh_event}', () => {
        const dir = ledgerDir();
        writeFileSync(join(dir, 'mesh_a.pending-events.jsonl'), event('mesh_a', 'worktree_bootstrap_complete') + '\n');
        const db = legacyDb();
        const report = migrateTurnLedgerV1(db, { ownerDaemonId: 'dc', exportPath: null, nowMs: 5_000, beforeFold: () => importLegacyPendingEventsJsonl(db, dir) });
        expect(report).toMatchObject({ pendingUndrained: 1, pendingNotified: 1 });
        const rows = db.prepare(`SELECT publish_state, payload_json FROM turn_events WHERE kind = 'notify'`).all() as Array<{ publish_state: string; payload_json: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.publish_state).toBe('pending');
        const payload = JSON.parse(rows[0]!.payload_json);
        expect(payload).toMatchObject({ notify: 'mesh_event', event: 'worktree_bootstrap_complete', entry: { k: 'turn.notify', targetDaemonId: 'dc' } });
        // The text rides LOCAL only — never the published entry.
        expect(JSON.stringify(payload.entry)).not.toContain('[System]');
        expect(payload.local.payload.coordinatorMessage).toBe('[System] worktree_bootstrap_complete');
    });

    it('step g: intended_for is a JSON CoordinatorIdentity — its sessionId becomes the notice target (not the raw JSON text)', () => {
        const db = legacyDb();
        db.prepare(`INSERT INTO mesh_pending_events (id, mesh_id, coordinator_daemon_id, event, payload, queued_at, intended_for)
            VALUES ('p1', 'mesh_a', 'dc', 'refine:completed', ?, 1000, ?)`)
            .run(JSON.stringify({ event: 'refine:completed', meshId: 'mesh_a' }), JSON.stringify({ daemonId: 'dc', sessionId: 'coord-sess-1' }));
        migrateTurnLedgerV1(db, { ownerDaemonId: 'dc', exportPath: null, nowMs: 5_000 });
        const row = db.prepare(`SELECT payload_json FROM turn_events WHERE kind = 'notify'`).get() as { payload_json: string };
        expect(JSON.parse(row.payload_json).entry.targetSessionId).toBe('coord-sess-1');
    });
});
