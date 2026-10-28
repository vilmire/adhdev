/**
 * Storage for structured mission records (design 2026-10-28 §4): items
 * (`mesh_mission_items`), the append-only change history (`mesh_mission_events`)
 * and the structured columns on `mesh_missions` (summary / outcome / version /
 * carry-over flag). Pure SQL over the daemon's mesh-runtime.db handle — no
 * policy: normalization lives in @adhdev/mesh-shared, orchestration (close →
 * carry-over, dedupe, evidence) in mesh-mission-structured.ts.
 *
 * Every mutating method here is synchronous better-sqlite3, so the callers
 * can wrap several calls in `MeshRuntimeStore.transaction`.
 */
import { randomBytes } from 'crypto';
import {
    boundEventPayload,
    type MissionDecision,
    type MissionItemKind,
    type MissionItemRef,
    type MissionItemState,
} from '@adhdev/mesh-shared';

import type { Database as Db } from 'better-sqlite3';

/** A `mesh_missions` row as the store hands it out (structured columns included). */
export interface MeshMissionRow {
    id: string;
    meshId: string;
    title: string;
    goal: string;
    status: string;
    closeCandidateEmittedAt?: string;
    briefJson?: string;
    createdAt: string;
    updatedAt: string;
    summary?: string;
    outcome?: string;
    outcomeReason?: string;
    /** Increments on every mission write; 1 for rows that predate the structured columns. */
    version?: number;
    isCarryOver?: boolean;
}

export function missionRowFromSql(row: Record<string, any>): MeshMissionRow {
    return {
        id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status,
        closeCandidateEmittedAt: row.close_candidate_emitted_at ?? undefined,
        briefJson: row.brief_json ?? undefined,
        createdAt: row.created_at, updatedAt: row.updated_at,
        ...(row.summary ? { summary: row.summary } : {}),
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.outcome_reason ? { outcomeReason: row.outcome_reason } : {}),
        ...(typeof row.version === 'number' ? { version: row.version } : {}),
        ...(row.is_carry_over === 1 ? { isCarryOver: true } : {}),
    };
}

export type MissionEventType =
    | 'created' | 'status_changed' | 'summary_changed' | 'goal_changed' | 'item_added'
    | 'item_state_changed' | 'decision_answered' | 'decision_answer_undone' | 'outcome_set' | 'items_moved'
    /** retention: one summary row replacing a long-closed mission's history */
    | 'collapsed';

export interface MissionItemRecord {
    id: string;
    missionId: string;
    meshId: string;
    kind: MissionItemKind;
    state: MissionItemState;
    text: string;
    machine?: string;
    refs: MissionItemRef[];
    decision?: MissionDecision;
    dedupeKey?: string;
    createdBy?: string;
    movedTo?: string;
    createdAt: string;
    updatedAt: string;
}

export interface MissionEventRecord {
    seq: number;
    missionId: string;
    meshId: string;
    type: MissionEventType;
    actor?: string;
    payload: Record<string, unknown>;
    at: string;
}

export interface MissionStructuredFields {
    summary?: string;
    outcome?: string;
    outcomeReason?: string;
    version: number;
    isCarryOver: boolean;
}

export type MissionOpenItemCounts = { remaining: number; live_check: number; decision: number; evidence: number };

/** Retention: closed missions older than this collapse to one summary event (design §4.3). */
export const MISSION_EVENT_COLLAPSE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
/** Retention: hard cap on event rows kept per mesh (oldest beyond it are dropped). */
export const MISSION_EVENTS_PER_MESH_CAP = 5000;

function parseJson<T>(text: unknown, fallback: T): T {
    if (typeof text !== 'string' || !text) return fallback;
    try { return JSON.parse(text) as T; } catch { return fallback; }
}

function rowToItem(row: Record<string, any>): MissionItemRecord {
    return {
        id: row.id,
        missionId: row.mission_id,
        meshId: row.mesh_id,
        kind: row.kind,
        state: row.state,
        text: row.text ?? '',
        ...(row.machine ? { machine: row.machine } : {}),
        refs: parseJson<MissionItemRef[]>(row.refs_json, []),
        ...(row.decision_json ? { decision: parseJson<MissionDecision | undefined>(row.decision_json, undefined) } : {}),
        ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
        ...(row.created_by ? { createdBy: row.created_by } : {}),
        ...(row.moved_to ? { movedTo: row.moved_to } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function newMissionItemId(): string {
    return `mi_${randomBytes(6).toString('hex')}`;
}

export class MissionItemStore {
    constructor(private readonly db: Db) {}

    // ── structured mission columns ──────────────────────────────────────────

    getStructured(meshId: string, missionId: string): MissionStructuredFields | null {
        const row = this.db.prepare('SELECT summary, outcome, outcome_reason, version, is_carry_over FROM mesh_missions WHERE mesh_id = ? AND id = ?')
            .get(meshId, missionId) as Record<string, any> | undefined;
        if (!row) return null;
        return {
            ...(row.summary ? { summary: row.summary } : {}),
            ...(row.outcome ? { outcome: row.outcome } : {}),
            ...(row.outcome_reason ? { outcomeReason: row.outcome_reason } : {}),
            version: typeof row.version === 'number' ? row.version : 1,
            isCarryOver: row.is_carry_over === 1,
        };
    }

    /** Set summary/outcome/outcome_reason. `null` clears; `undefined` leaves untouched. Does NOT bump the version (see {@link bumpVersion}). */
    setStructured(meshId: string, missionId: string, patch: { summary?: string | null; outcome?: string | null; outcomeReason?: string | null }): void {
        const sets: string[] = [];
        const args: unknown[] = [];
        if (patch.summary !== undefined) { sets.push('summary = ?'); args.push(patch.summary); }
        if (patch.outcome !== undefined) { sets.push('outcome = ?'); args.push(patch.outcome); }
        if (patch.outcomeReason !== undefined) { sets.push('outcome_reason = ?'); args.push(patch.outcomeReason); }
        if (!sets.length) return;
        this.db.prepare(`UPDATE mesh_missions SET ${sets.join(', ')} WHERE mesh_id = ? AND id = ?`).run(...args, meshId, missionId);
    }

    /** Every mission write bumps the version (last-write-wins, never a conflict) and touches updated_at. */
    bumpVersion(meshId: string, missionId: string, nowIso: string = new Date().toISOString()): number {
        this.db.prepare('UPDATE mesh_missions SET version = version + 1, updated_at = ? WHERE mesh_id = ? AND id = ?').run(nowIso, meshId, missionId);
        return this.getStructured(meshId, missionId)?.version ?? 1;
    }

    findCarryOverMissionId(meshId: string): string | undefined {
        const row = this.db.prepare('SELECT id FROM mesh_missions WHERE mesh_id = ? AND is_carry_over = 1 ORDER BY created_at ASC LIMIT 1')
            .get(meshId) as { id: string } | undefined;
        return row?.id;
    }

    flagCarryOver(meshId: string, missionId: string): void {
        this.db.prepare('UPDATE mesh_missions SET is_carry_over = 1 WHERE mesh_id = ? AND id = ?').run(meshId, missionId);
    }

    // ── items ───────────────────────────────────────────────────────────────

    insertItem(item: Omit<MissionItemRecord, 'createdAt' | 'updatedAt'> & { createdAt?: string }): MissionItemRecord {
        const now = new Date().toISOString();
        this.db.prepare(
            `INSERT INTO mesh_mission_items (id, mission_id, mesh_id, kind, state, text, machine, refs_json, decision_json, dedupe_key, created_by, moved_to, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            item.id, item.missionId, item.meshId, item.kind, item.state, item.text,
            item.machine ?? null,
            item.refs.length ? JSON.stringify(item.refs) : null,
            item.decision ? JSON.stringify(item.decision) : null,
            item.dedupeKey ?? null, item.createdBy ?? null, item.movedTo ?? null,
            item.createdAt ?? now, now,
        );
        return this.getItem(item.meshId, item.id)!;
    }

    getItem(meshId: string, itemId: string): MissionItemRecord | null {
        const row = this.db.prepare('SELECT * FROM mesh_mission_items WHERE mesh_id = ? AND id = ?').get(meshId, itemId) as Record<string, any> | undefined;
        return row ? rowToItem(row) : null;
    }

    findByDedupeKey(missionId: string, dedupeKey: string): MissionItemRecord | null {
        const row = this.db.prepare('SELECT * FROM mesh_mission_items WHERE mission_id = ? AND dedupe_key = ?').get(missionId, dedupeKey) as Record<string, any> | undefined;
        return row ? rowToItem(row) : null;
    }

    /** Mesh-wide lookup of a decision by dedupe key (a re-ask must find the earlier answer wherever it lives). */
    findDecisionByKey(meshId: string, dedupeKey: string, states: readonly MissionItemState[]): MissionItemRecord | null {
        const placeholders = states.map(() => '?').join(', ');
        const row = this.db.prepare(
            `SELECT * FROM mesh_mission_items WHERE mesh_id = ? AND kind = 'decision' AND dedupe_key = ? AND state IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`,
        ).get(meshId, dedupeKey, ...states) as Record<string, any> | undefined;
        return row ? rowToItem(row) : null;
    }

    listItems(meshId: string, missionId: string, opts?: { kinds?: readonly MissionItemKind[]; states?: readonly MissionItemState[] }): MissionItemRecord[] {
        const where = ['mesh_id = ?', 'mission_id = ?'];
        const args: unknown[] = [meshId, missionId];
        if (opts?.kinds?.length) { where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`); args.push(...opts.kinds); }
        if (opts?.states?.length) { where.push(`state IN (${opts.states.map(() => '?').join(', ')})`); args.push(...opts.states); }
        const rows = this.db.prepare(`SELECT * FROM mesh_mission_items WHERE ${where.join(' AND ')} ORDER BY created_at ASC, rowid ASC`).all(...args) as Array<Record<string, any>>;
        return rows.map(rowToItem);
    }

    /** All open items of the mesh (any mission) of one kind — the future decision-inbox projection reads this. */
    listOpenByKind(meshId: string, kind: MissionItemKind): MissionItemRecord[] {
        const rows = this.db.prepare(
            "SELECT * FROM mesh_mission_items WHERE mesh_id = ? AND kind = ? AND state = 'open' ORDER BY created_at ASC, rowid ASC",
        ).all(meshId, kind) as Array<Record<string, any>>;
        return rows.map(rowToItem);
    }

    updateItem(meshId: string, itemId: string, patch: {
        missionId?: string;
        state?: MissionItemState;
        text?: string;
        machine?: string | null;
        refs?: MissionItemRef[];
        decision?: MissionDecision;
        dedupeKey?: string | null;
        movedTo?: string | null;
    }): void {
        const sets: string[] = ['updated_at = ?'];
        const args: unknown[] = [new Date().toISOString()];
        if (patch.missionId !== undefined) { sets.push('mission_id = ?'); args.push(patch.missionId); }
        if (patch.state !== undefined) { sets.push('state = ?'); args.push(patch.state); }
        if (patch.text !== undefined) { sets.push('text = ?'); args.push(patch.text); }
        if (patch.machine !== undefined) { sets.push('machine = ?'); args.push(patch.machine); }
        if (patch.refs !== undefined) { sets.push('refs_json = ?'); args.push(patch.refs.length ? JSON.stringify(patch.refs) : null); }
        if (patch.decision !== undefined) { sets.push('decision_json = ?'); args.push(JSON.stringify(patch.decision)); }
        if (patch.dedupeKey !== undefined) { sets.push('dedupe_key = ?'); args.push(patch.dedupeKey); }
        if (patch.movedTo !== undefined) { sets.push('moved_to = ?'); args.push(patch.movedTo); }
        this.db.prepare(`UPDATE mesh_mission_items SET ${sets.join(', ')} WHERE mesh_id = ? AND id = ?`).run(...args, meshId, itemId);
    }

    deleteItem(meshId: string, itemId: string): void {
        this.db.prepare('DELETE FROM mesh_mission_items WHERE mesh_id = ? AND id = ?').run(meshId, itemId);
    }

    openCounts(meshId: string, missionId: string): MissionOpenItemCounts {
        const counts: MissionOpenItemCounts = { remaining: 0, live_check: 0, decision: 0, evidence: 0 };
        const rows = this.db.prepare(
            "SELECT kind, COUNT(*) AS n FROM mesh_mission_items WHERE mesh_id = ? AND mission_id = ? AND state = 'open' GROUP BY kind",
        ).all(meshId, missionId) as Array<{ kind: MissionItemKind; n: number }>;
        for (const r of rows) if (r.kind in counts) counts[r.kind as keyof MissionOpenItemCounts] = r.n;
        return counts;
    }

    /** One grouped query for many missions (mission list views). Missions with no open items are absent. */
    openCountsByMission(meshId: string): Map<string, MissionOpenItemCounts> {
        const out = new Map<string, MissionOpenItemCounts>();
        const rows = this.db.prepare(
            "SELECT mission_id, kind, COUNT(*) AS n FROM mesh_mission_items WHERE mesh_id = ? AND state = 'open' GROUP BY mission_id, kind",
        ).all(meshId) as Array<{ mission_id: string; kind: MissionItemKind; n: number }>;
        for (const r of rows) {
            const c = out.get(r.mission_id) ?? { remaining: 0, live_check: 0, decision: 0, evidence: 0 };
            if (r.kind in c) c[r.kind as keyof MissionOpenItemCounts] = r.n;
            out.set(r.mission_id, c);
        }
        return out;
    }

    // ── events ──────────────────────────────────────────────────────────────

    appendEvent(meshId: string, missionId: string, type: MissionEventType, actor: string | undefined, payload: Record<string, unknown>): number {
        const res = this.db.prepare(
            'INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(missionId, meshId, type, actor ?? null, boundEventPayload(payload), new Date().toISOString());
        return Number(res.lastInsertRowid);
    }

    listEvents(meshId: string, missionId: string, opts?: { limit?: number; types?: readonly MissionEventType[] }): MissionEventRecord[] {
        const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
        const where = ['mesh_id = ?', 'mission_id = ?'];
        const args: unknown[] = [meshId, missionId];
        if (opts?.types?.length) { where.push(`type IN (${opts.types.map(() => '?').join(', ')})`); args.push(...opts.types); }
        const rows = this.db.prepare(
            `SELECT * FROM mesh_mission_events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
        ).all(...args, limit) as Array<Record<string, any>>;
        return rows.reverse().map(r => ({
            seq: r.seq, missionId: r.mission_id, meshId: r.mesh_id, type: r.type,
            ...(r.actor ? { actor: r.actor } : {}),
            payload: parseJson<Record<string, unknown>>(r.payload_json, {}),
            at: r.at,
        }));
    }

    // ── retention (design §4.3 / §13.1 "DB 크기") ───────────────────────────

    /**
     * (1) Missions closed (completed/abandoned) for over 180 days keep ONE summary
     * event instead of their history; (2) per mesh, event rows beyond the cap are
     * dropped oldest-first. Returns row counts only.
     */
    pruneEvents(nowMs: number = Date.now(), opts?: { collapseAfterMs?: number; perMeshCap?: number }): { collapsedMissions: number; deleted: number } {
        const collapseAfterMs = opts?.collapseAfterMs ?? MISSION_EVENT_COLLAPSE_AFTER_MS;
        const perMeshCap = opts?.perMeshCap ?? MISSION_EVENTS_PER_MESH_CAP;
        let deleted = 0;
        let collapsedMissions = 0;
        const cutoffIso = new Date(nowMs - collapseAfterMs).toISOString();
        const old = this.db.prepare(
            `SELECT m.id AS id, m.mesh_id AS mesh_id, m.status AS status, m.outcome AS outcome, m.updated_at AS updated_at,
                    (SELECT COUNT(*) FROM mesh_mission_events e WHERE e.mission_id = m.id) AS n,
                    (SELECT COUNT(*) FROM mesh_mission_events e WHERE e.mission_id = m.id AND e.type = 'collapsed') AS c
               FROM mesh_missions m WHERE m.status IN ('completed', 'abandoned') AND m.updated_at < ?`,
        ).all(cutoffIso) as Array<{ id: string; mesh_id: string; status: string; outcome: string | null; updated_at: string; n: number; c: number }>;
        for (const m of old) {
            // Already collapsed (exactly the one summary row) → nothing to do.
            if (m.n <= 1 && m.c === m.n) continue;
            deleted += Number(this.db.prepare('DELETE FROM mesh_mission_events WHERE mission_id = ?').run(m.id).changes);
            this.db.prepare('INSERT INTO mesh_mission_events (mission_id, mesh_id, type, actor, payload_json, at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(m.id, m.mesh_id, 'collapsed', 'retention', JSON.stringify({ status: m.status, outcome: m.outcome ?? 'unspecified', closedAt: m.updated_at, eventsCollapsed: m.n }), new Date(nowMs).toISOString());
            collapsedMissions++;
        }
        const meshes = this.db.prepare('SELECT mesh_id, COUNT(*) AS n FROM mesh_mission_events GROUP BY mesh_id HAVING n > ?').all(perMeshCap) as Array<{ mesh_id: string; n: number }>;
        for (const m of meshes) {
            deleted += Number(this.db.prepare(
                `DELETE FROM mesh_mission_events WHERE mesh_id = ? AND seq IN (SELECT seq FROM mesh_mission_events WHERE mesh_id = ? ORDER BY seq ASC LIMIT ?)`,
            ).run(m.mesh_id, m.mesh_id, m.n - perMeshCap).changes);
        }
        return { collapsedMissions, deleted };
    }

    /** Mesh deletion / test cleanup. */
    clearMesh(meshId: string): void {
        this.db.prepare('DELETE FROM mesh_mission_items WHERE mesh_id = ?').run(meshId);
        this.db.prepare('DELETE FROM mesh_mission_events WHERE mesh_id = ?').run(meshId);
    }
}
