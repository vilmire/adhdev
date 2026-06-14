import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { getLedgerDir } from './mesh-ledger.js';
import { nodeSatisfiesRequiredTags } from './mesh-work-queue.js';
import type { MeshTaskStatus, MeshWorkQueueEntry } from './mesh-work-queue.js';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

let DatabaseCtor: typeof BetterSqlite3 | undefined;

function loadDatabaseCtor(): typeof BetterSqlite3 {
    if (DatabaseCtor) return DatabaseCtor;
    const runtimeRequire = typeof require === 'function'
        ? require
        : createRequire(import.meta.url);
    DatabaseCtor = runtimeRequire('better-sqlite3') as typeof BetterSqlite3;
    return DatabaseCtor;
}

function safeMeshId(meshId: string): string {
    return meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function legacyQueuePath(meshId: string): string {
    return join(getLedgerDir(), `${safeMeshId(meshId)}.queue.json`);
}

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
    } catch {
        // Best-effort compatibility for existing installs. If migration fails,
        // opening the new store will create a clean DB instead of blocking boot.
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

    static getInstance(): MeshRuntimeStore {
        if (!this.instance) {
            this.instance = new MeshRuntimeStore(meshRuntimeStorePath());
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

            CREATE TABLE IF NOT EXISTS mesh_completion_fingerprints (
                fingerprint TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL
            );

            -- R3: idempotent coordinator inbox. When a terminal/force-inject event is
            -- direct-injected into a LIVE local CLI coordinator (coord.onEvent('send_message')),
            -- we record (coordinator_daemon_id, fingerprint) here. That same coordinator also
            -- polls get_pending_mesh_events, which would re-deliver the queued copy of the very
            -- event it just received in its PTY → user sees the completion twice. The drain for
            -- a coordinator daemon filters out events already direct-delivered to it, giving
            -- exactly-once-per-coordinator while keeping the queue for other consumers (idle /
            -- MCP-only / remote) that did NOT receive the direct inject.
            CREATE TABLE IF NOT EXISTS mesh_direct_delivered_events (
                coordinator_daemon_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY (coordinator_daemon_id, fingerprint)
            );

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

            CREATE TABLE IF NOT EXISTS remote_idle_sessions (
                node_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                metadata TEXT,
                PRIMARY KEY (node_id, session_id)
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
                drained_at INTEGER
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
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_missions_mesh_status
                ON mesh_missions(mesh_id, status, updated_at);
        `);
    }

    hasCompletionFingerprint(fingerprint: string): boolean {
        const now = Date.now();
        const row = this.db
            .prepare('SELECT 1 FROM mesh_completion_fingerprints WHERE fingerprint = ? AND expires_at > ?')
            .get(fingerprint, now) as { 1: number } | undefined;
        // Sweep expired fingerprints every 100 reads so stale rows don't accumulate
        // even during read-heavy (non-write) periods when recordFingerprintSeen is idle.
        if (++this.fingerprintSweepCounter >= 100) {
            this.fingerprintSweepCounter = 0;
            this.sweepExpiredFingerprints();
        }
        return row !== undefined;
    }

    recordCompletionFingerprint(fingerprint: string, ttlMs: number): void {
        const expiresAt = Date.now() + ttlMs;
        this.db.prepare('INSERT OR REPLACE INTO mesh_completion_fingerprints (fingerprint, expires_at) VALUES (?, ?)')
            .run(fingerprint, expiresAt);
        this.maybeCheckpointWal();
    }

    sweepExpiredFingerprints(): void {
        this.db.prepare('DELETE FROM mesh_completion_fingerprints WHERE expires_at <= ?').run(Date.now());
    }

    // R3: record that an event (by pending-event fingerprint) was direct-injected into a live
    // coordinator on the given daemon, so that coordinator's own drain skips the queued copy.
    recordDirectDelivered(coordinatorDaemonId: string, fingerprint: string, ttlMs: number): void {
        if (!coordinatorDaemonId || !fingerprint) return;
        this.db.prepare(
            'INSERT OR REPLACE INTO mesh_direct_delivered_events (coordinator_daemon_id, fingerprint, expires_at) VALUES (?, ?, ?)'
        ).run(coordinatorDaemonId, fingerprint, Date.now() + ttlMs);
        this.maybeCheckpointWal();
    }

    wasDirectDelivered(coordinatorDaemonId: string, fingerprint: string): boolean {
        if (!coordinatorDaemonId || !fingerprint) return false;
        const row = this.db.prepare(
            'SELECT 1 FROM mesh_direct_delivered_events WHERE coordinator_daemon_id = ? AND fingerprint = ? AND expires_at > ?'
        ).get(coordinatorDaemonId, fingerprint, Date.now());
        return row !== undefined;
    }

    sweepExpiredDirectDelivered(): void {
        this.db.prepare('DELETE FROM mesh_direct_delivered_events WHERE expires_at <= ?').run(Date.now());
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

    // O(1) claim: transaction ensures only one session claims a pending task
    claimNextQueueTask(meshId: string, nodeId: string, sessionId: string, capabilityTags: string[] = []): MeshWorkQueueEntry | null {
        return this.transaction(() => {
            this.ensureLegacyQueueMigrated(meshId);
            if (this.hasActiveAssignment(meshId, sessionId, nodeId)) return null;

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
                    WHERE mesh_id = ? AND status = 'pending' AND target_node_id = ? AND target_session_id IS NULL
                    ORDER BY created_at ASC
                `).all(meshId, nodeId) as Array<{ payload: string }>
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
            const dependenciesSatisfied = (candidate: MeshWorkQueueEntry): boolean => {
                if (candidate.blockedReason) return false;
                const deps = Array.isArray(candidate.dependsOn) ? candidate.dependsOn : [];
                return deps.every(depId => depStatus.get(depId) === 'completed');
            };

            const entry = candidates.find(candidate =>
                nodeSatisfiesRequiredTags(candidate.requiredTags, capabilityTags)
                && dependenciesSatisfied(candidate));
            if (!entry) return null;

            const now = new Date().toISOString();
            entry.status = 'assigned';
            entry.assignedNodeId = nodeId;
            entry.assignedSessionId = sessionId;
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

    findAssignedBySession(meshId: string, sessionId: string, occurredAtIso?: string): MeshWorkQueueEntry | null {
        this.ensureLegacyQueueMigrated(meshId);
        // Use updated_at (≈ dispatchTimestamp when status='assigned') for the occurredAt filter.
        const sql = occurredAtIso
            ? `SELECT payload FROM mesh_queue WHERE mesh_id = ? AND assigned_session_id = ? AND status = 'assigned' AND updated_at <= ? ORDER BY updated_at DESC LIMIT 1`
            : `SELECT payload FROM mesh_queue WHERE mesh_id = ? AND assigned_session_id = ? AND status = 'assigned' ORDER BY updated_at DESC LIMIT 1`;
        const args: string[] = occurredAtIso ? [meshId, sessionId, occurredAtIso] : [meshId, sessionId];
        const row = this.db.prepare(sql).get(...args as [string, string, string?]) as { payload: string } | undefined;
        return row ? JSON.parse(row.payload) as MeshWorkQueueEntry : null;
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

    updateDirectDispatchStatus(meshId: string, sessionId: string, status: 'acked' | 'completed' | 'failed' | 'stale'): void {
        if (!sessionId) return; // never update rows without a session binding
        const now = new Date().toISOString();
        this.db.prepare(`
            UPDATE mesh_direct_dispatches
            SET status = @status, updated_at = @updatedAt
            WHERE mesh_id = @meshId AND session_id = @sessionId
              AND session_id IS NOT NULL
              AND status NOT IN ('completed', 'failed')
        `).run({ status, meshId, sessionId, updatedAt: now });
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

    setRemoteIdleSession(nodeId: string, sessionId: string, providerType: string, expiresAt: number, metadata?: any): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO remote_idle_sessions (node_id, session_id, provider_type, expires_at, metadata)
            VALUES (?, ?, ?, ?, ?)
        `).run(nodeId, sessionId, providerType, expiresAt, metadata ? JSON.stringify(metadata) : null);
    }

    getRemoteIdleSessions(): Array<{ nodeId: string; sessionId: string; providerType: string; expiresAt: number; metadata?: any }> {
        const rows = this.db.prepare('SELECT node_id, session_id, provider_type, expires_at, metadata FROM remote_idle_sessions').all() as Array<any>;
        return rows.map(r => ({
            nodeId: r.node_id,
            sessionId: r.session_id,
            providerType: r.provider_type,
            expiresAt: r.expires_at,
            metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        }));
    }

    deleteRemoteIdleSession(nodeId: string, sessionId: string): void {
        this.db.prepare('DELETE FROM remote_idle_sessions WHERE node_id = ? AND session_id = ?').run(nodeId, sessionId);
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
        if (++this.walWriteCounter % 200 === 0) {
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
    }): boolean {
        const result = this.db.prepare(
            `INSERT OR IGNORE INTO mesh_pending_events
             (id, mesh_id, coordinator_daemon_id, event, payload, fingerprint, queued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
            event.id,
            event.meshId,
            event.coordinatorDaemonId ?? null,
            event.event,
            JSON.stringify(event.payload ?? {}),
            event.fingerprint ?? null,
            event.queuedAt,
        );
        this.maybeCheckpointWal();
        return result.changes > 0;
    }

    drainPendingEvents(meshId: string, coordinatorDaemonId?: string | null): Array<{ id: string; event: string; payload: unknown }> {
        return this.transaction(() => {
            const whereClause = coordinatorDaemonId
                ? `WHERE mesh_id = ? AND drained = 0 AND (coordinator_daemon_id IS NULL OR coordinator_daemon_id = ?)`
                : `WHERE mesh_id = ? AND drained = 0`;
            const params: unknown[] = coordinatorDaemonId
                ? [meshId, coordinatorDaemonId]
                : [meshId];
            const rows = this.db.prepare(
                `SELECT id, event, payload FROM mesh_pending_events ${whereClause} ORDER BY queued_at ASC LIMIT 100`
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
    peekPendingEvents(meshId: string, coordinatorDaemonId?: string | null): Array<{ id: string; event: string; payload: unknown }> {
        const whereClause = coordinatorDaemonId
            ? `WHERE mesh_id = ? AND drained = 0 AND (coordinator_daemon_id IS NULL OR coordinator_daemon_id = ?)`
            : `WHERE mesh_id = ? AND drained = 0`;
        const params: unknown[] = coordinatorDaemonId ? [meshId, coordinatorDaemonId] : [meshId];
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
    }): void {
        const now = new Date().toISOString();
        this.db.prepare(
            `INSERT INTO mesh_missions (id, mesh_id, title, goal, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title,
                 goal = excluded.goal,
                 status = excluded.status,
                 updated_at = excluded.updated_at`
        ).run(
            mission.id,
            mission.meshId,
            mission.title,
            mission.goal ?? '',
            mission.status ?? 'active',
            now,
            now,
        );
        this.maybeCheckpointWal();
    }

    getMission(meshId: string, missionId: string): { id: string; meshId: string; title: string; goal: string; status: string; createdAt: string; updatedAt: string } | null {
        const row = this.db.prepare(
            'SELECT * FROM mesh_missions WHERE mesh_id = ? AND id = ?'
        ).get(meshId, missionId) as Record<string, string> | undefined;
        if (!row) return null;
        return { id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
    }

    getMissions(meshId: string, statuses?: string[]): Array<{ id: string; meshId: string; title: string; goal: string; status: string; createdAt: string; updatedAt: string }> {
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
        return rows.map(row => ({ id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
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
}
