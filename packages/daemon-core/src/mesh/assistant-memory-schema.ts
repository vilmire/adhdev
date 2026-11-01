/**
 * Assistant memory archive tables (docs/design/2026-11-01-assistant-memory.md §2.2).
 *
 * The archive tier sits beside the MEMORY.md / USER.md core files: entries that
 * do not belong in the always-injected prompt snapshot (project-scoped facts,
 * budget overflow, promoted decision preferences, review lessons). Searchable
 * through an FTS5 external-content index. Local-only: no seqscribe topic, never
 * projected to the cloud status path.
 *
 * `seq` is the rowid alias the FTS index keys on. `id` (a 10-char sha1 prefix
 * assigned at creation) is the stable public handle and is NOT the rowid:
 * a table without an INTEGER PRIMARY KEY may renumber rowids on VACUUM
 * (`MeshRuntimeStore.vacuum()` exists), which would silently desync an
 * external-content index.
 */

import type { MeshRuntimeStore } from './mesh-runtime-store.js';

export function ensureAssistantMemorySchema(db: MeshRuntimeStore['db']): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_memory_entry (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL CHECK (scope IN ('global','project')),
            project_ref TEXT,
            kind TEXT NOT NULL CHECK (kind IN ('rule','env','preference','lesson')),
            text TEXT NOT NULL,
            origin TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_hit_at INTEGER,
            hit_count INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER,
            source_ref TEXT,
            archived_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_memory_entry_project
            ON assistant_memory_entry(scope, project_ref, archived_at);
        CREATE INDEX IF NOT EXISTS idx_assistant_memory_entry_source
            ON assistant_memory_entry(source_ref);
        CREATE VIRTUAL TABLE IF NOT EXISTS assistant_memory_fts USING fts5(
            text, content='assistant_memory_entry', content_rowid='seq', tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS assistant_memory_entry_ai AFTER INSERT ON assistant_memory_entry BEGIN
            INSERT INTO assistant_memory_fts(rowid, text) VALUES (new.seq, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS assistant_memory_entry_ad AFTER DELETE ON assistant_memory_entry BEGIN
            INSERT INTO assistant_memory_fts(assistant_memory_fts, rowid, text) VALUES ('delete', old.seq, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS assistant_memory_entry_au AFTER UPDATE OF text ON assistant_memory_entry BEGIN
            INSERT INTO assistant_memory_fts(assistant_memory_fts, rowid, text) VALUES ('delete', old.seq, old.text);
            INSERT INTO assistant_memory_fts(rowid, text) VALUES (new.seq, new.text);
        END;
        -- Local daily counters for the memory subsystem (design §3 metrics M-mem-*).
        CREATE TABLE IF NOT EXISTS assistant_memory_metric (
            day TEXT NOT NULL,
            metric TEXT NOT NULL,
            n INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, metric)
        );
        -- One row per qualifying owner decision answer, keyed by the decision's
        -- question dedupe key (the "type key" for preference promotion, §3.8).
        CREATE TABLE IF NOT EXISTS assistant_decision_answer_log (
            mesh_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            type_key TEXT NOT NULL,
            choice_key TEXT NOT NULL,
            choice_label TEXT NOT NULL,
            answered_at INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (mesh_id, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_decision_answer_log_type
            ON assistant_decision_answer_log(type_key, choice_key);
        -- A (type, choice) that was turned into a preference ('promoted'), or that the
        -- owner undid and must not be promoted again ('rejected').
        CREATE TABLE IF NOT EXISTS assistant_decision_promotion (
            type_key TEXT NOT NULL,
            choice_key TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('promoted','rejected')),
            text TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            at INTEGER NOT NULL,
            PRIMARY KEY (type_key, choice_key)
        );
    `);
}
