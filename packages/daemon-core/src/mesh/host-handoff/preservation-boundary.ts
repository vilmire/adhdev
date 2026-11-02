/** Production preservation boundary. A handoff may leave preflight only when
 * project memory, pending notices, and approval bytes are readable together.
 * Failure stays `state_preservation_unverified`. This never returns success
 * merely because the experimental flag is on. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAssistantProject } from '../../assistant/assistant-projects.js';
import { exportProjectApprovalFiles } from './project-files.js';
import { exportSnapshot, HOST_SNAPSHOT_TABLES, sha256Hex, type SnapshotPayload } from './snapshot-export.js';
import { localTableColumns, verifyStagedSnapshot } from './snapshot-import.js';
import type { PreflightCheck } from './types.js';

type Sql = { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
type BoundaryDb = {
    prepare(sql: string): Sql;
    exec(sql: string): unknown;
    transaction<T>(fn: () => T): () => T;
};

const fail = (detail: string): PreflightCheck => ({ id: 'state_preservation', ok: false, code: 'state_preservation_unverified', detail });

function inventory(configDir: string, meshId: string): { ok: true; mesh: Record<string, unknown> } | { ok: false; detail: string } {
    const path = join(configDir, 'meshes.json');
    if (!existsSync(path)) return { ok: false, detail: 'project inventory unavailable' };
    let parsed: { meshes?: unknown };
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as { meshes?: unknown }; }
    catch { return { ok: false, detail: 'project inventory unreadable' }; }
    if (!Array.isArray(parsed.meshes)) return { ok: false, detail: 'project inventory invalid' };
    const mesh = parsed.meshes.find(m => !!m && typeof m === 'object' && (m as { id?: string }).id === meshId) as Record<string, unknown> | undefined;
    if (!mesh) return { ok: false, detail: 'project is not in the local inventory' };
    const host = mesh.meshHost as { handedOffTo?: unknown; handoffFence?: unknown; hostEpoch?: unknown } | undefined;
    if (host?.handedOffTo) return { ok: false, detail: 'project authority already moved' };
    if (host?.handoffFence) return { ok: false, detail: 'project write fence is already held' };
    if (host?.hostEpoch !== undefined && !Number.isInteger(host.hostEpoch)) return { ok: false, detail: 'project epoch is not an exact integer' };
    return { ok: true, mesh };
}

function consumedAmbiguity(configDir: string): string | null {
    for (const area of ['staged', 'staged-control'] as const) {
        const dir = join(configDir, 'assistant', area);
        if (!existsSync(dir)) continue;
        let names: string[];
        try { names = readdirSync(dir); } catch { return 'approval directory is unreadable'; }
        for (const name of names) {
            if (!name.endsWith('.json.consumed')) continue;
            const live = name.slice(0, -'.consumed'.length);
            if (!/^[A-Za-z0-9_-]+\.json$/.test(live)) return 'approval consent receipt name is not exact';
            const receipt = join(dir, name);
            const stat = lstatSync(receipt);
            if (!stat.isFile() || stat.isSymbolicLink()) return 'approval consent receipt is not a local file';
            if (existsSync(join(dir, live))) return 'approval has both a live proposal and a consumed receipt';
        }
    }
    return null;
}

/** Read one durable watermark. Any missing or inconsistent required state refuses. */
export function assessPreservationBoundary(db: BoundaryDb, configDir: string, meshId: string): PreflightCheck {
    try {
        if (!meshId) return fail('project identity is missing');
        const found = inventory(configDir, meshId);
        if (!found.ok) return fail(found.detail);
        for (const spec of HOST_SNAPSHOT_TABLES) {
            if (!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(spec.table)) {
                return fail(`required table ${spec.table} is missing`);
            }
        }
        if (!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'assistant_memory_fts'").get()) {
            return fail('project memory search index is missing');
        }
        const memories = db.prepare("SELECT e.seq AS seq, e.id AS id, e.text AS text, f.text AS indexed FROM assistant_memory_entry e LEFT JOIN assistant_memory_fts f ON f.rowid = e.seq WHERE e.scope = 'project' AND e.project_ref = ?").all(meshId) as Array<{ seq: number; id: string; text: string; indexed: string | null }>;
        for (const row of memories) {
            if (typeof row.id !== 'string' || !row.id || typeof row.text !== 'string') return fail('project memory row has no stable id');
            if (row.indexed !== row.text) return fail('project memory search index does not match the stored entry');
        }
        if (db.prepare("SELECT 1 AS open FROM turn_attempts WHERE mesh_id = ? AND terminal_outcome IS NULL LIMIT 1").get(meshId)) {
            return fail('a project turn is still open');
        }
        const pending = db.prepare("SELECT event_id, attempt_id, payload_json FROM turn_events WHERE mesh_id = ? AND publish_state = 'pending'").all(meshId) as Array<{ event_id: string; attempt_id: string; payload_json: string }>;
        const seen = new Set<string>();
        for (const event of pending) {
            if (typeof event.event_id !== 'string' || !event.event_id || seen.has(event.event_id)) return fail('pending notice has no stable id');
            seen.add(event.event_id);
            const attempt = db.prepare('SELECT terminal_outcome FROM turn_attempts WHERE attempt_id = ? AND mesh_id = ?').get(event.attempt_id, meshId) as { terminal_outcome: string | null } | undefined;
            if (!attempt || attempt.terminal_outcome == null) return fail('pending notice belongs to an in-flight turn');
        }
        const ambiguous = consumedAmbiguity(configDir);
        if (ambiguous) return fail(ambiguous);
        const meshes = [found.mesh] as Array<{ id: string }>;
        const files = exportProjectApprovalFiles(configDir, meshId, ref => {
            const resolved = resolveAssistantProject(ref, meshes);
            return resolved.ok ? resolved.mesh.id : null;
        });
        const epoch = (found.mesh.meshHost as { hostEpoch?: number } | undefined)?.hostEpoch ?? 0;
        const snap = exportSnapshot({
            db, meshId, handoffId: `preservation:${meshId}`, fromDaemonId: 'preservation-probe', toDaemonId: 'preservation-probe',
            hostEpoch: epoch, meshConfig: found.mesh, projectFiles: files,
        });
        const verified = verifyStagedSnapshot(snap.manifest, snap.chunks, localTableColumns(db as never));
        if (!verified.ok) return fail(verified.detail);
        return { id: 'state_preservation', ok: true, detail: 'project memory, pending notices, and approval bytes match one durable watermark' };
    } catch (e) {
        return fail((e as Error)?.message || 'preservation boundary could not be verified');
    }
}

/** One receipt per exposed notice id. Same handoff epoch and bytes may retry.
 * A different payload or epoch is a second delivery and is refused. */
export function adoptPendingNoticeReceipts(db: BoundaryDb, meshId: string, payload: SnapshotPayload, provenance?: { handoffId?: string; epoch?: number }): void {
    const table = payload.tables.turn_events;
    if (!table) throw new Error('pending notice table is missing from the snapshot');
    const col = (name: string) => table.columns.indexOf(name);
    const idAt = col('event_id'), meshAt = col('mesh_id'), stateAt = col('publish_state'), bodyAt = col('payload_json');
    if (idAt < 0 || meshAt < 0 || stateAt < 0) throw new Error('pending notice identity columns are missing');
    const pending = table.rows.filter(row => row[meshAt] === meshId && row[stateAt] === 'pending');
    if (!pending.length) return;
    if (!provenance?.handoffId || !Number.isInteger(provenance.epoch)) throw new Error('notice adoption has no exact handoff receipt');
    db.exec(`CREATE TABLE IF NOT EXISTS mesh_host_notice_receipts (
        mesh_id TEXT NOT NULL, event_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
        handoff_id TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (mesh_id, event_id))`);
    const select = db.prepare('SELECT payload_sha256, handoff_id, epoch FROM mesh_host_notice_receipts WHERE mesh_id = ? AND event_id = ?');
    const insert = db.prepare('INSERT INTO mesh_host_notice_receipts (mesh_id, event_id, payload_sha256, handoff_id, epoch) VALUES (?, ?, ?, ?, ?)');
    for (const row of pending) {
        const eventId = row[idAt];
        if (typeof eventId !== 'string' || !eventId) throw new Error('pending notice has no stable id');
        const hash = sha256Hex(String(bodyAt < 0 ? '' : row[bodyAt] ?? ''));
        const existing = select.get(meshId, eventId) as { payload_sha256: string; handoff_id: string; epoch: number } | undefined;
        if (existing) {
            if (existing.payload_sha256 !== hash || existing.handoff_id !== provenance.handoffId || existing.epoch !== provenance.epoch) {
                throw new Error(existing.epoch !== provenance.epoch ? 'stale epoch notice replay' : 'notice receipt conflicts with retained delivery');
            }
            continue;
        }
        insert.run(meshId, eventId, hash, provenance.handoffId, provenance.epoch);
    }
}
