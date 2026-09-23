// ---------------------------------------------------------------------------
// turn-ledger/migrate-v2 — drop the legacy tables whose last writer is gone
// ---------------------------------------------------------------------------
// `PRAGMA user_version` 1 → 2 (wiring-unification C-W8).
//
// v1 (migrate-v1.ts) folded the legacy turn/outbox/ledger tables into the turn
// ledger and dropped them — but the schema step still re-created them EMPTY on
// every open, because writers of several remained (the C integration's
// "recreate empty" transition). C-W8 retired those writers:
//
//   mesh_turn_attempts / _events / _held_suspensions — Stage 5 reducer deleted;
//     Stage 6 presentation reads `turn_attempts`;
//   mesh_session_delivery — delivery lifecycle = attempt `delivered`/`consumed`;
//   mesh_direct_dispatches — a direct dispatch IS its open `mesh_direct` attempt;
//   mesh_completion_fingerprints / mesh_inflight_hold — no reader or writer left;
//   mesh_pending_events — notices are `turn.notify` rows since C-W3.
//
// So whatever landed in them after v1 is a redundant shadow of state the turn
// ledger already holds (post-v1 direct dispatches opened their `mesh_direct`
// attempts through `turn_observe`). v2 does NOT fold those rows — folding a
// legacy attempt next to its ledger twin would trip the one-open-attempt-per-
// session index — it EXPORTS them (rollback audit, same JSONL shape as v1) and
// DROPS the tables for good.
//
// Operating notes recorded after v1 still went to `mesh_event_ledger` (its
// readers had not moved yet); v2 folds them into `mesh_operating_notes` —
// lifecycle fields (pinned / expiresAt / supersedes / subjectKey /
// sourceCoordinator) included this time — and deletes those note rows from the
// ledger. `mesh_event_ledger` itself stays: its generic event readers are the
// remaining C-W8 work (see the design stamp).
//
// Idempotent and crash-safe: one immediate transaction for the fold + drops +
// user_version; the export happens before it and appends.
// ---------------------------------------------------------------------------

import { closeSync, mkdirSync, openSync, writeSync } from 'fs';
import { dirname } from 'path';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { ensureTurnLedgerSchema, readUserVersion, tableExists } from './schema.js';
import { TurnStore, type OperatingNoteMetaColumn } from './store.js';

export const TURN_LEDGER_V2 = 2;

/** The legacy tables v2 drops (all but `mesh_event_ledger`, whose readers remain). */
export const V2_RETIRED_TABLES = [
    'mesh_turn_attempts',
    'mesh_turn_events',
    'mesh_turn_held_suspensions',
    'mesh_session_delivery',
    'mesh_direct_dispatches',
    'mesh_completion_fingerprints',
    'mesh_inflight_hold',
    'mesh_pending_events',
] as const;

const NOTE_KIND = 'coordinator_operating_note';
const NOTE_TOMBSTONE_KIND = 'coordinator_operating_note_tombstone';

export interface TurnLedgerMigrationV2Report {
    skipped: boolean;
    exportedRows: number;
    exportPath: string | null;
    notesFolded: number;
    noteTombstonesApplied: number;
    droppedTables: string[];
}

function parseObject(text: unknown): Record<string, unknown> {
    if (typeof text !== 'string' || !text) return {};
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function exportRows(db: DatabaseHandle, path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a', 0o600);
    let written = 0;
    try {
        for (const table of V2_RETIRED_TABLES) {
            if (!tableExists(db, table)) continue;
            for (const row of db.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<Record<string, unknown>>) {
                writeSync(fd, `${JSON.stringify({ _table: table, _migration: 'v2', ...row })}\n`);
                written++;
            }
        }
        if (tableExists(db, 'mesh_event_ledger')) {
            for (const row of db.prepare(`SELECT * FROM mesh_event_ledger WHERE kind IN (?, ?)`).iterate(NOTE_KIND, NOTE_TOMBSTONE_KIND) as Iterable<Record<string, unknown>>) {
                writeSync(fd, `${JSON.stringify({ _table: 'mesh_event_ledger', _migration: 'v2', ...row })}\n`);
                written++;
            }
        }
    } finally {
        closeSync(fd);
    }
    return written;
}

/** Fold the ledger's post-v1 operating notes into `mesh_operating_notes`, then delete them from the ledger. */
function foldLedgerNotes(db: DatabaseHandle, store: TurnStore, report: TurnLedgerMigrationV2Report): void {
    if (!tableExists(db, 'mesh_event_ledger')) return;
    const rows = db.prepare(`SELECT id, mesh_id, timestamp, kind, session_id, payload FROM mesh_event_ledger WHERE kind IN (?, ?) ORDER BY timestamp, rowid`)
        .all(NOTE_KIND, NOTE_TOMBSTONE_KIND) as Array<{ id: string; mesh_id: string; timestamp: string; kind: string; session_id: string | null; payload: string }>;
    const idsByText = new Map<string, string[]>();
    for (const row of rows) {
        const payload = parseObject(row.payload);
        const at = Date.parse(row.timestamp);
        const atMs = Number.isFinite(at) ? at : Date.now();
        if (row.kind === NOTE_KIND) {
            const text = str(payload.text);
            if (!text) continue;
            const meta: OperatingNoteMetaColumn = {
                ...(payload.pinned === true ? { pinned: true } : {}),
                ...(str(payload.expiresAt) ? { expiresAt: str(payload.expiresAt) } : {}),
                ...(str(payload.supersedes) ? { supersedes: str(payload.supersedes) } : {}),
                ...(str(payload.subjectKey) ? { subjectKey: str(payload.subjectKey) } : {}),
                ...(str(payload.sourceCoordinator) ? { sourceCoordinator: str(payload.sourceCoordinator) } : {}),
            };
            const created = Date.parse(typeof payload.createdAt === 'string' ? payload.createdAt : '');
            if (store.insertOperatingNote({
                noteId: row.id, meshId: row.mesh_id, text, category: str(payload.category) ?? null,
                callerSessionId: row.session_id, createdAt: Number.isFinite(created) ? created : atMs, meta,
            })) {
                report.notesFolded++;
                const key = `${row.mesh_id}\u0000${text}`;
                idsByText.set(key, [...(idsByText.get(key) ?? []), row.id]);
            }
        } else {
            const targetId = str(payload.targetNoteId);
            const targetText = str(payload.targetFingerprint);
            if (targetId && store.tombstoneOperatingNote(row.mesh_id, targetId, atMs)) report.noteTombstonesApplied++;
            for (const id of targetText ? idsByText.get(`${row.mesh_id}\u0000${targetText}`) ?? [] : []) {
                if (store.tombstoneOperatingNote(row.mesh_id, id, atMs)) report.noteTombstonesApplied++;
            }
            if (targetText) {
                // Keep the text-forget contract: a later note with this text is born retracted.
                store.insertOperatingNote({
                    noteId: row.id, meshId: row.mesh_id, text: targetText, category: null, callerSessionId: null,
                    createdAt: atMs, meta: { textTombstone: true, ...(str(payload.reason) ? { forgetReason: str(payload.reason) } : {}) },
                });
            }
        }
    }
    db.prepare(`DELETE FROM mesh_event_ledger WHERE kind IN (?, ?)`).run(NOTE_KIND, NOTE_TOMBSTONE_KIND);
}

/**
 * Run the one-way v2 step. No-op (`skipped`) once user_version ≥ 2; refuses
 * (throws) below 1 — v1 must have run first (boot runs v1 then v2).
 */
export function migrateTurnLedgerV2(db: DatabaseHandle, opts: { exportPath: string | null }): TurnLedgerMigrationV2Report {
    const report: TurnLedgerMigrationV2Report = { skipped: false, exportedRows: 0, exportPath: null, notesFolded: 0, noteTombstonesApplied: 0, droppedTables: [] };
    ensureTurnLedgerSchema(db);
    const version = readUserVersion(db);
    if (version >= TURN_LEDGER_V2) {
        report.skipped = true;
        return report;
    }
    if (version < 1) throw new Error(`turn-ledger migration v2 needs user_version 1 (found ${version}) — run v1 first`);
    if (opts.exportPath) {
        report.exportedRows = exportRows(db, opts.exportPath);
        report.exportPath = opts.exportPath;
    }
    const store = new TurnStore(db);
    db.transaction(() => {
        foldLedgerNotes(db, store, report);
        for (const table of V2_RETIRED_TABLES) {
            if (!tableExists(db, table)) continue;
            db.exec(`DROP TABLE ${table}`);
            report.droppedTables.push(table);
        }
        db.pragma(`user_version = ${TURN_LEDGER_V2}`);
    }).immediate();
    return report;
}

export function formatTurnLedgerMigrationV2Line(r: TurnLedgerMigrationV2Report): string {
    if (r.skipped) return `turn-ledger migration v2: already at user_version ${TURN_LEDGER_V2}`;
    return `turn-ledger migration v2: notes folded ${r.notesFolded} (+${r.noteTombstonesApplied} tombstones), exported ${r.exportedRows} rows${r.exportPath ? ` → ${r.exportPath}` : ''}, dropped [${r.droppedTables.join(',')}], user_version=${TURN_LEDGER_V2}`;
}
