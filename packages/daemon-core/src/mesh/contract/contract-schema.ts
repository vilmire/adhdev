/**
 * Contract versioning — private durable schema (PROPOSED-DATA-CONTRACT
 * "logical sets"). Additive and idempotent; run by MeshRuntimeStore.migrate.
 *
 * ★Local-only. Nothing here is a seqscribe topic or a status/event field:
 * unit bodies, rationale and quarantine bodies live in these private tables
 * and are never serialized into shared turn/status events (F10).
 *
 * Store/writer barrier (AC22): `contract_store_meta.protocol_version` records
 * the newest protocol a writer used. A binary that supports an OLDER protocol
 * refuses every strict operation instead of reading rows it cannot interpret
 * (`store_version_unsupported`); missing strict rows mean held, never legacy.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import { CONTRACT_PROTOCOL_VERSION } from './contract-types.js';

export function ensureContractSchema(db: DatabaseHandle): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS contract_store_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contract_authorities (
            namespace_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            owner_principal TEXT NOT NULL,
            authority_daemon_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL,
            process_incarnation INTEGER NOT NULL,
            policy_revision INTEGER NOT NULL,
            policy_json TEXT NOT NULL,
            revocation_generation INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            enrolled_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contract_authorities_mesh ON contract_authorities(mesh_id);
        CREATE TABLE IF NOT EXISTS contract_epochs (
            namespace_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL,
            authority_daemon_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            PRIMARY KEY (namespace_id, authority_epoch)
        );
        CREATE TABLE IF NOT EXISTS contract_repo_bindings (
            repo_binding_id TEXT NOT NULL,
            namespace_id TEXT NOT NULL,
            repo_path TEXT NOT NULL,
            common_dir TEXT NOT NULL,
            hash_algorithm TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (namespace_id, repo_binding_id)
        );
        CREATE TABLE IF NOT EXISTS contract_grants (
            grant_id TEXT PRIMARY KEY,
            namespace_id TEXT NOT NULL,
            verifier TEXT NOT NULL UNIQUE,
            coordinator_session_id TEXT NOT NULL,
            authority_daemon_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL,
            process_incarnation INTEGER NOT NULL,
            grant_generation INTEGER NOT NULL,
            ops_json TEXT NOT NULL,
            max_impact TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            overlap_until INTEGER,
            revoked_at INTEGER,
            revoke_reason TEXT,
            minted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contract_grants_session ON contract_grants(namespace_id, coordinator_session_id);
        CREATE TABLE IF NOT EXISTS contract_heads (
            namespace_id TEXT PRIMARY KEY,
            authority_epoch INTEGER NOT NULL,
            head_generation INTEGER NOT NULL,
            revision_id TEXT,
            policy_revision INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contract_head_log (
            namespace_id TEXT NOT NULL,
            head_generation INTEGER NOT NULL,
            authority_epoch INTEGER NOT NULL,
            revision_id TEXT,
            prior_revision_id TEXT,
            policy_revision INTEGER NOT NULL,
            acceptance_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            accepted_at INTEGER NOT NULL,
            PRIMARY KEY (namespace_id, head_generation)
        );
        CREATE TABLE IF NOT EXISTS contract_revisions (
            revision_id TEXT PRIMARY KEY,
            namespace_id TEXT NOT NULL,
            predecessor_revision_id TEXT,
            impact TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            total_bytes INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contract_units (
            revision_id TEXT NOT NULL,
            unit_id TEXT NOT NULL,
            unit_digest TEXT NOT NULL,
            byte_length INTEGER NOT NULL,
            roles_json TEXT NOT NULL,
            PRIMARY KEY (revision_id, unit_id)
        );
        CREATE TABLE IF NOT EXISTS contract_revoked_revisions (
            namespace_id TEXT NOT NULL,
            revision_id TEXT NOT NULL,
            revocation_generation INTEGER NOT NULL,
            revoked_at INTEGER NOT NULL,
            PRIMARY KEY (namespace_id, revision_id)
        );
        CREATE TABLE IF NOT EXISTS contract_spool (
            digest TEXT PRIMARY KEY,
            byte_length INTEGER NOT NULL,
            body BLOB,
            gc_generation INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            purged_at INTEGER,
            purge_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS contract_proposals (
            proposal_id TEXT NOT NULL,
            proposal_version INTEGER NOT NULL,
            namespace_id TEXT NOT NULL,
            base_epoch INTEGER NOT NULL,
            base_head_generation INTEGER NOT NULL,
            base_revision_id TEXT,
            base_policy_revision INTEGER NOT NULL,
            candidate_revision_id TEXT NOT NULL,
            impact TEXT NOT NULL,
            author_principal TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            closed_at INTEGER,
            PRIMARY KEY (proposal_id, proposal_version)
        );
        CREATE TABLE IF NOT EXISTS contract_reviews (
            review_id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL,
            proposal_version INTEGER NOT NULL,
            candidate_revision_id TEXT NOT NULL,
            base_head_generation INTEGER NOT NULL,
            base_revision_id TEXT,
            policy_revision INTEGER NOT NULL,
            reviewer_principal TEXT NOT NULL,
            verdict TEXT NOT NULL,
            rationale TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contract_idempotency (
            namespace_id TEXT NOT NULL,
            idem_key TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (namespace_id, idem_key)
        );
        CREATE TABLE IF NOT EXISTS contract_impact_outbox (
            acceptance_id TEXT PRIMARY KEY,
            namespace_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL,
            head_generation INTEGER NOT NULL,
            revision_id TEXT,
            notice_class TEXT NOT NULL,
            scan_cursor TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contract_notices (
            notice_key TEXT PRIMARY KEY,
            namespace_id TEXT NOT NULL,
            binding_id TEXT NOT NULL,
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            authority_epoch INTEGER NOT NULL,
            head_generation INTEGER NOT NULL,
            to_revision_id TEXT,
            notice_class TEXT NOT NULL,
            state TEXT NOT NULL,
            hint_operation_id TEXT,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_contract_notices_binding ON contract_notices(binding_id, state);
        CREATE TABLE IF NOT EXISTS contract_mission_scopes (
            mesh_id TEXT NOT NULL,
            mission_id TEXT NOT NULL,
            namespace_id TEXT NOT NULL,
            units_json TEXT NOT NULL,
            mode TEXT NOT NULL,
            bound_at INTEGER NOT NULL,
            PRIMARY KEY (mesh_id, mission_id)
        );
        CREATE TABLE IF NOT EXISTS contract_task_scopes (
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            namespace_id TEXT NOT NULL,
            units_json TEXT NOT NULL,
            mode TEXT NOT NULL,
            bound_at INTEGER NOT NULL,
            PRIMARY KEY (mesh_id, task_id)
        );
        CREATE TABLE IF NOT EXISTS contract_pin_sets (
            pin_set_id TEXT PRIMARY KEY,
            namespace_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL,
            head_generation INTEGER NOT NULL,
            revision_id TEXT,
            policy_revision INTEGER NOT NULL,
            revocation_generation INTEGER NOT NULL,
            pins_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contract_bindings (
            binding_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            namespace_id TEXT NOT NULL,
            recipient_session_id TEXT NOT NULL,
            recipient_node_id TEXT,
            recipient_daemon_id TEXT,
            pin_set_id TEXT NOT NULL,
            block_digest TEXT NOT NULL,
            block_bytes INTEGER NOT NULL,
            e1_stage TEXT NOT NULL,
            state TEXT NOT NULL,
            linked_from_binding_id TEXT,
            admitted_at INTEGER NOT NULL,
            ended_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_contract_bindings_task ON contract_bindings(mesh_id, task_id, state);
        CREATE TABLE IF NOT EXISTS contract_reads (
            read_id TEXT PRIMARY KEY,
            binding_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            revision_id TEXT NOT NULL,
            unit_id TEXT NOT NULL,
            unit_digest TEXT NOT NULL,
            range_start INTEGER NOT NULL,
            range_end INTEGER NOT NULL,
            unit_length INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            request_id TEXT,
            served_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contract_reads_binding ON contract_reads(binding_id);
        CREATE TABLE IF NOT EXISTS contract_claims (
            claim_id TEXT PRIMARY KEY,
            binding_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            units_json TEXT NOT NULL,
            claimed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contract_claims_binding ON contract_claims(binding_id);
        CREATE TABLE IF NOT EXISTS contract_result_evidence (
            result_key TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            output_version INTEGER NOT NULL,
            payload_digest TEXT NOT NULL,
            namespace_id TEXT NOT NULL,
            binding_id TEXT,
            pin_set_id TEXT,
            evidence_json TEXT NOT NULL,
            snapshot_digest TEXT NOT NULL,
            provenance TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contract_result_evidence_task ON contract_result_evidence(mesh_id, task_id);
        CREATE TABLE IF NOT EXISTS contract_revalidations (
            revalidation_id TEXT PRIMARY KEY,
            result_key TEXT NOT NULL,
            purpose TEXT NOT NULL,
            namespace_id TEXT NOT NULL,
            authority_epoch INTEGER NOT NULL,
            head_generation INTEGER NOT NULL,
            revision_id TEXT,
            policy_revision INTEGER NOT NULL,
            revocation_generation INTEGER NOT NULL,
            decision TEXT NOT NULL,
            assessor_principal TEXT NOT NULL,
            reason TEXT NOT NULL,
            expires_at INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contract_revalidations_result ON contract_revalidations(result_key, purpose);
        CREATE TABLE IF NOT EXISTS contract_held_handoffs (
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            result_key TEXT NOT NULL,
            notes_json TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            session_id TEXT,
            node_id TEXT,
            recorded_at INTEGER NOT NULL,
            published_at INTEGER,
            PRIMARY KEY (mesh_id, task_id)
        );
        CREATE TABLE IF NOT EXISTS contract_use_guards (
            guard_id TEXT PRIMARY KEY,
            namespace_id TEXT NOT NULL,
            units_json TEXT NOT NULL,
            result_keys_json TEXT NOT NULL,
            purpose TEXT NOT NULL,
            vector_json TEXT NOT NULL,
            state TEXT NOT NULL,
            process_incarnation INTEGER NOT NULL,
            external_ref_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contract_use_guards_ns ON contract_use_guards(namespace_id, state);
        CREATE TABLE IF NOT EXISTS contract_audit_quarantine (
            quarantine_id TEXT PRIMARY KEY,
            delivery_id TEXT NOT NULL UNIQUE,
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            attempt_id TEXT,
            payload_digest TEXT NOT NULL,
            body_digest TEXT NOT NULL,
            prepared_tuple_json TEXT NOT NULL,
            provenance TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contract_tombstones (
            digest TEXT PRIMARY KEY,
            reason TEXT NOT NULL,
            purged_at INTEGER NOT NULL
        );
    `);
    const row = db.prepare(`SELECT value FROM contract_store_meta WHERE key = 'protocol_version'`).get() as { value: string } | undefined;
    if (!row) {
        db.prepare(`INSERT INTO contract_store_meta (key, value) VALUES ('protocol_version', ?)`).run(String(CONTRACT_PROTOCOL_VERSION));
    }
}

/** The store's recorded protocol version; a value above ours means a newer writer used this DB. */
export function readContractStoreProtocolVersion(db: DatabaseHandle): number {
    const row = db.prepare(`SELECT value FROM contract_store_meta WHERE key = 'protocol_version'`).get() as { value: string } | undefined;
    const v = row ? Number(row.value) : CONTRACT_PROTOCOL_VERSION;
    return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}
