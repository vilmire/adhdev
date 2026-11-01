/**
 * Storage for `mesh_mission_ref_evals` (design 2026-11-01-mission-git-refs §4) and the
 * single, transition-only `git_state_changed` event the projection records.
 *
 * The ONLY writer of these rows. It touches no mission/item column: a containment
 * verdict is a projection that never changes a mission's status, outcome or items.
 */
import type { MissionGitStateValue, MissionRefGitDetail, MissionRefGitEval, MissionRefGitMethod, MissionRefGitStatus } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

const DETAIL_MAX_BYTES = 2048;

function boundDetail(detail: MissionRefGitDetail | undefined): string | null {
    if (!detail || Object.keys(detail).length === 0) return null;
    let json = JSON.stringify(detail);
    if (Buffer.byteLength(json) > DETAIL_MAX_BYTES) {
        const { reasonCode, unknownReason, note, nodeId } = detail;
        json = JSON.stringify({ reasonCode, unknownReason, note, nodeId });
    }
    return json;
}

function parseDetail(json: unknown): MissionRefGitDetail | undefined {
    if (typeof json !== 'string' || !json) return undefined;
    try {
        const v = JSON.parse(json);
        return v && typeof v === 'object' && !Array.isArray(v) ? v as MissionRefGitDetail : undefined;
    } catch {
        return undefined;
    }
}

function rowToEval(r: Record<string, any>): MissionRefGitEval {
    const [kind, repo, ...rest] = String(r.ref_key).split(':');
    return {
        itemId: r.item_id,
        refKey: r.ref_key,
        kind: kind === 'branch' ? 'branch' : 'commit',
        value: rest.join(':'),
        ...(repo ? { repo } : {}),
        ...(r.pinned_sha ? { pinnedSha: r.pinned_sha } : {}),
        baseRef: r.base_ref,
        ...(r.base_sha ? { baseSha: r.base_sha } : {}),
        status: r.status as MissionRefGitStatus,
        ...(r.method ? { method: r.method as MissionRefGitMethod } : {}),
        ...(parseDetail(r.detail_json) ? { detail: parseDetail(r.detail_json) } : {}),
        evaluatedAt: r.evaluated_at,
    };
}

export class MissionRefEvalsStore {
    constructor(private readonly db: MeshRuntimeStore['db']) {}

    list(meshId: string, missionId: string): MissionRefGitEval[] {
        const rows = this.db.prepare(
            'SELECT * FROM mesh_mission_ref_evals WHERE mesh_id = ? AND mission_id = ? ORDER BY item_id, ref_key',
        ).all(meshId, missionId) as Array<Record<string, any>>;
        return rows.map(rowToEval);
    }

    /** Rows of every mission of the mesh, keyed by mission id (one query for list views). */
    listByMesh(meshId: string): Map<string, MissionRefGitEval[]> {
        const rows = this.db.prepare(
            'SELECT * FROM mesh_mission_ref_evals WHERE mesh_id = ? ORDER BY mission_id, item_id, ref_key',
        ).all(meshId) as Array<Record<string, any>>;
        const out = new Map<string, MissionRefGitEval[]>();
        for (const r of rows) {
            const list = out.get(r.mission_id) ?? [];
            list.push(rowToEval(r));
            out.set(r.mission_id, list);
        }
        return out;
    }

    upsert(meshId: string, missionId: string, e: MissionRefGitEval): void {
        this.db.prepare(
            `INSERT INTO mesh_mission_ref_evals
                (mesh_id, mission_id, item_id, ref_key, pinned_sha, base_ref, base_sha, status, method, detail_json, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(item_id, ref_key, base_ref) DO UPDATE SET
                mesh_id = excluded.mesh_id, mission_id = excluded.mission_id,
                pinned_sha = COALESCE(mesh_mission_ref_evals.pinned_sha, excluded.pinned_sha),
                base_sha = excluded.base_sha, status = excluded.status, method = excluded.method,
                detail_json = excluded.detail_json, evaluated_at = excluded.evaluated_at`,
        ).run(
            meshId, missionId, e.itemId, e.refKey, e.pinnedSha ?? null, e.baseRef, e.baseSha ?? null,
            e.status, e.method ?? null, boundDetail(e.detail), e.evaluatedAt,
        );
        // The base may be named differently between evaluations (`origin/main` vs a local `main`): one row per ref.
        this.db.prepare('DELETE FROM mesh_mission_ref_evals WHERE item_id = ? AND ref_key = ? AND base_ref <> ?').run(e.itemId, e.refKey, e.baseRef);
    }

    /** Drop rows of refs that are no longer on the mission's items (removed/changed refs must not keep voting). */
    deleteStale(meshId: string, missionId: string, keep: ReadonlySet<string>): number {
        let n = 0;
        for (const r of this.list(meshId, missionId)) {
            if (keep.has(`${r.itemId}\u0000${r.refKey}`)) continue;
            n += Number(this.db.prepare('DELETE FROM mesh_mission_ref_evals WHERE item_id = ? AND ref_key = ? AND base_ref = ?').run(r.itemId, r.refKey, r.baseRef).changes);
        }
        return n;
    }
}

export function missionRefEvals(): MissionRefEvalsStore {
    return new MissionRefEvalsStore(MeshRuntimeStore.getInstance().db);
}

/**
 * Record `git_state_changed {from,to,baseSha}` — called only when the projected state
 * actually differs from the last one this mission recorded (event history is the
 * memory; re-evaluations with an unchanged result write nothing).
 */
export function recordGitStateTransition(
    meshId: string,
    missionId: string,
    to: MissionGitStateValue,
    baseSha: string | undefined,
): { recorded: boolean; from: MissionGitStateValue | 'none' } {
    const items = MeshRuntimeStore.getInstance().missionItems();
    const last = items.listEvents(meshId, missionId, { types: ['git_state_changed'], limit: 1 })[0];
    const from = (last?.payload?.to as MissionGitStateValue | undefined) ?? 'none';
    if (from === to) return { recorded: false, from };
    // A first-ever `no_refs` is the absence of the feature, not a transition worth recording.
    if (from === 'none' && to === 'no_refs') return { recorded: false, from };
    items.appendEvent(meshId, missionId, 'git_state_changed', 'daemon', { from, to, ...(baseSha ? { baseSha } : {}) });
    return { recorded: true, from };
}
