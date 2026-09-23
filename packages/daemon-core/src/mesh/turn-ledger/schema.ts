// ---------------------------------------------------------------------------
// turn-ledger/schema — DDL of the turn ledger tables (design §5 C3)
// ---------------------------------------------------------------------------
// Wiring-unification Phase C3 + the C-W3 audit corrections. These tables live
// in `mesh-runtime.db` next to `mesh_queue` so a turn commit, its queue row
// flip and its graph advance are ONE better-sqlite3 transaction (C2).
//
// Creation is additive and idempotent (`CREATE … IF NOT EXISTS`), run on every
// store open, exactly like the rest of mesh-runtime-store-schema.ts. What is
// NOT additive — folding the legacy tables in and dropping them — is the
// one-way `migrate-v1.ts` (0 → 1; nothing in the tree used user_version
// before, C3 correction 2), `migrate-v2.ts` (1 → 2, C-W8: drops the legacy
// tables whose last writer was retired) and `migrate-v3.ts` (2 → 3, C-W9a:
// folds the recent event-ledger rows into `mesh_local_records` and drops
// `mesh_event_ledger`); they are the only writers of `PRAGMA user_version`.
//
// Column deltas vs the design DDL, all content-free and each justified:
//   turn_attempts.consume_profile / max_task_retries / last_liveness /
//     candidate_notified_generation / last_no_progress_notice_at /
//     terminal_summary_json — TurnAttempt (types.ts) fields the reducer reads;
//     a column each instead of burying them in data_json keeps reads typed.
//   turn_events.mesh_id / rule — the publisher needs the topic of an
//     attempt-less notice (mesh_event, delivered:<w>:<s> rows), and `rule` is
//     the reducer's TRANSITIONS id, the one field every audit asks for first.
//   mesh_operating_notes.category — the per-category TTL
//     (OPERATING_NOTE_CATEGORY_TTL_DAYS) needs it; it was payload.category.
//   mesh_local_records (C-W9a) — the LOCAL-ONLY half of `meshRecord(...,
//     {local})`: the full nested payload of a non-turn mesh record (refine
//     job results, MAGI synthesis, dispatch failure errors, diagnostics) that
//     the content-free `mesh.<id>.events` projection drops. Its own table,
//     not `turn_events` rows: a record has no attempt / generation / verdict /
//     publish state, often no session (turn_events.session_id is NOT NULL),
//     and needs time-based retention independent of attempt pruning. Never
//     published; never reaches the server.
//   mesh_topic_index — indexes per C3 correction 1 (never on the constant
//     `kind`), plus a writer index for own-writer reads (correction 3:
//     `WHERE writer = ?` before LIMIT).
//
// `turn_holds.session_id` is deliberately ABSENT (C10-6 decision, C-W2): every
// hold is attempt-scoped (no outbox subjects), so `sessionIdFor(attemptId)` is
// a primary-key join to `turn_attempts.session_id`. A denormalized copy would
// go stale on the one mutation that matters — R25/R26 rebinds and R27a
// adoption rewrite the attempt's session while its holds stay.
// ---------------------------------------------------------------------------

import type { Database as DatabaseHandle } from 'better-sqlite3';

/** `PRAGMA user_version` once migrate-v1 has folded (and dropped) the legacy tables. */
export const TURN_LEDGER_V1 = 1;

/**
 * The current schema version: 3 once migrate-v3 (C-W9a) has folded the recent
 * `mesh_event_ledger` rows into `mesh_local_records` and dropped the event
 * ledger — the last legacy table. (2 = migrate-v2 dropped the other retired
 * tables and folded post-v1 operating notes.)
 */
export const TURN_LEDGER_SCHEMA_VERSION = 3;

/** The legacy tables migrate-v1 folds and drops (C3 step 8). */
export const LEGACY_TURN_TABLES = [
    'mesh_turn_attempts',
    'mesh_turn_events',
    'mesh_turn_held_suspensions',
    'mesh_session_delivery',
    'mesh_direct_dispatches',
    'mesh_completion_fingerprints',
    'mesh_inflight_hold',
    'mesh_pending_events',
    'mesh_event_ledger',
] as const;
export type LegacyTurnTable = typeof LEGACY_TURN_TABLES[number];

export const TURN_LEDGER_DDL = `
    CREATE TABLE IF NOT EXISTS turn_attempts (
        attempt_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('mesh_queue','mesh_direct','plain')),
        mesh_id TEXT,
        task_id TEXT,
        attempt_no INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL,
        node_id TEXT,
        provider_type TEXT,
        owner_daemon_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        prev_gen_session_id TEXT,
        prev_gen_consumed INTEGER,
        dispatch_nonce INTEGER,
        message_id TEXT,
        input_json TEXT,
        via TEXT,
        consume_profile TEXT NOT NULL DEFAULT 'default',
        max_task_retries INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL,
        suspension TEXT,
        redrive_count INTEGER NOT NULL DEFAULT 0,
        reclaim_count INTEGER NOT NULL DEFAULT 0,
        hollow_count INTEGER NOT NULL DEFAULT 0,
        liveness_fail_streak INTEGER NOT NULL DEFAULT 0,
        last_liveness TEXT,
        coordinator_daemon_id TEXT,
        coordinator_session_id TEXT,
        accepted_at INTEGER NOT NULL,
        delivered_at INTEGER,
        consumed_at INTEGER,
        last_activity_at INTEGER,
        last_probe_at INTEGER,
        weak_since INTEGER,
        candidate_notified_generation INTEGER,
        last_no_progress_notice_at INTEGER,
        notified_at INTEGER,
        terminal_outcome TEXT,
        terminal_reason TEXT,
        terminal_source TEXT,
        terminal_strength TEXT,
        terminal_at INTEGER,
        terminal_summary_json TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_turn_attempts_task
        ON turn_attempts(mesh_id, task_id, attempt_no) WHERE task_id IS NOT NULL;
    -- ≤1 open attempt per session.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_turn_attempts_open_session
        ON turn_attempts(session_id) WHERE terminal_outcome IS NULL;
    CREATE INDEX IF NOT EXISTS ix_turn_attempts_mesh_state
        ON turn_attempts(mesh_id, state);
    CREATE INDEX IF NOT EXISTS ix_turn_attempts_terminal_at
        ON turn_attempts(scope, terminal_at) WHERE terminal_outcome IS NOT NULL;

    CREATE TABLE IF NOT EXISTS turn_events (
        event_id TEXT PRIMARY KEY,
        mesh_id TEXT,
        attempt_id TEXT,
        generation INTEGER,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('applied','recorded','rejected','forwarded')),
        rule TEXT,
        rejection TEXT,
        dedupe_key TEXT NOT NULL DEFAULT '',
        from_state TEXT,
        to_state TEXT,
        -- local-only; may hold summaries / notice text (never published as-is)
        payload_json TEXT NOT NULL DEFAULT '{}',
        observed_by TEXT,
        src_writer TEXT,
        src_seq INTEGER,
        publish_state TEXT NOT NULL DEFAULT 'none' CHECK (publish_state IN ('none','pending','published')),
        published_seq INTEGER,
        at_ms INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        UNIQUE (attempt_id, generation, kind, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS ix_turn_events_unpublished
        ON turn_events(recorded_at) WHERE publish_state = 'pending';
    CREATE INDEX IF NOT EXISTS ix_turn_events_attempt
        ON turn_events(attempt_id, recorded_at);
    CREATE INDEX IF NOT EXISTS ix_turn_events_mesh_kind
        ON turn_events(mesh_id, kind, at_ms);

    CREATE TABLE IF NOT EXISTS turn_holds (
        hold_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        generation INTEGER,
        reason TEXT NOT NULL,
        until_ms INTEGER,
        on_expire TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_turn_holds_due ON turn_holds(status, until_ms);
    CREATE INDEX IF NOT EXISTS ix_turn_holds_attempt ON turn_holds(attempt_id, status);

    CREATE TABLE IF NOT EXISTS mesh_topic_index (
        writer TEXT NOT NULL,
        seq INTEGER NOT NULL,
        mesh_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ledger_kind TEXT,
        task_id TEXT,
        session_id TEXT,
        node_id TEXT,
        at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (writer, seq, mesh_id)
    );
    CREATE INDEX IF NOT EXISTS ix_topic_index_ledger_kind
        ON mesh_topic_index(mesh_id, ledger_kind, at_ms);
    CREATE INDEX IF NOT EXISTS ix_topic_index_session
        ON mesh_topic_index(mesh_id, session_id, at_ms);
    CREATE INDEX IF NOT EXISTS ix_topic_index_task
        ON mesh_topic_index(mesh_id, task_id, at_ms) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_topic_index_writer
        ON mesh_topic_index(mesh_id, writer, at_ms);
    CREATE INDEX IF NOT EXISTS ix_topic_index_event
        ON mesh_topic_index(mesh_id, event_id);

    CREATE TABLE IF NOT EXISTS mesh_operating_notes (
        note_id TEXT PRIMARY KEY,
        mesh_id TEXT NOT NULL,
        text TEXT NOT NULL,
        category TEXT,
        tombstoned_at INTEGER,
        caller_session_id TEXT,
        created_at INTEGER NOT NULL,
        -- C-W8: content-free lifecycle fields (pinned / expiresAt / supersedes /
        -- subjectKey / sourceCoordinator / text-tombstone marker), JSON.
        meta_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS ix_mesh_operating_notes_mesh
        ON mesh_operating_notes(mesh_id, created_at);

    CREATE TABLE IF NOT EXISTS mesh_local_records (
        event_id TEXT PRIMARY KEY,
        mesh_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        node_id TEXT,
        session_id TEXT,
        provider_type TEXT,
        task_id TEXT,
        at_ms INTEGER NOT NULL,
        -- local-only; may hold free text / nested objects (never published as-is)
        payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS ix_mesh_local_records_kind
        ON mesh_local_records(mesh_id, kind, at_ms);
    CREATE INDEX IF NOT EXISTS ix_mesh_local_records_time
        ON mesh_local_records(mesh_id, at_ms);
    CREATE INDEX IF NOT EXISTS ix_mesh_local_records_task
        ON mesh_local_records(mesh_id, task_id, at_ms) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_mesh_local_records_session
        ON mesh_local_records(mesh_id, session_id, at_ms) WHERE session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_mesh_local_records_at
        ON mesh_local_records(at_ms);
`;

/** Additive, idempotent: create every turn-ledger table and index (+ the C-W8 column add). */
export function ensureTurnLedgerSchema(db: DatabaseHandle): void {
    db.exec(TURN_LEDGER_DDL);
    const noteColumns = new Set((db.prepare(`PRAGMA table_info(mesh_operating_notes)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!noteColumns.has('meta_json')) db.exec(`ALTER TABLE mesh_operating_notes ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'`);
}

export function readUserVersion(db: DatabaseHandle): number {
    const value = db.pragma('user_version', { simple: true });
    return typeof value === 'number' ? value : Number(value) || 0;
}

export function tableExists(db: DatabaseHandle, table: string): boolean {
    const row = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { ok?: number } | undefined;
    return row?.ok === 1;
}
