/**
 * Release objects schema (docs/design/2026-11-01-release-objects.md §3). Additive and
 * idempotent: `CREATE ... IF NOT EXISTS` plus a guarded `ALTER TABLE mesh_missions ADD
 * COLUMN release_note`. Must run after `mesh_missions` exists.
 */
import type { MeshRuntimeStore } from './mesh-runtime-store.js';

export function ensureMeshReleaseSchema(db: MeshRuntimeStore['db']): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mesh_releases (
            id TEXT PRIMARY KEY,                    -- 'rel_' + 12 hex
            mesh_id TEXT NOT NULL,
            name TEXT NOT NULL,
            channel TEXT NOT NULL,                  -- preview | stable
            version TEXT,
            status TEXT NOT NULL DEFAULT 'planned', -- planned|frozen|deployed|verified|superseded|cancelled
            base_commit TEXT,
            head_commit TEXT,
            targets_json TEXT,                      -- snapshot of the deploy record targets
            changelog_json TEXT,                    -- ChangelogDraft
            note TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version_seq INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_mesh_releases_mesh ON mesh_releases(mesh_id, status, updated_at);

        CREATE TABLE IF NOT EXISTS mesh_release_missions (
            release_id TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            mission_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'member',   -- member | moved_out | removed
            moved_to_release_id TEXT,
            added_by TEXT NOT NULL,
            note TEXT,
            added_at TEXT NOT NULL,
            ended_at TEXT,
            PRIMARY KEY (release_id, mission_id, added_at)
        );
        -- A mission is an active member of at most one release (a move ends the old row first).
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_release_missions_one_active
            ON mesh_release_missions(mission_id) WHERE state = 'member';
        CREATE INDEX IF NOT EXISTS idx_mesh_release_missions_release ON mesh_release_missions(release_id, state);

        CREATE TABLE IF NOT EXISTS mesh_release_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            release_id TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            type TEXT NOT NULL,
            actor TEXT,
            payload_json TEXT,
            at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mesh_release_events_release ON mesh_release_events(release_id, seq);
    `);
    const cols = db.prepare(`PRAGMA table_info(mesh_missions)`).all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(c => c.name === 'release_note')) {
        db.exec(`ALTER TABLE mesh_missions ADD COLUMN release_note TEXT`);
    }
}
