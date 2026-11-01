/**
 * `mesh_mission_ref_evals` — per-ref git containment verdicts for mission item refs
 * (docs/design/2026-11-01-mission-git-refs.md §4). Additive and idempotent
 * (`CREATE ... IF NOT EXISTS`); `mesh_missions` gains no column. The mission-level
 * `gitState` is never stored: it is computed from these rows at read time.
 */
import type { MeshRuntimeStore } from './mesh-runtime-store.js';

export function ensureMissionRefEvalsSchema(db: MeshRuntimeStore['db']): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mesh_mission_ref_evals (
            mesh_id TEXT NOT NULL,
            mission_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            ref_key TEXT NOT NULL,            -- kind:repo:value (normalized, lower-case SHA)
            pinned_sha TEXT,                  -- branch refs: SHA at first evaluation
            base_ref TEXT NOT NULL,
            base_sha TEXT,
            status TEXT NOT NULL,             -- contained_ancestor|contained_patch_equivalent|not_contained|unknown
            method TEXT,                      -- ancestry|cherry|residual_patch
            detail_json TEXT,                 -- <= 2 KB
            evaluated_at TEXT NOT NULL,
            PRIMARY KEY (item_id, ref_key, base_ref)
        );
        CREATE INDEX IF NOT EXISTS idx_mesh_mission_ref_evals_mission
            ON mesh_mission_ref_evals(mesh_id, mission_id);
    `);
}
