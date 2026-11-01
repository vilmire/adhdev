/**
 * Recurring-procedure detection tables (design 2026-11-01-procedure-skills.md
 * §4.5), in `mesh-runtime.db`. LOCAL ONLY: these rows hold a 120-char excerpt
 * of the owner's own request and never reach the status path, push, webhooks
 * or the cloud server (CLAUDE.md server content boundary).
 *
 * Idempotent (`IF NOT EXISTS`); called once from `migrate()`.
 */

import type { MeshRuntimeStore } from './mesh-runtime-store.js';

export function ensureProcedureSignalSchema(db: MeshRuntimeStore['db']): void {
    db.exec(`
        -- One row per owner request / project_send that may be a repeated
        -- procedure. keywords_json: <= 12 normalised tokens (no numbers, paths
        -- or ids); simhash: 64-bit hex; excerpt: <= 120 chars, credential-clean.
        CREATE TABLE IF NOT EXISTS assistant_procedure_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at_ms INTEGER NOT NULL,
            mesh_id TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL,
            turn_key TEXT NOT NULL DEFAULT '',
            keywords_json TEXT NOT NULL,
            simhash TEXT NOT NULL,
            excerpt TEXT NOT NULL DEFAULT '',
            attached_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_procedure_signals_at
            ON assistant_procedure_signals(at_ms);

        -- state: open | proposed | saved | dismissed | covered
        CREATE TABLE IF NOT EXISTS assistant_procedure_candidates (
            cluster_id TEXT PRIMARY KEY,
            first_at INTEGER NOT NULL,
            last_at INTEGER NOT NULL,
            signal_count INTEGER NOT NULL,
            distinct_days INTEGER NOT NULL,
            representative_excerpt TEXT NOT NULL DEFAULT '',
            keywords_json TEXT NOT NULL DEFAULT '[]',
            simhash TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT 'open',
            staged_id TEXT,
            dismissed_until INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
    `);
}
