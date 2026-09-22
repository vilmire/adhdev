import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { LOG } from '../logging/logger.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';
import { getConfigDir } from '../config/config.js';
import { getLedgerDir } from './mesh-ledger.js';
import { resolveSessionDeliveryRetentionMs } from './mesh-retention-config.js';
import { nodeSatisfiesRequiredTags, isTaskReadonly, taskDependenciesSatisfied, meshTaskNotBeforeReady, meshTaskPriorityRank } from './mesh-work-queue.js';
import { taskIsParked } from './mesh-task-parking.js';
import { MeshGraphStore } from './mesh-graph-store.js';
import { modelNamesEquivalent } from './slot-model-enforcement.js';
import { effectiveSlotCap } from './mesh-daemon-slot-axis.js';
import { meshNodeIdMatches, daemonIdsEquivalent, expandDaemonIdForms, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { MeshTaskStatus, MeshWorkQueueEntry } from './mesh-work-queue.js';
import { selectClaimCandidate, type MeshClaimRefusal, type MeshClaimRefusalReason } from './mesh-claim-refusal.js';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';
// Pure move (file-size gate): row shapes/mappers + the retention sweep now live in
// mesh-runtime-store-turn-rows.ts. Imported back for internal use by class methods
// below, and re-exported at the bottom of this file so every existing import path
// (`from './mesh-runtime-store.js'`) keeps working unchanged — barrel-preserving,
// same pattern as mesh-tools-internal.ts / mesh-tools.ts.
import { notifyLedgerBulkChange, type MeshTurnAttemptRow, type MeshTurnHeldSuspensionRow } from './mesh-runtime-store-turn-rows.js';
import { selectTurnEventsForTask, selectTurnEventsByKind, deleteTurnEventsByKindOlderThan, pruneTerminalTurnAttemptsWithCascade, upsertHandoffNoteText, selectHandoffNoteText, deleteHandoffNoteTextOlderThan, type TurnEventRow, type HandoffNoteTextRow } from './mesh-turn-event-queries.js';
import { selectUnsettledTerminalQueueRowsAndAttempts } from './mesh-unsettled-terminal-queries.js';
// TURN-LEDGER pure move (file-size gate): the Stage 5 turn-attempt / turn-event /
// held-suspension persistence lives in mesh-runtime-store-turn-attempts.ts; the
// class methods below delegate with `this` as `self` (router.ts → router-refine.ts
// pattern). No behavior change — SQL strings and WAL-checkpoint order are verbatim.
import {
    insertTurnAttempt, getTurnAttempt, getCurrentTurnAttempt, getLatestTurnAttemptForSession,
    getTurnAttemptBySeq, listTurnAttemptsForTask, listSupersededNonterminalTurnAttempts,
    listQueueTerminatedNonterminalTurnAttempts, listActiveTurnAttempts, advanceTurnAttemptStage,
    commitTurnAttemptTerminal, markTurnAttemptRedriven, rebindTurnAttemptSession,
    insertTurnEvent, hasTurnEvent, insertHeldTurnSuspension, getHeldTurnSuspension,
    listHeldTurnSuspensionsForAttempt, listHeldTurnSuspensionsForMesh, resolveHeldTurnSuspension,
    type MeshTurnAttemptInsert, type MeshTurnAttemptStageOpts,
    type MeshTurnEventInsert, type MeshHeldTurnSuspensionInsert,
} from './mesh-runtime-store-turn-attempts.js';
// Pure move (file-size gate): the schema DDL + column migrations, the G2 event
// ledger and the G3 pending-coordinator-event persistence now live in
// mesh-runtime-store-schema.ts / -ledger.ts / -pending-events.ts. The class keeps
// thin delegating wrappers below so the public surface and every existing call
// site are unchanged — same `self`-passing pattern as the turn-attempt extraction.
import {
    migrate as migrateSchema, tableColumns as schemaTableColumns,
    migrateMeshIsolationColumns as schemaMigrateMeshIsolationColumns,
    hasLoggedMigrationFailure, markLoggedMigrationFailure,
} from './mesh-runtime-store-schema.js';
import {
    appendLedgerEntry, readLedgerEntries, readLedgerEntriesOrdered, clearLedgerForMesh,
    deleteLedgerEntries, hasLedgerEntry, ledgerEntryCount, importLedgerEntries, readLedgerSlice,
} from './mesh-runtime-store-ledger.js';
import {
    insertPendingEvent, drainPendingEvents, peekPendingEvents, recentDrainedPendingEvents,
    recentDrainedPendingEventPayloads, hasPendingEventFingerprint, hasDrainedEventId,
    drainedEventIdsForMesh, pendingEventCount, markPendingEventsDrainedById,
    requeueDrainedPendingEventByFingerprint, updatePendingEventPayloadByFingerprint,
    requeueDrainedPendingEventById, deletePendingEventsById, prunePendingEvents,
} from './mesh-runtime-store-pending-events.js';

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
        if (!hasLoggedMigrationFailure()) {
            markLoggedMigrationFailure();
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
    /** Readonly (not private) so the extracted ./mesh-runtime-store-turn-attempts.ts delegates can reach it via `self`. */
    readonly db: DatabaseHandle;
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
        // The whole database is going away, including mesh_event_ledger. mesh-ledger
        // caches ledger reads for up to 30s and keys that cache by meshId, so it
        // cannot detect a store swap on its own — tell it to drop everything, or the
        // next test reads the previous test's rows.
        notifyLedgerBulkChange();
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

    // ── Schema DDL + column migrations ───────────────────────────────────────
    // Implementation lives in ./mesh-runtime-store-schema.ts (behavior-preserving
    // code move, file-size gate). Kept here as thin delegators so the constructor
    // call and every call site are unchanged; the extracted functions reach the db
    // handle via `self` (same pattern as the turn-attempt delegators below).

    private migrate(): void {
        migrateSchema(this);
    }

    private tableColumns(table: string): Set<string> {
        return schemaTableColumns(this, table);
    }

    // Only called by migrate() in production, but kept as a class member because a
    // regression test re-invokes it through `(db as any)` to assert the migration is
    // idempotent across boots (mesh-runtime-store.test.ts, Part 8-1).
    private migrateMeshIsolationColumns(): void {
        schemaMigrateMeshIsolationColumns(this);
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

    /** Public (not private) so the extracted ./mesh-runtime-store-turn-attempts.ts delegates can reach it via `self`. */
    maybeCheckpointWal(): void {
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
            /** A6-SILENT-REFUSAL: optional sink the claim fills in when it returns null,
             *  naming WHICH predicate refused. See MeshClaimRefusal. Purely diagnostic —
             *  the return contract (`MeshWorkQueueEntry | null`) is unchanged, so every
             *  existing caller that omits it behaves exactly as before. */
            outRefusal?: MeshClaimRefusal;
        },
    ): MeshWorkQueueEntry | null {
        return this.transaction(() => {
            this.ensureLegacyQueueMigrated(meshId);
            const refuse = (reason: MeshClaimRefusalReason, detail?: string, deepest?: MeshWorkQueueEntry): null => {
                if (opts?.outRefusal) {
                    opts.outRefusal.reason = reason;
                    if (detail) opts.outRefusal.detail = detail;
                    // Structural id/difficulty alongside the free-form `detail` string, so a
                    // caller (LEDGER-AUTOLAUNCH-RETRY-SPAM ⑤ — the difficulty-floor claim-path
                    // pager) can act on WHICH task was refused without parsing "closest
                    // candidate <id> of <n>" back out of prose.
                    if (deepest) {
                        opts.outRefusal.taskId = deepest.id;
                        if (deepest.difficulty) opts.outRefusal.difficulty = deepest.difficulty;
                    }
                }
                return null;
            };
            // A session executes one task at a time regardless of mode — block early.
            // The node-level conflict is evaluated per-candidate below so that
            // read-only (live_debug_readonly) tasks can claim concurrently on a node
            // that already has an active assignment, while write tasks keep the
            // one-active-per-node invariant (worktree isolation).
            if (this.hasActiveSessionAssignment(meshId, sessionId)) return refuse('session_already_assigned');
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

            // PIN-PARKING: a PARKED row is claimable by nobody — not even the session it
            // is still pinned to. Parking means "this delta's addressee went stale and the
            // coordinator has not yet decided what to do with it"; letting the original
            // session claim it later would deliver an instruction whose premise the
            // coordinator was explicitly asked to re-confirm, which is the same
            // wrong-context delivery parking exists to prevent.
            //
            // Keeping the pin already hides the row from every OTHER session (the tier-1
            // SELECT only offers a session-pinned row to that session), so this guard is
            // the one remaining hole — and being in the shared candidate filter, it is
            // fail-closed against any future change to those queries. Unparking happens
            // exclusively through requeueTask.
            const notParked = (candidate: MeshWorkQueueEntry): boolean => !taskIsParked(candidate);

            // A6-SILENT-REFUSAL (rationale: mesh-claim-refusal.ts). Was one boolean `.find(...)`
            // whose failure collapsed into a bare `return null` — nine predicates, one silent
            // exit. Order and short-circuit semantics are preserved exactly; this only records
            // WHICH gate said no.
            const selected = selectClaimCandidate<MeshWorkQueueEntry>(candidates, [
                { reason: 'required_tags_unsatisfied', test: c => nodeSatisfiesRequiredTags(c.requiredTags, capabilityTags) },
                { reason: 'dependencies_unsatisfied', test: dependenciesSatisfied },
                { reason: 'not_before_delayed', test: notBeforeReady },
                { reason: 'task_parked', test: notParked },
                { reason: 'convergence_target_is_worktree', test: convergenceAllows },
                { reason: 'target_pin_unmatched', test: targetMatches },
                { reason: 'difficulty_floor_unmet', test: difficultyAllows },
                { reason: 'parallel_cap_reached', test: parallelCapsAllow },
                { reason: 'node_busy_with_active_assignment', test: nodeConflictAllows },
            ]);
            if (!selected.entry) {
                if (!candidates.length) return refuse('no_pending_candidates');
                return refuse(selected.reason, selected.deepest
                    ? `closest candidate ${selected.deepest.id} of ${candidates.length}` : undefined,
                    selected.deepest);
            }
            const entry = selected.entry;

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
            // AUTOLAUNCH-SPAWN-CAP (P3): a successful claim is the healthy outcome the
            // durable spawn counter is waiting for — reset the budget here, at the ONE
            // choke point every claim path funnels through (idle drain, inline launch
            // claim, remote claim, redrive, direct-delivery fallback all end here).
            delete entry.autoLaunchUnclaimedCount;
            // SPAWN-CAP-TRANSPORT-AWARE: the dispatch-failure tally is scoped to the same
            // "since the last successful claim" window, so it clears here too.
            delete entry.autoLaunchDispatchFailedCount;
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
        // MESH-ISOLATION-LEAK: always mesh-scoped (cross-mesh nodeId collision).
        // CLAIM-RETRY-LOOP-LIFECYCLE: enforce expiry here too — pruneExpiredRemoteIdleSessions
        // only runs on a NEW agent:ready, so a dead/removed node's row never got pruned.
        const rows = this.db.prepare('SELECT node_id, session_id, provider_type, expires_at, metadata FROM remote_idle_sessions WHERE mesh_id = ? AND expires_at > ?').all(meshId, Date.now()) as Array<any>;
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

    // CLAIM-RETRY-LOOP-LIFECYCLE: deleteRemoteIdleSession above fires only on a successful
    // claim; called from remove_mesh_node to clear a node's row on removal instead.
    deleteRemoteIdleSessionsForNode(meshId: string, nodeId: string): void {
        this.db.prepare('DELETE FROM remote_idle_sessions WHERE mesh_id = ? AND node_id = ?').run(meshId, nodeId);
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
     *
     * `callerRole` is a diagnostic, not an auth boundary: it reflects whether
     * ADHDEV_COORDINATOR_SESSION_ID was present in this process's env at call
     * time, and a process can set that env var on itself. It exists to answer
     * "was this call made by a coordinator-launched process or not" for the
     * mesh-tool-call-caller-instrumentation investigation, not to gate access —
     * do not wire it into any block/allow decision.
     */
    recordMeshToolCall(opts: {
        meshId: string;
        tool: string;
        sessionId?: string | null;
        callerRole?: 'coordinator' | 'unknown' | null;
        windowMs?: number;
        maxCalls?: number;
    }): { rateLimitExceeded: boolean; callsInWindow: number; advisory: string | null } {
        const { meshId, tool, sessionId = null, callerRole = null } = opts;
        const windowMs = opts.windowMs ?? 10_000;
        const maxCalls = opts.maxCalls ?? 5;
        const now = Date.now();
        const windowStart = now - windowMs;

        this.db.prepare(
            'INSERT INTO mesh_tool_call_log (mesh_id, tool, session_id, caller_role, called_at) VALUES (?, ?, ?, ?, ?)'
        ).run(meshId, tool, sessionId, callerRole, now);

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
     * Read back recent mesh_tool_call_log rows for one mesh, most recent first.
     * Diagnostic reader for the MESH-TOOL-CALL-CALLER-INSTRUMENTATION 1단계
     * investigation (was session_id/caller_role actually getting recorded, and
     * does the coordinator/unknown split hold up) — not on any hot path.
     */
    getRecentToolCalls(meshId: string, limit = 100): Array<{ tool: string; sessionId: string | null; callerRole: string | null; calledAt: number }> {
        const rows = this.db.prepare(
            'SELECT tool, session_id, caller_role, called_at FROM mesh_tool_call_log WHERE mesh_id = ? ORDER BY called_at DESC LIMIT ?'
        ).all(meshId, limit) as Array<{ tool: string; session_id: string | null; caller_role: string | null; called_at: number }>;
        return rows.map(r => ({ tool: r.tool, sessionId: r.session_id, callerRole: r.caller_role, calledAt: r.called_at }));
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

    /**
     * Retention prune for TERMINAL mesh_turn_attempts rows, cascading to
     * mesh_turn_events and mesh_turn_held_suspensions. SQL, the three exclusion
     * anchors and their rationale: mesh-turn-event-queries.ts.
     */
    pruneTerminalTurnAttempts(olderThanMs: number): { attempts: number; events: number; heldSuspensions: number } {
        return this.transaction(() => pruneTerminalTurnAttemptsWithCascade(this.db, olderThanMs));
    }

    // ── G2: Event Ledger ────────────────────────────────────────────────────
    // Implementation lives in ./mesh-runtime-store-ledger.ts (behavior-preserving
    // code move, file-size gate). Thin delegators keep the public surface and
    // every call site unchanged.

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
        appendLedgerEntry(this, entry);
    }

    readLedgerEntries(meshId: string, opts?: {
        tail?: number;
        since?: string;
        kind?: string;
        limit?: number;
    }): Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId: string | null; sessionId: string | null; providerType: string | null; taskId: string | null; payload: unknown }> {
        return readLedgerEntries(this, meshId, opts);
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
        return readLedgerEntriesOrdered(this, meshId, opts);
    }

    /** Remove all ledger entries for a mesh (mesh deletion / test cleanup). */
    clearLedgerForMesh(meshId: string): number {
        return clearLedgerForMesh(this, meshId);
    }

    /** G2: remove entries moved to the JSONL archive so the SQLite runtime set mirrors the active ledger. */
    deleteLedgerEntries(meshId: string, ids: string[]): number {
        return deleteLedgerEntries(this, meshId, ids);
    }

    hasLedgerEntry(meshId: string, id: string): boolean {
        return hasLedgerEntry(this, meshId, id);
    }

    ledgerEntryCount(meshId: string): number {
        return ledgerEntryCount(this, meshId);
    }

    importLedgerEntries(entries: Array<{
        id: string; meshId: string; timestamp: string; kind: string;
        nodeId?: string | null; sessionId?: string | null; providerType?: string | null; taskId?: string | null; payload?: unknown;
    }>): number {
        return importLedgerEntries(this, entries);
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
        return readLedgerSlice(this, meshId, opts);
    }
    // ── G3: Pending Coordinator Events ──────────────────────────────────────
    // Implementation lives in ./mesh-runtime-store-pending-events.ts
    // (behavior-preserving code move, file-size gate). Thin delegators keep the
    // public surface and every call site unchanged.

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
        return insertPendingEvent(this, event);
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
        return drainPendingEvents(this, meshId, coordinatorDaemonId, opts);
    }

    /** Non-destructive peek — returns undrained events without marking them drained. */
    peekPendingEvents(meshId: string, coordinatorDaemonId?: string | null | ReadonlyArray<string>): Array<{ id: string; event: string; payload: unknown }> {
        return peekPendingEvents(this, meshId, coordinatorDaemonId);
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
        return recentDrainedPendingEvents(this, meshId, limit);
    }

    /**
     * ENTER-LOSS layer ③ (boot-time composer-residue sweep) — recently-DRAINED
     * pending-event rows across ALL meshes, payloads included. The sweep matches
     * each payload's coordinatorMessage against the composer text of restored
     * idle sessions: an event is marked drained BEFORE its body is written to the
     * PTY (the consume-before-submit ordering this incident class exploits), so a
     * body stranded in a composer by a mid-submit daemon death is identifiable
     * ONLY from these drained rows — the undrained queue no longer holds it.
     * Drained rows are soft-marked (retained until mesh deletion), so this reads
     * history, not live queue state.
     */
    recentDrainedPendingEventPayloads(sinceEpochMs: number, limit = 200): Array<{
        id: string;
        meshId: string;
        event: string;
        payload: unknown;
        drainedAt: number;
    }> {
        return recentDrainedPendingEventPayloads(this, sinceEpochMs, limit);
    }

    hasPendingEventFingerprint(meshId: string, fingerprint: string): boolean {
        return hasPendingEventFingerprint(this, meshId, fingerprint);
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
        return hasDrainedEventId(this, meshId, eventId);
    }

    /**
     * B3a — snapshot of the v2 event_ids ALREADY drained (drained = 1) for the mesh.
     * Taken BEFORE a drain call marks the current batch drained=1, so the resulting
     * set names only PRIOR drains — the re-delivery dedup baseline. (Reading it after
     * the drain would self-match the batch's own freshly-drained rows.) Non-v2 rows
     * have a NULL event_id and are excluded by the index/WHERE.
     */
    drainedEventIdsForMesh(meshId: string): Set<string> {
        return drainedEventIdsForMesh(this, meshId);
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
        const changes = this.db.prepare('DELETE FROM mesh_pending_events WHERE mesh_id = ?').run(meshId).changes;
        // DUPNOTIF-DURABLE (gap_b): the terminal-completion dedup record deliberately
        // OUTLIVES its pending row (that is the whole point — the row is deleted by
        // retention/outbox expiry while the same completion can still be re-produced).
        // It is still per-mesh pending-event state, so a "clear this mesh's pending
        // events" must take it too; otherwise a cleared mesh keeps suppressing
        // completions for tasks whose rows are gone. Namespaced `pending::<fingerprint>`,
        // so this cannot touch the mesh-event-forwarding completion fingerprints sharing
        // the table.
        this.db.prepare(
            `DELETE FROM mesh_completion_fingerprints WHERE mesh_id = ? AND fingerprint LIKE 'pending::%'`
        ).run(meshId);
        return changes;
    }

    pendingEventCount(meshId: string): number {
        return pendingEventCount(this, meshId);
    }

    /**
     * Mark specific pending-event rows drained by id (ack). Used by the
     * unresolved-delegate durable-forward outbox: an event is peeked (not drained)
     * while its push to the coordinator is unconfirmed, then marked drained ONLY
     * after the push is acked. A failed push leaves the row undrained so the next
     * reconcile tick retries it. Returns the number of rows newly marked drained.
     */
    markPendingEventsDrainedById(ids: ReadonlyArray<string>): number {
        return markPendingEventsDrainedById(this, ids);
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
        return requeueDrainedPendingEventByFingerprint(this, meshId, fingerprint);
    }

    /**
     * COORD-GENERATION-HANDOFF (defect 3): rewrite a queued row's payload in place,
     * used to strip the `targetCoordinatorSessionId` of a coordinator confirmed dead
     * so the event falls through to daemon-level delivery.
     *
     * Why a payload rewrite is required rather than just re-queuing: the in-memory
     * event the caller holds is a COPY. requeueDrainedPendingEventByFingerprint flips
     * `drained` but never touches `payload`, so without this the dead session stamp
     * survives in SQLite and the very next drain re-reads it, re-enters the strict-
     * unmatched branch, and the event loops on every 4s tick until the TTL kills it —
     * i.e. the reattribution would silently not stick.
     *
     * Scoped by fingerprint + drained = 0, so it can only ever touch the row this
     * caller just returned to the queue. `queued_at` and `fingerprint` are untouched:
     * the row keeps its identity (no duplicate can be created, all fingerprint-keyed
     * dedup continues to match) and its true age.
     *
     * Returns true when a queued row was found and rewritten.
     */
    updatePendingEventPayloadByFingerprint(meshId: string, fingerprint: string, payload: unknown): boolean {
        return updatePendingEventPayloadByFingerprint(this, meshId, fingerprint, payload);
    }

    /**
     * ENTER-LOSS layer ③ (composer-residue recovery) — the row-id twin of
     * requeueDrainedPendingEventByFingerprint, with identical semantics: flip the
     * EXISTING drained row back to drained=0 IN PLACE. Never a re-insert — the
     * UNIQUE (mesh_id, fingerprint) index stays occupied by this very row, so no
     * duplicate can be created and the DUPNOTIF suppressors are never in play.
     * `queued_at` is preserved (age keeps measuring from the original enqueue) and
     * `drained_by` is cleared with `drained_at` (the previous drainer is no longer
     * the consumer of record).
     *
     * The sweep identifies residue from `recentDrainedPendingEventPayloads`, which
     * returns row ids — an id is a strictly more precise handle than the
     * fingerprint (fingerprints can be NULL on legacy rows), hence this variant.
     * Returns true when a drained row was found and returned to the queue.
     */
    requeueDrainedPendingEventById(rowId: string): boolean {
        return requeueDrainedPendingEventById(this, rowId);
    }

    /**
     * Hard-delete pending-event rows by id (including the dedup fingerprint history).
     * Used to expire an unresolved-delegate outbox entry that has exhausted its retry
     * budget — fully removing it frees the fingerprint so a genuinely new completion
     * for the same task could be re-queued later. Returns the number of rows deleted.
     */
    deletePendingEventsById(ids: ReadonlyArray<string>): number {
        return deletePendingEventsById(this, ids);
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
     *     TERMINAL events named in `neverExpireEvents` are exempt from this window
     *     outright — see that option's doc below.
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
    prunePendingEvents(opts: {
        drainedOlderThanMs: number;
        undrainedOlderThanMs: number;
        /**
         * TERMINAL-NEVER-EXPIRES. Event names that are EXEMPT from the undrained
         * window entirely — never age-expired, however old they get. Caller-supplied
         * (the store must not own mesh event taxonomy) and matched by exact event
         * name, never by prefix/substring: a substring match would be a silent
         * over-match the moment a new event name happens to contain one of these.
         *
         * The undrained window exists to sweep orphans whose information is
         * re-derivable — a `refine:*` lifecycle marker, an `agent:ready` — for a
         * coordinator identity that never returned. A terminal completion is the
         * opposite: its finalSummary/worker result exists ONLY in this row, so
         * expiring it destroys the single copy of a worker's output. Bounding table
         * growth is not worth that, and terminal rows are naturally bounded anyway
         * (one per dispatched task, not a per-tick lifecycle stream). Exempt rows are
         * excluded from the delete AND from `undrainedRows`, so they are neither
         * deleted nor mirrored — they simply stay queued and deliverable.
         */
        neverExpireEvents?: ReadonlySet<string>;
    }): {
        drainedExpired: number;
        undrainedExpired: number;
        undrainedRows: Array<{ id: string; meshId: string; event: string; payload: unknown }>;
        /** Undrained rows past the window that were KEPT because their event name is
         *  in `neverExpireEvents`. Observability only — a non-zero value means the
         *  terminal exemption actively prevented a data-destroying expiry. */
        terminalExempt: number;
    } {
        return prunePendingEvents(this, opts);
    }

    // ── TURN-LEDGER (Stage 5): authoritative turn attempts ───────────────────
    // Implementation lives in ./mesh-runtime-store-turn-attempts.ts (behavior-
    // preserving code move, file-size gate). Kept here as thin delegators so the
    // public surface and every call site are unchanged; the extracted functions
    // reach the db handle via `self` (same pattern as router.ts → router-refine.ts).

    insertTurnAttempt(row: MeshTurnAttemptInsert): boolean { return insertTurnAttempt(this, row); }
    getTurnAttempt(attemptId: string): MeshTurnAttemptRow | null { return getTurnAttempt(this, attemptId); }
    getCurrentTurnAttempt(meshId: string, taskId: string): MeshTurnAttemptRow | null { return getCurrentTurnAttempt(this, meshId, taskId); }
    getLatestTurnAttemptForSession(sessionId: string): MeshTurnAttemptRow | null { return getLatestTurnAttemptForSession(this, sessionId); }
    getTurnAttemptBySeq(meshId: string, taskId: string, attemptSeq: number): MeshTurnAttemptRow | null { return getTurnAttemptBySeq(this, meshId, taskId, attemptSeq); }
    listTurnAttemptsForTask(meshId: string, taskId: string): MeshTurnAttemptRow[] { return listTurnAttemptsForTask(this, meshId, taskId); }
    listSupersededNonterminalTurnAttempts(meshId: string): MeshTurnAttemptRow[] { return listSupersededNonterminalTurnAttempts(this, meshId); }
    listQueueTerminatedNonterminalTurnAttempts(meshId: string): MeshTurnAttemptRow[] { return listQueueTerminatedNonterminalTurnAttempts(this, meshId); }
    listActiveTurnAttempts(meshId: string): MeshTurnAttemptRow[] { return listActiveTurnAttempts(this, meshId); }
    advanceTurnAttemptStage(attemptId: string, toStage: string, allowedFromCsv: string, opts: MeshTurnAttemptStageOpts): string | null { return advanceTurnAttemptStage(this, attemptId, toStage, allowedFromCsv, opts); }
    commitTurnAttemptTerminal(attemptId: string, outcome: string, reason: string | null, terminalAt: string): { committed: boolean; row: MeshTurnAttemptRow | null } { return commitTurnAttemptTerminal(this, attemptId, outcome, reason, terminalAt); }
    markTurnAttemptRedriven(attemptId: string, leaseDeadlineMs: number, updatedAt: string): void { markTurnAttemptRedriven(this, attemptId, leaseDeadlineMs, updatedAt); }
    rebindTurnAttemptSession(attemptId: string, sessionId: string, updatedAt: string): boolean { return rebindTurnAttemptSession(this, attemptId, sessionId, updatedAt); }

    // ── TURN-LEDGER (Stage 5): idempotency-keyed causal events ───────────────
    // Implementation: ./mesh-runtime-store-turn-attempts.ts (same pure move).

    insertTurnEvent(row: MeshTurnEventInsert): boolean { return insertTurnEvent(this, row); }
    hasTurnEvent(attemptId: string, kind: string, dedupeKey = ''): boolean { return hasTurnEvent(this, attemptId, kind, dedupeKey); }

    /** Turn events for one task, oldest first. SQL: mesh-turn-event-queries.ts. */
    listTurnEventsForTask(meshId: string, taskId: string): Omit<TurnEventRow, 'taskId'>[] { return selectTurnEventsForTask(this.db, meshId, taskId); }
    getUnsettledTerminalQueueRowsAndAttempts(meshId: string, outcomes: string[]) { return selectUnsettledTerminalQueueRowsAndAttempts(this.db, meshId, outcomes); }

    /** By-KIND turn-event queries. SQL + index rationale: mesh-turn-event-queries.ts. */
    listTurnEventsByKind(meshId: string, kind: string, limit = 200): TurnEventRow[] { return selectTurnEventsByKind(this.db, meshId, kind, limit); }
    deleteTurnEventsByKindOlderThan(kind: string, cutoffIso: string, meshId?: string): number { return deleteTurnEventsByKindOlderThan(this.db, kind, cutoffIso, meshId); }

    /** WORKER-MCP decision C: handoff note TEXT (durable, replaces the in-process mirror). */
    upsertHandoffNoteText(row: HandoffNoteTextRow): void { return upsertHandoffNoteText(this.db, row); }
    getHandoffNoteText(meshId: string, taskId: string): HandoffNoteTextRow | null { return selectHandoffNoteText(this.db, meshId, taskId); }
    deleteHandoffNoteTextOlderThan(cutoffIso: string): number { return deleteHandoffNoteTextOlderThan(this.db, cutoffIso); }

    // ── TURN-LEDGER (Stage 5): held suspensions (pre-consumed waiting_*) ─────
    // Implementation: ./mesh-runtime-store-turn-attempts.ts (same pure move).

    insertHeldTurnSuspension(row: MeshHeldTurnSuspensionInsert): boolean { return insertHeldTurnSuspension(this, row); }
    getHeldTurnSuspension(attemptId: string, stage: string): MeshTurnHeldSuspensionRow | null { return getHeldTurnSuspension(this, attemptId, stage); }
    listHeldTurnSuspensionsForAttempt(attemptId: string, status?: string): MeshTurnHeldSuspensionRow[] { return listHeldTurnSuspensionsForAttempt(this, attemptId, status); }
    listHeldTurnSuspensionsForMesh(meshId: string, status: string): MeshTurnHeldSuspensionRow[] { return listHeldTurnSuspensionsForMesh(this, meshId, status); }
    resolveHeldTurnSuspension(holdId: string, status: 'applied' | 'dropped', resolution: string, resolvedAt: string): boolean { return resolveHeldTurnSuspension(this, holdId, status, resolution, resolvedAt); }
}

// Re-export barrel: row shapes/mappers + the retention sweep moved to
// mesh-runtime-store-turn-rows.ts (pure move, file-size gate) — every existing
// `import { X } from './mesh-runtime-store.js'` keeps resolving unchanged.
export type { MeshTurnAttemptRow, MeshTurnHeldSuspensionRow } from './mesh-runtime-store-turn-rows.js';
// A6-SILENT-REFUSAL: the claim-refusal vocabulary lives in its own dependency-free leaf
// (mesh-claim-refusal) because this file is a frozen file-size baseline entry. Re-exported
// here so callers can keep importing it alongside the claim API they already use.
export type { MeshClaimRefusal, MeshClaimRefusalReason } from './mesh-claim-refusal.js';
export {
    MESH_EVENT_LEDGER_RETENTION_MS,
    MESH_TOOL_CALL_LOG_RETENTION_MS,
    MESH_TERMINAL_QUEUE_RETENTION_MS,
    pruneMeshRuntimeRetention,
} from './mesh-runtime-store-turn-rows.js';
