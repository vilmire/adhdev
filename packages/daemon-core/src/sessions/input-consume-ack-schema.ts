/**
 * Durable consume-ACK journal for session input (mission 0d092498,
 * mi_36292e2de12b). One row per messageId; metadata only — ids, enums,
 * counters, evidence kind. Never input text. Local-only (never projected to
 * the cloud status path). Additive and idempotent; called once from
 * `mesh/mesh-runtime-store-schema.ts`.
 */
import type { Database as DatabaseHandle } from 'better-sqlite3';

export function ensureInputConsumeAckSchema(db: DatabaseHandle): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS input_consume_ack (
            message_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            state TEXT NOT NULL,
            evidence TEXT,
            retries INTEGER NOT NULL DEFAULT 0,
            pid INTEGER NOT NULL,
            boot_nonce TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_input_consume_ack_session
            ON input_consume_ack(session_id, updated_at);
    `);
}
