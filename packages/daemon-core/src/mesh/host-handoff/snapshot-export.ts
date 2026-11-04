/**
 * Snapshot export (design §7.2 step 3): host-owned rows of one mesh, cut into
 * 256 KB hash-chained chunks. The table list is the contract — adding a
 * host-owned table to the handoff means adding it to HOST_SNAPSHOT_TABLES.
 */

import { createHash } from 'node:crypto';
import type { ProjectApprovalFile } from './project-files.js';
import { HOST_HANDOFF_CHUNK_BYTES, HOST_HANDOFF_PROTOCOL, type HandoffLaunchPlan, type HandoffManifest, type ManifestChunk, type TableSpec } from './types.js';

export const HOST_SNAPSHOT_TABLES: readonly TableSpec[] = [
    { table: 'mesh_queue', meshColumn: 'mesh_id', orderBy: 'created_at, id' },
    { table: 'mesh_missions', meshColumn: 'mesh_id', orderBy: 'created_at, id' },
    { table: 'mesh_mission_items', meshColumn: 'mesh_id', orderBy: 'created_at, id' },
    { table: 'mesh_mission_events', meshColumn: 'mesh_id', orderBy: 'seq' },
    { table: 'mesh_handoff_note_text', meshColumn: 'mesh_id', orderBy: 'task_id' },
    { table: 'mesh_idle_reminder', meshColumn: 'mesh_id', orderBy: 'mesh_id' },
    { table: 'assistant_threads', meshColumn: 'mesh_id', orderBy: 'mesh_id' },
    // Metadata only (bounded preview); bodies are fetched lazily from their origin by the new host.
    { table: 'session_artifacts', meshColumn: 'mesh_id', orderBy: 'artifact_id' },
    { table: 'turn_attempts', meshColumn: 'mesh_id', orderBy: 'attempt_id' },
    { table: 'turn_events', meshColumn: 'mesh_id', orderBy: 'recorded_at, event_id' },
    { table: 'turn_holds', meshColumn: 'attempt_id', orderBy: 'hold_id', parentTable: 'turn_attempts', parentColumn: 'attempt_id',
        scopeSql: 'attempt_id IN (SELECT attempt_id FROM turn_attempts WHERE mesh_id = ?)' },
    { table: 'mesh_topic_index', meshColumn: 'mesh_id', orderBy: 'writer, seq' },
    { table: 'mesh_operating_notes', meshColumn: 'mesh_id', orderBy: 'note_id' },
    { table: 'mesh_local_records', meshColumn: 'mesh_id', orderBy: 'event_id' },
    { table: 'mesh_task_outputs', meshColumn: 'mesh_id', orderBy: 'task_id, version' },
    { table: 'mesh_tool_call_log', meshColumn: 'mesh_id', orderBy: 'called_at, id' },
    { table: 'mesh_mission_ref_evals', meshColumn: 'mesh_id', orderBy: 'item_id, ref_key, base_ref' },
    { table: 'mesh_scheduler_cursor', meshColumn: 'mesh_id', orderBy: 'mesh_id' },
    { table: 'mesh_releases', meshColumn: 'mesh_id', orderBy: 'id' },
    { table: 'mesh_release_missions', meshColumn: 'mesh_id', orderBy: 'release_id, mission_id, added_at' },
    { table: 'mesh_release_events', meshColumn: 'mesh_id', orderBy: 'seq' },
    { table: 'assistant_attempt_bodies', meshColumn: 'mesh_id', orderBy: 'attempt_id' },
    { table: 'assistant_relays', meshColumn: 'mesh_id', orderBy: 'attempt_id' },
    { table: 'assistant_relay_coverage', meshColumn: 'attempt_id', orderBy: 'attempt_id', parentTable: 'assistant_relays', parentColumn: 'attempt_id',
        scopeSql: 'attempt_id IN (SELECT attempt_id FROM assistant_relays WHERE mesh_id = ?)' },
    { table: 'assistant_decision_answer_log', meshColumn: 'mesh_id', orderBy: 'item_id' },
    { table: 'assistant_procedure_signals', meshColumn: 'mesh_id', orderBy: 'id' },
    { table: 'assistant_memory_entry', meshColumn: 'project_ref', scopeSql: "scope = 'project' AND project_ref = ?", orderBy: 'seq' },
    { table: 'assistant_metric_daily', meshColumn: 'mesh_id', orderBy: 'day' },
];

/** Local storage key of a project-scoped history table (see history-identity.ts). Never leaves the machine. */
export const HISTORY_ROW_ID = 'row_id';

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[] }; transaction?<T>(fn: () => T): () => T };

export interface SnapshotPayload {
    version: 1;
    tables: Record<string, { columns: string[]; rows: unknown[][] }>;
    /** Sanitised host mesh config (no secrets / tokens / keys). */
    config: Record<string, unknown> | null;
    files: ProjectApprovalFile[];
}

export function sha256Hex(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

const SECRET_KEY = /(secret|token|password|passphrase|credential|private_?key|api_?key|authorization)/i;

/** Drop secret-looking keys at any depth. Never rewrites values, only removes keys. */
export function sanitizeConfigForSnapshot(value: unknown): { value: unknown; removed: number } {
    let removed = 0;
    const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
                if (SECRET_KEY.test(k)) { removed++; continue; }
                out[k] = walk(child);
            }
            return out;
        }
        return v;
    };
    return { value: walk(value), removed };
}

export function readTable(db: Db, spec: TableSpec, meshId: string): { columns: string[]; rows: unknown[][] } {
    const objs = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.scopeSql ?? `${spec.meshColumn} = ?`} ORDER BY ${spec.orderBy}`).all(meshId) as Array<Record<string, unknown>>;
    const columns = objs.length ? Object.keys(objs[0]!).filter(c => c !== HISTORY_ROW_ID) : tableColumns(db, spec.table);
    return { columns, rows: objs.map(o => columns.map(c => o[c] ?? null)) };
}

export function tableColumns(db: Db, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name).filter(c => c !== HISTORY_ROW_ID);
}

export interface ExportInput {
    launchPlan?: HandoffLaunchPlan;
    db: Db;
    meshId: string;
    handoffId: string;
    fromDaemonId: string;
    toDaemonId: string;
    hostEpoch: number;
    /** Raw host mesh config entry; sanitised here. */
    meshConfig: unknown;
    chunkBytes?: number;
    projectFiles?: ProjectApprovalFile[];
}

export interface ExportedSnapshot { manifest: HandoffManifest; chunks: Array<{ seq: number; sha256: string; data: string }> }

/** Manifest digest = sha256 over the header fields and the ordered chunk hashes. */
export function manifestDigest(m: Omit<HandoffManifest, 'digest'>): string {
    return sha256Hex(JSON.stringify([m.protocol, m.handoffId, m.meshId, m.fromDaemonId, m.toDaemonId, m.hostEpoch, m.nextEpoch,
        Object.entries(m.tables).map(([t, v]) => [t, v.rows, v.columns]), m.configDigest, m.chunks.map(c => c.sha256), ...(m.launchPlan ? [m.launchPlan] : [])]));
}

export function exportSnapshot(input: ExportInput): ExportedSnapshot {
    // One SQLite read transaction cuts every table at the same watermark.
    if (!input.db.transaction) throw new Error('snapshot requires a transactional store');
    return input.db.transaction(() => exportSnapshotInTransaction(input))();
}

function exportSnapshotInTransaction(input: ExportInput): ExportedSnapshot {
    const tables: SnapshotPayload['tables'] = {};
    for (const spec of HOST_SNAPSHOT_TABLES) tables[spec.table] = readTable(input.db, spec, input.meshId);
    const config = input.meshConfig === null || input.meshConfig === undefined ? null : sanitizeConfigForSnapshot(input.meshConfig).value as Record<string, unknown>;
    const payload: SnapshotPayload = { version: 1, tables, config, files: input.projectFiles ?? [] };
    const text = JSON.stringify(payload);
    const size = input.chunkBytes ?? HOST_HANDOFF_CHUNK_BYTES;
    // Cut on string length (JSON of mostly-ASCII ids; a chunk may exceed `size` bytes only by multibyte text).
    const chunks: Array<{ seq: number; sha256: string; data: string }> = [];
    for (let at = 0, seq = 0; seq === 0 || at < text.length; seq++) {
        // Never cut inside a surrogate pair: each half alone would not survive UTF-8 staging or encoding.
        let end = Math.min(at + size, text.length);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && end - at > 1 && last >= 0xD800 && last <= 0xDBFF) end--;
        const data = text.slice(at, end);
        chunks.push({ seq, sha256: sha256Hex(data), data });
        at = end;
    }
    const manifestChunks: ManifestChunk[] = chunks.map(c => ({ seq: c.seq, sha256: c.sha256, bytes: Buffer.byteLength(c.data) }));
    const header: Omit<HandoffManifest, 'digest'> = {
        ...(input.launchPlan ? { launchPlan: input.launchPlan } : {}),
        protocol: HOST_HANDOFF_PROTOCOL, handoffId: input.handoffId, meshId: input.meshId,
        fromDaemonId: input.fromDaemonId, toDaemonId: input.toDaemonId, hostEpoch: input.hostEpoch, nextEpoch: input.hostEpoch + 1,
        tables: Object.fromEntries(Object.entries(tables).map(([t, v]) => [t, { rows: v.rows.length, columns: v.columns }])),
        configDigest: sha256Hex(JSON.stringify(config)), chunks: manifestChunks,
    };
    return { manifest: { ...header, digest: manifestDigest(header) }, chunks };
}

/** Total snapshot size (for the disk-space preflight). */
export function snapshotBytes(s: ExportedSnapshot): number {
    return s.manifest.chunks.reduce((n, c) => n + c.bytes, 0);
}

/** Row counts per table, for the ACK. */
export function rowCountsOf(manifest: HandoffManifest): Record<string, number> {
    return Object.fromEntries(Object.entries(manifest.tables).map(([t, v]) => [t, v.rows]));
}
