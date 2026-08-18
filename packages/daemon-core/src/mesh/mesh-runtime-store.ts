import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { LOG } from '../logging/logger.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';
import { getConfigDir } from '../config/config.js';
import { getLedgerDir } from './mesh-ledger.js';
import { resolveSessionDeliveryRetentionMs } from './mesh-retention-config.js';
import { nodeSatisfiesRequiredTags, isTaskReadonly, taskDependenciesSatisfied, meshTaskNotBeforeReady, meshTaskPriorityRank } from './mesh-work-queue.js';
import { migrateMeshGraphSchema } from './mesh-graph-schema.js';
import { MeshGraphStore } from './mesh-graph-store.js';
import { modelNamesEquivalent } from './slot-model-enforcement.js';
import { effectiveSlotCap } from './mesh-daemon-slot-axis.js';
import { meshNodeIdMatches, daemonIdsEquivalent, expandDaemonIdForms, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { MeshTaskStatus, MeshWorkQueueEntry } from './mesh-work-queue.js';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

let DatabaseCtor: typeof BetterSqlite3 | undefined;

function loadDatabaseCtor(): typeof BetterSqlite3 {
    if (DatabaseCtor) return DatabaseCtor;
    DatabaseCtor = loadBetterSqlite3() as typeof BetterSqlite3;
    return DatabaseCtor;
}

function safeMeshId(meshId: string): string {
    return meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// T2 (B2b): a persisted acked-hold record for one in-flight direct dispatch. The
// reconcile loop keeps a Map cache of these but this row is the SSOT so the hold
// survives a daemon restart. See the mesh_inflight_hold table comment.
export interface MeshInflightHoldRow {
    taskId: string;
    meshId: string | null;
    holdReason: string | null;
    heldAt: number | null;
    firstIdleSinceAck: number | null;
    readFailureCount: number | null;
    updatedAt: number | null;
}

function legacyQueuePath(meshId: string): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.queue.json`);
}

let loggedMigrationFailure = false;
let loggedStrayCleanup = false;

/**
 * MESH-COMPLEXITY-AUDIT Part 8-1: one-shot hygiene for a stray root mesh-runtime.db.
 *
 * The store lives at `~/.adhdev/mesh-ledger/mesh-runtime.db` (getLedgerDir()). An older
 * build path could create a 0-byte `mesh-runtime.db` directly under `~/.adhdev/` — a
 * dead file that is never opened or read (the canonical path is the only one used) but
 * lingers. Remove it if and only if it is provably that stray: (a) exists, (b) is NOT the
 * canonical store path, and (c) is empty (0 bytes). The size gate is the safety belt — we
 * never unlink a non-empty file, so a real DB that somehow landed here is left untouched
 * and surfaces as data rather than being silently deleted. Best-effort: any error is
 * swallowed (with one diagnostic warn), never blocking store init.
 */
function cleanupStrayRootRuntimeDb(canonicalPath: string): void {
    try {
        const strayPath = join(getConfigDir(), 'mesh-runtime.db');
        if (strayPath === canonicalPath) return; // canonical dir IS the config dir — never touch
        if (!existsSync(strayPath)) return;
        if (statSync(strayPath).size !== 0) return; // non-empty → not the known 0-byte stray; leave it
        unlinkSync(strayPath);
        if (!loggedStrayCleanup) {
            loggedStrayCleanup = true;
            LOG.info('MeshRuntimeStore', `Removed stray 0-byte root mesh-runtime.db at ${strayPath}`);
        }
    } catch (err: any) {
        if (!loggedStrayCleanup) {
            loggedStrayCleanup = true;
            LOG.warn('MeshRuntimeStore', `Stray root mesh-runtime.db cleanup failed (ignored): ${err?.message || err}`);
        }
    }
}

function meshRuntimeStorePath(): string {
    const dir = getLedgerDir();
    const nextPath = join(dir, 'mesh-runtime.db');
    cleanupStrayRootRuntimeDb(nextPath);
    if (existsSync(nextPath)) return nextPath;

    const legacyPath = join(dir, 'beads.db');
    if (!existsSync(legacyPath)) return nextPath;

    try {
        renameSync(legacyPath, nextPath);
        for (const suffix of ['-wal', '-shm']) {
            const legacyCompanion = `${legacyPath}${suffix}`;
            if (existsSync(legacyCompanion)) {
                renameSync(legacyCompanion, `${nextPath}${suffix}`);
            }
        }
    } catch (err: any) {
        // Migration failed — most commonly win32 EPERM when a handle to the
        // legacy DB is still open. Do NOT fall through to opening `nextPath`:
        // that would create a fresh EMPTY store while the existing data stays
        // stranded in the legacy file (split-brain / silent data loss). Instead
        // keep using whichever file actually holds the data in-place — the next
        // boot retries the rename. If the main rename already landed (only a
        // companion file failed), the data is at nextPath; otherwise it is still
        // at legacyPath.
        if (!loggedMigrationFailure) {
            loggedMigrationFailure = true;
            LOG.warn(
                'MeshRuntimeStore',
                `Legacy beads.db→mesh-runtime.db migration failed; using existing DB in-place to avoid data loss: ${err?.message || err}`,
            );
        }
        return existsSync(nextPath) ? nextPath : legacyPath;
    }
    return nextPath;
}

export class MeshRuntimeStore {
    private static instance: MeshRuntimeStore | undefined;
    private readonly db: DatabaseHandle;
    private readonly dbPath: string;
    private readonly migratedMeshIds = new Set<string>();
    // Idle-active-mission-reminder debounce (mesh-idle-reminder.ts). In-memory only:
    // this is a spam guard for a best-effort coordinator nudge, so a daemon restart
    // resetting it (at most one extra reminder) is harmless — no SQLite persistence
    // is warranted. Keyed by meshId; the value records when the last reminder fired
    // and the hash of the active-mission id set it named, so a changed mission set
    // re-fires before the time window elapses.
    private readonly idleReminderState = new Map<string, { emittedAt: number; missionSetHash: string }>();
    private fingerprintSweepCounter = 0;
    private walWriteCounter = 0;
    // Independent cadence for the tool-call-log sweep. Must NOT share walWriteCounter:
    // sharing makes each store's threshold drift by the other's write volume (WAL
    // checkpoint at 500 vs tool-log sweep at 200 would interfere arbitrarily).
    private toolCallLogCounter = 0;
    private static readonly WAL_CHECK_INTERVAL = 500;
    private static readonly WAL_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

    private constructor(dbPath: string) {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        this.dbPath = dbPath;
        this.db = new (loadDatabaseCtor())(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('busy_timeout = 5000');
        this.migrate();
    }

    private static loggedGetInstanceFailure = false;

    static getInstance(): MeshRuntimeStore {
        if (!this.instance) {
            try {
                this.instance = new MeshRuntimeStore(meshRuntimeStorePath());
            } catch (err: any) {
                // SQLite store could not be opened (e.g. better-sqlite3 native
                // load failure, locked/corrupt DB). Callers wrap getInstance in
                // try/catch and silently degrade to JSONL-only — surface ONE warn
                // so that degraded mode is diagnosable, then re-throw unchanged.
                if (!MeshRuntimeStore.loggedGetInstanceFailure) {
                    MeshRuntimeStore.loggedGetInstanceFailure = true;
                    LOG.warn(
                        'MeshRuntimeStore',
                        `getInstance failed; callers will degrade to JSONL-only: ${err?.message || err}`,
                    );
                }
                throw err;
            }
        }
        return this.instance;
    }

    static resetForTests(): void {
        this.instance?.close();
        this.instance = undefined;
    }

    /**
     * VACUUM the SQLite database to reclaim on-disk space. Retention prunes rows
     * with DELETE, which frees pages inside the file but does NOT shrink it — the
     * mesh-runtime.db grew to hundreds of MB (mission 86def38d disk-accumulation
     * bootstrap failure) precisely because the file was never compacted. This
     * rewrites the DB into a minimal footprint. Best-effort: a VACUUM failure (e.g.
     * insufficient temp space, a read lock) is logged and swallowed so it can never
     * block daemon shutdown. Called once on shutdown (see daemon-lifecycle), never
     * on the hot path — VACUUM takes an exclusive lock and rewrites the whole file.
     */
    vacuum(): void {
        try {
            // Fold the WAL back into the main DB first so VACUUM reclaims those pages too.
            try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* checkpoint best-effort */ }
            this.db.exec('VACUUM;');
            LOG.info('MeshRuntimeStore', 'VACUUM completed on shutdown');
        } catch (err: any) {
            LOG.warn('MeshRuntimeStore', `VACUUM on shutdown failed (ignored): ${err?.message || err}`);
        }
    }

    close(): void {
        this.db.close();
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn).immediate();
    }

    /** GRAPH-ORCHESTRATION Phase A: row-CRUD over the additive graph tables, bound to
     * THIS handle so phase-B graph writes can join the one queue transaction. */
    private graphStoreInstance: MeshGraphStore | undefined;
    graphStore(): MeshGraphStore {
        if (!this.graphStoreInstance) this.graphStoreInstance = new MeshGraphStore(this.db);
        return this.graphStoreInstance;
    }

    private migrate(): void {
        this.db.exec(`
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

            -- TURN-LEDGER (Stage 5): durable outbound delivery state (coordinator-bound
            -- completion / ACK notifications) for restart recovery. A row is enqueued in
            -- the SAME transaction as the reducer's terminal commit, so a crash between
            -- commit and network delivery can never lose the notification; on boot the
            -- drain resumes from status='pending' rows. Exactly-once logical delivery is
            -- enforced by the row id (the attempt's terminal event id) — re-enqueue is
            -- INSERT OR IGNORE — and by the downstream pending-events fingerprint dedup.
            CREATE TABLE IF NOT EXISTS mesh_turn_outbox (
                id TEXT PRIMARY KEY,
                mesh_id TEXT NOT NULL,
                attempt_id TEXT,
                task_id TEXT,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at_ms INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_turn_outbox_due
                ON mesh_turn_outbox(status, next_attempt_at_ms);
            CREATE INDEX IF NOT EXISTS idx_mesh_turn_outbox_mesh
                ON mesh_turn_outbox(mesh_id, status);

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
        this.migrateMeshIsolationColumns();
        // GRAPH-ORCHESTRATION Phase A: additive graph tables (CREATE IF NOT EXISTS only). See mesh-graph-schema.ts.
        migrateMeshGraphSchema(this.db);
    }

    private tableColumns(table: string): Set<string> {
        const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        return new Set(rows.map(r => r.name));
    }

    /**
     * MESH-ISOLATION-LEAK migration. Two tables historically lacked a `mesh_id` column,
     * letting one machine that belongs to multiple meshes (multiple repos) leak rows
     * across meshes. Both migrations are idempotent and run on every boot — the column
     * check short-circuits once the new schema is in place.
     */
    private migrateMeshIsolationColumns(): void {
        try {
            // 1. mesh_completion_fingerprints: ADD COLUMN + backfill mesh_id from the
            //    fingerprint string's first '::'-joined segment (buildMeshCompletionFingerprint
            //    prefixes meshId). A row whose fingerprint has no '::' (legacy/foreign format)
            //    backfills to '' — still strictly tighter than the prior global query.
            const fpCols = this.tableColumns('mesh_completion_fingerprints');
            if (!fpCols.has('mesh_id')) {
                this.db.exec(`ALTER TABLE mesh_completion_fingerprints ADD COLUMN mesh_id TEXT NOT NULL DEFAULT ''`);
                this.db.exec(`
                    UPDATE mesh_completion_fingerprints
                    SET mesh_id = substr(fingerprint, 1, instr(fingerprint, '::') - 1)
                    WHERE instr(fingerprint, '::') > 0 AND mesh_id = ''
                `);
            }
            // The mesh_id column is now guaranteed to exist (fresh DB had it from CREATE TABLE,
            // legacy DB just got it via ALTER). Create the index unconditionally — IF NOT EXISTS
            // makes it a no-op once present.
            this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_mesh_completion_fingerprints_mesh
                    ON mesh_completion_fingerprints(mesh_id, fingerprint)
            `);

            // 2. remote_idle_sessions: the mesh_id is part of the PRIMARY KEY, which SQLite
            //    cannot add via ALTER. The rows are ephemeral — sessions re-register on the
            //    next agent:ready / agent:generating_completed — so a safe DROP+recreate is
            //    acceptable (per fix spec) rather than a full table rebuild + un-backfillable
            //    mesh_id. Only rebuild when the legacy (no mesh_id) schema is detected.
            const idleCols = this.tableColumns('remote_idle_sessions');
            if (!idleCols.has('mesh_id')) {
                this.db.exec(`
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
            const missionCols = this.tableColumns('mesh_missions');
            if (!missionCols.has('source')) {
                this.db.exec(`ALTER TABLE mesh_missions ADD COLUMN source TEXT`);
            }
            // 3b. mesh_missions.close_candidate_emitted_at (G3): nullable idempotency
            //     marker for the mission_close_candidate coordinator nudge. Pre-existing
            //     rows keep it NULL — treated as "not yet emitted", so the first
            //     all-terminal detection after this migration emits once, then marks it.
            if (!missionCols.has('close_candidate_emitted_at')) {
                this.db.exec(`ALTER TABLE mesh_missions ADD COLUMN close_candidate_emitted_at TEXT`);
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
            const pendingCols = this.tableColumns('mesh_pending_events');
            for (const col of ['protocol_version', 'event_id', 'scope', 'dispatched_by', 'intended_for', 'drained_by'] as const) {
                if (!pendingCols.has(col)) {
                    this.db.exec(`ALTER TABLE mesh_pending_events ADD COLUMN ${col} TEXT`);
                }
            }
            // Idempotency index on event_id (partial: only stamped v2 rows). Created
            // unconditionally — IF NOT EXISTS makes it a no-op once present, and the
            // event_id column is guaranteed to exist by the loop above.
            this.db.exec(`
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
            this.db.exec(`DROP TABLE IF EXISTS mesh_direct_delivered_events`);

            // 6. MESH-COMPLEXITY-AUDIT Part 8-2: drop the mesh_completion_conflicts
            //    diagnostic table. It recorded which task lost a completion-fingerprint
            //    dedup collision but had NO production reader (getRecentCompletionConflicts
            //    was test-only) and played NO part in the no-loss delivery contract — the
            //    dedup DECISION is the fingerprint match in mesh-event-forwarding.ts and is
            //    unchanged. Pure runtime-residue cleanup with no behavior change: a fresh
            //    store never creates it; an old install drops the dormant table once.
            //    Idempotent — DROP TABLE IF EXISTS is a no-op on every subsequent boot.
            this.db.exec(`DROP TABLE IF EXISTS mesh_completion_conflicts`);

            // 7. LEDGER-TASK-TRACEABILITY (B): mesh_event_ledger.task_id. A pre-existing
            //    DB has the ledger table (CREATE IF NOT EXISTS is a no-op) without this
            //    column, so add it. Nullable — legacy rows read back with task_id NULL and
            //    fall back to payload.taskId at the read layer (ledgerEntryTaskId), so no
            //    backfill is needed. Idempotent: the column check short-circuits once present.
            const ledgerCols = this.tableColumns('mesh_event_ledger');
            if (!ledgerCols.has('task_id')) {
                this.db.exec(`ALTER TABLE mesh_event_ledger ADD COLUMN task_id TEXT`);
            }
            // kind+task_id join index (task lifecycle timeline). Created unconditionally —
            // IF NOT EXISTS is a no-op once present; the column is guaranteed above.
            this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_mesh_event_ledger_task
                    ON mesh_event_ledger(mesh_id, task_id, timestamp)
                    WHERE task_id IS NOT NULL
            `);
        } catch (err: any) {
            // Best-effort: a failed isolation migration must not brick the store. The
            // CREATE-TABLE definitions above already carry the new schema for fresh DBs;
            // an existing DB that fails here keeps the old (leaky-but-functional) schema
            // until the next boot retries. Surface one warn for diagnosability.
            if (!loggedMigrationFailure) {
                loggedMigrationFailure = true;
                LOG.warn('MeshRuntimeStore', `mesh-isolation column migration failed: ${err?.message || err}`);
            }
        }
    }

    hasCompletionFingerprint(meshId: string, fingerprint: string): boolean {
        const now = Date.now();
        // Scope by mesh_id (defense-in-depth) AS WELL AS the fingerprint string, whose
        // first '::' segment already encodes meshId. A fingerprint can only suppress a
        // duplicate within its own mesh.
        const row = this.db
            .prepare('SELECT 1 FROM mesh_completion_fingerprints WHERE mesh_id = ? AND fingerprint = ? AND expires_at > ?')
            .get(meshId, fingerprint, now) as { 1: number } | undefined;
        // Sweep expired fingerprints every 100 reads so stale rows don't accumulate
        // even during read-heavy (non-write) periods when recordFingerprintSeen is idle.
        if (++this.fingerprintSweepCounter >= 100) {
            this.fingerprintSweepCounter = 0;
            this.sweepExpiredFingerprints();
        }
        return row !== undefined;
    }

    recordCompletionFingerprint(meshId: string, fingerprint: string, ttlMs: number): void {
        const expiresAt = Date.now() + ttlMs;
        this.db.prepare('INSERT OR REPLACE INTO mesh_completion_fingerprints (fingerprint, expires_at, mesh_id) VALUES (?, ?, ?)')
            .run(fingerprint, expiresAt, meshId);
        this.maybeCheckpointWal();
    }

    sweepExpiredFingerprints(): void {
        this.db.prepare('DELETE FROM mesh_completion_fingerprints WHERE expires_at <= ?').run(Date.now());
    }

    private maybeCheckpointWal(): void {
        if (++this.walWriteCounter < MeshRuntimeStore.WAL_CHECK_INTERVAL) return;
        this.walWriteCounter = 0;
        try {
            const walPath = `${this.dbPath}-wal`;
            if (!existsSync(walPath)) return;
            const size = statSync(walPath).size;
            if (size < MeshRuntimeStore.WAL_MAX_BYTES) return;
            process.stderr.write(
                `[adhdev-mesh] WAL file ${Math.round(size / 1024 / 1024)}MB exceeds threshold; forcing checkpoint\n`,
            );
            this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch { /* best-effort */ }
    }

    private ensureLegacyQueueMigrated(meshId: string): void {
        if (this.migratedMeshIds.has(meshId)) return;
        this.migratedMeshIds.add(meshId);

        const count = this.db
            .prepare('SELECT COUNT(*) AS count FROM mesh_queue WHERE mesh_id = ?')
            .get(meshId) as { count: number };
        if (count.count > 0) return;

        const path = legacyQueuePath(meshId);
        if (!existsSync(path)) return;

        try {
            const entries = JSON.parse(readFileSync(path, 'utf-8')) as MeshWorkQueueEntry[];
            if (!Array.isArray(entries)) return;
            const insert = this.db.prepare(`
                INSERT OR REPLACE INTO mesh_queue (
                    id, mesh_id, status, target_node_id, target_session_id,
                    assigned_node_id, assigned_session_id, created_at, updated_at, payload
                ) VALUES (
                    @id, @meshId, @status, @targetNodeId, @targetSessionId,
                    @assignedNodeId, @assignedSessionId, @createdAt, @updatedAt, @payload
                )
            `);
            for (const entry of entries) {
                insert.run(this.toRow(entry));
            }
        } catch {
            return;
        }
    }

    getQueueEntries(meshId: string, statuses?: MeshTaskStatus[]): MeshWorkQueueEntry[] {
        this.ensureLegacyQueueMigrated(meshId);
        if (statuses?.length) {
            const placeholders = statuses.map(() => '?').join(', ');
            const rows = this.db
                .prepare(`SELECT payload FROM mesh_queue WHERE mesh_id = ? AND status IN (${placeholders}) ORDER BY created_at ASC`)
                .all(meshId, ...statuses) as Array<{ payload: string }>;
            return rows.map(row => JSON.parse(row.payload) as MeshWorkQueueEntry);
        }
        const rows = this.db
            .prepare('SELECT payload FROM mesh_queue WHERE mesh_id = ? ORDER BY created_at ASC')
            .all(meshId) as Array<{ payload: string }>;
        return rows.map(row => JSON.parse(row.payload) as MeshWorkQueueEntry);
    }

    getQueueRevision(meshId: string): string {
        this.ensureLegacyQueueMigrated(meshId);
        const rows = this.db
            .prepare('SELECT id, status, updated_at FROM mesh_queue WHERE mesh_id = ? ORDER BY id ASC')
            .all(meshId) as Array<{ id: string; status: string; updated_at: string }>;
        // Tab as field delimiter (UUIDs and ISO timestamps never contain tabs).
        return rows.map(row => `${row.id}\t${row.status}\t${row.updated_at}`).join('\n');
    }

    replaceQueue(meshId: string, queue: MeshWorkQueueEntry[]): void {
        const deleteStmt = this.db.prepare('DELETE FROM mesh_queue WHERE mesh_id = ?');
        const insert = this.db.prepare(`
            INSERT INTO mesh_queue (
                id, mesh_id, status, target_node_id, target_session_id,
                assigned_node_id, assigned_session_id, created_at, updated_at, payload
            ) VALUES (
                @id, @meshId, @status, @targetNodeId, @targetSessionId,
                @assignedNodeId, @assignedSessionId, @createdAt, @updatedAt, @payload
            )
        `);
        deleteStmt.run(meshId);
        for (const entry of queue) insert.run(this.toRow(entry));
        this.maybeCheckpointWal();
    }

    deleteQueue(meshId: string): void {
        this.db.prepare('DELETE FROM mesh_queue WHERE mesh_id = ?').run(meshId);
        this.migratedMeshIds.delete(meshId);
    }

    insertQueueEntry(entry: MeshWorkQueueEntry): void {
        this.db.prepare(`
            INSERT INTO mesh_queue (
                id, mesh_id, status, target_node_id, target_session_id,
                assigned_node_id, assigned_session_id, created_at, updated_at, payload
            ) VALUES (
                @id, @meshId, @status, @targetNodeId, @targetSessionId,
                @assignedNodeId, @assignedSessionId, @createdAt, @updatedAt, @payload
            )
        `).run(this.toRow(entry));
        this.maybeCheckpointWal();
    }

    updateQueueEntry(entry: MeshWorkQueueEntry): void {
        const now = new Date().toISOString();
        entry.updatedAt = now;
        this.db.prepare(`
            UPDATE mesh_queue SET
                status = @status,
                target_node_id = @targetNodeId,
                target_session_id = @targetSessionId,
                assigned_node_id = @assignedNodeId,
                assigned_session_id = @assignedSessionId,
                updated_at = @updatedAt,
                payload = @payload
            WHERE id = @id AND mesh_id = @meshId
        `).run(this.toRow(entry));
        this.maybeCheckpointWal();
    }

    findQueueEntryById(meshId: string, id: string): MeshWorkQueueEntry | null {
        this.ensureLegacyQueueMigrated(meshId);
        const row = this.db.prepare(
            'SELECT payload FROM mesh_queue WHERE id = ? AND mesh_id = ?'
        ).get(id, meshId) as { payload: string } | undefined;
        return row ? JSON.parse(row.payload) as MeshWorkQueueEntry : null;
    }

    hasActiveAssignment(meshId: string, sessionId: string, nodeId: string): boolean {
        this.ensureLegacyQueueMigrated(meshId);
        const row = this.db.prepare(`
            SELECT 1 FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned'
              AND (assigned_session_id = ? OR assigned_node_id = ?)
            LIMIT 1
        `).get(meshId, sessionId, nodeId);
        return row !== undefined;
    }

    /** A session may only execute one task at a time, regardless of task mode. */
    private hasActiveSessionAssignment(meshId: string, sessionId: string): boolean {
        const row = this.db.prepare(`
            SELECT 1 FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned' AND assigned_session_id = ?
            LIMIT 1
        `).get(meshId, sessionId);
        return row !== undefined;
    }

    /** A node may only execute one write task at a time (worktree isolation). */
    private hasActiveNodeAssignment(meshId: string, nodeId: string): boolean {
        // The serialization gate (claimNextQueueTask's `!nodeBusy`) must see a node as
        // busy when ANY active row's assigned_node_id matches in ANY equivalent
        // daemon-id form (config-form `daemon_mach_X` vs stamp-form `mach_X`, or the
        // standalone form). A raw `assigned_node_id = ?` on a single form silently
        // misses a form-variant assigned row, making an already-assigned node look idle
        // and letting a second write task claim it — duplicate claim / base leak. Mirror
        // the node-pinned SELECT below (the `target_node_id IN (...)` query): expand to
        // every equivalent form and bind an IN (...) set so the busy gate and the
        // candidate SELECT use the SAME matching rule.
        const nodeIdForms = expandDaemonIdForms(nodeId);
        if (nodeIdForms.length === 0) return false;
        const placeholders = nodeIdForms.map(() => '?').join(', ');
        const row = this.db.prepare(`
            SELECT 1 FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned' AND assigned_node_id IN (${placeholders})
            LIMIT 1
        `).get(meshId, ...nodeIdForms);
        return row !== undefined;
    }

    /**
     * Count active (status='assigned') tasks on a node, regardless of provider or
     * task mode. This is the load metric for least-loaded / round-robin ranking:
     * the scheduler prefers the node with the fewest active assignments so
     * untargeted work spreads instead of piling onto whichever node asks first.
     */
    nodeActiveAssignmentCount(meshId: string, nodeId: string): number {
        const row = this.db.prepare(`
            SELECT COUNT(*) as count FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned' AND assigned_node_id = ?
        `).get(meshId, nodeId) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    /**
     * O(1) count of queue tasks in 'pending' status for a mesh. A COUNT(*) over the
     * indexed status column, so it avoids JSON.parse-ing every queue row — used as a
     * cheap guard before the reconcile loop runs a full triggerMeshQueue scan.
     */
    pendingQueueTaskCount(meshId: string): number {
        const row = this.db.prepare(`
            SELECT COUNT(*) as count FROM mesh_queue
            WHERE mesh_id = ? AND status = 'pending'
        `).get(meshId) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    /**
     * Read the current per-mesh round-robin cursor (0 when unset). Used to rotate
     * the tie-break winner among nodes tied at the least load.
     */
    getSchedulerCursor(meshId: string): number {
        const row = this.db.prepare(
            'SELECT cursor FROM mesh_scheduler_cursor WHERE mesh_id = ?'
        ).get(meshId) as { cursor: number } | undefined;
        return row?.cursor ?? 0;
    }

    /**
     * Atomically advance the per-mesh round-robin cursor by one and return the
     * value that was current BEFORE the bump (the value the caller should rotate
     * by for this pass). UPSERT keeps it lock-free across concurrent passes.
     */
    bumpSchedulerCursor(meshId: string): number {
        return this.transaction(() => {
            const current = this.getSchedulerCursor(meshId);
            this.db.prepare(`
                INSERT INTO mesh_scheduler_cursor (mesh_id, cursor) VALUES (?, ?)
                ON CONFLICT(mesh_id) DO UPDATE SET cursor = excluded.cursor
            `).run(meshId, current + 1);
            return current;
        });
    }

    // ── Acked-Hold State (T2 / B2b) ──────────────────────────────────────────
    //
    // Persistent mirror of the reconcile loop's inFlightAckedHoldState Map. Keyed
    // by task_id (one in-flight dispatch = one hold). These are plain read/write/
    // delete/list accessors; the read-through/write-through cache and the restart
    // rehydrate live in mesh-reconcile-loop.ts.

    private mapInflightHoldRow(r: Record<string, unknown> | undefined): MeshInflightHoldRow | null {
        if (!r) return null;
        return {
            taskId: r.task_id as string,
            meshId: (r.mesh_id as string | null) ?? null,
            holdReason: (r.hold_reason as string | null) ?? null,
            heldAt: (r.held_at as number | null) ?? null,
            firstIdleSinceAck: (r.first_idle_since_ack as number | null) ?? null,
            readFailureCount: (r.read_failure_count as number | null) ?? null,
            updatedAt: (r.updated_at as number | null) ?? null,
        };
    }

    upsertInflightHold(entry: {
        taskId: string;
        meshId?: string | null;
        holdReason?: string | null;
        heldAt?: number | null;
        firstIdleSinceAck?: number | null;
        readFailureCount?: number | null;
    }): void {
        const now = Date.now();
        // Preserve held_at across an upsert (it marks when the hold was first created);
        // only set it from the incoming value when the row is new. All other fields are
        // overwritten with the latest state — the caller passes the full current state.
        this.db.prepare(`
            INSERT INTO mesh_inflight_hold
                (task_id, mesh_id, hold_reason, held_at, first_idle_since_ack, read_failure_count, updated_at)
            VALUES (@taskId, @meshId, @holdReason, @heldAt, @firstIdleSinceAck, @readFailureCount, @updatedAt)
            ON CONFLICT(task_id) DO UPDATE SET
                mesh_id = excluded.mesh_id,
                hold_reason = excluded.hold_reason,
                first_idle_since_ack = excluded.first_idle_since_ack,
                read_failure_count = excluded.read_failure_count,
                updated_at = excluded.updated_at
        `).run({
            taskId: entry.taskId,
            meshId: entry.meshId ?? null,
            holdReason: entry.holdReason ?? null,
            heldAt: entry.heldAt ?? now,
            firstIdleSinceAck: entry.firstIdleSinceAck ?? null,
            readFailureCount: entry.readFailureCount ?? null,
            updatedAt: now,
        });
        this.maybeCheckpointWal();
    }

    getInflightHold(taskId: string): MeshInflightHoldRow | null {
        const row = this.db.prepare(
            'SELECT * FROM mesh_inflight_hold WHERE task_id = ?'
        ).get(taskId) as Record<string, unknown> | undefined;
        return this.mapInflightHoldRow(row);
    }

    listInflightHoldsByMesh(meshId: string): MeshInflightHoldRow[] {
        const rows = this.db.prepare(
            'SELECT * FROM mesh_inflight_hold WHERE mesh_id = ?'
        ).all(meshId) as Array<Record<string, unknown>>;
        return rows.map(r => this.mapInflightHoldRow(r)).filter((r): r is MeshInflightHoldRow => r !== null);
    }

    deleteInflightHold(taskId: string): void {
        this.db.prepare('DELETE FROM mesh_inflight_hold WHERE task_id = ?').run(taskId);
    }

    /**
     * Count active (status='assigned') tasks on a (daemon, provider) combination,
     * matched by the assignedProviderType stamped on the payload at claim time.
     * Drives the per-(daemon, provider) maxParallel cap (summed across a provider's
     * slots[].maxParallel). The active-assignment set for a single daemon is tiny, so
     * parsing payloads here is cheap and avoids a schema migration. Pre-cap legacy
     * rows (no provider stamp) and other providers on the same daemon do not consume
     * this provider's budget, so the cap is fully backward compatible.
     */
    /**
     * Active assignments charged to ONE SLOT — the (provider, model) pair whose
     * `maxParallel` is being enforced — on this node's DAEMON MACHINE.
     *
     * ★ The counting axis is the daemon, not the node. `maxParallel` bounds a
     * machine resource (CPU, memory, the upstream rate limit, the single on-disk
     * CLI auth), and a node is a branch-isolation unit — so counting per node let
     * N worktrees of one repo on one laptop each carry their own `opus: 1` and run
     * N opus processes against a cap that says one. The caller resolves the sibling
     * node set (mesh-daemon-slot-axis); remote machines declare their own daemonId
     * and therefore keep independent budgets.
     *
     * A row with NO `assignedModel` (claimed by an older daemon, or via an idle/event
     * drain that cannot know the launched model) counts against EVERY slot of its
     * provider. That is deliberately conservative: skipping such a row would let a
     * pre-upgrade opus task go uncounted and admit a second one past a cap of 1, which
     * is the over-subscription this cap exists to prevent. The cost is that a mixed
     * fleet can refuse slightly early, which is the safe direction.
     *
     * Model comparison goes through modelNamesEquivalent so `opus`,
     * `claude-opus-4-6` and `Claude Opus 4.6 (Thinking)` are one slot rather than
     * three separate budgets (the canon-identity defect class).
     */
    private activeSlotAssignmentCount(
        meshId: string,
        nodeId: string,
        providerType: string,
        assignedModel: string,
        daemonNodeIds?: readonly string[],
    ): number {
        const rows = this.assignedRowsForDaemon(meshId, nodeId, daemonNodeIds);
        let count = 0;
        for (const row of rows) {
            try {
                const entry = JSON.parse(row.payload) as MeshWorkQueueEntry;
                if (entry.assignedProviderType !== providerType) continue;
                const rowModel = typeof entry.assignedModel === 'string' ? entry.assignedModel.trim() : '';
                // Unstamped row → counts against every slot of this provider.
                if (!rowModel) { count += 1; continue; }
                // Both sides model-less is the provider-default slot; otherwise compare
                // canonically.
                if (!assignedModel) continue;
                if (modelNamesEquivalent(rowModel, assignedModel)) count += 1;
            } catch { /* skip unparsable row */ }
        }
        return count;
    }

    /**
     * Assigned rows charged to the DAEMON MACHINE that owns `nodeId`.
     *
     * `daemonNodeIds` is the caller-resolved sibling set (every node on the same
     * physical daemon — see mesh-daemon-slot-axis). Each id is expanded through
     * expandDaemonIdForms so a row stamped in one interchangeable id form still
     * matches; matching is done with an `IN (...)` bind, not a raw `= ?`.
     *
     * Omitting `daemonNodeIds` falls back to the single node — exactly the prior
     * behavior — so a caller that cannot resolve the mesh never widens a cap.
     */
    private assignedRowsForDaemon(
        meshId: string,
        nodeId: string,
        daemonNodeIds?: readonly string[],
    ): Array<{ payload: string }> {
        const scope = Array.isArray(daemonNodeIds) && daemonNodeIds.length > 0
            ? daemonNodeIds
            : [nodeId];
        const forms = expandDaemonIdForms(scope as ReadonlyArray<string>);
        if (forms.length === 0) return [];
        const placeholders = forms.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT payload FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned' AND assigned_node_id IN (${placeholders})
        `).all(meshId, ...forms) as Array<{ payload: string }>;
    }

    private activeProviderAssignmentCount(
        meshId: string,
        nodeId: string,
        providerType: string,
        daemonNodeIds?: readonly string[],
    ): number {
        const rows = this.assignedRowsForDaemon(meshId, nodeId, daemonNodeIds);
        let count = 0;
        for (const row of rows) {
            try {
                const entry = JSON.parse(row.payload) as MeshWorkQueueEntry;
                if (entry.assignedProviderType === providerType) count += 1;
            } catch { /* skip unparsable row */ }
        }
        return count;
    }

    // O(1) claim: transaction ensures only one session claims a pending task
    claimNextQueueTask(
        meshId: string,
        nodeId: string,
        sessionId: string,
        capabilityTags: string[] = [],
        opts?: {
            providerType?: string;
            providerMaxParallel?: number;
            assignedModel?: string;
            slotMaxParallel?: number;
            /** Every nodeId sharing this node's daemon machine — the scope the
             *  provider/slot maxParallel caps are counted over. Omit to count the
             *  single node (prior behavior; never widens a cap). */
            daemonNodeIds?: readonly string[];
            nodeIsWorktree?: boolean;
            assignedTranscriptProfile?: MeshWorkQueueEntry['assignedTranscriptProfile'];
            allowedTaskDifficulties?: readonly import('@adhdev/mesh-shared').MeshTaskDifficulty[];
        },
    ): MeshWorkQueueEntry | null {
        return this.transaction(() => {
            this.ensureLegacyQueueMigrated(meshId);
            // A session executes one task at a time regardless of mode — block early.
            // The node-level conflict is evaluated per-candidate below so that
            // read-only (live_debug_readonly) tasks can claim concurrently on a node
            // that already has an active assignment, while write tasks keep the
            // one-active-per-node invariant (worktree isolation).
            if (this.hasActiveSessionAssignment(meshId, sessionId)) return null;
            const nodeBusy = this.hasActiveNodeAssignment(meshId, nodeId);

            // Per-(daemon, provider) maxParallel cap (summed slots[].maxParallel).
            // Bounds the (daemon, provider) resource pool — one CLI, one auth file,
            // one upstream rate limit per machine — so sibling worktrees share it.
            // This composes with the global/taskMode caps enforced in the coordinator
            // (stricter wins); omitting providerMaxParallel preserves prior behavior.
            //
            // ★ Evaluated PER CANDIDATE (not once up front) because the effective cap
            // depends on whether the candidate is read-only: read-only work may not
            // take the last free slot, so a write task always has one within a single
            // completion (see effectiveSlotCap / the starvation note in
            // mesh-daemon-slot-axis). A write candidate still sees the full cap, so
            // this is never looser than before for writes.
            const providerType = typeof opts?.providerType === 'string' ? opts.providerType.trim() : '';
            const providerMaxParallel = opts?.providerMaxParallel;
            const providerCapDeclared = providerType
                && typeof providerMaxParallel === 'number'
                && Number.isFinite(providerMaxParallel)
                && providerMaxParallel >= 0;
            const liveProviderCount = providerCapDeclared
                ? this.activeProviderAssignmentCount(meshId, nodeId, providerType, opts?.daemonNodeIds)
                : 0;

            // Per-SLOT maxParallel cap. A slot — the (provider, model) pair — is an
            // independent unit: `maxParallel: 1` on claude-cli/opus means ONE opus task
            // on this DAEMON at a time, even while a sibling claude-cli/sonnet slot is
            // idle. The provider cap above bounds the shared pool (one CLI, one auth,
            // one upstream rate limit); this bounds the individual slot. Stricter wins,
            // so both are checked, and a claim missing either bound is refused.
            //
            // Enforced inside the same transaction as the provider cap so concurrent
            // claims cannot both read "1 free" and both commit. Like the provider cap,
            // the read-only reservation makes the effective bound candidate-dependent.
            const assignedModel = typeof opts?.assignedModel === 'string' ? opts.assignedModel.trim() : '';
            const slotMaxParallel = opts?.slotMaxParallel;
            const slotCapDeclared = providerType
                && typeof slotMaxParallel === 'number'
                && Number.isFinite(slotMaxParallel)
                && slotMaxParallel >= 0;
            const liveSlotCount = slotCapDeclared
                ? this.activeSlotAssignmentCount(meshId, nodeId, providerType, assignedModel, opts?.daemonNodeIds)
                : 0;

            /**
             * Both maxParallel axes for one candidate, with the read-only reservation
             * applied. Refuses when either axis is met — stricter wins, unchanged.
             */
            const parallelCapsAllow = (candidate: MeshWorkQueueEntry): boolean => {
                const readonlyCandidate = isTaskReadonly(candidate);
                if (providerCapDeclared) {
                    const cap = effectiveSlotCap(providerMaxParallel as number, readonlyCandidate);
                    if (cap !== undefined && liveProviderCount >= cap) return false;
                }
                if (slotCapDeclared) {
                    const cap = effectiveSlotCap(slotMaxParallel as number, readonlyCandidate);
                    if (cap !== undefined && liveSlotCount >= cap) return false;
                }
                return true;
            };

            // The node-pinned SELECT must match a row whose target_node_id was stamped
            // in ANY equivalent daemon-id form (config-form `daemon_mach_X` vs the
            // claiming session's stamp-form `mach_X`). A single `= ?` bind on the
            // stamp-form silently fails to fetch a config-form row, leaving the task
            // pending forever (the empty-session WORKTREE-CLAIM-GATE repro). Expand to
            // every equivalent form and bind an IN (...) set; the per-candidate
            // targetMatches() JS gate above re-validates each fetched row.
            const nodeIdForms = expandDaemonIdForms(nodeId);
            const nodePinnedPlaceholders = nodeIdForms.map(() => '?').join(', ');
            // Priority: session-targeted > node-targeted (no session) > unconstrained.
            // G6: WITHIN each targeting tier, a higher task-level priority is pulled first;
            // created_at ASC (from the SQL ORDER BY) is the intra-priority tie-break. The
            // tier ordering is preserved (a high-priority unconstrained task never jumps
            // ahead of a session/node-pinned task) so targeting stays the outer key and
            // priority is the inner key. Sort is stable, so equal-priority rows keep FIFO.
            const parseTier = (query: string, ...params: unknown[]): MeshWorkQueueEntry[] => {
                const tierRows = this.db.prepare(query).all(...params) as Array<{ payload: string }>;
                return tierRows
                    .map(row => JSON.parse(row.payload) as MeshWorkQueueEntry)
                    .sort((a, b) => meshTaskPriorityRank(b.priority) - meshTaskPriorityRank(a.priority));
            };
            const candidates = [
                ...parseTier(`
                    SELECT payload FROM mesh_queue
                    WHERE mesh_id = ? AND status = 'pending' AND target_session_id = ?
                    ORDER BY created_at ASC
                `, meshId, sessionId),
                ...parseTier(`
                    SELECT payload FROM mesh_queue
                    WHERE mesh_id = ? AND status = 'pending' AND target_node_id IN (${nodePinnedPlaceholders}) AND target_session_id IS NULL
                    ORDER BY created_at ASC
                `, meshId, ...nodeIdForms),
                ...parseTier(`
                    SELECT payload FROM mesh_queue
                    WHERE mesh_id = ? AND status = 'pending' AND target_node_id IS NULL AND target_session_id IS NULL
                    ORDER BY created_at ASC
                `, meshId),
            ];

            // M1: a task with unmet dependencies (or a system blockedReason) is not claimable.
            // Resolve dependency statuses in one query over the union of referenced ids.
            const depIds = [...new Set(candidates.flatMap(c => Array.isArray(c.dependsOn) ? c.dependsOn : []))];
            const depStatus = new Map<string, string>();
            if (depIds.length > 0) {
                const placeholders = depIds.map(() => '?').join(', ');
                const depRows = this.db.prepare(
                    `SELECT id, status FROM mesh_queue WHERE mesh_id = ? AND id IN (${placeholders})`
                ).all(meshId, ...depIds) as Array<{ id: string; status: string }>;
                for (const r of depRows) depStatus.set(r.id, r.status);
            }
            // DEPENDSON-GATE-SYMMETRY: the claim gate shares the single
            // taskDependenciesSatisfied predicate with the auto-launch filter and
            // the cloud eager P2P push, so a task blocked here is blocked there too.
            const dependenciesSatisfied = (candidate: MeshWorkQueueEntry): boolean =>
                taskDependenciesSatisfied(candidate, depStatus);

            // Per-candidate node-conflict gate: write tasks require an idle node; read-only
            // tasks bypass the node-busy check so N read-only diagnoses can run on one node
            // at once. Read-only classification is decided solely by isTaskReadonly (the
            // single predicate shared with the cap counters / auto-launch / guardrail).
            const nodeConflictAllows = (candidate: MeshWorkQueueEntry): boolean => {
                if (isTaskReadonly(candidate)) return true;
                return !nodeBusy;
            };

            // G7: delayed execution. A task with a notBefore in the future is held pending
            // (skipped as a claim candidate) until the wall clock passes it. Fail-open on an
            // unparseable timestamp (meshTaskNotBeforeReady) so a bad value never strands work.
            const claimNowMs = Date.now();
            const notBeforeReady = (candidate: MeshWorkQueueEntry): boolean =>
                meshTaskNotBeforeReady(candidate, claimNowMs);

            // WTDISPATCH-FANOUT: a `convergence` task lands its work onto base (merge →
            // push → cleanup against the real checkout). It must NEVER be claimed by a
            // co-located worktree-clone session — N sibling worktree sessions on one daemon
            // each claiming the same convergence intent is the 4-way push/deploy fan-out the
            // live repro hit. Base-only, fail-closed: when the claiming node is a worktree
            // (nodeIsWorktree), exclude every convergence candidate so it stays pending for
            // the base node to pull.
            const nodeIsWorktree = opts?.nodeIsWorktree === true;
            const convergenceAllows = (candidate: MeshWorkQueueEntry): boolean =>
                candidate.taskMode !== 'convergence' || !nodeIsWorktree;

            // WTDISPATCH-FANOUT: defensive exact-target gate. The prioritized SQL above
            // already segregates session/node-pinned rows, but a future query change (or a
            // candidate row whose stored target drifted from its column) must never let a
            // sibling worktree session on the same daemon absorb another node's/session's
            // pinned task. When a task carries an explicit target, require an exact match
            // here too — fail-closed.
            // The target id may have been stamped in a different serialization /
            // daemon-id form than the claiming session's nodeId (config-form
            // `daemon_mach_X` vs stamp-form `mach_X`, or the 3-way id/nodeId/node_id
            // node forms). A raw `!==` here permanently strands a node-pinned task as
            // an empty session. Accept the candidate when the target resolves to the
            // same node under ANY equivalent form; keep targetSessionId an exact match.
            const targetMatches = (candidate: MeshWorkQueueEntry): boolean => {
                // Session ids are single-form (unlike node/daemon ids with their 3
                // serialization forms requiring expandDaemonIdForms) — see the
                // sessionIdsEquivalent doc; it is the one canonical exact-match
                // predicate for them.
                if (candidate.targetSessionId && !sessionIdsEquivalent(candidate.targetSessionId, sessionId)) return false;
                if (
                    candidate.targetNodeId
                    && !daemonIdsEquivalent(candidate.targetNodeId, nodeId)
                    && !meshNodeIdMatches({ id: candidate.targetNodeId }, nodeId)
                ) {
                    return false;
                }
                return true;
            };

            // DIFFICULTY HARD FLOOR (idle/event claim path): the auto-launch selector
            // filters slots before ranking, but an already-running session reaches this
            // atomic claim without that selector. Restrict classified candidates to the
            // grades its concrete model can run (or the conservative intersection when
            // the live model is unknown). Freeform/legacy rows remain unconstrained.
            const allowedTaskDifficulties = opts?.allowedTaskDifficulties;
            const difficultyAllows = (candidate: MeshWorkQueueEntry): boolean =>
                !allowedTaskDifficulties
                || candidate.difficulty === 'freeform'
                || !candidate.difficulty
                || allowedTaskDifficulties.includes(candidate.difficulty as import('@adhdev/mesh-shared').MeshTaskDifficulty);

            const entry = candidates.find(candidate =>
                nodeSatisfiesRequiredTags(candidate.requiredTags, capabilityTags)
                && dependenciesSatisfied(candidate)
                && notBeforeReady(candidate)
                && convergenceAllows(candidate)
                && targetMatches(candidate)
                && difficultyAllows(candidate)
                && parallelCapsAllow(candidate)
                && nodeConflictAllows(candidate));
            if (!entry) return null;

            const now = new Date().toISOString();
            entry.status = 'assigned';
            entry.assignedNodeId = nodeId;
            entry.assignedSessionId = sessionId;
            if (providerType) entry.assignedProviderType = providerType;
            // Per-slot cap accounting: record WHICH model this claim runs, so the next
            // claim can count assignments against the right slot instead of lumping
            // every same-provider task into one pool.
            if (assignedModel) entry.assignedModel = assignedModel;
            // P1 transcript-authority stamp (write-only for now): lets the
            // coordinator classify this worker without local provider access.
            if (opts?.assignedTranscriptProfile) entry.assignedTranscriptProfile = opts.assignedTranscriptProfile;
            entry.dispatchTimestamp = now;
            // REDRIVE-DUP: bump the per-task dispatch nonce on every claim so this dispatch
            // carries a nonce strictly greater than any prior (reclaimed) dispatch of the same
            // task. The worker echoes it on agent:generating_started; the coordinator rejects a
            // stale-nonce ack so a reclaimed+re-dispatched task's original inject cannot execute.
            entry.dispatchNonce = (entry.dispatchNonce || 0) + 1;
            entry.updatedAt = now;

            this.db.prepare(`
                UPDATE mesh_queue SET
                    status = 'assigned', assigned_node_id = ?, assigned_session_id = ?,
                    updated_at = ?, payload = ?
                WHERE id = ? AND mesh_id = ?
            `).run(nodeId, sessionId, now, JSON.stringify(entry), entry.id, meshId);

            this.maybeCheckpointWal();
            return entry;
        });
    }

    getQueueStatsByStatus(meshId: string): { status: string; count: number }[] {
        this.ensureLegacyQueueMigrated(meshId);
        return this.db.prepare(
            `SELECT status, COUNT(*) as count FROM mesh_queue WHERE mesh_id = ? GROUP BY status`
        ).all(meshId) as { status: string; count: number }[];
    }

    getActiveAssignmentDetails(meshId: string): Array<{ id: string; nodeId?: string; sessionId?: string; message: string }> {
        this.ensureLegacyQueueMigrated(meshId);
        const rows = this.db.prepare(`
            SELECT assigned_node_id, assigned_session_id, payload
            FROM mesh_queue WHERE mesh_id = ? AND status = 'assigned'
        `).all(meshId) as Array<{ assigned_node_id: string | null; assigned_session_id: string | null; payload: string }>;
        return rows.map(r => {
            let id = '', message = '';
            try { const e = JSON.parse(r.payload) as MeshWorkQueueEntry; id = e.id; message = e.message; } catch { /* ignore */ }
            return { id, nodeId: r.assigned_node_id ?? undefined, sessionId: r.assigned_session_id ?? undefined, message };
        });
    }

    /**
     * Resolve the `assigned` queue row a completion event belongs to.
     *
     * Clock-skew safety (C2): a completion event's `occurredAtIso` carries the
     * REMOTE WORKER's clock, while `updated_at` carries the COORDINATOR's clock
     * (set at assignment and re-bumped on every mutation). For a remote node,
     * coordinator-clock > worker-clock skew used to make an `updated_at <= occurredAt`
     * filter return nothing, stranding the finished task as `assigned` forever.
     *
     * We therefore NEVER filter completion-matching on the mutable `updated_at`:
     *  1. If `taskId` is given, match the exact `assigned` row by id (no time filter).
     *  2. Otherwise a session holds at most one `assigned` task — match it without a
     *     time filter. If several exist (shouldn't normally), disambiguate by the
     *     IMMUTABLE `dispatchTimestamp`: latest `dispatchTimestamp <= occurredAt`,
     *     and if skew makes ALL of them later than `occurredAt`, fall back to the
     *     most-recent `dispatchTimestamp` rather than returning null.
     */
    findAssignedBySession(
        meshId: string,
        sessionId: string,
        occurredAtIso?: string,
        taskId?: string,
    ): MeshWorkQueueEntry | null {
        this.ensureLegacyQueueMigrated(meshId);

        // WRITE/READ PREDICATE SYMMETRY (COMPLETION-PROPAGATION F1): the claim path writes
        // assigned_session_id RAW (claimNextTask), and the sibling gates that decide whether a
        // session already holds work (sessionHasActiveAssignment) and which pending row a
        // session may claim (targetMatches) compare it through sessionIdsEquivalent — the
        // canonical single-form predicate that TRIMS both sides. A raw SQL `assigned_session_id
        // = ?` here is asymmetric with that write/sibling predicate: a completion whose
        // resolveEventSessionId-reinterpreted sessionId is equivalent-but-not-byte-identical to
        // the stored column (e.g. a whitespace/serialization skew from a manually-launched
        // session) silently fetched zero rows and stranded the finished task as `assigned`
        // forever (the mesh-work-queue :1251 "N assigned row(s) exist" warning is that exact
        // signature). Fetch every `assigned` row for the mesh and filter session membership in
        // JS with sessionIdsEquivalent, mirroring the node-id IN(...)+JS-revalidate pattern the
        // claim SELECT uses (claimNextTask :720-736 / targetMatches :797-811).
        const allRows = this.db.prepare(
            `SELECT payload FROM mesh_queue WHERE mesh_id = ? AND status = 'assigned'`
        ).all(meshId) as Array<{ payload: string }>;
        const sessionEntries = allRows
            .map(r => { try { return JSON.parse(r.payload) as MeshWorkQueueEntry; } catch { return null; } })
            .filter((e): e is MeshWorkQueueEntry => e !== null)
            .filter(e => sessionIdsEquivalent(e.assignedSessionId, sessionId));

        // 1. Exact taskId match — robust against clock skew and stale rows. Scoped to the
        // session-equivalent set (as the raw `AND assigned_session_id = ? AND id = ?` was),
        // now via the trimming equivalence predicate.
        if (taskId) {
            const byId = sessionEntries.find(e => e.id === taskId);
            if (byId) return byId;
            // Fall through to session-based matching if the id didn't line up
            // (e.g. event carried a stale/foreign taskId).
        }

        // 2. Session-based match WITHOUT the mutable updated_at filter.
        const entries = sessionEntries;
        if (entries.length === 0) return null;
        if (entries.length === 1) return entries[0];

        // Multiple assigned rows for one session: disambiguate by the immutable
        // dispatchTimestamp (falling back to updated_at only for legacy rows that
        // predate dispatchTimestamp). We use these to ORDER, never to FILTER —
        // so a skewed occurredAt can never drop the live row to null.
        const orderKey = (e: MeshWorkQueueEntry) => e.dispatchTimestamp ?? e.updatedAt ?? '';
        const byDispatchDesc = [...entries].sort((a, b) => orderKey(b).localeCompare(orderKey(a)));
        if (occurredAtIso) {
            const atOrBefore = byDispatchDesc.find(e => orderKey(e) <= occurredAtIso);
            if (atOrBefore) return atOrBefore;
        }
        // Skew made every dispatch later than occurredAt — fall back to the
        // most-recently dispatched row rather than stranding the completion.
        return byDispatchDesc[0];
    }

    private toRow(entry: MeshWorkQueueEntry): Record<string, unknown> {
        return {
            id: entry.id,
            meshId: entry.meshId,
            status: entry.status,
            targetNodeId: entry.targetNodeId ?? null,
            targetSessionId: entry.targetSessionId ?? null,
            assignedNodeId: entry.assignedNodeId ?? null,
            assignedSessionId: entry.assignedSessionId ?? null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            payload: JSON.stringify(entry),
        };
    }

    // ── Direct Dispatch Tracking ─────────────────────────────────────────────

    insertDirectDispatch(entry: {
        taskId: string;
        meshId: string;
        nodeId?: string;
        sessionId?: string;
        providerType?: string;
        message: string;
        taskMode?: string;
        via: string;
        dispatchedToIdleSession?: boolean;
        dispatchedAt: string;
    }): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT OR REPLACE INTO mesh_direct_dispatches
                (task_id, mesh_id, node_id, session_id, provider_type, message, task_mode, via,
                 status, dispatched_to_idle_session, dispatched_at, updated_at)
            VALUES
                (@taskId, @meshId, @nodeId, @sessionId, @providerType, @message, @taskMode, @via,
                 'dispatched', @dispatchedToIdle, @dispatchedAt, @updatedAt)
        `).run({
            taskId: entry.taskId,
            meshId: entry.meshId,
            nodeId: entry.nodeId ?? null,
            sessionId: entry.sessionId ?? null,
            providerType: entry.providerType ?? null,
            message: entry.message,
            taskMode: entry.taskMode ?? null,
            via: entry.via,
            dispatchedToIdle: entry.dispatchedToIdleSession ? 1 : 0,
            dispatchedAt: entry.dispatchedAt,
            updatedAt: now,
        });
    }

    getActiveDirectDispatches(meshId: string): Array<{
        taskId: string;
        meshId: string;
        nodeId: string | null;
        sessionId: string | null;
        providerType: string | null;
        message: string;
        taskMode: string | null;
        via: string;
        status: string;
        dispatchedToIdleSession: boolean;
        dispatchedAt: string;
        updatedAt: string;
    }> {
        const rows = this.db.prepare(`
            SELECT task_id, mesh_id, node_id, session_id, provider_type, message, task_mode, via,
                   status, dispatched_to_idle_session, dispatched_at, updated_at
            FROM mesh_direct_dispatches
            WHERE mesh_id = ? AND status NOT IN ('completed', 'failed', 'stale')
            ORDER BY dispatched_at ASC
        `).all(meshId) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            taskId: r.task_id as string,
            meshId: r.mesh_id as string,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            message: r.message as string,
            taskMode: r.task_mode as string | null,
            via: r.via as string,
            status: r.status as string,
            dispatchedToIdleSession: (r.dispatched_to_idle_session as number) === 1,
            dispatchedAt: r.dispatched_at as string,
            updatedAt: r.updated_at as string,
        }));
    }

    // CANON-B (dispatch identity): mesh_direct_dispatches is keyed by task_id (PK), but a
    // single session can host several sequential direct dispatches (re-dispatch / nudge), so
    // matching a status flip by session_id alone hits EVERY non-terminal row for that session
    // — flipping a sibling task's row and stranding the one whose event actually fired (the
    // assigned-stranded watchdog then requeues a task that is really still generating). When
    // the firing event carries a taskId, target the single PK row; the session_id match is the
    // legacy fallback only for events that arrive without a taskId.
    updateDirectDispatchStatus(meshId: string, sessionId: string, status: 'acked' | 'completed' | 'failed' | 'stale', taskId?: string): void {
        const now = new Date().toISOString();
        if (taskId) {
            this.db.prepare(`
                UPDATE mesh_direct_dispatches
                SET status = @status, updated_at = @updatedAt
                WHERE mesh_id = @meshId AND task_id = @taskId
                  AND status NOT IN ('completed', 'failed')
            `).run({ status, meshId, taskId, updatedAt: now });
            return;
        }
        if (!sessionId) return; // never update rows without a session binding
        this.db.prepare(`
            UPDATE mesh_direct_dispatches
            SET status = @status, updated_at = @updatedAt
            WHERE mesh_id = @meshId AND session_id = @sessionId
              AND session_id IS NOT NULL
              AND status NOT IN ('completed', 'failed')
        `).run({ status, meshId, sessionId, updatedAt: now });
    }

    /**
     * MESH-DISPATCH-MISROUTE (fix 3, consumer residual): resolve the task_id of the SINGLE
     * non-terminal direct dispatch a session owns. Returns the task_id only when the session
     * holds exactly ONE active ('dispatched'/'acked') row — the case where a taskId-less
     * lifecycle event (a legacy/relayed worker whose producer never stamped meshActiveTaskId)
     * unambiguously belongs to that one dispatch. With zero rows there is nothing to ack; with
     * two or more (a re-dispatch/nudge sibling) the firing event's owner is ambiguous, so we
     * return null and the caller MUST NOT fall back to the session_id sweep that would flip a
     * sibling row ("may flip a sibling dispatch row"). This narrows the legacy fallback to the
     * only safe case instead of removing the producer-side TASKIDLESS stamp's safety net.
     */
    getSoleActiveDirectDispatchTaskId(meshId: string, sessionId: string): string | null {
        if (!sessionId) return null;
        const rows = this.db.prepare(`
            SELECT task_id FROM mesh_direct_dispatches
            WHERE mesh_id = ? AND session_id = ?
              AND status NOT IN ('completed', 'failed', 'stale')
        `).all(meshId, sessionId) as Array<{ task_id: string }>;
        if (rows.length !== 1) return null;
        const taskId = typeof rows[0]?.task_id === 'string' ? rows[0].task_id.trim() : '';
        return taskId || null;
    }

    cleanupTerminalDirectDispatches(olderThanMs: number): void {
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        this.db.prepare(`
            DELETE FROM mesh_direct_dispatches
            WHERE status IN ('completed', 'failed', 'stale') AND updated_at < ?
        `).run(cutoff);
    }

    deleteDirectDispatches(meshId: string): void {
        this.db.prepare(`DELETE FROM mesh_direct_dispatches WHERE mesh_id = ?`).run(meshId);
    }

    /**
     * Delete specific direct dispatch rows by taskId for a mesh. Used by the staleDirect prune
     * path to remove orphaned/terminal dispatch records whose node/session is no longer in the
     * live mesh. Returns the number of rows actually deleted. No-op for an empty taskId list.
     */
    deleteDirectDispatchesByTaskId(meshId: string, taskIds: string[]): number {
        const ids = (taskIds || []).map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean);
        if (!ids.length) return 0;
        const stmt = this.db.prepare(`DELETE FROM mesh_direct_dispatches WHERE mesh_id = ? AND task_id = ?`);
        let deleted = 0;
        const run = this.db.transaction((rows: string[]) => {
            for (const taskId of rows) {
                deleted += stmt.run(meshId, taskId).changes;
            }
        });
        run(ids);
        return deleted;
    }

    markStaleDirectDispatches(meshId: string, olderThanMs: number): void {
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        const now = new Date().toISOString();
        this.db.prepare(`
            UPDATE mesh_direct_dispatches
            SET status = 'stale', updated_at = ?
            WHERE mesh_id = ? AND status = 'dispatched' AND dispatched_at < ?
        `).run(now, meshId, cutoff);
    }

    // ── Remote Idle Sessions ─────────────────────────────────────────────────

    setRemoteIdleSession(meshId: string, nodeId: string, sessionId: string, providerType: string, expiresAt: number, metadata?: any): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO remote_idle_sessions (mesh_id, node_id, session_id, provider_type, expires_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(meshId, nodeId, sessionId, providerType, expiresAt, metadata ? JSON.stringify(metadata) : null);
    }

    getRemoteIdleSessions(meshId: string): Array<{ nodeId: string; sessionId: string; providerType: string; expiresAt: number; metadata?: any }> {
        // MESH-ISOLATION-LEAK: always mesh-scoped. A bare (cross-mesh) read here is what
        // let mesh B claim mesh A's idle session when both share a nodeId.
        const rows = this.db.prepare('SELECT node_id, session_id, provider_type, expires_at, metadata FROM remote_idle_sessions WHERE mesh_id = ?').all(meshId) as Array<any>;
        return rows.map(r => ({
            nodeId: r.node_id,
            sessionId: r.session_id,
            providerType: r.provider_type,
            expiresAt: r.expires_at,
            metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        }));
    }

    deleteRemoteIdleSession(meshId: string, nodeId: string, sessionId: string): void {
        this.db.prepare('DELETE FROM remote_idle_sessions WHERE mesh_id = ? AND node_id = ? AND session_id = ?').run(meshId, nodeId, sessionId);
    }

    pruneExpiredRemoteIdleSessions(): void {
        this.db.prepare('DELETE FROM remote_idle_sessions WHERE expires_at <= ?').run(Date.now());
    }

    // ── Session Delivery Queue ───────────────────────────────────────────────

    insertSessionDelivery(entry: {
        id: string;
        meshId: string;
        nodeId?: string;
        sessionId?: string;
        providerType?: string;
        taskId?: string;
        kind: string;
        priority?: number;
        message: string;
        status: string;
        deliverAfter?: string;
        expiresAt?: string;
        sourceCoordinatorSessionId?: string;
        sourceCoordinatorDaemonId?: string;
        createdAt: string;
        updatedAt: string;
    }): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO mesh_session_delivery (
                id, mesh_id, node_id, session_id, provider_type, task_id, kind, priority,
                message, status, deliver_after, expires_at, attempt_count,
                source_coordinator_session_id, source_coordinator_daemon_id,
                last_error, created_at, updated_at
            ) VALUES (
                @id, @meshId, @nodeId, @sessionId, @providerType, @taskId, @kind, @priority,
                @message, @status, @deliverAfter, @expiresAt, 0,
                @sourceCoordinatorSessionId, @sourceCoordinatorDaemonId,
                NULL, @createdAt, @updatedAt
            )
        `).run({
            id: entry.id,
            meshId: entry.meshId,
            nodeId: entry.nodeId ?? null,
            sessionId: entry.sessionId ?? null,
            providerType: entry.providerType ?? null,
            taskId: entry.taskId ?? null,
            kind: entry.kind,
            priority: entry.priority ?? 0,
            // MESH-DELIVERY-MESSAGE-NOTNULL: the `message` column is NOT NULL, but a
            // re-dispatch / reclaim / idle-assign path can reach here with an undefined
            // message (a claimed task whose payload predates the message field, or a
            // slimmed re-drive entry). better-sqlite3 binds undefined as NULL, so the
            // bare `entry.message` threw 'NOT NULL constraint failed' and — because this
            // insert runs inside triggerMeshQueue — took down the ENTIRE queue drain
            // (fresh enqueue, pending-claim recovery, idle-assign, MAGI replica launch),
            // stranding all delegation. A delivery record's message is informational
            // ack-tracking, so coercing an absent message to '' preserves the row and the
            // drain instead of crashing. Matches the `?? null` defensive coercion every
            // other optional column here already uses.
            message: entry.message ?? '',
            status: entry.status,
            deliverAfter: entry.deliverAfter ?? null,
            expiresAt: entry.expiresAt ?? null,
            sourceCoordinatorSessionId: entry.sourceCoordinatorSessionId ?? null,
            sourceCoordinatorDaemonId: entry.sourceCoordinatorDaemonId ?? null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
        });
        this.maybeCheckpointWal();
    }

    // DELIVERED-NOT-CONSUMED-REDRIVE monotonic FSM: the forward-progress lifecycle of a
    // delivery is a strictly increasing rank — a status may only advance, never regress.
    // The redrive bug was a NON-monotonic FSM: the transport-confirm callback
    // (mesh-queue-assignment :384) writes 'delivered' unconditionally by PK, so when the
    // worker's agent:generating_started raced AHEAD of the confirm and already flipped the
    // row 'delivering'→'acked', the late confirm CLOBBERED 'acked' back to 'delivered'.
    // taskDeliveryConsumed() (which keys on 'acked'/'completed') then read false forever,
    // and the short-grace re-drive re-opened an already-consumed task. Enforcing the rank
    // ordering here makes the two event orders converge on the same monotone terminal state
    // regardless of arrival order, so a late confirm can never demote a consumed delivery.
    // 'failed'/'expired'/'cancelled' are absorbing OUTCOMES, not progress ranks — they are
    // always allowed (a genuine dispatch failure must be recordable even from 'acked').
    //
    // QUEUED-IS-PROGRESS: 'queued' is a legitimate INTERMEDIATE rank between 'delivering'
    // and 'delivered', NOT the floor of the FSM. A delivery row is INSERTED as 'delivering'
    // (dispatch in flight to the transport); when the session is busy the adapter buffers
    // the prompt and the transport confirm reports {status:'queued'} — a genuine forward
    // step (handed to the adapter's outbound queue), but still short of 'delivered'
    // (submitted at the PTY boundary; see DISPATCH-ACK-EVIDENCE in mesh-queue-assignment).
    // Ranking 'queued' at 0 made that confirm write a rank REGRESSION (0 < 1), so the
    // monotonic guard dropped it and the row stayed 'delivering' forever — never confirmed
    // for taskHasConfirmedDelivery, feeding the redrive staleness heuristics a permanent
    // "no confirmed delivery" signal for a prompt that was already buffered on the worker.
    // At rank 2 the confirm records correctly and the later flush advance
    // (queued→delivered / queued→acked via consumeSessionDelivery) still applies.
    private static readonly DELIVERY_PROGRESS_RANK: Record<string, number> = {
        delivering: 1,
        queued: 2,
        delivered: 3,
        acked: 4,
        completed: 5,
    };

    updateSessionDeliveryStatus(id: string, status: string, opts?: { lastError?: string; incrementAttempt?: boolean }): void {
        const now = new Date().toISOString();
        if (opts?.incrementAttempt) {
            // Retry/requeue path (transport failure → 'failed', or an explicit re-queue): this is
            // the deliberate reset signal, NOT the racing progress writes that cause the clobber, so
            // it is exempt from the monotonic guard and always applies (preserves attempt_count
            // bookkeeping and the failure ledger). The clobber bug lives only in the plain
            // progress write below.
            this.db.prepare(`
                UPDATE mesh_session_delivery
                SET status = @status, last_error = @lastError, attempt_count = attempt_count + 1, updated_at = @updatedAt
                WHERE id = @id
            `).run({ id, status, lastError: opts?.lastError ?? null, updatedAt: now });
            return;
        }
        // Monotonic guard for forward-progress statuses: a plain status write may ADVANCE or
        // rewrite the SAME rank, but NEVER regress to a strictly-lower rank. This is what stops the
        // late transport-confirm ('delivered', rank 3) from clobbering an already-consumed row
        // ('acked', rank 4): the `@targetRank >= current` predicate fetches zero rows for 4→3, so
        // 'acked' survives. Absorbing failure outcomes (failed/expired/cancelled) have no rank and
        // are written unconditionally.
        const targetRank = MeshRuntimeStore.DELIVERY_PROGRESS_RANK[status];
        if (targetRank === undefined) {
            this.db.prepare(`
                UPDATE mesh_session_delivery
                SET status = @status, last_error = @lastError, updated_at = @updatedAt
                WHERE id = @id
            `).run({ id, status, lastError: opts?.lastError ?? null, updatedAt: now });
            return;
        }
        // Absorbing failure states (failed/expired/cancelled) map to rank 99 so no progress write
        // (max rank 5) can ever resurrect a dead delivery. The CASE mirrors DELIVERY_PROGRESS_RANK
        // exactly — keep the two in sync.
        this.db.prepare(`
            UPDATE mesh_session_delivery
            SET status = @status, last_error = @lastError, updated_at = @updatedAt
            WHERE id = @id AND (@targetRank >= CASE status
                WHEN 'delivering' THEN 1 WHEN 'queued' THEN 2 WHEN 'delivered' THEN 3
                WHEN 'acked' THEN 4 WHEN 'completed' THEN 5 ELSE 99 END)
        `).run({ id, status, lastError: opts?.lastError ?? null, updatedAt: now, targetRank });
    }

    /**
     * DELIVERED-NOT-CONSUMED-REDRIVE consume path. Advance a task's delivery record(s) to a
     * CONSUMED status ('acked' or 'completed'), matching on mesh + session (+ taskId when the
     * event names one) and INCLUDING rows already in 'delivered'/'acked'/'delivering'.
     *
     * The ack/terminal callers previously routed through getActiveSessionDeliveries(), whose SQL
     * EXCLUDES 'delivered' — so in the normal event order (transport confirm flips 'delivered'
     * BEFORE the worker's generating_started fires) the ack matched zero rows and the delivery
     * was stranded 'delivered', never 'acked'. This finds the row by (mesh, session[, task])
     * directly and relies on updateSessionDeliveryStatus's monotonic guard to only advance it.
     * Returns the number of rows advanced.
     */
    consumeSessionDelivery(meshId: string, sessionId: string, status: 'acked' | 'completed', taskId?: string): number {
        const rows = this.db.prepare(
            taskId
                ? `SELECT id, session_id FROM mesh_session_delivery
                     WHERE mesh_id = ? AND task_id = ?
                       AND status IN ('queued','delivering','delivered','acked')`
                : `SELECT id, session_id FROM mesh_session_delivery
                     WHERE mesh_id = ? AND session_id = ?
                       AND status IN ('queued','delivering','delivered','acked')`,
        ).all(meshId, taskId ?? sessionId) as Array<{ id: string; session_id: string | null }>;
        // Filter session membership in JS with the trimming equivalence predicate (mirrors
        // findAssignedBySession): a taskId match must still belong to this session, and the
        // session-only match already selected by column may carry serialization skew.
        let advanced = 0;
        for (const r of rows) {
            if (!sessionIdsEquivalent(r.session_id ?? undefined, sessionId)) continue;
            this.updateSessionDeliveryStatus(r.id, status);
            advanced++;
        }
        return advanced;
    }

    /**
     * DELIVERED-NOT-CONSUMED-REDRIVE terminal path. Mark every OPEN delivery for a session
     * (queued/delivering/delivered/acked) terminal on task completion/failure. The prior
     * markSessionDeliveriesTerminal() routed through getActiveSessionDeliveries(), whose SQL
     * EXCLUDES 'delivered'/'completed' — so a 'delivered' row (the common case, since the
     * transport confirm flips it before the completion event) was never marked terminal and
     * stayed 'delivered', keeping taskDeliveryConsumed() false and feeding the false re-drive.
     * We match rows in OPEN states directly here. 'completed' advances monotonically (it is the
     * top progress rank); 'failed' is an absorbing outcome written unconditionally.
     */
    markOpenSessionDeliveriesTerminal(meshId: string, sessionId: string, terminalStatus: 'completed' | 'failed'): number {
        const rows = this.db.prepare(
            `SELECT id, session_id FROM mesh_session_delivery
               WHERE mesh_id = ? AND status IN ('queued','delivering','delivered','acked')`,
        ).all(meshId) as Array<{ id: string; session_id: string | null }>;
        let marked = 0;
        for (const r of rows) {
            if (!sessionIdsEquivalent(r.session_id ?? undefined, sessionId)) continue;
            this.updateSessionDeliveryStatus(r.id, terminalStatus);
            marked++;
        }
        return marked;
    }

    getActiveSessionDeliveries(meshId: string, sessionId?: string): Array<{
        id: string; meshId: string; nodeId: string | null; sessionId: string | null;
        providerType: string | null; taskId: string | null; kind: string; priority: number;
        message: string; status: string; deliverAfter: string | null; expiresAt: string | null;
        attemptCount: number; sourceCoordinatorSessionId: string | null;
        sourceCoordinatorDaemonId: string | null; lastError: string | null;
        createdAt: string; updatedAt: string;
    }> {
        const now = new Date().toISOString();
        const sql = sessionId
            ? `SELECT * FROM mesh_session_delivery WHERE mesh_id = ? AND session_id = ? AND status NOT IN ('delivered','completed','failed','expired','cancelled') AND (expires_at IS NULL OR expires_at > ?) ORDER BY priority DESC, created_at ASC`
            : `SELECT * FROM mesh_session_delivery WHERE mesh_id = ? AND status NOT IN ('delivered','completed','failed','expired','cancelled') AND (expires_at IS NULL OR expires_at > ?) ORDER BY priority DESC, created_at ASC`;
        const rows = sessionId
            ? this.db.prepare(sql).all(meshId, sessionId, now) as Array<Record<string, unknown>>
            : this.db.prepare(sql).all(meshId, now) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            id: r.id as string,
            meshId: r.mesh_id as string,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            taskId: r.task_id as string | null,
            kind: r.kind as string,
            priority: r.priority as number,
            message: r.message as string,
            status: r.status as string,
            deliverAfter: r.deliver_after as string | null,
            expiresAt: r.expires_at as string | null,
            attemptCount: r.attempt_count as number,
            sourceCoordinatorSessionId: r.source_coordinator_session_id as string | null,
            sourceCoordinatorDaemonId: r.source_coordinator_daemon_id as string | null,
            lastError: r.last_error as string | null,
            createdAt: r.created_at as string,
            updatedAt: r.updated_at as string,
        }));
    }

    /**
     * Bug B watchdog support: true when at least one delivery record for the task has
     * reached a confirmed-handed-off status (delivered / acked / completed). The
     * assigned-stranded watchdog uses this to distinguish a dispatch that was never
     * confirmed (reclaimable) from one that WAS handed to the worker (a genuinely
     * in-flight or completion-lost task, which is PHASE 4's responsibility, not this
     * watchdog's). Indexed by (mesh_id, task_id).
     */
    taskHasConfirmedDelivery(meshId: string, taskId: string): boolean {
        const row = this.db.prepare(`
            SELECT 1 FROM mesh_session_delivery
            WHERE mesh_id = ? AND task_id = ? AND status IN ('delivered','acked','completed')
            LIMIT 1
        `).get(meshId, taskId) as { 1: number } | undefined;
        return !!row;
    }

    /**
     * DELIVERED-NOT-CONSUMED re-drive support: true when at least one delivery record for
     * the task has reached a CONSUMED status ('acked' / 'completed'). Distinct from
     * {@link taskHasConfirmedDelivery} ('delivered' | 'acked' | 'completed'): a delivery is
     * flipped to 'delivered' the instant the transport hands the dispatch off, but only
     * flipped to 'acked' when the worker's agent:generating_started event arrives (see the
     * generating_started handler in mesh-event-forwarding) — i.e. when the session has
     * actually begun the turn. That distinction is the cross-daemon consumption signal the
     * short-grace re-drive uses: a row whose delivery is 'delivered' but never 'acked' was
     * handed to a REMOTE worker that never started generating — the remote autoLaunch
     * delivered≠consumed gap — even when the session's busy verdict is UNKNOWN (not locally
     * observable). Indexed by (mesh_id, task_id).
     */
    taskDeliveryConsumed(meshId: string, taskId: string): boolean {
        const row = this.db.prepare(`
            SELECT 1 FROM mesh_session_delivery
            WHERE mesh_id = ? AND task_id = ? AND status IN ('acked','completed')
            LIMIT 1
        `).get(meshId, taskId) as { 1: number } | undefined;
        return !!row;
    }

    expireStaleSessionDeliveries(meshId: string): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            UPDATE mesh_session_delivery
            SET status = 'expired', updated_at = ?
            WHERE mesh_id = ? AND expires_at IS NOT NULL AND expires_at <= ?
              AND status NOT IN ('delivered','completed','failed','expired','cancelled')
        `).run(now, meshId, now);
    }

    deleteSessionDeliveries(meshId: string): void {
        this.db.prepare('DELETE FROM mesh_session_delivery WHERE mesh_id = ?').run(meshId);
    }

    // ── Completion Conflict Diagnostics ──────────────────────────────────────

    // MESH-COMPLEXITY-AUDIT Part 8-2: recordCompletionConflict /
    // getRecentCompletionConflicts (and their mesh_completion_conflicts table)
    // were removed. They were a write-only diagnostic of fingerprint-dedup
    // collisions with no production reader and no part in the no-loss delivery
    // contract; the table is dropped in migrateMeshIsolationColumns (step 6).

    /**
     * Record a mesh tool call and check whether this mesh+tool combination is
     * being called too rapidly (sliding window rate guard).
     *
     * Returns a rate-limit advisory string when the call rate is too high, null otherwise.
     * windowMs: sliding window size in ms (default 10s)
     * maxCalls: max allowed calls within the window (default 5)
     */
    recordMeshToolCall(opts: {
        meshId: string;
        tool: string;
        sessionId?: string | null;
        windowMs?: number;
        maxCalls?: number;
    }): { rateLimitExceeded: boolean; callsInWindow: number; advisory: string | null } {
        const { meshId, tool, sessionId = null } = opts;
        const windowMs = opts.windowMs ?? 10_000;
        const maxCalls = opts.maxCalls ?? 5;
        const now = Date.now();
        const windowStart = now - windowMs;

        this.db.prepare(
            'INSERT INTO mesh_tool_call_log (mesh_id, tool, session_id, called_at) VALUES (?, ?, ?, ?)'
        ).run(meshId, tool, sessionId, now);

        const row = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM mesh_tool_call_log WHERE mesh_id = ? AND tool = ? AND called_at >= ?'
        ).get(meshId, tool, windowStart) as { cnt: number };
        const callsInWindow = row?.cnt ?? 0;

        // Sweep old entries periodically to keep the table lean (every 200 calls across all tools).
        if (++this.toolCallLogCounter % 200 === 0) {
            this.db.prepare(
                'DELETE FROM mesh_tool_call_log WHERE called_at < ?'
            ).run(now - Math.max(windowMs * 10, 60_000));
        }

        if (callsInWindow > maxCalls) {
            const advisory = `Rate limit: ${tool} called ${callsInWindow} times in the last ${windowMs / 1000}s for mesh ${meshId}. `
                + `Wait for pendingCoordinatorEvents or an explicit user status request before calling again.`;
            return { rateLimitExceeded: true, callsInWindow, advisory };
        }
        return { rateLimitExceeded: false, callsInWindow, advisory: null };
    }

    /**
     * Prune tool call log entries older than the given age in ms.
     * Returns the number of rows deleted. Also used by the periodic retention
     * sweep (pruneMeshRuntimeRetention) — the in-write sweep in recordMeshToolCall
     * only fires every 200 calls and only covers the rate-limit window, so a
     * quiet mesh otherwise accumulates rows indefinitely.
     */
    pruneToolCallLog(olderThanMs: number): number {
        return this.db.prepare('DELETE FROM mesh_tool_call_log WHERE called_at < ?').run(Date.now() - olderThanMs).changes;
    }

    /**
     * Retention prune for mesh_event_ledger (SoT 1-11 (b)). The ledger is append-only
     * with NO lifecycle GC of its own, so lifecycle events accumulate without bound
     * (the dominant mesh-runtime.db growth). Every production reader is bounded to a
     * recent window (readLedgerEntries tail/limit ≤ a few hundred; task-stats /
     * terminal-evidence scans look at recent tasks), so rows past a generous age only
     * cost space. Excluded from deletion — retained forever:
     *   - coordinator_operating_note / _tombstone: runtime-accumulated lessons whose
     *     whole point is surviving restarts; a tombstone must also outlive the notes
     *     it retracts.
     * Timestamps are ISO-8601 TEXT, so the lexicographic `<` cutoff is a correct time
     * comparison; a malformed timestamp compares greater than any ISO date and is
     * conservatively retained. Returns rows deleted.
     */
    pruneEventLedger(olderThanMs: number): number {
        const cutoffIso = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
        return this.db.prepare(
            `DELETE FROM mesh_event_ledger
             WHERE timestamp < ?
               AND kind NOT IN ('coordinator_operating_note', 'coordinator_operating_note_tombstone')`
        ).run(cutoffIso).changes;
    }

    /**
     * Retention prune for TERMINAL (completed/cancelled/failed) mesh_queue rows
     * (SoT 1-11 (b)). Terminal rows are kept as recent history (mesh_task_history,
     * completion-dedup taskId lookups) but nothing ever deletes them, so the queue
     * table grows monotonically. Rows past the retention window serve no reader —
     * every dedup/attribution path operates on recent tasks — EXCEPT as a dependency
     * anchor: taskDependenciesSatisfied resolves dependsOn by id and treats a MISSING
     * row as not-completed, so deleting a completed row that a still-live
     * (pending/assigned) row depends on would permanently strand the dependent.
     * Those ids are collected first and excluded. Returns rows deleted.
     */
    pruneTerminalQueueEntries(olderThanMs: number): number {
        const cutoffIso = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
        return this.transaction(() => {
            // Dependency guard: protect every id a live row still depends on.
            const liveRows = this.db.prepare(
                `SELECT payload FROM mesh_queue WHERE status IN ('pending', 'assigned')`
            ).all() as Array<{ payload: string }>;
            const protectedIds = new Set<string>();
            for (const row of liveRows) {
                try {
                    const entry = JSON.parse(row.payload) as MeshWorkQueueEntry;
                    if (Array.isArray(entry.dependsOn)) {
                        for (const dep of entry.dependsOn) {
                            if (typeof dep === 'string' && dep) protectedIds.add(dep);
                        }
                    }
                } catch { /* unparsable payload → nothing to protect */ }
            }
            const candidates = this.db.prepare(
                `SELECT id FROM mesh_queue
                 WHERE status IN ('completed', 'cancelled', 'failed') AND updated_at < ?`
            ).all(cutoffIso) as Array<{ id: string }>;
            const deletable = candidates.map(r => r.id).filter(id => !protectedIds.has(id));
            let removed = 0;
            // Chunk the DELETE to stay well under SQLite's bind-parameter limit.
            for (let i = 0; i < deletable.length; i += 500) {
                const chunk = deletable.slice(i, i + 500);
                removed += this.db.prepare(
                    `DELETE FROM mesh_queue WHERE id IN (${chunk.map(() => '?').join(',')})`
                ).run(...chunk).changes;
            }
            return removed;
        });
    }

    /**
     * Retention prune for TERMINAL-OUTCOME mesh_session_delivery rows (lifecycle
     * retention Slice 1). Only the absorbing/final statuses are deleted —
     * 'completed' (top progress rank), 'failed', 'expired', 'cancelled'. The
     * live/nonterminal rows (queued/delivering/delivered/acked) are NEVER
     * pruned here: they carry the retry/recovery semantics
     * (taskHasConfirmedDelivery / taskDeliveryConsumed / consumeSessionDelivery /
     * the delivered≠consumed re-drive), and expireStaleSessionDeliveries is the
     * only path that retires a live row (into 'expired', which this prune then
     * collects after the window). Age is measured from updated_at (when the row
     * reached its outcome). Timestamps are ISO-8601 TEXT, so the lexicographic
     * `<` cutoff is a correct time comparison; a row exactly AT the cutoff is
     * kept (strict `<`). Returns rows deleted.
     */
    pruneTerminalSessionDeliveries(olderThanMs: number): number {
        const cutoffIso = new Date(Date.now() - Math.max(0, olderThanMs)).toISOString();
        return this.db.prepare(
            `DELETE FROM mesh_session_delivery
             WHERE status IN ('completed', 'failed', 'expired', 'cancelled')
               AND updated_at < ?`
        ).run(cutoffIso).changes;
    }

    // ── G2: Event Ledger ────────────────────────────────────────────────────

    appendLedgerEntry(entry: {
        id: string;
        meshId: string;
        timestamp: string;
        kind: string;
        nodeId?: string | null;
        sessionId?: string | null;
        providerType?: string | null;
        taskId?: string | null;
        payload?: unknown;
    }): void {
        // Ledger `kind` is a mandatory schema invariant (mesh_event_ledger.kind is
        // NOT NULL; every MeshLedgerKind is a non-empty tag). A blank kind would be a
        // structurally-broken entry — reject it here rather than write an unqueryable
        // row. NOTE: pending-event JSONL files (`*.pending-events.jsonl`) are a
        // SEPARATE shape that intentionally has NO `kind` field (they key off `.event`);
        // a generic audit that scans the whole ledger DIRECTORY and reads `.kind` off
        // those rows sees "kind=None", which is an artifact of mixing the two files, not
        // a ledger defect. This guard makes the ledger-side invariant explicit.
        if (!entry.kind || !String(entry.kind).trim()) {
            LOG.warn('MeshRuntimeStore', `Refusing to append ledger entry with empty kind for mesh ${entry.meshId} (id ${entry.id})`);
            return;
        }
        this.db.prepare(
            `INSERT OR IGNORE INTO mesh_event_ledger
             (id, mesh_id, timestamp, kind, node_id, session_id, provider_type, task_id, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            entry.id,
            entry.meshId,
            entry.timestamp,
            entry.kind,
            entry.nodeId ?? null,
            entry.sessionId ?? null,
            entry.providerType ?? null,
            entry.taskId ?? null,
            JSON.stringify(entry.payload ?? {}),
        );
        this.maybeCheckpointWal();
    }

    readLedgerEntries(meshId: string, opts?: {
        tail?: number;
        since?: string;
        kind?: string;
        limit?: number;
    }): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; taskId: string | null; payload: unknown }> {
        const limit = opts?.tail ?? opts?.limit ?? 200;
        let query: string;
        const params: unknown[] = [meshId];
        if (opts?.kind && opts?.since) {
            query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? AND kind = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?`;
            params.push(opts.kind, opts.since, limit);
        } else if (opts?.kind) {
            query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? AND kind = ? ORDER BY timestamp DESC LIMIT ?`;
            params.push(opts.kind, limit);
        } else if (opts?.since) {
            query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?`;
            params.push(opts.since, limit);
        } else {
            query = `SELECT * FROM mesh_event_ledger WHERE mesh_id = ? ORDER BY timestamp DESC LIMIT ?`;
            params.push(limit);
        }
        const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            id: r.id as string,
            meshId: r.mesh_id as string,
            timestamp: r.timestamp as string,
            kind: r.kind as string,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            taskId: (r.task_id as string | null) ?? null,
            payload: (() => { try { return JSON.parse(r.payload as string); } catch { return {}; } })(),
        }));
    }

    /**
     * G2 read cutover: read ledger entries in append order (oldest first),
     * matching legacy JSONL file-order semantics. Ties on the same timestamp
     * are broken by rowid (insertion order), preserving the positional
     * guarantee that mesh-events relies on for same-millisecond entries.
     */
    readLedgerEntriesOrdered(meshId: string, opts?: {
        since?: string;
        kinds?: string[];
        tail?: number;
    }): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; taskId: string | null; payload: unknown }> {
        const params: unknown[] = [meshId];
        let whereClause = 'mesh_id = ?';
        if (opts?.since) {
            whereClause += ' AND timestamp >= ?';
            params.push(opts.since);
        }
        const kinds = Array.isArray(opts?.kinds) ? opts.kinds.filter(k => typeof k === 'string' && k.trim()) : [];
        if (kinds.length > 0) {
            whereClause += ` AND kind IN (${kinds.map(() => '?').join(', ')})`;
            params.push(...kinds);
        }
        let query: string;
        if (opts?.tail && opts.tail > 0) {
            // Tail: newest N in append order — inner DESC limit, outer re-sort ASC.
            query = `SELECT * FROM (
                SELECT rowid AS rid, * FROM mesh_event_ledger WHERE ${whereClause}
                ORDER BY timestamp DESC, rowid DESC LIMIT ?
            ) ORDER BY timestamp ASC, rid ASC`;
            params.push(Math.floor(opts.tail));
        } else {
            query = `SELECT rowid AS rid, * FROM mesh_event_ledger WHERE ${whereClause} ORDER BY timestamp ASC, rowid ASC`;
        }
        const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            id: r.id as string,
            meshId: r.mesh_id as string,
            timestamp: r.timestamp as string,
            kind: r.kind as string,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            taskId: (r.task_id as string | null) ?? null,
            payload: (() => { try { return JSON.parse(r.payload as string); } catch { return {}; } })(),
        }));
    }

    /** Remove all ledger entries for a mesh (mesh deletion / test cleanup). */
    clearLedgerForMesh(meshId: string): number {
        return this.db.prepare('DELETE FROM mesh_event_ledger WHERE mesh_id = ?').run(meshId).changes;
    }

    /** G2: remove entries moved to the JSONL archive so the SQLite runtime set mirrors the active ledger. */
    deleteLedgerEntries(meshId: string, ids: string[]): number {
        if (!ids.length) return 0;
        let deleted = 0;
        const stmt = this.db.prepare('DELETE FROM mesh_event_ledger WHERE mesh_id = ? AND id = ?');
        this.db.transaction(() => {
            for (const id of ids) {
                deleted += stmt.run(meshId, id).changes;
            }
        })();
        return deleted;
    }

    hasLedgerEntry(meshId: string, id: string): boolean {
        const row = this.db.prepare(
            'SELECT 1 FROM mesh_event_ledger WHERE mesh_id = ? AND id = ? LIMIT 1'
        ).get(meshId, id);
        return row !== undefined;
    }

    ledgerEntryCount(meshId: string): number {
        const row = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM mesh_event_ledger WHERE mesh_id = ?'
        ).get(meshId) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
    }

    importLedgerEntries(entries: Array<{
        id: string; meshId: string; timestamp: string; kind: string;
        nodeId?: string | null; sessionId?: string | null; providerType?: string | null; taskId?: string | null; payload?: unknown;
    }>): number {
        let imported = 0;
        const stmt = this.db.prepare(
            `INSERT OR IGNORE INTO mesh_event_ledger
             (id, mesh_id, timestamp, kind, node_id, session_id, provider_type, task_id, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        this.db.transaction(() => {
            for (const e of entries) {
                // Skip structurally-broken entries with a blank kind (see appendLedgerEntry):
                // mesh_event_ledger.kind is NOT NULL and every kind is a non-empty tag, so an
                // empty-kind row is unqueryable noise. Mirrors readLedgerFile's `entry.id && entry.kind`
                // JSONL guard, keeping the import path from re-introducing what the read path filters.
                if (!e.kind || !String(e.kind).trim()) continue;
                const result = stmt.run(
                    e.id, e.meshId, e.timestamp, e.kind,
                    e.nodeId ?? null, e.sessionId ?? null, e.providerType ?? null, e.taskId ?? null,
                    JSON.stringify(e.payload ?? {}),
                );
                if (result.changes > 0) imported++;
            }
        })();
        return imported;
    }

    /**
     * G4: Read a bounded, cursor-addressable ledger slice directly from the SQLite
     * mesh_event_ledger table. This is the P2P reconcile read path; JSONL files are
     * retained as export/import/debug/legacy artifacts only.
     *
     * The return shape is structurally compatible with MeshLedgerSlice so callers
     * in mesh-tools.ts can pass it directly to buildMeshLedgerReplicaEvidence.
     */
    readLedgerSlice(meshId: string, opts?: {
        afterId?: string;
        since?: string;
        kind?: string;
        limit?: number;
    }): {
        protocol: 'adhdev.mesh.ledger.slice.v1';
        meshId: string;
        entries: Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; payload: unknown }>;
        cursor: { afterId: string | null; nextAfterId: string | null; limit: number; hasMore: boolean };
        sourceOfTruth: { kind: 'local_sqlite'; table: 'mesh_event_ledger'; bounded: true; maxLimit: number };
    } {
        // Protocol maximum of 500, default 100 — mirrors mesh-ledger.ts constants.
        const MAX_LIMIT = 500;
        const DEFAULT_LIMIT = 100;
        const limit = (typeof opts?.limit === 'number' && Number.isFinite(opts.limit))
            ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit)))
            : DEFAULT_LIMIT;

        const afterId = typeof opts?.afterId === 'string' && opts.afterId.trim() ? opts.afterId.trim() : null;

        // Build query: fetch limit+1 rows so we can detect hasMore without a COUNT(*).
        const params: unknown[] = [meshId];
        let whereClause = 'mesh_id = ?';

        if (opts?.kind) {
            whereClause += ' AND kind = ?';
            params.push(opts.kind);
        }
        if (opts?.since) {
            whereClause += ' AND timestamp >= ?';
            params.push(opts.since);
        }
        if (afterId) {
            // afterId: return entries with timestamp strictly after the referenced entry's timestamp,
            // or with the same timestamp but id > afterId (stable pagination).
            whereClause += ` AND (timestamp > (SELECT timestamp FROM mesh_event_ledger WHERE id = ? AND mesh_id = ?) OR (timestamp = (SELECT timestamp FROM mesh_event_ledger WHERE id = ? AND mesh_id = ?) AND id > ?))`;
            params.push(afterId, meshId, afterId, meshId, afterId);
        }

        // Fetch limit+1 to detect hasMore
        const query = `SELECT * FROM mesh_event_ledger WHERE ${whereClause} ORDER BY timestamp ASC, id ASC LIMIT ?`;
        params.push(limit + 1);

        const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
        const hasMore = rows.length > limit;
        const bounded = hasMore ? rows.slice(0, limit) : rows;

        const entries = bounded.map(r => ({
            id: r.id as string,
            meshId: r.mesh_id as string,
            timestamp: r.timestamp as string,
            kind: r.kind as string,
            nodeId: r.node_id as string | null,
            sessionId: r.session_id as string | null,
            providerType: r.provider_type as string | null,
            payload: (() => { try { return JSON.parse(r.payload as string); } catch { return {}; } })(),
        }));

        return {
            protocol: 'adhdev.mesh.ledger.slice.v1',
            meshId,
            entries,
            cursor: {
                afterId,
                nextAfterId: entries.length ? entries[entries.length - 1].id : afterId,
                limit,
                hasMore,
            },
            sourceOfTruth: {
                kind: 'local_sqlite',
                table: 'mesh_event_ledger',
                bounded: true,
                maxLimit: MAX_LIMIT,
            },
        };
    }

    // ── G3: Pending Coordinator Events ──────────────────────────────────────

    insertPendingEvent(event: {
        id: string;
        meshId: string;
        coordinatorDaemonId?: string | null;
        event: string;
        payload?: unknown;
        fingerprint?: string | null;
        queuedAt: number;
        // v2 envelope columns (B2a) — all optional so v1 callers/rows are unaffected.
        // dispatchedBy / intendedFor are pre-serialized CoordinatorIdentity JSON.
        protocolVersion?: string | null;
        eventId?: string | null;
        scope?: string | null;
        dispatchedBy?: string | null;
        intendedFor?: string | null;
    }): boolean {
        const result = this.db.prepare(
            `INSERT OR IGNORE INTO mesh_pending_events
             (id, mesh_id, coordinator_daemon_id, event, payload, fingerprint, queued_at,
              protocol_version, event_id, scope, dispatched_by, intended_for)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            event.id,
            event.meshId,
            event.coordinatorDaemonId ?? null,
            event.event,
            JSON.stringify(event.payload ?? {}),
            event.fingerprint ?? null,
            event.queuedAt,
            event.protocolVersion ?? null,
            event.eventId ?? null,
            event.scope ?? null,
            event.dispatchedBy ?? null,
            event.intendedFor ?? null,
        );
        this.maybeCheckpointWal();
        return result.changes > 0;
    }

    /**
     * Drain undrained pending events for a mesh, atomically marking them drained.
     * When `opts.onlyEvents` is supplied, ONLY rows whose `event` is in that set are
     * drained — the rest stay queued (drained=0) for a later drain. This is how the
     * reconcile loop force-drains terminal/force-inject events into a *generating*
     * coordinator while leaving non-force progress events for the coordinator's next
     * idle transition. Filtering happens inside the same transaction as the
     * drained=1 marking, so force-drain + a concurrent full drain can never both
     * consume the same row.
     */
    drainPendingEvents(
        meshId: string,
        coordinatorDaemonId?: string | null | ReadonlyArray<string>,
        // `drainedBy` (REFINE-EVENT-SESSION-SCOPED-UNICAST) is the pre-serialized
        // drainer CoordinatorIdentity JSON, recorded on the rows this call consumes so
        // a mis-delivered unicast is auditable after the fact instead of inferred.
        // Omitted → the column stays NULL, exactly as before (no behaviour change).
        opts?: { onlyEvents?: ReadonlySet<string>; drainedBy?: string | null },
    ): Array<{ id: string; event: string; payload: unknown }> {
        return this.transaction(() => {
            const onlyEvents = opts?.onlyEvents;
            // An explicit-but-empty filter means "drain nothing" (no event name can match).
            if (onlyEvents && onlyEvents.size === 0) return [];
            const eventList = onlyEvents ? [...onlyEvents] : [];
            // A coordinator daemon can answer to more than one id form: its canonical
            // status id (e.g. `standalone_<machineId>` / `daemon_<machineId>`, which the
            // MCP layer stamps via ctx.localDaemonId) AND the bare machineId (stamped by
            // the local queue-assignment path). Accept ANY of them so a unicast event
            // stamped with either id is drained here. Unscoped (NULL) rows always match.
            const daemonIds = (Array.isArray(coordinatorDaemonId)
                ? coordinatorDaemonId
                : coordinatorDaemonId ? [coordinatorDaemonId] : [])
                .filter((id): id is string => typeof id === 'string' && id.length > 0);
            // Filter by event name IN-SQL when onlyEvents is set so the LIMIT applies to
            // matching rows — a long run of non-force events ahead in the queue must not
            // crowd a force event out of the 100-row window.
            const clauses = ['mesh_id = ?', 'drained = 0'];
            const params: unknown[] = [meshId];
            if (daemonIds.length > 0) {
                clauses.push(`(coordinator_daemon_id IS NULL OR coordinator_daemon_id IN (${daemonIds.map(() => '?').join(',')}))`);
                params.push(...daemonIds);
            }
            if (eventList.length > 0) {
                clauses.push(`event IN (${eventList.map(() => '?').join(',')})`);
                params.push(...eventList);
            }
            const rows = this.db.prepare(
                `SELECT id, event, payload FROM mesh_pending_events WHERE ${clauses.join(' AND ')} ORDER BY queued_at ASC LIMIT 100`
            ).all(...params) as Array<{ id: string; event: string; payload: string }>;
            if (rows.length === 0) return [];
            const ids = rows.map(r => r.id);
            const now = Date.now();
            this.db.prepare(
                `UPDATE mesh_pending_events SET drained = 1, drained_at = ?, drained_by = ? WHERE id IN (${ids.map(() => '?').join(',')})`
            ).run(now, opts?.drainedBy ?? null, ...ids);
            return rows.map(r => ({
                id: r.id,
                event: r.event,
                payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
            }));
        });
    }

    /** Non-destructive peek — returns undrained events without marking them drained. */
    peekPendingEvents(meshId: string, coordinatorDaemonId?: string | null | ReadonlyArray<string>): Array<{ id: string; event: string; payload: unknown }> {
        const daemonIds = (Array.isArray(coordinatorDaemonId)
            ? coordinatorDaemonId
            : coordinatorDaemonId ? [coordinatorDaemonId] : [])
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const whereClause = daemonIds.length > 0
            ? `WHERE mesh_id = ? AND drained = 0 AND (coordinator_daemon_id IS NULL OR coordinator_daemon_id IN (${daemonIds.map(() => '?').join(',')}))`
            : `WHERE mesh_id = ? AND drained = 0`;
        const params: unknown[] = daemonIds.length > 0 ? [meshId, ...daemonIds] : [meshId];
        const rows = this.db.prepare(
            `SELECT id, event, payload FROM mesh_pending_events ${whereClause} ORDER BY queued_at ASC LIMIT 100`
        ).all(...params) as Array<{ id: string; event: string; payload: string }>;
        return rows.map(r => ({
            id: r.id,
            event: r.event,
            payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
        }));
    }

    /**
     * REFINE-EVENT-SESSION-SCOPED-UNICAST — drain attribution audit. Returns the most
     * recent pending-event rows for a mesh with WHO drained each one, so a suspected
     * mis-delivery ("my refine result went to another coordinator session") is answered
     * from the ledger instead of inferred from timing. `drainedBy` is the serialized
     * drainer CoordinatorIdentity, or null when the row is still queued, was drained
     * before this column existed, or was drained by a caller that passed no identity.
     */
    recentDrainedPendingEvents(meshId: string, limit = 100): Array<{
        id: string;
        event: string;
        scope: string | null;
        intendedFor: string | null;
        drainedBy: string | null;
        drained: boolean;
        queuedAt: number;
        drainedAt: number | null;
    }> {
        const rows = this.db.prepare(
            `SELECT id, event, scope, intended_for, drained_by, drained, queued_at, drained_at
             FROM mesh_pending_events WHERE mesh_id = ? ORDER BY queued_at DESC LIMIT ?`
        ).all(meshId, Math.max(1, limit)) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            id: r.id as string,
            event: r.event as string,
            scope: (r.scope as string | null) ?? null,
            intendedFor: (r.intended_for as string | null) ?? null,
            drainedBy: (r.drained_by as string | null) ?? null,
            drained: r.drained === 1,
            queuedAt: r.queued_at as number,
            drainedAt: (r.drained_at as number | null) ?? null,
        }));
    }

    hasPendingEventFingerprint(meshId: string, fingerprint: string): boolean {
        const row = this.db.prepare(
            'SELECT 1 FROM mesh_pending_events WHERE mesh_id = ? AND fingerprint = ? AND drained = 0 LIMIT 1'
        ).get(meshId, fingerprint);
        return row !== undefined;
    }

    /**
     * B3a — v2 eventId idempotency. Returns true when a row with this event_id has
     * ALREADY been drained (drained = 1) for the mesh. Drained rows are retained
     * (soft-marked, not deleted until mesh deletion), so this is a durable, restart-
     * surviving dedup: a v2 event whose eventId was already consumed is skipped on
     * re-delivery even when its content fingerprint differs. Scoped by mesh_id +
     * the partial event_id index (idx_mesh_pending_events_event_id).
     */
    hasDrainedEventId(meshId: string, eventId: string): boolean {
        if (!eventId) return false;
        const row = this.db.prepare(
            'SELECT 1 FROM mesh_pending_events WHERE mesh_id = ? AND event_id = ? AND drained = 1 LIMIT 1'
        ).get(meshId, eventId);
        return row !== undefined;
    }

    /**
     * B3a — snapshot of the v2 event_ids ALREADY drained (drained = 1) for the mesh.
     * Taken BEFORE a drain call marks the current batch drained=1, so the resulting
     * set names only PRIOR drains — the re-delivery dedup baseline. (Reading it after
     * the drain would self-match the batch's own freshly-drained rows.) Non-v2 rows
     * have a NULL event_id and are excluded by the index/WHERE.
     */
    drainedEventIdsForMesh(meshId: string): Set<string> {
        const rows = this.db.prepare(
            'SELECT DISTINCT event_id FROM mesh_pending_events WHERE mesh_id = ? AND drained = 1 AND event_id IS NOT NULL'
        ).all(meshId) as Array<{ event_id: string }>;
        return new Set(rows.map(r => r.event_id));
    }

    // ── M3: Mission Records ─────────────────────────────────────────────────

    upsertMission(mission: {
        id: string;
        meshId: string;
        title: string;
        goal?: string;
        status?: string;
        source?: string;
    }): void {
        const now = new Date().toISOString();
        // `source` is a write-once provenance tag: on conflict we only overwrite it
        // with a non-null incoming value (COALESCE(excluded, existing)), so a later
        // status/goal upsert that omits source never clears a previously-stamped
        // 'magi'/'coordinator' tag.
        // close_candidate_emitted_at is deliberately NOT in the UPDATE set: the G3
        // idempotency marker is owned solely by setMissionCloseCandidateEmittedAt, so a
        // title/goal/status upsert here never clears or overwrites it.
        this.db.prepare(
            `INSERT INTO mesh_missions (id, mesh_id, title, goal, status, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title,
                 goal = excluded.goal,
                 status = excluded.status,
                 source = COALESCE(excluded.source, mesh_missions.source),
                 updated_at = excluded.updated_at`
        ).run(
            mission.id,
            mission.meshId,
            mission.title,
            mission.goal ?? '',
            mission.status ?? 'active',
            mission.source ?? null,
            now,
            now,
        );
        this.maybeCheckpointWal();
    }

    getMission(meshId: string, missionId: string): { id: string; meshId: string; title: string; goal: string; status: string; source?: string; closeCandidateEmittedAt?: string; createdAt: string; updatedAt: string } | null {
        const row = this.db.prepare(
            'SELECT * FROM mesh_missions WHERE mesh_id = ? AND id = ?'
        ).get(meshId, missionId) as Record<string, string> | undefined;
        if (!row) return null;
        return { id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, source: row.source ?? undefined, closeCandidateEmittedAt: row.close_candidate_emitted_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
    }

    getMissions(meshId: string, statuses?: string[]): Array<{ id: string; meshId: string; title: string; goal: string; status: string; source?: string; closeCandidateEmittedAt?: string; createdAt: string; updatedAt: string }> {
        let rows: Array<Record<string, string>>;
        if (statuses?.length) {
            const placeholders = statuses.map(() => '?').join(', ');
            rows = this.db.prepare(
                `SELECT * FROM mesh_missions WHERE mesh_id = ? AND status IN (${placeholders}) ORDER BY updated_at DESC`
            ).all(meshId, ...statuses) as Array<Record<string, string>>;
        } else {
            rows = this.db.prepare(
                'SELECT * FROM mesh_missions WHERE mesh_id = ? ORDER BY updated_at DESC'
            ).all(meshId) as Array<Record<string, string>>;
        }
        return rows.map(row => ({ id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, source: row.source ?? undefined, closeCandidateEmittedAt: row.close_candidate_emitted_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }));
    }

    /**
     * G3: set/clear the mission_close_candidate idempotency marker. Passing an ISO
     * timestamp records that the all-terminal nudge has been emitted for this mission;
     * passing null clears it (mission returned to a non-terminal state, so a future
     * re-completion may nudge again). Touches ONLY this column — never the mission's
     * updated_at — so the marker write is invisible to updatedAt-ordered surfaces and
     * does not masquerade as mission activity. Returns rows changed (0 if no such mission).
     */
    setMissionCloseCandidateEmittedAt(meshId: string, missionId: string, emittedAt: string | null): number {
        return this.db.prepare(
            'UPDATE mesh_missions SET close_candidate_emitted_at = ? WHERE mesh_id = ? AND id = ?'
        ).run(emittedAt, meshId, missionId).changes;
    }

    /**
     * Read the last idle-active-mission-reminder debounce marker for a mesh, or null if
     * none has fired this process. In-memory only (see idleReminderState) — best-effort
     * spam guard for a coordinator nudge, intentionally not SQLite-backed.
     */
    getIdleReminderState(meshId: string): { emittedAt: number; missionSetHash: string } | null {
        return this.idleReminderState.get(meshId) ?? null;
    }

    /** Record that an idle-active-mission reminder just fired for a mesh (debounce marker). */
    setIdleReminderState(meshId: string, state: { emittedAt: number; missionSetHash: string }): void {
        this.idleReminderState.set(meshId, state);
    }

    /** Clear the idle-reminder debounce marker for a mesh — mesh deletion / test cleanup. */
    clearIdleReminderState(meshId: string): void {
        this.idleReminderState.delete(meshId);
    }

    /** Remove all missions for a mesh — mesh deletion / test cleanup. */
    clearMissionsForMesh(meshId: string): number {
        return this.db.prepare('DELETE FROM mesh_missions WHERE mesh_id = ?').run(meshId).changes;
    }

    /** Remove all pending-event rows (drained included) for a mesh — mesh deletion / test cleanup. */
    clearPendingEventsForMesh(meshId: string): number {
        return this.db.prepare('DELETE FROM mesh_pending_events WHERE mesh_id = ?').run(meshId).changes;
    }

    pendingEventCount(meshId: string): number {
        const row = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM mesh_pending_events WHERE mesh_id = ? AND drained = 0'
        ).get(meshId) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
    }

    /**
     * Mark specific pending-event rows drained by id (ack). Used by the
     * unresolved-delegate durable-forward outbox: an event is peeked (not drained)
     * while its push to the coordinator is unconfirmed, then marked drained ONLY
     * after the push is acked. A failed push leaves the row undrained so the next
     * reconcile tick retries it. Returns the number of rows newly marked drained.
     */
    markPendingEventsDrainedById(ids: ReadonlyArray<string>): number {
        const idList = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (idList.length === 0) return 0;
        const now = Date.now();
        return this.db.prepare(
            `UPDATE mesh_pending_events SET drained = 1, drained_at = ? WHERE drained = 0 AND id IN (${idList.map(() => '?').join(',')})`
        ).run(now, ...idList).changes;
    }

    /**
     * STRICT-ROUTE-HOLD-DURABILITY: return an ALREADY-DRAINED row to the queue
     * (drained=1 → drained=0), in place, by fingerprint.
     *
     * Why this exists (the rc.33 defect): a strict-routed completion whose originating
     * coordinator session is not currently live is "held" by re-queuing it. That
     * re-queue used to call the normal insert path, which CANNOT work for a held
     * event — three independent suppressors reject it:
     *
     *   1. `idx_mesh_pending_events_fingerprint` is UNIQUE on (mesh_id, fingerprint)
     *      with NO `drained` qualifier, and insertPendingEvent uses INSERT OR IGNORE.
     *      The just-drained row still occupies that fingerprint, so the "fresh
     *      undrained copy" is silently ignored — changes = 0, no row added.
     *   2. hasPendingCoordinatorEventDuplicate → hasPendingEventFingerprint queries
     *      `drained = 0`, so it does NOT see the drained original and reports no
     *      duplicate — the caller believes the re-queue succeeded.
     *   3. Even if a copy did land, the v2 eventId is already in
     *      drainedEventIdsForMesh(), so routeV2EventsForDrainer would skip it as
     *      already-delivered on the next drain.
     *
     * The pre-restart hold only ever worked because the in-memory reconcile loop
     * re-read the event; nothing durable was written. A restart inside the 60s TTL
     * therefore lost the completion permanently (observed: task ec6c901a — exactly
     * one row, drained=1, and zero lines in the JSONL mirror).
     *
     * Flipping the EXISTING row back to drained=0 is the only correct move: it keeps
     * the unique fingerprint (no duplicate row can ever be created), removes the
     * eventId from the drained-baseline so the v2 idempotency filter stops swallowing
     * it, and makes the hold survive a process restart. queued_at is deliberately
     * PRESERVED so the strict TTL keeps measuring the event's true age across holds
     * and cannot be refreshed into an immortal row.
     *
     * Returns true when a drained row was found and returned to the queue.
     */
    requeueDrainedPendingEventByFingerprint(meshId: string, fingerprint: string): boolean {
        if (!fingerprint) return false;
        // drained_by is cleared with drained_at: the row is queued again, so the
        // previous drainer is no longer the consumer of record. Leaving it set would
        // make the audit surface attribute the row to a coordinator that gave it back.
        const changes = this.db.prepare(
            `UPDATE mesh_pending_events SET drained = 0, drained_at = NULL, drained_by = NULL
             WHERE mesh_id = ? AND fingerprint = ? AND drained = 1`
        ).run(meshId, fingerprint).changes;
        if (changes > 0) this.maybeCheckpointWal();
        return changes > 0;
    }

    /**
     * Hard-delete pending-event rows by id (including the dedup fingerprint history).
     * Used to expire an unresolved-delegate outbox entry that has exhausted its retry
     * budget — fully removing it frees the fingerprint so a genuinely new completion
     * for the same task could be re-queued later. Returns the number of rows deleted.
     */
    deletePendingEventsById(ids: ReadonlyArray<string>): number {
        const idList = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (idList.length === 0) return 0;
        return this.db.prepare(
            `DELETE FROM mesh_pending_events WHERE id IN (${idList.map(() => '?').join(',')})`
        ).run(...idList).changes;
    }

    /**
     * Retention prune for mesh_pending_events. This table has no lifecycle GC of its
     * own: a drained row is soft-marked (drained=1) and RETAINED — deliberately, so
     * drainedEventIdsForMesh() has a durable v2-eventId dedup baseline — and an
     * undrained row queued for a coordinator that never returned (a dead/evicted
     * coordinator identity) stays drained=0 forever. Both accumulate without bound
     * (observed: tens of thousands of rows, mostly stale). This is the missing
     * retention step. Two independent windows:
     *
     *   - drained rows older than `drainedOlderThanMs`: the coordinator consumed them
     *     long ago; the only thing they still back is the eventId re-delivery guard,
     *     which is only meaningful for the recent past (a re-delivery of a week-old
     *     event cannot occur — its producer session is long gone). Safe to delete.
     *   - UNDRAINED rows older than `undrainedOlderThanMs` (a much wider window):
     *     these are orphaned events for a coordinator identity that never drained
     *     them. Kept wide so a genuinely-offline-but-returning coordinator still
     *     receives its backlog; only genuinely unrecoverable orphans are swept.
     *
     * Both windows key off `queued_at` (always present) — `drained_at` can be NULL on
     * legacy rows. Returns the number of rows deleted, split by which window matched:
     * `drainedExpired` (already-delivered rows past the dedup-useful window — not a
     * drop, the coordinator already got these) and `undrainedExpired` (rows that were
     * NEVER delivered — a genuine silent drop, same shape as the retired JSONL trim's
     * `pending_trim_dropped`). `undrainedRows` carries the id/meshId/event/payload of
     * every undrained-expired row BEFORE deletion so the caller can mirror it to the
     * mesh ledger as `event_held` (recoverable via mesh_requeue_held_events) instead of
     * losing it silently — this is the observability gap the retired trim used to cover
     * and the SQLite-only cutover left open. Best-effort / idempotent: running it
     * repeatedly with nothing to prune is a cheap no-op.
     */
    prunePendingEvents(opts: { drainedOlderThanMs: number; undrainedOlderThanMs: number }): {
        drainedExpired: number;
        undrainedExpired: number;
        undrainedRows: Array<{ id: string; meshId: string; event: string; payload: unknown }>;
    } {
        const now = Date.now();
        const drainedCutoff = now - Math.max(0, opts.drainedOlderThanMs);
        const undrainedCutoff = now - Math.max(0, opts.undrainedOlderThanMs);

        // Capture the undrained-expired rows BEFORE deleting them — these never
        // reached a coordinator, so deleting them is a silent drop unless the caller
        // mirrors this snapshot to the ledger first.
        const undrainedSelectRows = this.db.prepare(
            'SELECT id, mesh_id, event, payload FROM mesh_pending_events WHERE drained = 0 AND queued_at < ?'
        ).all(undrainedCutoff) as Array<{ id: string; mesh_id: string; event: string; payload: string }>;
        const undrainedRows = undrainedSelectRows.map(r => ({
            id: r.id,
            meshId: r.mesh_id,
            event: r.event,
            payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
        }));

        const drainedExpired = this.db.prepare(
            'DELETE FROM mesh_pending_events WHERE drained = 1 AND queued_at < ?'
        ).run(drainedCutoff).changes;
        const undrainedExpired = this.db.prepare(
            'DELETE FROM mesh_pending_events WHERE drained = 0 AND queued_at < ?'
        ).run(undrainedCutoff).changes;
        return { drainedExpired, undrainedExpired, undrainedRows };
    }

    // ── TURN-LEDGER (Stage 5): authoritative turn attempts ───────────────────

    /**
     * Insert a new turn attempt. INSERT OR IGNORE on the PRIMARY KEY / the
     * UNIQUE(mesh_id, task_id, attempt_seq) constraint makes a retried open (e.g. a
     * dispatch restarted after a crash between the queue claim and this write)
     * idempotent: returns true when this call inserted the row, false when an
     * attempt for that identity already exists (caller then reads it back).
     */
    insertTurnAttempt(row: {
        attemptId: string; meshId: string; taskId: string; attemptSeq: number;
        nodeId?: string; sessionId?: string; providerType?: string;
        coordinatorDaemonId?: string; coordinatorSessionId?: string;
        dispatchNonce?: number; stage: string; leaseDeadlineMs?: number | null;
        acceptedAt?: string; createdAt: string; updatedAt: string;
    }): boolean {
        const res = this.db.prepare(`
            INSERT OR IGNORE INTO mesh_turn_attempts (
                attempt_id, mesh_id, task_id, attempt_seq, node_id, session_id,
                provider_type, coordinator_daemon_id, coordinator_session_id,
                dispatch_nonce, stage, lease_deadline_ms, accepted_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.attemptId, row.meshId, row.taskId, row.attemptSeq,
            row.nodeId ?? null, row.sessionId ?? null, row.providerType ?? null,
            row.coordinatorDaemonId ?? null, row.coordinatorSessionId ?? null,
            row.dispatchNonce ?? null, row.stage, row.leaseDeadlineMs ?? null,
            row.acceptedAt ?? null, row.createdAt, row.updatedAt,
        );
        this.maybeCheckpointWal();
        return res.changes > 0;
    }

    getTurnAttempt(attemptId: string): MeshTurnAttemptRow | null {
        const row = this.db.prepare('SELECT * FROM mesh_turn_attempts WHERE attempt_id = ?')
            .get(attemptId) as Record<string, unknown> | undefined;
        return row ? meshTurnAttemptFromRow(row) : null;
    }

    /**
     * The CURRENT attempt for a task: the highest attempt_seq row. Reassignment
     * monotonically increases the seq (it is the dispatch nonce), so the max-seq row
     * is the only attempt late events may still mutate.
     */
    getCurrentTurnAttempt(meshId: string, taskId: string): MeshTurnAttemptRow | null {
        const row = this.db.prepare(`
            SELECT * FROM mesh_turn_attempts
            WHERE mesh_id = ? AND task_id = ?
            ORDER BY attempt_seq DESC LIMIT 1
        `).get(meshId, taskId) as Record<string, unknown> | undefined;
        return row ? meshTurnAttemptFromRow(row) : null;
    }

    /**
     * The CURRENT attempt bound to a worker session, across meshes/tasks: the
     * nonterminal row if one exists, else the most recently touched terminal row.
     * Stage 6's presentation layer resolves sessions (not tasks) — read_chat,
     * session status, dashboard and the restart gate all key on sessionId.
     */
    /**
     * The attempt that governs a session's presented execution status.
     *
     * A nonterminal attempt is preferred (an in-flight turn outranks a finished
     * one), but ONLY when it is its task's CURRENT attempt — i.e. no higher
     * attempt_seq exists for the same task.
     *
     * ORPHAN-LEGACY-ATTEMPT (fix ③): without that restriction, a stranded
     * lower-seq row (classically a `legacy-<taskId>-0` minted mid-turn while the
     * real dispatch already held seq >= 1) outranks the real, COMPLETED attempt
     * purely because it is nonterminal. Such a row is unreachable by
     * construction — every ACK and every completion targets the current attempt,
     * and the reducer's stale-attempt guard refuses to mutate a non-current row —
     * so it stays `generating` forever and pins the session's presented status to
     * `generating` even though its turn finished. Fixes ① (no new orphans) and ②
     * (close the existing ones) address the rows themselves; this guard is the
     * read-side safety net for any that still slip through, e.g. mid-flight
     * before the reclaim sweep runs.
     *
     * `attempt_seq DESC` is the final tie-break, not decoration: attempts of one
     * task are routinely written inside the same millisecond, so `updated_at`
     * alone leaves ties that SQLite may resolve either way — which would make
     * the selection (and therefore the presented session status) flap between
     * runs. Preferring the newer attempt is the correct resolution.
     */
    getLatestTurnAttemptForSession(sessionId: string): MeshTurnAttemptRow | null {
        const row = this.db.prepare(`
            SELECT a.* FROM mesh_turn_attempts a
            WHERE a.session_id = ?
            ORDER BY
                (a.terminal_outcome IS NULL AND NOT EXISTS (
                    SELECT 1 FROM mesh_turn_attempts b
                    WHERE b.mesh_id = a.mesh_id AND b.task_id = a.task_id
                      AND b.attempt_seq > a.attempt_seq
                )) DESC,
                a.updated_at DESC,
                a.attempt_seq DESC
            LIMIT 1
        `).get(sessionId) as Record<string, unknown> | undefined;
        return row ? meshTurnAttemptFromRow(row) : null;
    }

    getTurnAttemptBySeq(meshId: string, taskId: string, attemptSeq: number): MeshTurnAttemptRow | null {
        const row = this.db.prepare(`
            SELECT * FROM mesh_turn_attempts WHERE mesh_id = ? AND task_id = ? AND attempt_seq = ?
        `).get(meshId, taskId, attemptSeq) as Record<string, unknown> | undefined;
        return row ? meshTurnAttemptFromRow(row) : null;
    }

    listTurnAttemptsForTask(meshId: string, taskId: string): MeshTurnAttemptRow[] {
        const rows = this.db.prepare(`
            SELECT * FROM mesh_turn_attempts WHERE mesh_id = ? AND task_id = ? ORDER BY attempt_seq ASC
        `).all(meshId, taskId) as Array<Record<string, unknown>>;
        return rows.map(meshTurnAttemptFromRow);
    }

    /**
     * ORPHAN-LEGACY-ATTEMPT (fix ②): nonterminal attempts that a HIGHER-seq
     * attempt of the same task has superseded.
     *
     * Such a row is unreachable by construction: `getCurrentTurnAttempt` returns
     * the max-seq row, so every ACK and every completion proposal resolves to the
     * newer attempt and the reducer's stale-attempt guard explicitly refuses to
     * mutate the older one. Nothing in the system can ever move it to terminal —
     * it would sit at `generating` indefinitely, and (before fix ③) outrank the
     * real completed attempt when presenting the session's status.
     *
     * Deliberately keyed on seq supersession rather than on the `legacy-` id
     * prefix: the id form is a symptom of one known minting path, whereas
     * "a newer attempt exists for this task" is the actual unreachability
     * condition and covers any future path that strands a row the same way.
     */
    listSupersededNonterminalTurnAttempts(meshId: string): MeshTurnAttemptRow[] {
        const rows = this.db.prepare(`
            SELECT a.* FROM mesh_turn_attempts a
            WHERE a.mesh_id = ?
              AND a.terminal_outcome IS NULL
              AND EXISTS (
                  SELECT 1 FROM mesh_turn_attempts b
                  WHERE b.mesh_id = a.mesh_id AND b.task_id = a.task_id
                    AND b.attempt_seq > a.attempt_seq
              )
            ORDER BY a.created_at ASC
        `).all(meshId) as Array<Record<string, unknown>>;
        return rows.map(meshTurnAttemptFromRow);
    }

    /**
     * QUEUE-TERMINAL-ATTEMPT: nonterminal attempts whose task's `mesh_queue` row
     * is ALREADY terminal (`completed` / `failed` / `cancelled`).
     *
     * The queue row is an independent writer from the turn-ledger reducer — see
     * Stage 5's rollout gate (some paths, e.g. mission cascade / requeueTask auto-
     * fail, flip the queue row through the legacy/shadow path without ever
     * routing a completion proposal through the reducer). When the queue has
     * already recorded a terminal outcome for a task, that is independent proof
     * the work is done, so an attempt row still sitting nonterminal is not a live
     * turn being protected — it is a finished task that was never told. Closing
     * it cannot kill a real in-flight turn: a genuinely active turn has its queue
     * row still `pending`/`assigned`, which this predicate excludes by
     * construction (only `completed`/`failed`/`cancelled` queue rows qualify).
     *
     * `EXISTS` (not a JOIN) so a task_id with NO matching queue row — nothing to
     * compare against — is excluded rather than treated as a false match; a NULL
     * comparison in a JOIN would silently drop or wrongly include such rows
     * depending on the join type, which is exactly the ambiguity this predicate
     * must not have. Measured on the live ledger (RCA 2b3d260d): 14 of 735
     * nonterminal attempts match, 2 of 721 `delivered`-stage rows — a live turn
     * is essentially never caught by this condition.
     *
     * Deliberately independent of `attempt_seq` / current-vs-superseded: unlike
     * listSupersededNonterminalTurnAttempts, this predicate targets the SOLE
     * (and therefore trivially "current") attempt of a task just as often as a
     * stale one — a task with only ONE attempt whose queue row is terminal is
     * exactly the residue class this exists to close (confirmed case: a
     * `waiting_choice` attempt whose queue row already reads `cancelled`).
     * `reclaimOrphanedTurnAttempts` (seq supersession) runs first in the same
     * restart-recovery sweep, so a stale non-current sibling row is already
     * closed by the time this predicate's SELECT runs.
     */
    listQueueTerminatedNonterminalTurnAttempts(meshId: string): MeshTurnAttemptRow[] {
        const rows = this.db.prepare(`
            SELECT a.* FROM mesh_turn_attempts a
            WHERE a.mesh_id = ?
              AND a.terminal_outcome IS NULL
              AND EXISTS (
                  SELECT 1 FROM mesh_queue q
                  WHERE q.mesh_id = a.mesh_id AND q.id = a.task_id
                    AND q.status IN ('completed', 'failed', 'cancelled')
              )
            ORDER BY a.created_at ASC
        `).all(meshId) as Array<Record<string, unknown>>;
        return rows.map(meshTurnAttemptFromRow);
    }

    /** Nonterminal attempts — the restart-recovery reconstruction set. */
    listActiveTurnAttempts(meshId: string): MeshTurnAttemptRow[] {
        const rows = this.db.prepare(`
            SELECT * FROM mesh_turn_attempts
            WHERE mesh_id = ? AND terminal_outcome IS NULL
            ORDER BY created_at ASC
        `).all(meshId) as Array<Record<string, unknown>>;
        return rows.map(meshTurnAttemptFromRow);
    }

    /**
     * Monotonic, idempotent nonterminal stage advance. The SQL guard accepts the
     * write only when `allowedFrom` (a comma-free SQL CASE whitelist built by the
     * reducer) matches the CURRENT stage — the transition rules live in exactly one
     * place (mesh-turn-ledger.ts) and are enforced inside the DB write so a
     * concurrent reducer instance cannot sneak a regression past the check.
     * Returns the stage the row is in AFTER this call (post-write read-back), so
     * idempotent/reordered events converge on the same observable result.
     */
    advanceTurnAttemptStage(
        attemptId: string,
        toStage: string,
        allowedFromCsv: string,
        opts: { updatedAt: string; leaseDeadlineMs?: number | null; deliveredAt?: string; consumedAt?: string },
    ): string | null {
        const fromList = allowedFromCsv.split(',').map(s => `'${s}'`).join(',');
        this.db.prepare(`
            UPDATE mesh_turn_attempts
            SET stage = @toStage, updated_at = @updatedAt,
                lease_deadline_ms = COALESCE(@leaseDeadlineMs, lease_deadline_ms),
                delivered_at = COALESCE(@deliveredAt, delivered_at),
                consumed_at = COALESCE(@consumedAt, consumed_at)
            WHERE attempt_id = @attemptId
              AND terminal_outcome IS NULL
              AND stage IN (${fromList})
        `).run({
            attemptId, toStage, updatedAt: opts.updatedAt,
            leaseDeadlineMs: opts.leaseDeadlineMs ?? null,
            deliveredAt: opts.deliveredAt ?? null,
            consumedAt: opts.consumedAt ?? null,
        });
        this.maybeCheckpointWal();
        const after = this.getTurnAttempt(attemptId);
        return after ? after.stage : null;
    }

    /**
     * EXACTLY-ONCE terminal commit. The conditional UPDATE wins only while
     * terminal_outcome IS NULL, so two concurrent completion proposals commit at
     * most one terminal transaction; the loser reads back the winner's outcome.
     * Returns the row after the attempt (always re-read).
     */
    commitTurnAttemptTerminal(
        attemptId: string,
        outcome: string,
        reason: string | null,
        terminalAt: string,
    ): { committed: boolean; row: MeshTurnAttemptRow | null } {
        const res = this.db.prepare(`
            UPDATE mesh_turn_attempts
            SET terminal_outcome = ?, terminal_reason = ?, terminal_at = ?, stage = ?, updated_at = ?
            WHERE attempt_id = ? AND terminal_outcome IS NULL
        `).run(outcome, reason, terminalAt, outcome, terminalAt, attemptId);
        this.maybeCheckpointWal();
        return { committed: res.changes > 0, row: this.getTurnAttempt(attemptId) };
    }

    /** Redrive bookkeeping: bump the durable redrive counter and set the next lease deadline. */
    markTurnAttemptRedriven(attemptId: string, leaseDeadlineMs: number, updatedAt: string): void {
        this.db.prepare(`
            UPDATE mesh_turn_attempts
            SET redrive_count = redrive_count + 1, lease_deadline_ms = ?, updated_at = ?
            WHERE attempt_id = ? AND terminal_outcome IS NULL
        `).run(leaseDeadlineMs, updatedAt, attemptId);
        this.maybeCheckpointWal();
    }

    /**
     * DUP-CLAIM-REBIND: point a still-open attempt at the session that is ACTUALLY
     * working it. Used when a node refuses a duplicate dispatch and names the live
     * holder — the attempt was opened against the session we tried to dispatch to,
     * but the work is running on the holder, so the binding (not the attempt) is what
     * is wrong. Conditional on `terminal_outcome IS NULL` so a settled attempt is
     * never rewritten; returns whether the rebind landed.
     */
    rebindTurnAttemptSession(attemptId: string, sessionId: string, updatedAt: string): boolean {
        const res = this.db.prepare(`
            UPDATE mesh_turn_attempts
            SET session_id = ?, updated_at = ?
            WHERE attempt_id = ? AND terminal_outcome IS NULL
        `).run(sessionId, updatedAt, attemptId);
        this.maybeCheckpointWal();
        return res.changes > 0;
    }

    // ── TURN-LEDGER (Stage 5): idempotency-keyed causal events ───────────────

    /**
     * Append a causal event. INSERT OR IGNORE on UNIQUE(attempt_id, kind, dedupe_key)
     * makes repeated/reordered arrivals insert-once. Returns true when this call
     * inserted (first arrival), false on a duplicate.
     */
    insertTurnEvent(row: {
        eventId: string; meshId: string; attemptId: string; taskId: string;
        kind: string; dedupeKey?: string; payload?: string;
        occurredAtMs?: number | null; recordedAt: string;
    }): boolean {
        const res = this.db.prepare(`
            INSERT OR IGNORE INTO mesh_turn_events (
                event_id, mesh_id, attempt_id, task_id, kind, dedupe_key, payload, occurred_at_ms, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            row.eventId, row.meshId, row.attemptId, row.taskId, row.kind,
            row.dedupeKey ?? '', row.payload ?? '{}', row.occurredAtMs ?? null, row.recordedAt,
        );
        return res.changes > 0;
    }

    hasTurnEvent(attemptId: string, kind: string, dedupeKey = ''): boolean {
        const row = this.db.prepare(
            'SELECT 1 FROM mesh_turn_events WHERE attempt_id = ? AND kind = ? AND dedupe_key = ? LIMIT 1',
        ).get(attemptId, kind, dedupeKey);
        return row !== undefined;
    }

    listTurnEventsForTask(meshId: string, taskId: string): Array<{
        eventId: string; attemptId: string; kind: string; dedupeKey: string;
        payload: string; occurredAtMs: number | null; recordedAt: string;
    }> {
        const rows = this.db.prepare(`
            SELECT * FROM mesh_turn_events WHERE mesh_id = ? AND task_id = ? ORDER BY recorded_at ASC, event_id ASC
        `).all(meshId, taskId) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            eventId: r.event_id as string,
            attemptId: r.attempt_id as string,
            kind: r.kind as string,
            dedupeKey: (r.dedupe_key as string) ?? '',
            payload: r.payload as string,
            occurredAtMs: r.occurred_at_ms as number | null,
            recordedAt: r.recorded_at as string,
        }));
    }

    // ── TURN-LEDGER (Stage 5): durable outbound delivery (outbox) ────────────

    /** Enqueue an outbound notification. INSERT OR IGNORE on the row id = exactly-once. */
    enqueueTurnOutbox(row: {
        id: string; meshId: string; attemptId?: string; taskId?: string;
        kind: string; payload?: string; nextAttemptAtMs?: number | null;
        createdAt: string; updatedAt: string;
    }): boolean {
        const res = this.db.prepare(`
            INSERT OR IGNORE INTO mesh_turn_outbox (
                id, mesh_id, attempt_id, task_id, kind, payload, status, next_attempt_at_ms, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `).run(
            row.id, row.meshId, row.attemptId ?? null, row.taskId ?? null,
            row.kind, row.payload ?? '{}', row.nextAttemptAtMs ?? null, row.createdAt, row.updatedAt,
        );
        this.maybeCheckpointWal();
        return res.changes > 0;
    }

    /** Due pending outbox rows (status='pending', next_attempt_at_ms NULL or <= nowMs). */
    listDueTurnOutbox(nowMs: number, meshId?: string): Array<{
        id: string; meshId: string; attemptId: string | null; taskId: string | null;
        kind: string; payload: string; attemptCount: number; createdAt: string;
    }> {
        const rows = (meshId
            ? this.db.prepare(`
                SELECT * FROM mesh_turn_outbox
                WHERE status = 'pending' AND mesh_id = ? AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
                ORDER BY created_at ASC
            `).all(meshId, nowMs)
            : this.db.prepare(`
                SELECT * FROM mesh_turn_outbox
                WHERE status = 'pending' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
                ORDER BY created_at ASC
            `).all(nowMs)) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            id: r.id as string,
            meshId: r.mesh_id as string,
            attemptId: r.attempt_id as string | null,
            taskId: r.task_id as string | null,
            kind: r.kind as string,
            payload: r.payload as string,
            attemptCount: r.attempt_count as number,
            createdAt: r.created_at as string,
        }));
    }

    /** Oldest pending outbox row age in ms (observability: outbox backlog age). */
    oldestPendingTurnOutboxAgeMs(nowMs: number): number | null {
        const row = this.db.prepare(`
            SELECT MIN(created_at) AS oldest FROM mesh_turn_outbox WHERE status = 'pending'
        `).get() as { oldest: string | null } | undefined;
        if (!row?.oldest) return null;
        const parsed = Date.parse(row.oldest);
        return Number.isNaN(parsed) ? null : Math.max(0, nowMs - parsed);
    }

    markTurnOutboxDelivered(id: string, updatedAt: string): void {
        this.db.prepare(`
            UPDATE mesh_turn_outbox SET status = 'delivered', updated_at = ? WHERE id = ? AND status = 'pending'
        `).run(updatedAt, id);
        this.maybeCheckpointWal();
    }

    /** Record a failed delivery attempt and schedule the retry (or park as 'failed' when no retry remains). */
    markTurnOutboxAttemptFailed(id: string, opts: { updatedAt: string; nextAttemptAtMs?: number | null; terminal?: boolean }): void {
        if (opts.terminal) {
            this.db.prepare(`
                UPDATE mesh_turn_outbox SET status = 'failed', attempt_count = attempt_count + 1, updated_at = ?
                WHERE id = ? AND status = 'pending'
            `).run(opts.updatedAt, id);
        } else {
            this.db.prepare(`
                UPDATE mesh_turn_outbox SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?, updated_at = ?
                WHERE id = ? AND status = 'pending'
            `).run(opts.nextAttemptAtMs ?? null, opts.updatedAt, id);
        }
        this.maybeCheckpointWal();
    }

    countTurnOutboxByStatus(meshId?: string): Record<string, number> {
        const rows = (meshId
            ? this.db.prepare('SELECT status, COUNT(*) AS n FROM mesh_turn_outbox WHERE mesh_id = ? GROUP BY status').all(meshId)
            : this.db.prepare('SELECT status, COUNT(*) AS n FROM mesh_turn_outbox GROUP BY status').all()
        ) as Array<{ status: string; n: number }>;
        const out: Record<string, number> = {};
        for (const r of rows) out[r.status] = r.n;
        return out;
    }

    // ── TURN-LEDGER (Stage 5): held suspensions (pre-consumed waiting_*) ─────

    /**
     * Hold a pre-consumed suspension edge. INSERT OR IGNORE on the hold id
     * (`<attemptId>:<stage>`) makes duplicate/reordered suspension arrivals
     * insert-once. Returns true when this call inserted (first hold).
     */
    insertHeldTurnSuspension(row: {
        holdId: string; meshId: string; attemptId: string; taskId: string;
        stage: string; sessionId?: string; dispatchNonce?: number | null;
        occurredAtMs?: number | null; recordedAt: string;
    }): boolean {
        const res = this.db.prepare(`
            INSERT OR IGNORE INTO mesh_turn_held_suspensions (
                hold_id, mesh_id, attempt_id, task_id, stage, session_id, dispatch_nonce, occurred_at_ms, recorded_at, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held')
        `).run(
            row.holdId, row.meshId, row.attemptId, row.taskId, row.stage,
            row.sessionId ?? null, row.dispatchNonce ?? null, row.occurredAtMs ?? null, row.recordedAt,
        );
        this.maybeCheckpointWal();
        return res.changes > 0;
    }

    /** The hold row for one (attempt, stage) pair, any status (held/applied/dropped). */
    getHeldTurnSuspension(attemptId: string, stage: string): MeshTurnHeldSuspensionRow | null {
        const row = this.db.prepare(
            'SELECT * FROM mesh_turn_held_suspensions WHERE hold_id = ? LIMIT 1',
        ).get(`${attemptId}:${stage}`) as Record<string, unknown> | undefined;
        return row ? meshTurnHeldSuspensionFromRow(row) : null;
    }

    /** Hold rows for an attempt, oldest occurrence first (drain order). */
    listHeldTurnSuspensionsForAttempt(attemptId: string, status?: string): MeshTurnHeldSuspensionRow[] {
        const rows = (status
            ? this.db.prepare(`
                SELECT * FROM mesh_turn_held_suspensions
                WHERE attempt_id = ? AND status = ?
                ORDER BY occurred_at_ms ASC, hold_id ASC
            `).all(attemptId, status)
            : this.db.prepare(`
                SELECT * FROM mesh_turn_held_suspensions
                WHERE attempt_id = ?
                ORDER BY occurred_at_ms ASC, hold_id ASC
            `).all(attemptId)) as Array<Record<string, unknown>>;
        return rows.map(meshTurnHeldSuspensionFromRow);
    }

    /** Hold rows for a mesh by status (the restart-reconcile drain set). */
    listHeldTurnSuspensionsForMesh(meshId: string, status: string): MeshTurnHeldSuspensionRow[] {
        const rows = this.db.prepare(`
            SELECT * FROM mesh_turn_held_suspensions
            WHERE mesh_id = ? AND status = ?
            ORDER BY occurred_at_ms ASC, hold_id ASC
        `).all(meshId, status) as Array<Record<string, unknown>>;
        return rows.map(meshTurnHeldSuspensionFromRow);
    }

    /**
     * Resolve a hold exactly once: the status='held' guard makes a concurrent
     * drain/terminal resolution converge on a single winner. Returns true when
     * this call flipped the row.
     */
    resolveHeldTurnSuspension(holdId: string, status: 'applied' | 'dropped', resolution: string, resolvedAt: string): boolean {
        const res = this.db.prepare(`
            UPDATE mesh_turn_held_suspensions
            SET status = ?, resolution = ?, resolved_at = ?
            WHERE hold_id = ? AND status = 'held'
        `).run(status, resolution, resolvedAt, holdId);
        this.maybeCheckpointWal();
        return res.changes > 0;
    }
}

/** Row shape returned by the mesh_turn_attempts accessors (camelCase, store-agnostic). */
export interface MeshTurnAttemptRow {
    attemptId: string;
    meshId: string;
    taskId: string;
    attemptSeq: number;
    nodeId: string | null;
    sessionId: string | null;
    providerType: string | null;
    coordinatorDaemonId: string | null;
    coordinatorSessionId: string | null;
    dispatchNonce: number | null;
    stage: string;
    redriveCount: number;
    leaseDeadlineMs: number | null;
    acceptedAt: string | null;
    deliveredAt: string | null;
    consumedAt: string | null;
    terminalOutcome: string | null;
    terminalReason: string | null;
    terminalAt: string | null;
    createdAt: string;
    updatedAt: string;
}

function meshTurnAttemptFromRow(r: Record<string, unknown>): MeshTurnAttemptRow {
    return {
        attemptId: r.attempt_id as string,
        meshId: r.mesh_id as string,
        taskId: r.task_id as string,
        attemptSeq: r.attempt_seq as number,
        nodeId: r.node_id as string | null,
        sessionId: r.session_id as string | null,
        providerType: r.provider_type as string | null,
        coordinatorDaemonId: r.coordinator_daemon_id as string | null,
        coordinatorSessionId: r.coordinator_session_id as string | null,
        dispatchNonce: r.dispatch_nonce as number | null,
        stage: r.stage as string,
        redriveCount: r.redrive_count as number,
        leaseDeadlineMs: r.lease_deadline_ms as number | null,
        acceptedAt: r.accepted_at as string | null,
        deliveredAt: r.delivered_at as string | null,
        consumedAt: r.consumed_at as string | null,
        terminalOutcome: r.terminal_outcome as string | null,
        terminalReason: r.terminal_reason as string | null,
        terminalAt: r.terminal_at as string | null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
    };
}

/** Row shape returned by the mesh_turn_held_suspensions accessors (camelCase, content-free). */
export interface MeshTurnHeldSuspensionRow {
    holdId: string;
    meshId: string;
    attemptId: string;
    taskId: string;
    stage: string;
    sessionId: string | null;
    dispatchNonce: number | null;
    occurredAtMs: number | null;
    recordedAt: string;
    status: string;
    resolution: string | null;
    resolvedAt: string | null;
}

function meshTurnHeldSuspensionFromRow(r: Record<string, unknown>): MeshTurnHeldSuspensionRow {
    return {
        holdId: r.hold_id as string,
        meshId: r.mesh_id as string,
        attemptId: r.attempt_id as string,
        taskId: r.task_id as string,
        stage: r.stage as string,
        sessionId: r.session_id as string | null,
        dispatchNonce: r.dispatch_nonce as number | null,
        occurredAtMs: r.occurred_at_ms as number | null,
        recordedAt: r.recorded_at as string,
        status: r.status as string,
        resolution: r.resolution as string | null,
        resolvedAt: r.resolved_at as string | null,
    };
}

// ─── Mesh runtime retention windows (SoT 1-11 (b) / gap I-10) ────────────────
// mesh-runtime.db had lifecycle GC only for mesh_pending_events (prunePendingEvents,
// hourly via the mesh-event maintenance sweep) and fingerprints/tool-call windows;
// mesh_event_ledger and terminal mesh_queue rows grew without bound. These windows
// are deliberately CONSERVATIVE — every production reader operates on a recent
// window far narrower than these, so the deletes trade only dead space:
//   - Event ledger 30 days: readers are tail/limit-bounded (≤ a few hundred rows) or
//     recent-task scoped; 30d comfortably exceeds any reconcile/stat/audit horizon.
//     Operating notes are exempted inside pruneEventLedger (retained forever).
//   - Tool-call log 14 days: it backs a seconds-scale rate-limit window; 14d keeps a
//     generous debugging horizon at trivial cost.
//   - Terminal queue rows 30 days: mesh_task_history / completion-dedup lookups are
//     recent-task scoped; live dependsOn anchors are exempted inside
//     pruneTerminalQueueEntries.
//   - Terminal session-delivery rows 14 days (lifecycle retention Slice 1):
//     completed/failed/expired/cancelled rows only — live/nonterminal rows
//     (queued/delivering/delivered/acked) carry the retry/recovery semantics and
//     are never pruned. Window is env-tunable (resolveSessionDeliveryRetentionMs,
//     clamped [1d, 90d]); the resolver is read at sweep time.
// No VACUUM here by design: reclaiming file pages is not worth stalling the daemon's
// single writer; freed pages are reused by future inserts.
export const MESH_EVENT_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const MESH_TOOL_CALL_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;  // 14 days
export const MESH_TERMINAL_QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Periodic retention sweep for the mesh-runtime.db tables that previously had no
 * lifecycle GC (event ledger, tool-call log, terminal queue rows, terminal
 * session-delivery rows). Runs on the SAME cadence as the pending-events retention
 * prune (the hourly mesh-event maintenance sweep in mesh-event-forwarding.ts).
 * Best-effort and idempotent: a store failure degrades to a no-op with one warn;
 * re-running with nothing to prune is a set of cheap no-op DELETEs.
 * The returned counts are the content-free sweep metrics (row counts only, never
 * message/payload content).
 */
export function pruneMeshRuntimeRetention(): { ledger: number; toolCalls: number; terminalQueue: number; sessionDelivery: number } {
    try {
        const store = MeshRuntimeStore.getInstance();
        const ledger = store.pruneEventLedger(MESH_EVENT_LEDGER_RETENTION_MS);
        const toolCalls = store.pruneToolCallLog(MESH_TOOL_CALL_LOG_RETENTION_MS);
        const terminalQueue = store.pruneTerminalQueueEntries(MESH_TERMINAL_QUEUE_RETENTION_MS);
        const sessionDelivery = store.pruneTerminalSessionDeliveries(resolveSessionDeliveryRetentionMs());
        if (ledger + toolCalls + terminalQueue + sessionDelivery > 0) {
            LOG.info('MeshRuntimeStore', `Retention prune removed ${ledger} ledger / ${toolCalls} tool-call / ${terminalQueue} terminal-queue / ${sessionDelivery} terminal-session-delivery row(s)`);
        }
        return { ledger, toolCalls, terminalQueue, sessionDelivery };
    } catch (e: any) {
        LOG.warn('MeshRuntimeStore', `Runtime retention prune failed: ${e?.message || e}`);
        return { ledger: 0, toolCalls: 0, terminalQueue: 0, sessionDelivery: 0 };
    }
}
