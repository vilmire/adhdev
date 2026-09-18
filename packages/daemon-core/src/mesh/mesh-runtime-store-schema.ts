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

        -- mesh_id is DB-level isolation (defense-in-depth). The fingerprint STRING
        -- also carries meshId as its first '::'-joined segment (see
        -- buildMeshCompletionFingerprint) — that string-prefix defense is kept; this
        -- column makes cross-mesh suppression impossible even if the string format
        -- drifts or two meshes ever collide on a fingerprint body.
        CREATE TABLE IF NOT EXISTS mesh_completion_fingerprints (
            fingerprint TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL,
            mesh_id TEXT NOT NULL DEFAULT ''
        );
        -- NOTE: the (mesh_id, fingerprint) index is created in migrateMeshIsolationColumns,
        -- NOT here. A pre-isolation DB still has the legacy table (CREATE IF NOT EXISTS is a
        -- no-op), so referencing mesh_id in an index before the ALTER ADD COLUMN runs would
        -- fail with "no such column". The migration adds the column then the index.

        CREATE TABLE IF NOT EXISTS mesh_direct_dispatches (
            task_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            node_id TEXT,
            session_id TEXT,
            provider_type TEXT,
            message TEXT NOT NULL,
            -- MESH-IMAGE-DISPATCH: serialized multipart input envelope (JSON) that
            -- accompanied the message, or NULL for an ordinary text-only dispatch.
            -- Nullable and additive so pre-existing rows read back exactly as before.
            input TEXT,
            task_mode TEXT,
            via TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'dispatched',
            dispatched_to_idle_session INTEGER NOT NULL DEFAULT 0,
            dispatched_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_direct_dispatches_mesh_session
            ON mesh_direct_dispatches(mesh_id, session_id, status);

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

        CREATE TABLE IF NOT EXISTS mesh_session_delivery (
            id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            node_id TEXT,
            session_id TEXT,
            provider_type TEXT,
            task_id TEXT,
            kind TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            message TEXT NOT NULL,
            -- MESH-IMAGE-DISPATCH: see mesh_direct_dispatches.input — same nullable
            -- serialized multipart envelope, so a queued delivery can carry an
            -- attachment through to the moment the session goes idle.
            input TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            deliver_after TEXT,
            expires_at TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            source_coordinator_session_id TEXT,
            source_coordinator_daemon_id TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_session_delivery_mesh_status
            ON mesh_session_delivery(mesh_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_mesh_session_delivery_session
            ON mesh_session_delivery(mesh_id, session_id, status);
        CREATE INDEX IF NOT EXISTS idx_mesh_session_delivery_task
            ON mesh_session_delivery(mesh_id, task_id);

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

        -- G3: Pending coordinator event inbox — replaces <meshId>.pending-events.jsonl.
        -- Coordinator drains this table on get_pending_mesh_events, then deletes drained rows.
        CREATE TABLE IF NOT EXISTS mesh_pending_events (
            id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            coordinator_daemon_id TEXT,
            event TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            fingerprint TEXT,
            queued_at INTEGER NOT NULL,
            drained INTEGER NOT NULL DEFAULT 0,
            drained_at INTEGER,
            -- v2 protocol envelope (B2a). All nullable so pre-v2 rows and events
            -- emitted before a coordinator identity is known coexist as v1. The
            -- authoritative copy of each also rides inside the payload column; these
            -- columns exist for queryable idempotency (event_id) and scope-based drain
            -- filtering without JSON-parsing every row. dispatched_by / intended_for
            -- hold the JSON-serialized CoordinatorIdentity.
            protocol_version TEXT,
            event_id TEXT,
            scope TEXT,
            dispatched_by TEXT,
            intended_for TEXT,
            -- REFINE-EVENT-SESSION-SCOPED-UNICAST: WHO consumed this row. The ledger
            -- previously recorded only THAT an event was drained, never by which
            -- coordinator identity — so a mis-delivered unicast (a sibling session
            -- consuming another coordinator's event) left no evidence and had to be
            -- inferred. Written at drain time as the JSON-serialized drainer
            -- CoordinatorIdentity. NULL on rows drained before this column existed
            -- and on any drain whose caller passed no identity (daemon-level drain).
            drained_by TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_pending_events_mesh_drained
            ON mesh_pending_events(mesh_id, drained, queued_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_pending_events_fingerprint
            ON mesh_pending_events(mesh_id, fingerprint)
            WHERE fingerprint IS NOT NULL;

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

        -- T2 (B2b): persistent acked-hold state for in-flight direct dispatches.
        -- The reconcile loop's PHASE-4 acked-hold (death-consequence counter,
        -- fast-track idle streak, live-confirmed flag) used to live only in a
        -- process-local Map (mesh-reconcile-loop.ts inFlightAckedHoldState), so a
        -- daemon restart lost it — re-opening the door to the duplicate-emit / drop
        -- window that the PHASE-4 transcript synth backstop then had to correct after
        -- the fact. Persisting it lets the state survive a restart: the loop
        -- rehydrates the Map from this table on first touch and stays read-through /
        -- write-through against it thereafter. Keyed by task_id (one hold per
        -- in-flight dispatch); mesh_id is carried for per-mesh listing / prune.
        --   hold_reason         — 'live' once a conclusive read confirmed the session
        --                         reachable since the ack, else 'unconfirmed' (drives
        --                         the death-backstop's liveConfirmedSinceAck gate).
        --   held_at             — ms epoch the hold row was first created.
        --   first_idle_since_ack — ms epoch of the FIRST tick in the current continuous
        --                         idle-with-final-assistant run (fast-track streak); NULL
        --                         when the streak is broken / not yet started.
        --   read_failure_count  — consecutive read_chat failures since the last
        --                         conclusive read (death backstop (a)).
        CREATE TABLE IF NOT EXISTS mesh_inflight_hold (
            task_id TEXT PRIMARY KEY,
            mesh_id TEXT,
            hold_reason TEXT,
            held_at INTEGER,
            first_idle_since_ack INTEGER,
            read_failure_count INTEGER,
            updated_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_inflight_hold_mesh
            ON mesh_inflight_hold(mesh_id);

        -- TURN-LEDGER (Stage 5): the authoritative causal turn transaction per task
        -- ATTEMPT. One row per (mesh_id, task_id, attempt_seq); attempt_seq is the
        -- dispatch nonce the attempt was opened under (monotonic per task), so a
        -- reclaim/re-dispatch opens a NEW attempt row while late events against the
        -- old attempt are rejected by identity, never applied. The stage column is a
        -- monotonic causal FSM (accepted → delivered → consumed → generating →
        -- [waiting_approval|waiting_choice] → finalizing → terminal); terminal_outcome
        -- is committed at most once via a conditional UPDATE (exactly-once logical
        -- completion). JSONL/ledger tables remain audit/export only — THIS table is
        -- the single mutable source of truth for turn state.
        CREATE TABLE IF NOT EXISTS mesh_turn_attempts (
            attempt_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            attempt_seq INTEGER NOT NULL,
            node_id TEXT,
            session_id TEXT,
            provider_type TEXT,
            coordinator_daemon_id TEXT,
            coordinator_session_id TEXT,
            dispatch_nonce INTEGER,
            stage TEXT NOT NULL DEFAULT 'accepted',
            redrive_count INTEGER NOT NULL DEFAULT 0,
            lease_deadline_ms INTEGER,
            accepted_at TEXT,
            delivered_at TEXT,
            consumed_at TEXT,
            terminal_outcome TEXT,
            terminal_reason TEXT,
            terminal_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (mesh_id, task_id, attempt_seq)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_turn_attempts_task
            ON mesh_turn_attempts(mesh_id, task_id, attempt_seq);
        CREATE INDEX IF NOT EXISTS idx_mesh_turn_attempts_session
            ON mesh_turn_attempts(mesh_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_mesh_turn_attempts_stage
            ON mesh_turn_attempts(mesh_id, stage);

        -- TURN-LEDGER (Stage 5): append-only, idempotency-keyed causal event log per
        -- attempt. UNIQUE(attempt_id, kind, dedupe_key) makes repeated/reordered ACKs
        -- and duplicate completion proposals insert-once (INSERT OR IGNORE → the
        -- reducer reads the existing row and treats the re-arrival as a duplicate).
        CREATE TABLE IF NOT EXISTS mesh_turn_events (
            event_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            dedupe_key TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL DEFAULT '{}',
            occurred_at_ms INTEGER,
            recorded_at TEXT NOT NULL,
            UNIQUE (attempt_id, kind, dedupe_key)
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_turn_events_task
            ON mesh_turn_events(mesh_id, task_id, kind);

        -- WORKER-MCP (design §5): by-kind probes; see mesh-turn-event-queries.ts.
        CREATE INDEX IF NOT EXISTS idx_mesh_turn_events_kind
            ON mesh_turn_events(mesh_id, kind, recorded_at);

        -- ★ Stage 5c-1: mesh_turn_outbox was defined here. It is no longer
        -- created; existing DBs have it dropped by migrateMeshIsolationColumns
        -- step 9. The re-drive guarantee it carried is now the seqscribe
        -- redrive consumer's durable cursor (mesh-terminal-redrive.ts).

        -- TURN-LEDGER (Stage 5): durable HELD SUSPENSIONS. A waiting_approval /
        -- waiting_choice edge can legitimately arrive BEFORE the consumed ACK
        -- (a fast picker fires ahead of the generating_started processing, whose
        -- attempt-resolution preamble defers the consumed write). The causal FSM
        -- rightly refuses accepted/delivered → waiting_*; instead of dropping the
        -- edge, the reducer holds it here — attempt/session/epoch-scoped and
        -- content-free — insert-once via hold_id (<attempt_id>:<stage>). The
        -- consumed commit applies the hold through the SAME FSM in the same
        -- transaction; the restart reconcile drain covers a crash between hold
        -- and consumed; terminal commits resolve held rows as dropped so a held
        -- picker can never resurrect a finished/reassigned attempt.
        CREATE TABLE IF NOT EXISTS mesh_turn_held_suspensions (
            hold_id TEXT PRIMARY KEY,
            mesh_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            stage TEXT NOT NULL,
            session_id TEXT,
            dispatch_nonce INTEGER,
            occurred_at_ms INTEGER,
            recorded_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'held',
            resolution TEXT,
            resolved_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_mesh_turn_held_suspensions_mesh
            ON mesh_turn_held_suspensions(mesh_id, status);
        CREATE INDEX IF NOT EXISTS idx_mesh_turn_held_suspensions_attempt
            ON mesh_turn_held_suspensions(attempt_id, status);
    `);
    migrateMeshIsolationColumns(self);
    // GRAPH-ORCHESTRATION Phase A: additive graph tables (CREATE IF NOT EXISTS only). See mesh-graph-schema.ts.
    migrateMeshGraphSchema(self.db);
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
        // 1. mesh_completion_fingerprints: ADD COLUMN + backfill mesh_id from the
        //    fingerprint string's first '::'-joined segment (buildMeshCompletionFingerprint
        //    prefixes meshId). A row whose fingerprint has no '::' (legacy/foreign format)
        //    backfills to '' — still strictly tighter than the prior global query.
        const fpCols = tableColumns(self, 'mesh_completion_fingerprints');
        if (!fpCols.has('mesh_id')) {
            self.db.exec(`ALTER TABLE mesh_completion_fingerprints ADD COLUMN mesh_id TEXT NOT NULL DEFAULT ''`);
            self.db.exec(`
                UPDATE mesh_completion_fingerprints
                SET mesh_id = substr(fingerprint, 1, instr(fingerprint, '::') - 1)
                WHERE instr(fingerprint, '::') > 0 AND mesh_id = ''
            `);
        }
        // The mesh_id column is now guaranteed to exist (fresh DB had it from CREATE TABLE,
        // legacy DB just got it via ALTER). Create the index unconditionally — IF NOT EXISTS
        // makes it a no-op once present.
        self.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_mesh_completion_fingerprints_mesh
                ON mesh_completion_fingerprints(mesh_id, fingerprint)
        `);

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

        // 4. mesh_pending_events v2 envelope columns (B2a). A pre-v2 DB has the
        //    table (CREATE IF NOT EXISTS is a no-op) without these columns, so add
        //    each missing one. All nullable — legacy rows read back as v1 events
        //    (protocol_version NULL) with no reader change. Idempotent: the column
        //    check short-circuits once present, and every ADD COLUMN is guarded.
        //    `drained_by` (REFINE-EVENT-SESSION-SCOPED-UNICAST) joins the same
        //    additive-nullable set: existing rows read back NULL, meaning "drained
        //    before drainer attribution existed / drained without an identity" — it is
        //    never interpreted as an identity, only rendered as unknown.
        const pendingCols = tableColumns(self, 'mesh_pending_events');
        for (const col of ['protocol_version', 'event_id', 'scope', 'dispatched_by', 'intended_for', 'drained_by'] as const) {
            if (!pendingCols.has(col)) {
                self.db.exec(`ALTER TABLE mesh_pending_events ADD COLUMN ${col} TEXT`);
            }
        }
        // 4b. MESH-IMAGE-DISPATCH: `input` on the two dispatch/delivery tables. An
        //     existing DB already has both tables, so the CREATE TABLE IF NOT EXISTS
        //     above is a no-op there and the new column must be ALTERed in — otherwise
        //     every insert carrying an attachment fails with "no such column: input" on
        //     precisely the installs that have been running longest. Nullable and
        //     additive: legacy rows read back NULL, which means "text-only dispatch",
        //     exactly what they were.
        const directDispatchCols = tableColumns(self, 'mesh_direct_dispatches');
        if (!directDispatchCols.has('input')) {
            self.db.exec(`ALTER TABLE mesh_direct_dispatches ADD COLUMN input TEXT`);
        }
        const sessionDeliveryCols = tableColumns(self, 'mesh_session_delivery');
        if (!sessionDeliveryCols.has('input')) {
            self.db.exec(`ALTER TABLE mesh_session_delivery ADD COLUMN input TEXT`);
        }

        // Idempotency index on event_id (partial: only stamped v2 rows). Created
        // unconditionally — IF NOT EXISTS makes it a no-op once present, and the
        // event_id column is guaranteed to exist by the loop above.
        self.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_mesh_pending_events_event_id
                ON mesh_pending_events(mesh_id, event_id)
                WHERE event_id IS NOT NULL
        `);

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
