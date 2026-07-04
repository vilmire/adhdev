import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { LOG } from '../logging/logger.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';
import { getLedgerDir } from './mesh-ledger.js';
import { nodeSatisfiesRequiredTags, isTaskReadonly, taskDependenciesSatisfied } from './mesh-work-queue.js';
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

function meshRuntimeStorePath(): string {
    const dir = getLedgerDir();
    const nextPath = join(dir, 'mesh-runtime.db');
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

    close(): void {
        this.db.close();
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn).immediate();
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

            CREATE TABLE IF NOT EXISTS mesh_completion_conflicts (
                id TEXT PRIMARY KEY,
                mesh_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                conflicting_task_id TEXT,
                conflicting_session_id TEXT,
                original_task_id TEXT,
                original_session_id TEXT,
                event TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_completion_conflicts_mesh
                ON mesh_completion_conflicts(mesh_id, created_at);

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
                intended_for TEXT
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
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_missions_mesh_status
                ON mesh_missions(mesh_id, status, updated_at);

            -- Load-balancing scheduler: per-mesh round-robin rotation cursor. When
            -- the schedulingStrategy is 'round_robin', several eligible nodes tied at
            -- the least load are rotated by this cursor so the tie-break winner cycles
            -- across scheduling passes instead of always favouring the same array-order
            -- node. Persisted (not a module Map) so rotation survives daemon restarts
            -- and stays a single source of truth across scheduling entry points.
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
        `);
        this.migrateMeshIsolationColumns();
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

            // 4. mesh_pending_events v2 envelope columns (B2a). A pre-v2 DB has the
            //    table (CREATE IF NOT EXISTS is a no-op) without these columns, so add
            //    each missing one. All nullable — legacy rows read back as v1 events
            //    (protocol_version NULL) with no reader change. Idempotent: the column
            //    check short-circuits once present, and every ADD COLUMN is guarded.
            const pendingCols = this.tableColumns('mesh_pending_events');
            for (const col of ['protocol_version', 'event_id', 'scope', 'dispatched_by', 'intended_for'] as const) {
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
     * Count active (status='assigned') tasks on a (node, provider) combination,
     * matched by the assignedProviderType stamped on the payload at claim time.
     * Drives the per-(node, provider) maxParallel cap (RepoMeshNodePolicy
     * providerRoles). The active-assignment set for a single node is tiny, so
     * parsing payloads here is cheap and avoids a schema migration. Pre-cap legacy
     * rows (no provider stamp) and other providers on the same node do not consume
     * this provider's budget, so the cap is fully backward compatible.
     */
    private activeProviderAssignmentCount(meshId: string, nodeId: string, providerType: string): number {
        const rows = this.db.prepare(`
            SELECT payload FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned' AND assigned_node_id = ?
        `).all(meshId, nodeId) as Array<{ payload: string }>;
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
        opts?: { providerType?: string; providerMaxParallel?: number; nodeIsWorktree?: boolean },
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

            // Per-(node, provider) maxParallel cap (RepoMeshNodePolicy providerRoles).
            // Orthogonal to taskMode: this bounds the (node, provider) resource pool
            // regardless of read-only vs write. When the cap is already met, this
            // session cannot claim any candidate here — return null. This composes
            // with the global/taskMode caps enforced in the coordinator (stricter
            // wins); omitting providerMaxParallel preserves prior behavior exactly.
            const providerType = typeof opts?.providerType === 'string' ? opts.providerType.trim() : '';
            const providerMaxParallel = opts?.providerMaxParallel;
            if (
                providerType
                && typeof providerMaxParallel === 'number'
                && Number.isFinite(providerMaxParallel)
                && providerMaxParallel >= 0
                && this.activeProviderAssignmentCount(meshId, nodeId, providerType) >= providerMaxParallel
            ) {
                return null;
            }

            // The node-pinned SELECT must match a row whose target_node_id was stamped
            // in ANY equivalent daemon-id form (config-form `daemon_mach_X` vs the
            // claiming session's stamp-form `mach_X`). A single `= ?` bind on the
            // stamp-form silently fails to fetch a config-form row, leaving the task
            // pending forever (the empty-session WORKTREE-CLAIM-GATE repro). Expand to
            // every equivalent form and bind an IN (...) set; the per-candidate
            // targetMatches() JS gate above re-validates each fetched row.
            const nodeIdForms = expandDaemonIdForms(nodeId);
            const nodePinnedPlaceholders = nodeIdForms.map(() => '?').join(', ');
            // Priority: session-targeted > node-targeted (no session) > unconstrained
            const rows = [
                ...(
                this.db.prepare(`
                    SELECT payload FROM mesh_queue
                    WHERE mesh_id = ? AND status = 'pending' AND target_session_id = ?
                    ORDER BY created_at ASC
                `).all(meshId, sessionId) as Array<{ payload: string }>
                ),
                ...(
                this.db.prepare(`
                    SELECT payload FROM mesh_queue
                    WHERE mesh_id = ? AND status = 'pending' AND target_node_id IN (${nodePinnedPlaceholders}) AND target_session_id IS NULL
                    ORDER BY created_at ASC
                `).all(meshId, ...nodeIdForms) as Array<{ payload: string }>
                ),
                ...(
                this.db.prepare(`
                    SELECT payload FROM mesh_queue
                    WHERE mesh_id = ? AND status = 'pending' AND target_node_id IS NULL AND target_session_id IS NULL
                    ORDER BY created_at ASC
                `).all(meshId) as Array<{ payload: string }>
                ),
            ];
            const candidates = rows.map(row => JSON.parse(row.payload) as MeshWorkQueueEntry);

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

            const entry = candidates.find(candidate =>
                nodeSatisfiesRequiredTags(candidate.requiredTags, capabilityTags)
                && dependenciesSatisfied(candidate)
                && convergenceAllows(candidate)
                && targetMatches(candidate)
                && nodeConflictAllows(candidate));
            if (!entry) return null;

            const now = new Date().toISOString();
            entry.status = 'assigned';
            entry.assignedNodeId = nodeId;
            entry.assignedSessionId = sessionId;
            if (providerType) entry.assignedProviderType = providerType;
            entry.dispatchTimestamp = now;
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
            message: entry.message,
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

    updateSessionDeliveryStatus(id: string, status: string, opts?: { lastError?: string; incrementAttempt?: boolean }): void {
        const now = new Date().toISOString();
        if (opts?.incrementAttempt) {
            this.db.prepare(`
                UPDATE mesh_session_delivery
                SET status = @status, last_error = @lastError, attempt_count = attempt_count + 1, updated_at = @updatedAt
                WHERE id = @id
            `).run({ id, status, lastError: opts?.lastError ?? null, updatedAt: now });
        } else {
            this.db.prepare(`
                UPDATE mesh_session_delivery
                SET status = @status, last_error = @lastError, updated_at = @updatedAt
                WHERE id = @id
            `).run({ id, status, lastError: opts?.lastError ?? null, updatedAt: now });
        }
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

    recordCompletionConflict(entry: {
        id: string;
        meshId: string;
        fingerprint: string;
        conflictingTaskId?: string;
        conflictingSessionId?: string;
        originalTaskId?: string;
        originalSessionId?: string;
        event: string;
        createdAt: string;
    }): void {
        this.db.prepare(`
            INSERT OR IGNORE INTO mesh_completion_conflicts
                (id, mesh_id, fingerprint, conflicting_task_id, conflicting_session_id,
                 original_task_id, original_session_id, event, created_at)
            VALUES (@id, @meshId, @fingerprint, @conflictingTaskId, @conflictingSessionId,
                    @originalTaskId, @originalSessionId, @event, @createdAt)
        `).run({
            id: entry.id,
            meshId: entry.meshId,
            fingerprint: entry.fingerprint,
            conflictingTaskId: entry.conflictingTaskId ?? null,
            conflictingSessionId: entry.conflictingSessionId ?? null,
            originalTaskId: entry.originalTaskId ?? null,
            originalSessionId: entry.originalSessionId ?? null,
            event: entry.event,
            createdAt: entry.createdAt,
        });
        this.maybeCheckpointWal();
    }

    getRecentCompletionConflicts(meshId: string, limitMs: number = 60 * 60 * 1000): Array<{
        id: string; meshId: string; fingerprint: string; conflictingTaskId: string | null;
        conflictingSessionId: string | null; originalTaskId: string | null;
        originalSessionId: string | null; event: string; createdAt: string;
    }> {
        const cutoff = new Date(Date.now() - limitMs).toISOString();
        const rows = this.db.prepare(
            'SELECT * FROM mesh_completion_conflicts WHERE mesh_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50'
        ).all(meshId, cutoff) as Array<Record<string, unknown>>;
        return rows.map(r => ({
            id: r.id as string,
            meshId: r.mesh_id as string,
            fingerprint: r.fingerprint as string,
            conflictingTaskId: r.conflicting_task_id as string | null,
            conflictingSessionId: r.conflicting_session_id as string | null,
            originalTaskId: r.original_task_id as string | null,
            originalSessionId: r.original_session_id as string | null,
            event: r.event as string,
            createdAt: r.created_at as string,
        }));
    }

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
     * Exposed for testing.
     */
    pruneToolCallLog(olderThanMs: number): void {
        this.db.prepare('DELETE FROM mesh_tool_call_log WHERE called_at < ?').run(Date.now() - olderThanMs);
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
        payload?: unknown;
    }): void {
        this.db.prepare(
            `INSERT OR IGNORE INTO mesh_event_ledger
             (id, mesh_id, timestamp, kind, node_id, session_id, provider_type, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            entry.id,
            entry.meshId,
            entry.timestamp,
            entry.kind,
            entry.nodeId ?? null,
            entry.sessionId ?? null,
            entry.providerType ?? null,
            JSON.stringify(entry.payload ?? {}),
        );
        this.maybeCheckpointWal();
    }

    readLedgerEntries(meshId: string, opts?: {
        tail?: number;
        since?: string;
        kind?: string;
        limit?: number;
    }): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; payload: unknown }> {
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
    }): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; payload: unknown }> {
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
        nodeId?: string | null; sessionId?: string | null; providerType?: string | null; payload?: unknown;
    }>): number {
        let imported = 0;
        const stmt = this.db.prepare(
            `INSERT OR IGNORE INTO mesh_event_ledger
             (id, mesh_id, timestamp, kind, node_id, session_id, provider_type, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        this.db.transaction(() => {
            for (const e of entries) {
                const result = stmt.run(
                    e.id, e.meshId, e.timestamp, e.kind,
                    e.nodeId ?? null, e.sessionId ?? null, e.providerType ?? null,
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
        opts?: { onlyEvents?: ReadonlySet<string> },
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
                `UPDATE mesh_pending_events SET drained = 1, drained_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`
            ).run(now, ...ids);
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

    hasPendingEventFingerprint(meshId: string, fingerprint: string): boolean {
        const row = this.db.prepare(
            'SELECT 1 FROM mesh_pending_events WHERE mesh_id = ? AND fingerprint = ? AND drained = 0 LIMIT 1'
        ).get(meshId, fingerprint);
        return row !== undefined;
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

    getMission(meshId: string, missionId: string): { id: string; meshId: string; title: string; goal: string; status: string; source?: string; createdAt: string; updatedAt: string } | null {
        const row = this.db.prepare(
            'SELECT * FROM mesh_missions WHERE mesh_id = ? AND id = ?'
        ).get(meshId, missionId) as Record<string, string> | undefined;
        if (!row) return null;
        return { id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, source: row.source ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
    }

    getMissions(meshId: string, statuses?: string[]): Array<{ id: string; meshId: string; title: string; goal: string; status: string; source?: string; createdAt: string; updatedAt: string }> {
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
        return rows.map(row => ({ id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, source: row.source ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }));
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
}
