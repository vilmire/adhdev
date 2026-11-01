/**
 * Storage for release objects (docs/design/2026-11-01-release-objects.md §3): releases,
 * mission membership and the release event log. Pure SQL over the daemon's
 * mesh-runtime.db handle with no policy — the rules (explicit membership, one active
 * release per mission, move semantics, lifecycle) live in mesh-releases.ts.
 *
 * Every mutating method is synchronous better-sqlite3, so callers wrap several calls in
 * `MeshRuntimeStore.transaction`.
 */
import { randomBytes } from 'crypto';
import type {
    ChangelogDraft, MeshReleaseChannel, ReleaseEventType, ReleaseMemberState, ReleaseStatus, ReleaseTargets,
} from '@adhdev/mesh-shared';
import type { Database as Db } from 'better-sqlite3';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

export interface MeshReleaseRecord {
    id: string;
    meshId: string;
    name: string;
    channel: MeshReleaseChannel;
    version?: string;
    status: ReleaseStatus;
    baseCommit?: string;
    headCommit?: string;
    targets?: ReleaseTargets;
    changelog?: ChangelogDraft;
    note?: string;
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
    versionSeq: number;
}

export interface ReleaseMemberRow {
    releaseId: string;
    meshId: string;
    missionId: string;
    state: ReleaseMemberState;
    movedToReleaseId?: string;
    addedBy: string;
    note?: string;
    addedAt: string;
    endedAt?: string;
}

export interface ReleaseEventRow {
    seq: number;
    releaseId: string;
    meshId: string;
    type: ReleaseEventType;
    actor?: string;
    payload: Record<string, unknown>;
    at: string;
}

function parseJson<T>(text: unknown, fallback: T): T {
    if (typeof text !== 'string' || !text) return fallback;
    try { return JSON.parse(text) as T; } catch { return fallback; }
}

function rowToRelease(r: Record<string, any>): MeshReleaseRecord {
    return {
        id: r.id,
        meshId: r.mesh_id,
        name: r.name,
        channel: r.channel,
        ...(r.version ? { version: r.version } : {}),
        status: r.status,
        ...(r.base_commit ? { baseCommit: r.base_commit } : {}),
        ...(r.head_commit ? { headCommit: r.head_commit } : {}),
        ...(r.targets_json ? { targets: parseJson<ReleaseTargets | undefined>(r.targets_json, undefined) } : {}),
        ...(r.changelog_json ? { changelog: parseJson<ChangelogDraft | undefined>(r.changelog_json, undefined) } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(r.created_by ? { createdBy: r.created_by } : {}),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        versionSeq: typeof r.version_seq === 'number' ? r.version_seq : 1,
    };
}

function rowToMember(r: Record<string, any>): ReleaseMemberRow {
    return {
        releaseId: r.release_id,
        meshId: r.mesh_id,
        missionId: r.mission_id,
        state: r.state,
        ...(r.moved_to_release_id ? { movedToReleaseId: r.moved_to_release_id } : {}),
        addedBy: r.added_by,
        ...(r.note ? { note: r.note } : {}),
        addedAt: r.added_at,
        ...(r.ended_at ? { endedAt: r.ended_at } : {}),
    };
}

export function newReleaseId(): string {
    return `rel_${randomBytes(6).toString('hex')}`;
}

export class MeshReleaseStore {
    constructor(private readonly db: Db) {}

    insert(rec: Omit<MeshReleaseRecord, 'versionSeq'>): void {
        this.db.prepare(
            `INSERT INTO mesh_releases (id, mesh_id, name, channel, version, status, base_commit, head_commit, targets_json, changelog_json, note, created_by, created_at, updated_at, version_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(
            rec.id, rec.meshId, rec.name, rec.channel, rec.version ?? null, rec.status,
            rec.baseCommit ?? null, rec.headCommit ?? null,
            rec.targets ? JSON.stringify(rec.targets) : null, rec.changelog ? JSON.stringify(rec.changelog) : null,
            rec.note ?? null, rec.createdBy ?? null, rec.createdAt, rec.updatedAt,
        );
    }

    get(meshId: string, id: string): MeshReleaseRecord | null {
        const row = this.db.prepare('SELECT * FROM mesh_releases WHERE mesh_id = ? AND id = ?').get(meshId, id) as Record<string, any> | undefined;
        return row ? rowToRelease(row) : null;
    }

    list(meshId: string, opts: { statuses?: readonly ReleaseStatus[]; channel?: MeshReleaseChannel } = {}): MeshReleaseRecord[] {
        const where = ['mesh_id = ?'];
        const args: unknown[] = [meshId];
        if (opts.statuses?.length) { where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`); args.push(...opts.statuses); }
        if (opts.channel) { where.push('channel = ?'); args.push(opts.channel); }
        const rows = this.db.prepare(`SELECT * FROM mesh_releases WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id`).all(...args) as Array<Record<string, any>>;
        return rows.map(rowToRelease);
    }

    /** Patch columns; `null` clears, `undefined` leaves. Bumps version_seq and updated_at. */
    update(meshId: string, id: string, patch: {
        name?: string; channel?: MeshReleaseChannel; version?: string | null; status?: ReleaseStatus;
        baseCommit?: string | null; headCommit?: string | null; targets?: ReleaseTargets | null;
        changelog?: ChangelogDraft | null; note?: string | null;
    }, nowIso: string = new Date().toISOString()): void {
        const sets: string[] = [];
        const args: unknown[] = [];
        const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };
        if (patch.name !== undefined) put('name', patch.name);
        if (patch.channel !== undefined) put('channel', patch.channel);
        if (patch.version !== undefined) put('version', patch.version);
        if (patch.status !== undefined) put('status', patch.status);
        if (patch.baseCommit !== undefined) put('base_commit', patch.baseCommit);
        if (patch.headCommit !== undefined) put('head_commit', patch.headCommit);
        if (patch.targets !== undefined) put('targets_json', patch.targets ? JSON.stringify(patch.targets) : null);
        if (patch.changelog !== undefined) put('changelog_json', patch.changelog ? JSON.stringify(patch.changelog) : null);
        if (patch.note !== undefined) put('note', patch.note);
        put('updated_at', nowIso);
        sets.push('version_seq = version_seq + 1');
        this.db.prepare(`UPDATE mesh_releases SET ${sets.join(', ')} WHERE mesh_id = ? AND id = ?`).run(...args, meshId, id);
    }

    // ── membership ──────────────────────────────────────────────────────────

    members(releaseId: string, states?: readonly ReleaseMemberState[]): ReleaseMemberRow[] {
        const rows = states?.length
            ? this.db.prepare(`SELECT * FROM mesh_release_missions WHERE release_id = ? AND state IN (${states.map(() => '?').join(',')}) ORDER BY added_at, mission_id`).all(releaseId, ...states)
            : this.db.prepare('SELECT * FROM mesh_release_missions WHERE release_id = ? ORDER BY added_at, mission_id').all(releaseId);
        return (rows as Array<Record<string, any>>).map(rowToMember);
    }

    /** The one release this mission is currently a member of, if any. */
    activeMembership(missionId: string): ReleaseMemberRow | null {
        const row = this.db.prepare("SELECT * FROM mesh_release_missions WHERE mission_id = ? AND state = 'member'").get(missionId) as Record<string, any> | undefined;
        return row ? rowToMember(row) : null;
    }

    /** missionId → active membership for every mission of the mesh (list views). */
    activeMembershipByMesh(meshId: string): Map<string, ReleaseMemberRow> {
        const rows = this.db.prepare("SELECT * FROM mesh_release_missions WHERE mesh_id = ? AND state = 'member'").all(meshId) as Array<Record<string, any>>;
        return new Map(rows.map(r => [r.mission_id as string, rowToMember(r)]));
    }

    /** Release ids that ever held the mission (history for the mission card). */
    historyOfMission(missionId: string): ReleaseMemberRow[] {
        const rows = this.db.prepare('SELECT * FROM mesh_release_missions WHERE mission_id = ? ORDER BY added_at').all(missionId) as Array<Record<string, any>>;
        return rows.map(rowToMember);
    }

    addMember(row: { releaseId: string; meshId: string; missionId: string; addedBy: string; note?: string; addedAt: string }): void {
        this.db.prepare(
            `INSERT INTO mesh_release_missions (release_id, mesh_id, mission_id, state, added_by, note, added_at) VALUES (?, ?, ?, 'member', ?, ?, ?)`,
        ).run(row.releaseId, row.meshId, row.missionId, row.addedBy, row.note ?? null, row.addedAt);
    }

    /** End the active membership row: `moved_out` (with target) or `removed`. */
    endMember(missionId: string, state: 'moved_out' | 'removed', endedAt: string, movedToReleaseId?: string): void {
        this.db.prepare(
            `UPDATE mesh_release_missions SET state = ?, moved_to_release_id = ?, ended_at = ? WHERE mission_id = ? AND state = 'member'`,
        ).run(state, movedToReleaseId ?? null, endedAt, missionId);
    }

    // ── events ──────────────────────────────────────────────────────────────

    appendEvent(meshId: string, releaseId: string, type: ReleaseEventType, actor: string | undefined, payload: Record<string, unknown>, at: string = new Date().toISOString()): void {
        let json = JSON.stringify(payload ?? {});
        if (Buffer.byteLength(json) > 16 * 1024) json = JSON.stringify({ truncated: true });
        this.db.prepare('INSERT INTO mesh_release_events (release_id, mesh_id, type, actor, payload_json, at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(releaseId, meshId, type, actor ?? null, json, at);
    }

    listEvents(releaseId: string, opts: { types?: readonly ReleaseEventType[]; limit?: number } = {}): ReleaseEventRow[] {
        const where = ['release_id = ?'];
        const args: unknown[] = [releaseId];
        if (opts.types?.length) { where.push(`type IN (${opts.types.map(() => '?').join(',')})`); args.push(...opts.types); }
        const rows = this.db.prepare(`SELECT * FROM mesh_release_events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...args, opts.limit ?? 50) as Array<Record<string, any>>;
        return rows.map(r => ({
            seq: r.seq, releaseId: r.release_id, meshId: r.mesh_id, type: r.type, ...(r.actor ? { actor: r.actor } : {}),
            payload: parseJson<Record<string, unknown>>(r.payload_json, {}), at: r.at,
        }));
    }
}

export function meshReleases(): MeshReleaseStore {
    return new MeshReleaseStore(MeshRuntimeStore.getInstance().db);
}
