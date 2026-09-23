/**
 * MeshRuntimeStore schema DDL + column migrations — extracted from
 * mesh-runtime-store.ts (behavior-preserving code move, file-size gate).
 *
 * These functions were `MeshRuntimeStore` methods; they now take the store
 * instance as `self` (same pattern as router.ts -> router-refine.ts, and the
 * sibling mesh-runtime-store-turn-attempts.ts). The class keeps thin delegating
 * wrappers, so the public surface and every existing call site are unchanged.
 * No DDL string, migration order, error handling, or result shape was changed —
 * only physical location + `this.` -> `self.`.
 *
 * `loggedMigrationFailure` lives here rather than in mesh-runtime-store.ts
 * because BOTH of its writers need the same one-shot flag: the legacy
 * beads.db->mesh-runtime.db rename in meshRuntimeStorePath() and the
 * mesh-isolation column migration below. Splitting it into two module-local
 * flags would turn one warn into two — a behavior change. It is exported as an
 * accessor pair so the single shared cell is preserved verbatim.
 */

import { LOG } from '../logging/logger.js';
import { migrateMeshGraphSchema } from './mesh-graph-schema.js';
import { ensureTurnLedgerSchema } from './turn-ledger/schema.js';
import type { MeshRuntimeStore } from './mesh-runtime-store.js';

let loggedMigrationFailureFlag = false;

/** Read the shared one-shot migration-failure log flag (see file header). */
export function hasLoggedMigrationFailure(): boolean {
    return loggedMigrationFailureFlag;
}

/** Set the shared one-shot migration-failure log flag (see file header). */
export function markLoggedMigrationFailure(): void {
    loggedMigrationFailureFlag = true;
}

export function migrate(self: MeshRuntimeStore): void {
    self.db.exec(`
        CREATE TABLE IF NOT EXISTS mesh_queue (
            id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            status TEXT NOT NULL,
            target_node_id TEXT,
            target_session_id TEXT,
            assigned_node_id TEXT,
            assigned_session_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            payload TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_queue_mesh_status_created
            ON mesh_queue(mesh_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_mesh_queue_assignment
            ON mesh_queue(mesh_id, assigned_node_id, assigned_session_id, status);
        -- Cross-mesh retention sweep (pruneTerminalQueueEntries) filters on status +
        -- updated_at with no mesh_id; without this it was a full table SCAN.
        CREATE INDEX IF NOT EXISTS idx_mesh_queue_status_updated
            ON mesh_queue(status, updated_at);

        -- C-W8: the legacy completion-fingerprint, direct-dispatch, session-delivery,
        -- pending-event and inflight-hold tables and the legacy turn tables are no
        -- longer created: their last writers are retired and
        -- turn-ledger/migrate-v2.ts drops them from existing DBs.

        -- MESH-ISOLATION-LEAK: mesh_id is part of the PK so a nodeId shared across two
        -- meshes (same machine in multiple repos) keeps a separate idle-session row per
        -- mesh, and getRemoteIdleSessions(meshId) can never surface another mesh's
        -- session for a queue claim.
        CREATE TABLE IF NOT EXISTS remote_idle_sessions (
            mesh_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            metadata TEXT,
            PRIMARY KEY (mesh_id, node_id, session_id)
        );

        -- MESH-COMPLEXITY-AUDIT Part 8-2: mesh_completion_conflicts removed
        -- (write-only fingerprint-collision diagnostic, no production reader,
        -- no no-loss role). Dropped in migrateMeshIsolationColumns step 6.

        CREATE TABLE IF NOT EXISTS mesh_tool_call_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mesh_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            session_id TEXT,
            caller_role TEXT,
            called_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_tool_call_log_mesh_tool_time
            ON mesh_tool_call_log(mesh_id, tool, called_at);

        -- G2: Event ledger — runtime source of truth for task/session lifecycle events.
        -- JSONL files are retained as export/import/debug/legacy artifacts only.
        CREATE TABLE IF NOT EXISTS mesh_event_ledger (
            id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            kind TEXT NOT NULL,
            node_id TEXT,
            session_id TEXT,
            provider_type TEXT,
            -- LEDGER-TASK-TRACEABILITY (B): the task a lifecycle entry pertains to,
            -- promoted from payload.taskId so kind+task_id joins are index-backed
            -- (legacy DBs get this column via migrateMeshIsolationColumns' ALTER).
            task_id TEXT,
            payload TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_event_ledger_mesh_time
            ON mesh_event_ledger(mesh_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_mesh_event_ledger_mesh_kind
            ON mesh_event_ledger(mesh_id, kind, timestamp);
        CREATE INDEX IF NOT EXISTS idx_mesh_event_ledger_session
            ON mesh_event_ledger(mesh_id, session_id, timestamp);

        -- M3: persistent mission records. Plans live in the system, not in the
        -- coordinator LLM's context. Progress is derived from task statuses at
        -- query time (mission_id on queue tasks) — never stored here.
        CREATE TABLE IF NOT EXISTS mesh_missions (
            id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            title TEXT NOT NULL,
            goal TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            source TEXT,
            -- G3: idempotency marker for the mission_close_candidate coordinator
            -- event. Set to the emit timestamp when all of a mission's tasks first
            -- become terminal (so the "consider closing this" nudge fires exactly
            -- once per all-terminal edge), and cleared back to NULL when the mission
            -- returns to a non-terminal state (new/re-opened task) so a later
            -- re-completion can nudge again. Never drives a status transition — the
            -- coordinator/human still decides via mesh_mission_upsert.
            close_candidate_emitted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_missions_mesh_status
            ON mesh_missions(mesh_id, status, updated_at);

        -- Load-balancing scheduler: per-mesh round-robin rotation cursor. When
        -- the schedulingStrategy spreads work ('fitness' with no task in scope),
        -- eligible nodes tied at the same (priority, load) are rotated by this
        -- cursor so the tie-break winner cycles across scheduling passes instead
        -- of always favouring the same array-order node. Persisted (not a module
        -- Map) so rotation survives daemon restarts and stays a single source of
        -- truth across scheduling entry points.
        CREATE TABLE IF NOT EXISTS mesh_scheduler_cursor (
            mesh_id TEXT PRIMARY KEY,
            cursor INTEGER NOT NULL DEFAULT 0
        );

        -- WORKER-MCP (design §5, decision C) — handoff note TEXT.
        --
        -- ★Why a table and not the meta index row's payload (turn_events since
        -- C-W8): that payload is content-free by design §9.1 (it stores the intent's
        -- LENGTH, never its text). The text lived only in an in-process Map, so
        -- its real lifetime was "until the daemon restarts" while its index row
        -- lived 30 days — and selectRelevantHandoffNotes skips any index row whose
        -- text is missing. Net effect: every note recorded before the last restart
        -- was permanently undeliverable, silently, while report_completion still
        -- answered "Handoff note stored — it will be delivered to related future
        -- tasks automatically."
        --
        -- Local-only: this table is never projected to the cloud status path, so
        -- the server content boundary is untouched. The seqscribe content-topic
        -- append (cross-machine delivery) is unchanged and still the other half.
        --
        -- Keyed by (mesh_id, task_id) — one note per task, matching the Map key it
        -- replaces and the UNIQUE(attempt_id, kind, '') on the index row. A re-report
        -- for the same task REPLACEs, so a corrected note supersedes its predecessor
        -- rather than accumulating.
        CREATE TABLE IF NOT EXISTS mesh_handoff_note_text (
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            attempt_id TEXT,
            node_id TEXT,
            notes_json TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            PRIMARY KEY (mesh_id, task_id)
        );

        -- The retention sweep deletes by age across all meshes.
        CREATE INDEX IF NOT EXISTS idx_mesh_handoff_note_text_recorded
            ON mesh_handoff_note_text(recorded_at);
    `);
    migrateMeshIsolationColumns(self);
    // GRAPH-ORCHESTRATION Phase A: additive graph tables (CREATE IF NOT EXISTS only). See mesh-graph-schema.ts.
    migrateMeshGraphSchema(self.db);
    // Wiring-unification C3: the turn-ledger tables (additive, idempotent). The
    // destructive fold of the legacy tables is migrate-v1 — run explicitly after
    // the store is open (MeshRuntimeStore.runTurnLedgerMigrationV1), never from
    // here: its step 0 re-enters the store singleton.
    ensureTurnLedgerSchema(self.db);
}


export function tableColumns(self: MeshRuntimeStore, table: string): Set<string> {
    const rows = self.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map(r => r.name));
}


/**
 * MESH-ISOLATION-LEAK migration. Two tables historically lacked a `mesh_id` column,
 * letting one machine that belongs to multiple meshes (multiple repos) leak rows
 * across meshes. Both migrations are idempotent and run on every boot — the column
 * check short-circuits once the new schema is in place.
 */
export function migrateMeshIsolationColumns(self: MeshRuntimeStore): void {
    try {
        // 1. (C-W8) The legacy completion-fingerprint table isolation column migration is
        //    gone with the table — no reader or writer is left, and migrate-v2 drops
        //    it from existing DBs.

        // 2. remote_idle_sessions: the mesh_id is part of the PRIMARY KEY, which SQLite
        //    cannot add via ALTER. The rows are ephemeral — sessions re-register on the
        //    next agent:ready / agent:generating_completed — so a safe DROP+recreate is
        //    acceptable (per fix spec) rather than a full table rebuild + un-backfillable
        //    mesh_id. Only rebuild when the legacy (no mesh_id) schema is detected.
        const idleCols = tableColumns(self, 'remote_idle_sessions');
        if (!idleCols.has('mesh_id')) {
            self.db.exec(`
                DROP TABLE IF EXISTS remote_idle_sessions;
                CREATE TABLE remote_idle_sessions (
                    mesh_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    provider_type TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    metadata TEXT,
                    PRIMARY KEY (mesh_id, node_id, session_id)
                );
            `);
        }

        // 3. mesh_missions.source: nullable provenance tag ('magi' | 'coordinator').
        //    Pre-existing rows keep source NULL — listMeshMissionSummaries treats a
        //    NULL/absent source as a coordinator mission (never auto-hidden), so the
        //    completed-MAGI bounding only ever affects rows explicitly stamped 'magi'.
        const missionCols = tableColumns(self, 'mesh_missions');
        if (!missionCols.has('source')) {
            self.db.exec(`ALTER TABLE mesh_missions ADD COLUMN source TEXT`);
        }
        // 3b. mesh_missions.close_candidate_emitted_at (G3): nullable idempotency
        //     marker for the mission_close_candidate coordinator nudge. Pre-existing
        //     rows keep it NULL — treated as "not yet emitted", so the first
        //     all-terminal detection after this migration emits once, then marks it.
        if (!missionCols.has('close_candidate_emitted_at')) {
            self.db.exec(`ALTER TABLE mesh_missions ADD COLUMN close_candidate_emitted_at TEXT`);
        }

        // 4 / 4b. (C-W8) The legacy pending-event inbox envelope columns and the `input`
        //    column on the legacy direct-dispatch table / the legacy session-delivery table went with those
        //    tables' retired writers. An existing DB keeps them only until
        //    migrate-v2 drops the tables (the v1 fold and the legacy pending-events
        //    JSONL import read them with SELECT * / tolerate a missing column).

        // 5. MESH-COMPLEXITY-AUDIT Part 8-1: drop the legacy mesh_direct_delivered_events
        //    table. It backed the retired R3 "direct-delivered" dedup marker
        //    (markMeshCoordinatorEventDirectDelivered / wasDirectDeliveredToCoordinator,
        //    removed when spontaneous PTY direct-inject was retired — see the NOTE in
        //    mesh-events-pending.ts). No live code CREATEs, reads, or writes it anymore,
        //    so this is a pure runtime-residue cleanup with no behavior change: a store
        //    that never had the table just no-ops (IF EXISTS), an old install carrying
        //    the dormant table has it removed once. Idempotent — DROP TABLE IF EXISTS is
        //    a no-op on every subsequent boot.
        self.db.exec(`DROP TABLE IF EXISTS mesh_direct_delivered_events`);

        // 6. MESH-COMPLEXITY-AUDIT Part 8-2: drop the mesh_completion_conflicts
        //    diagnostic table. It recorded which task lost a completion-fingerprint
        //    dedup collision but had NO production reader (getRecentCompletionConflicts
        //    was test-only) and played NO part in the no-loss delivery contract — the
        //    dedup DECISION is the fingerprint match in mesh-event-forwarding.ts and is
        //    unchanged. Pure runtime-residue cleanup with no behavior change: a fresh
        //    store never creates it; an old install drops the dormant table once.
        //    Idempotent — DROP TABLE IF EXISTS is a no-op on every subsequent boot.
        self.db.exec(`DROP TABLE IF EXISTS mesh_completion_conflicts`);

        // 7. LEDGER-TASK-TRACEABILITY (B): mesh_event_ledger.task_id. A pre-existing
        //    DB has the ledger table (CREATE IF NOT EXISTS is a no-op) without this
        //    column, so add it. Nullable — legacy rows read back with task_id NULL and
        //    fall back to payload.taskId at the read layer (ledgerEntryTaskId), so no
        //    backfill is needed. Idempotent: the column check short-circuits once present.
        const ledgerCols = tableColumns(self, 'mesh_event_ledger');
        if (!ledgerCols.has('task_id')) {
            self.db.exec(`ALTER TABLE mesh_event_ledger ADD COLUMN task_id TEXT`);
        }
        // kind+task_id join index (task lifecycle timeline). Created unconditionally —
        // IF NOT EXISTS is a no-op once present; the column is guaranteed above.
        self.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_mesh_event_ledger_task
                ON mesh_event_ledger(mesh_id, task_id, timestamp)
                WHERE task_id IS NOT NULL
        `);

        // 8. MESH-TOOL-CALL-CALLER-INSTRUMENTATION (1단계): mesh_tool_call_log.caller_role.
        //    Nullable provenance tag ('coordinator' | 'unknown') recording whether the
        //    process that made this tool call carried ADHDEV_COORDINATOR_SESSION_ID at
        //    launch. Pre-existing rows read back NULL — they predate this instrumentation
        //    and are simply unclassified, not "unknown" in the observed sense. See
        //    recordMeshToolCall for why this is a diagnostic signal, not an auth boundary.
        const toolCallCols = tableColumns(self, 'mesh_tool_call_log');
        if (!toolCallCols.has('caller_role')) {
            self.db.exec(`ALTER TABLE mesh_tool_call_log ADD COLUMN caller_role TEXT`);
        }

        // 9. ★ Stage 5c-1: drop the retired `mesh_turn_outbox` table (design
        //    docs/design/2026-08-29-seqscribe-outbox-migration.md §5 row 1).
        //    Same shape as steps 5 and 6 above: nothing CREATEs, reads or
        //    writes it any more, so a fresh store never has it and an existing
        //    one sheds it once. Idempotent — DROP TABLE IF EXISTS no-ops on
        //    every later boot, and dropping a table takes its indexes with it.
        //
        //    ★ Dropping rather than leaving it dormant is deliberate and is
        //    the one genuinely irreversible step of 5c-1. It is safe because
        //    5b established, on live evidence, that the table is EMPTY of work:
        //    5b-1 blocked enqueue (new rows 0) and 5b-2 disarmed the drain
        //    pumps only after the residue was observed empty across
        //    REQUIRED_CLEAN_SWEEPS consecutive sweeps. What remains in an old
        //    DB is `delivered` / `failed` history — rows this machine never
        //    pruned (there was no DELETE path anywhere in the tree, which is
        //    §11-4's defect ② and is resolved by this drop rather than by a
        //    retention sweep that would exist only to be deleted).
        //
        //    ★ A pending row surviving here would be a completion notification
        //    that never reached its coordinator. That cannot be recovered by a
        //    flag revert after this point, which is why the drop is gated on
        //    the 5b sweep evidence rather than run speculatively.
        self.db.exec(`DROP TABLE IF EXISTS mesh_turn_outbox`);
    } catch (err: any) {
        // Best-effort: a failed isolation migration must not brick the store. The
        // CREATE-TABLE definitions above already carry the new schema for fresh DBs;
        // an existing DB that fails here keeps the old (leaky-but-functional) schema
        // until the next boot retries. Surface one warn for diagnosability.
        if (!hasLoggedMigrationFailure()) {
            markLoggedMigrationFailure();
            LOG.warn('MeshRuntimeStore', `mesh-isolation column migration failed: ${err?.message || err}`);
        }
    }
}
