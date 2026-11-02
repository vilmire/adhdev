/**
 * Host-handoff journal + staging tables (design 2026-11-01 §7.2). Additive and
 * idempotent; called from one line in mesh-runtime-store-schema.ts. The journal
 * is keyed (handoff_id, role) so one daemon can hold both sides in tests.
 */

export interface HandoffSchemaDb { exec(sql: string): unknown }

export function ensureHostHandoffSchema(db: HandoffSchemaDb): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mesh_host_handoff (
            handoff_id TEXT NOT NULL,
            role TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            peer_daemon_id TEXT NOT NULL,
            phase TEXT NOT NULL,
            epoch INTEGER NOT NULL,
            manifest_digest TEXT,
            row_counts_json TEXT,
            target_node_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            abort_reason TEXT,
            commit_intent_at INTEGER,
            probe_count INTEGER,
            last_probe_at INTEGER,
            target_public_key TEXT,
            PRIMARY KEY (handoff_id, role)
        );
        CREATE INDEX IF NOT EXISTS idx_mesh_host_handoff_mesh ON mesh_host_handoff(mesh_id, role, updated_at);

        -- Target staging area: received snapshot chunks, NOT live tables. Dropped on activate/discard.
        CREATE TABLE IF NOT EXISTS mesh_host_handoff_stage (
            handoff_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (handoff_id, seq)
        );
        CREATE TABLE IF NOT EXISTS mesh_host_handoff_manifest (
            handoff_id TEXT PRIMARY KEY,
            manifest_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mesh_host_handoff_certificate (
            handoff_id TEXT PRIMARY KEY,
            certificate_json TEXT NOT NULL
        );

        -- Source side after commit: host-owned rows of a handed-off mesh are read-only until retention ends.
        CREATE TABLE IF NOT EXISTS mesh_host_handed_off (
            mesh_id TEXT PRIMARY KEY,
            handoff_id TEXT NOT NULL,
            new_host_daemon_id TEXT NOT NULL,
            epoch INTEGER NOT NULL,
            handed_off_at INTEGER NOT NULL,
            retain_until INTEGER NOT NULL
        );
    `);
}
