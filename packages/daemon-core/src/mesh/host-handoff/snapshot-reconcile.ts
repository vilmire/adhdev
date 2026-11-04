/**
 * A member that has worked for a project already holds its own rows for it, often
 * under a different primary key than the host's (legacy attempt ids, per-daemon event
 * and artifact ids). A primary-key match cannot see those: they collide on a secondary
 * UNIQUE index instead. Each index has one explicit rule here. There is deliberately no
 * `INSERT OR REPLACE` or `OR IGNORE`, which would drop a row without saying so.
 *
 * Who wins (design "A worker's own observations"):
 * - Host-owned project state goes to the source: attempts, mission items, release membership.
 * - A worker's observations stay local: events and artifacts, except a notice the source
 *   still owes and an artifact whose origin is the source.
 * - Another project's row is never touched. That collision refuses, naming table and key.
 *
 * Every local row removed or changed here is written to the `reconciliation` archive side.
 * The incoming versions are already in `source-snapshot`.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { SnapshotPayload } from './snapshot-export.js';

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } };
type Row = Record<string, unknown>;

/** Every secondary UNIQUE index of a snapshot table has a rule below. A test compares this with the live schema. */
export const SECONDARY_UNIQUE_RULES: Readonly<Record<string, readonly string[]>> = {
    turn_attempts: ['ux_turn_attempts_task', 'ux_turn_attempts_open_session'],
    turn_events: ['sqlite_autoindex_turn_events_2'],
    session_artifacts: ['idx_session_artifacts_unique_path'],
    mesh_mission_items: ['idx_mesh_mission_items_dedupe'],
    mesh_release_missions: ['idx_mesh_release_missions_one_active'],
    assistant_memory_entry: ['sqlite_autoindex_assistant_memory_entry_1'],
};

/** Key space of a row_map entry whose old key was the target's own, never a source key. */
export const TARGET_LOCAL_KEY_SPACE = 'target-local';

const ATTEMPT_KEYED_TABLES = ['assistant_relays', 'assistant_attempt_bodies', 'assistant_relay_coverage'] as const;

export function snapshotConflict(table: string, key: unknown, why: string): Error {
    return new Error(`snapshot conflicts with retained local state: ${table} key ${JSON.stringify(key)} (${why})`);
}

export interface Resolution { table: string; index: string; key: unknown[]; winner: 'source' | 'target'; local: Row; incomingKey?: unknown }

export interface ReconcilerContext { meshId: string; sourceDaemonId: string; digest: string; payload: SnapshotPayload; now?: () => number }

export class SnapshotReconciler {
    readonly resolutions: Resolution[] = [];
    private readonly incoming = new Map<string, Set<unknown>>();
    constructor(private readonly db: Db, private readonly c: ReconcilerContext) {}

    /** Clear the way for one incoming row. `skip`: the local row stays and the incoming one is not applied. */
    resolve(table: string, columns: string[], row: unknown[]): 'apply' | 'skip' {
        const v = (name: string) => row[columns.indexOf(name)];
        switch (table) {
            case 'turn_attempts': return this.attempt(v);
            case 'turn_events': return this.event(v);
            case 'session_artifacts': return this.artifact(v);
            case 'mesh_mission_items': return this.missionItem(v);
            case 'mesh_release_missions': return this.releaseMember(v);
            default: return 'apply';
        }
    }

    private one(sql: string, ...args: unknown[]): Row | undefined { return this.db.prepare(sql).all(...args)[0] as Row | undefined; }
    private run(sql: string, ...args: unknown[]): void { this.db.prepare(sql).run(...args); }
    private now(): number { return this.c.now?.() ?? Date.now(); }

    private map(table: string, keySpace: string, from: unknown[], to: unknown[]): void {
        this.run('INSERT OR REPLACE INTO mesh_host_handoff_row_map (mesh_id,table_name,source_daemon_id,source_key,target_key,snapshot_digest) VALUES (?,?,?,?,?,?)',
            this.c.meshId, table, keySpace, JSON.stringify(from), JSON.stringify(to), this.c.digest);
    }

    private incomingHas(table: string, column: string, value: unknown): boolean {
        const id = `${table}.${column}`;
        let values = this.incoming.get(id);
        if (!values) {
            const t = this.c.payload.tables[table];
            const at = t?.columns.indexOf(column) ?? -1;
            values = new Set(t && at >= 0 ? t.rows.map(r => r[at]) : []);
            this.incoming.set(id, values);
        }
        return values.has(value);
    }

    // ── turn_attempts ────────────────────────────────────────────────────────

    private attempt(v: (c: string) => unknown): 'apply' {
        const id = v('attempt_id');
        if (v('task_id') !== null) {
            const local = this.one('SELECT * FROM turn_attempts WHERE mesh_id=? AND task_id=? AND attempt_no=? AND attempt_id!=?', this.c.meshId, v('task_id'), v('attempt_no'), id);
            if (local) this.absorbAttempt(local, id, v('terminal_outcome') !== null);
        }
        if (v('terminal_outcome') === null) {
            const open = this.one('SELECT * FROM turn_attempts WHERE session_id=? AND terminal_outcome IS NULL AND attempt_id!=?', v('session_id'), id);
            if (open) {
                if (open.mesh_id !== this.c.meshId) throw snapshotConflict('turn_attempts', [v('session_id')], `session is running attempt ${String(open.attempt_id)} of another project`);
                // The same session cannot run two turns, and the host's is the one the project knows.
                this.run("UPDATE turn_attempts SET terminal_outcome='cancelled', terminal_reason='host_handoff_superseded', terminal_source='host_handoff', terminal_at=?, updated_at=? WHERE attempt_id=?",
                    this.now(), this.now(), open.attempt_id);
                this.resolutions.push({ table: 'turn_attempts', index: 'ux_turn_attempts_open_session', key: [v('session_id')], winner: 'source', local: open, incomingKey: id });
            }
        }
        return 'apply';
    }

    /** The host's attempt replaces the member's row for the same turn. Everything the member observed moves onto it. */
    private absorbAttempt(local: Row, targetId: unknown, targetTerminal: boolean): void {
        const localId = local.attempt_id;
        for (const event of this.db.prepare('SELECT * FROM turn_events WHERE attempt_id=?').all(localId) as Row[]) {
            const held = event.generation !== null && this.one('SELECT 1 AS present FROM turn_events WHERE attempt_id=? AND generation=? AND kind=? AND dedupe_key=?', targetId, event.generation, event.kind, event.dedupe_key);
            if (held) {
                // The same fact is already recorded on the surviving attempt.
                this.run('DELETE FROM turn_events WHERE event_id=?', event.event_id);
                this.resolutions.push({ table: 'turn_events', index: 'sqlite_autoindex_turn_events_2', key: [targetId, event.generation, event.kind, event.dedupe_key], winner: 'source', local: event });
            } else this.run('UPDATE turn_events SET attempt_id=? WHERE event_id=?', targetId, event.event_id);
        }
        for (const hold of this.db.prepare('SELECT * FROM turn_holds WHERE attempt_id=?').all(localId) as Row[]) {
            // A hold id embeds its attempt id, and the ledger reads the attempt back out of it.
            const prefix = `${String(localId)}:`;
            const holdId = String(hold.hold_id);
            const nextId = holdId.startsWith(prefix) ? `${String(targetId)}:${holdId.slice(prefix.length)}` : holdId;
            if (nextId !== holdId && (this.incomingHas('turn_holds', 'hold_id', nextId) || this.one('SELECT 1 AS present FROM turn_holds WHERE hold_id=?', nextId))) {
                this.run('DELETE FROM turn_holds WHERE hold_id=?', holdId);
                this.resolutions.push({ table: 'turn_holds', index: 'primary', key: [nextId], winner: 'source', local: hold });
                continue;
            }
            // A settled attempt has nothing left to hold.
            const settle = targetTerminal && hold.status === 'active';
            this.run('UPDATE turn_holds SET hold_id=?, attempt_id=?, status=?, resolved_at=? WHERE hold_id=?',
                nextId, targetId, settle ? 'resolved' : hold.status, settle ? this.now() : hold.resolved_at, holdId);
        }
        for (const table of ATTEMPT_KEYED_TABLES) {
            const row = this.one(`SELECT * FROM ${table} WHERE attempt_id=?`, localId);
            if (!row) continue;
            if (this.incomingHas(table, 'attempt_id', targetId) || this.one(`SELECT 1 AS present FROM ${table} WHERE attempt_id=?`, targetId)) {
                this.run(`DELETE FROM ${table} WHERE attempt_id=?`, localId);
                this.resolutions.push({ table, index: 'primary', key: [targetId], winner: 'source', local: row });
            } else this.run(`UPDATE ${table} SET attempt_id=? WHERE attempt_id=?`, targetId, localId);
        }
        this.run('UPDATE mesh_handoff_note_text SET attempt_id=? WHERE mesh_id=? AND attempt_id=?', targetId, this.c.meshId, localId);
        // contract_* rows are not project history that travels. They keep the id they were
        // written with, and the row map says what it became.
        this.run('DELETE FROM turn_attempts WHERE attempt_id=?', localId);
        this.map('turn_attempts', TARGET_LOCAL_KEY_SPACE, [localId], [targetId]);
        this.resolutions.push({ table: 'turn_attempts', index: 'ux_turn_attempts_task', key: [this.c.meshId, local.task_id, local.attempt_no], winner: 'source', local, incomingKey: targetId });
    }

    // ── turn_events ──────────────────────────────────────────────────────────

    private event(v: (c: string) => unknown): 'apply' | 'skip' {
        // SQLite treats NULLs as distinct: a row without an attempt or generation cannot collide.
        if (v('attempt_id') === null || v('generation') === null) return 'apply';
        const local = this.one('SELECT * FROM turn_events WHERE attempt_id=? AND generation=? AND kind=? AND dedupe_key=? AND event_id!=?', v('attempt_id'), v('generation'), v('kind'), v('dedupe_key'), v('event_id'));
        if (!local) return 'apply';
        const key = [v('attempt_id'), v('generation'), v('kind'), v('dedupe_key')];
        if (v('publish_state') === 'pending') {
            // The source still owes this notice. Its row carries the delivery state.
            this.run('DELETE FROM turn_events WHERE event_id=?', local.event_id);
            this.map('turn_events', TARGET_LOCAL_KEY_SPACE, [local.event_id], [v('event_id')]);
            this.resolutions.push({ table: 'turn_events', index: 'sqlite_autoindex_turn_events_2', key, winner: 'source', local, incomingKey: v('event_id') });
            return 'apply';
        }
        this.map('turn_events', this.c.sourceDaemonId, [v('event_id')], [local.event_id]);
        this.resolutions.push({ table: 'turn_events', index: 'sqlite_autoindex_turn_events_2', key, winner: 'target', local, incomingKey: v('event_id') });
        return 'skip';
    }

    // ── session_artifacts ────────────────────────────────────────────────────

    private artifact(v: (c: string) => unknown): 'apply' | 'skip' {
        const local = this.one('SELECT * FROM session_artifacts WHERE session_id=? AND rel_path=? AND artifact_id!=?', v('session_id'), v('rel_path'), v('artifact_id'));
        if (!local) return 'apply';
        const key = [v('session_id'), v('rel_path')];
        // A row with no project yet (written before attribution) is this session's own file, not another project's.
        if (local.mesh_id !== null && local.mesh_id !== this.c.meshId) throw snapshotConflict('session_artifacts', key, `path belongs to another project's artifact ${String(local.artifact_id)}`);
        const origin = String(local.origin_daemon_id ?? '');
        if (daemonIdsEquivalent(origin, this.c.sourceDaemonId)) {
            this.run('DELETE FROM session_artifacts WHERE artifact_id=?', local.artifact_id);
            this.map('session_artifacts', TARGET_LOCAL_KEY_SPACE, [local.artifact_id], [v('artifact_id')]);
            this.resolutions.push({ table: 'session_artifacts', index: 'idx_session_artifacts_unique_path', key, winner: 'source', local, incomingKey: v('artifact_id') });
            return 'apply';
        }
        if (local.mesh_id === null) this.run('UPDATE session_artifacts SET mesh_id=?, mission_id=COALESCE(mission_id,?) WHERE artifact_id=?', this.c.meshId, v('mission_id'), local.artifact_id);
        this.map('session_artifacts', this.c.sourceDaemonId, [v('artifact_id')], [local.artifact_id]);
        this.resolutions.push({ table: 'session_artifacts', index: 'idx_session_artifacts_unique_path', key, winner: 'target', local, incomingKey: v('artifact_id') });
        return 'skip';
    }

    // ── mesh_mission_items ───────────────────────────────────────────────────

    private missionItem(v: (c: string) => unknown): 'apply' {
        if (v('dedupe_key') === null) return 'apply';
        const local = this.one('SELECT * FROM mesh_mission_items WHERE mission_id=? AND dedupe_key=? AND id!=?', v('mission_id'), v('dedupe_key'), v('id'));
        if (!local) return 'apply';
        const key = [v('mission_id'), v('dedupe_key')];
        if (local.mesh_id !== this.c.meshId) throw snapshotConflict('mesh_mission_items', key, `item ${String(local.id)} belongs to another project`);
        // Rows pointing at the replaced item follow it, unless the survivor already has that row.
        this.run('UPDATE OR IGNORE mesh_mission_ref_evals SET item_id=? WHERE item_id=?', v('id'), local.id);
        this.run('DELETE FROM mesh_mission_ref_evals WHERE item_id=?', local.id);
        this.run('UPDATE OR IGNORE assistant_decision_answer_log SET item_id=? WHERE mesh_id=? AND item_id=?', v('id'), this.c.meshId, local.id);
        this.run('DELETE FROM assistant_decision_answer_log WHERE mesh_id=? AND item_id=?', this.c.meshId, local.id);
        this.run('DELETE FROM mesh_mission_items WHERE id=?', local.id);
        this.map('mesh_mission_items', TARGET_LOCAL_KEY_SPACE, [local.id], [v('id')]);
        this.resolutions.push({ table: 'mesh_mission_items', index: 'idx_mesh_mission_items_dedupe', key, winner: 'source', local, incomingKey: v('id') });
        return 'apply';
    }

    // ── mesh_release_missions ────────────────────────────────────────────────

    private releaseMember(v: (c: string) => unknown): 'apply' {
        if (v('state') !== 'member') return 'apply';
        const local = this.one("SELECT * FROM mesh_release_missions WHERE mission_id=? AND state='member' AND NOT (release_id=? AND added_at=?)", v('mission_id'), v('release_id'), v('added_at'));
        if (!local) return 'apply';
        if (local.mesh_id !== this.c.meshId) throw snapshotConflict('mesh_release_missions', [v('mission_id')], `mission is active in release ${String(local.release_id)} of another project`);
        // The row stays as history: this mission is simply no longer in that release.
        this.run("UPDATE mesh_release_missions SET state='removed', ended_at=COALESCE(ended_at,?) WHERE release_id=? AND mission_id=? AND added_at=?",
            new Date(this.now()).toISOString(), local.release_id, local.mission_id, local.added_at);
        this.resolutions.push({ table: 'mesh_release_missions', index: 'idx_mesh_release_missions_one_active', key: [v('mission_id')], winner: 'source', local, incomingKey: v('release_id') });
        return 'apply';
    }

    // ── assistant_memory_entry ───────────────────────────────────────────────

    /** `id` is the public identity. `seq` is this daemon's storage rowid and may belong to any other entry here. */
    applyMemoryRows(columns: string[], rows: unknown[][]): void {
        const idAt = columns.indexOf('id'), seqAt = columns.indexOf('seq');
        const rest = columns.filter(c => c !== 'seq');
        const restAt = rest.map(c => columns.indexOf(c));
        for (const row of rows) {
            const local = this.one('SELECT * FROM assistant_memory_entry WHERE id=?', row[idAt]);
            if (local) {
                if (local.scope !== 'project' || local.project_ref !== this.c.meshId) throw snapshotConflict('assistant_memory_entry', [row[idAt]], 'id is held by a global entry or another project');
                if (restAt.every((at, i) => local[rest[i]!] === row[at])) continue;
                this.run(`UPDATE assistant_memory_entry SET ${rest.map(c => `${c}=?`).join(',')} WHERE id=?`, ...restAt.map(at => row[at]), row[idAt]);
                this.resolutions.push({ table: 'assistant_memory_entry', index: 'sqlite_autoindex_assistant_memory_entry_1', key: [row[idAt]], winner: 'source', local, incomingKey: row[seqAt] });
                continue;
            }
            const keepSeq = !this.one('SELECT 1 AS present FROM assistant_memory_entry WHERE seq=?', row[seqAt]);
            const names = keepSeq ? columns : rest;
            this.run(`INSERT INTO assistant_memory_entry (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, ...names.map(c => row[columns.indexOf(c)]));
        }
    }

    /** One audit record per handoff. A retry finds nothing new, and appends to what it finds. */
    archive(handoffId: string): void {
        if (!this.resolutions.length) return;
        const prior = this.one("SELECT payload_json FROM mesh_host_handoff_archive WHERE handoff_id=? AND side='reconciliation'", handoffId) as { payload_json?: string } | undefined;
        const merged = [...(prior?.payload_json ? JSON.parse(prior.payload_json) as Resolution[] : []), ...this.resolutions];
        this.run("INSERT INTO mesh_host_handoff_archive (handoff_id,side,mesh_id,snapshot_digest,payload_json) VALUES (?,'reconciliation',?,?,?) ON CONFLICT(handoff_id,side) DO UPDATE SET payload_json=excluded.payload_json",
            handoffId, this.c.meshId, this.c.digest, JSON.stringify(merged));
    }
}
