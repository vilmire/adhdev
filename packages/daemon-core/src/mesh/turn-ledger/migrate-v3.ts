// ---------------------------------------------------------------------------
// turn-ledger/migrate-v3 — retire `mesh_event_ledger` (the last legacy table)
// ---------------------------------------------------------------------------
// `PRAGMA user_version` 2 → 3 (wiring-unification C-W9a).
//
// C-W9a moved every writer of the event ledger onto `meshRecord(..., { local })`
// (topic projection + a `mesh_local_records` row) and every reader onto
// `mesh_local_records` / `turn_attempts` / `mesh_topic_index`. What is left of
// the ledger is history, and this step moves the part a reader can still use:
//
//   0. (optional, `jsonlDir`) the ACTIVE per-mesh JSONL mirror
//      (`<safeMeshId>.jsonl`, rotation-capped at 10 MB) — the event ledger
//      re-imported it lazily per mesh, so a mesh nobody read since v1 still
//      has its recent history only there. Rotations / archives are older than
//      any reader's horizon and stay on disk untouched (no reader is left).
//   1. EXPORT every `mesh_event_ledger` row (rollback audit, same JSONL shape
//      as v1/v2: `{_table, _migration:'v3', ...row}`).
//   2. FOLD the rows inside the local-record retention window (30 days) into
//      `mesh_local_records` — same id, kind, identifiers, task id (column, or
//      payload.taskId for legacy rows), time, full payload. Operating notes
//      are skipped (v2 moved them to `mesh_operating_notes`).
//   3. DROP `mesh_event_ledger`.
//
// Idempotent and crash-safe: the export happens before the transaction and
// appends; fold + drop + user_version are one immediate transaction; the fold
// is INSERT OR IGNORE by event id, so a rerun after a crash cannot duplicate.
// ---------------------------------------------------------------------------

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'fs';
import { dirname, join } from 'path';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { ensureTurnLedgerSchema, readUserVersion, tableExists } from './schema.js';
import { LocalRecordStore } from '../mesh-local-record-store.js';

export const TURN_LEDGER_V3 = 3;

/** The table v3 drops. */
export const V3_RETIRED_TABLE = 'mesh_event_ledger';

/** Local-record retention (mirrors MESH_LOCAL_RECORD_RETENTION_MS — a leaf copy, no import edge). */
const FOLD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** The active JSONL was rotated at 10 MB; anything bigger is not an active mirror. */
const MAX_ACTIVE_JSONL_BYTES = 16 * 1024 * 1024;
const NOTE_KINDS = new Set(['coordinator_operating_note', 'coordinator_operating_note_tombstone']);

export interface TurnLedgerMigrationV3Report {
    skipped: boolean;
    jsonlFilesScanned: number;
    jsonlRowsImported: number;
    exportedRows: number;
    exportPath: string | null;
    foldedRows: number;
    /** Rows older than the fold window (exported only). */
    expiredRows: number;
    droppedTables: string[];
}

interface LedgerRow {
    id: string; mesh_id: string; timestamp: string; kind: string; node_id: string | null; session_id: string | null;
    provider_type: string | null; task_id?: string | null; payload: string;
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

function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function safeMeshId(meshId: string): string {
    return meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Step 0: the active per-mesh JSONL mirrors straight into `mesh_local_records`
 * (a line is accepted only if it is a ledger entry of the mesh the file is
 * named after — test leftovers, export files and pending-event files are not).
 */
function importActiveJsonl(dir: string, local: LocalRecordStore, cutoffMs: number, report: TurnLedgerMigrationV3Report): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
        const m = /^([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
        if (!m) continue;
        const path = join(dir, name);
        try {
            if (!statSync(path).isFile() || statSync(path).size > MAX_ACTIVE_JSONL_BYTES) continue;
        } catch {
            continue;
        }
        report.jsonlFilesScanned++;
        let text = '';
        try { text = readFileSync(path, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let entry: Record<string, unknown>;
            try { entry = JSON.parse(line); } catch { continue; }
            if (!entry || typeof entry !== 'object' || '_table' in entry) continue;
            const id = str(entry.id);
            const meshId = str(entry.meshId);
            const kind = str(entry.kind);
            const at = Date.parse(typeof entry.timestamp === 'string' ? entry.timestamp : '');
            const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload) ? entry.payload as Record<string, unknown> : null;
            if (!id || !meshId || !kind || !payload || !Number.isFinite(at) || safeMeshId(meshId) !== m[1]) continue;
            if (NOTE_KINDS.has(kind) || at < cutoffMs) continue;
            if (local.insert({
                eventId: id, meshId, kind,
                nodeId: str(entry.nodeId), sessionId: str(entry.sessionId), providerType: str(entry.providerType),
                taskId: str(entry.taskId) ?? str(payload.taskId),
                atMs: at, payload,
            })) report.jsonlRowsImported++;
        }
    }
}

function exportRows(db: DatabaseHandle, path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a', 0o600);
    let written = 0;
    try {
        for (const row of db.prepare(`SELECT * FROM ${V3_RETIRED_TABLE}`).iterate() as Iterable<Record<string, unknown>>) {
            writeSync(fd, `${JSON.stringify({ _table: V3_RETIRED_TABLE, _migration: 'v3', ...row })}\n`);
            written++;
        }
    } finally {
        closeSync(fd);
    }
    return written;
}

function foldRows(db: DatabaseHandle, local: LocalRecordStore, cutoffMs: number, report: TurnLedgerMigrationV3Report): void {
    const hasTaskId = (db.prepare(`PRAGMA table_info(${V3_RETIRED_TABLE})`).all() as Array<{ name: string }>).some((c) => c.name === 'task_id');
    const rows = db.prepare(`SELECT * FROM ${V3_RETIRED_TABLE} ORDER BY timestamp, rowid`).all() as LedgerRow[];
    for (const row of rows) {
        if (NOTE_KINDS.has(row.kind) || !row.kind || !row.kind.trim()) continue;
        const at = Date.parse(row.timestamp);
        if (!Number.isFinite(at) || at < cutoffMs) {
            report.expiredRows++;
            continue;
        }
        const payload = parseObject(row.payload);
        if (local.insert({
            eventId: row.id, meshId: row.mesh_id, kind: row.kind,
            nodeId: row.node_id, sessionId: row.session_id, providerType: row.provider_type,
            taskId: (hasTaskId ? str(row.task_id) : null) ?? str(payload.taskId),
            atMs: at, payload,
        })) report.foldedRows++;
    }
}

/**
 * Run the one-way v3 step. No-op (`skipped`) once user_version ≥ 3; refuses
 * (throws) below 2 — boot runs v1, v2, then v3.
 */
export function migrateTurnLedgerV3(db: DatabaseHandle, opts: { exportPath: string | null; jsonlDir?: string | null; nowMs?: number }): TurnLedgerMigrationV3Report {
    const report: TurnLedgerMigrationV3Report = {
        skipped: false, jsonlFilesScanned: 0, jsonlRowsImported: 0, exportedRows: 0, exportPath: null,
        foldedRows: 0, expiredRows: 0, droppedTables: [],
    };
    ensureTurnLedgerSchema(db);
    const version = readUserVersion(db);
    if (version >= TURN_LEDGER_V3) {
        report.skipped = true;
        return report;
    }
    if (version < 2) throw new Error(`turn-ledger migration v3 needs user_version 2 (found ${version}) — run v1 and v2 first`);
    const cutoffMs = (opts.nowMs ?? Date.now()) - FOLD_WINDOW_MS;
    const local = new LocalRecordStore(db);
    const hasLedger = tableExists(db, V3_RETIRED_TABLE);
    if (hasLedger && opts.exportPath) {
        report.exportedRows = exportRows(db, opts.exportPath);
        report.exportPath = opts.exportPath;
    }
    db.transaction(() => {
        if (opts.jsonlDir) importActiveJsonl(opts.jsonlDir, local, cutoffMs, report);
        if (hasLedger) {
            foldRows(db, local, cutoffMs, report);
            db.exec(`DROP TABLE ${V3_RETIRED_TABLE}`);
            report.droppedTables.push(V3_RETIRED_TABLE);
        }
        db.pragma(`user_version = ${TURN_LEDGER_V3}`);
    }).immediate();
    return report;
}

export function formatTurnLedgerMigrationV3Line(r: TurnLedgerMigrationV3Report): string {
    if (r.skipped) return `turn-ledger migration v3: already at user_version ${TURN_LEDGER_V3}`;
    return `turn-ledger migration v3: jsonl ${r.jsonlRowsImported} row(s) from ${r.jsonlFilesScanned} file(s), folded ${r.foldedRows} ledger row(s) into mesh_local_records (${r.expiredRows} past retention, export only), exported ${r.exportedRows} rows${r.exportPath ? ` → ${r.exportPath}` : ''}, dropped [${r.droppedTables.join(',')}], user_version=${TURN_LEDGER_V3}`;
}
