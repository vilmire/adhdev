import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { LOG } from '../logging/logger.js';
import { loadBetterSqlite3 } from '../system/load-better-sqlite3.js';
import { getConfigDir } from '../config/config.js';
import { getLedgerDir } from './mesh-ledger-paths.js';
import { MeshGraphStore } from './mesh-graph-store.js';
import { TurnStore } from './turn-ledger/store.js';
import { migrateTurnLedgerV1, turnLedgerExportPath, type TurnLedgerMigrationOptions, type TurnLedgerMigrationReport } from './turn-ledger/migrate-v1.js';
import { migrateTurnLedgerV2, type TurnLedgerMigrationV2Report } from './turn-ledger/migrate-v2.js';
import { migrateTurnLedgerV3, type TurnLedgerMigrationV3Report } from './turn-ledger/migrate-v3.js';
import { LocalRecordStore } from './mesh-local-record-store.js';
import { modelNamesEquivalent } from './slot-model-enforcement.js';
import { expandDaemonIdForms } from '@adhdev/mesh-shared';
import type { MeshTaskStatus, MeshWorkQueueEntry } from './mesh-work-queue.js';
import { type MeshClaimRefusal } from './mesh-claim-refusal.js';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { WalCheckpointScheduler, DEFAULT_WAL_CHECKPOINT_POLICY } from './mesh-runtime-store-wal.js';
import {
    findAssignedBySession as findAssignedBySessionImpl, getQueueHeads as getQueueHeadsImpl,
    pruneTerminalQueueEntries as pruneTerminalQueueEntriesImpl, pruneTerminalQueueEntriesDetailed as pruneTerminalQueueEntriesDetailedImpl, selectActiveDirectDispatches, selectSoleActiveDirectDispatchTaskId, type DirectDispatchView,
    type MeshQueueHead,
    getQueueFacts as getQueueFactsImpl, getQueueStatusCounts as getQueueStatusCountsImpl,
    getQueueDependencyHeads as getQueueDependencyHeadsImpl, type MeshQueueFacts,
} from './mesh-runtime-store-queue-reads.js';
import { upsertHandoffNoteText, selectHandoffNoteText, deleteHandoffNoteTextOlderThan, type HandoffNoteTextRow } from './mesh-handoff-note-text.js';
// Pure move (file-size gate): the schema DDL + column migrations live in
// mesh-runtime-store-schema.ts (the G2 event ledger retired with C-W9a — records
// are `mesh_local_records`, mesh-local-record-store.ts). The class keeps thin
// delegating wrappers below — same `self`-passing pattern as the turn-attempt extraction.
import {
    migrate as migrateSchema,
    hasLoggedMigrationFailure,
    markLoggedMigrationFailure,
} from './mesh-runtime-store-schema.js';
import { claimNextQueueTask } from './mesh-runtime-store-claim.js';

let DatabaseCtor: typeof BetterSqlite3 | undefined;

function loadDatabaseCtor(): typeof BetterSqlite3 {
    if (DatabaseCtor) return DatabaseCtor;
    DatabaseCtor = loadBetterSqlite3() as typeof BetterSqlite3;
    return DatabaseCtor;
}

function safeMeshId(meshId: string): string {
    return meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
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
    private readonly migratedMeshIds = new Set<string>();
    // Idle-active-mission-reminder debounce (mesh-idle-reminder.ts). In-memory only:
    // this is a spam guard for a best-effort coordinator nudge, so a daemon restart
    // resetting it (at most one extra reminder) is harmless — no SQLite persistence
    // is warranted. Keyed by meshId; the value records when the last reminder fired
    // and the hash of the active-mission id set it named, so a changed mission set
    // re-fires before the time window elapses.
    private readonly idleReminderState = new Map<string, { emittedAt: number; missionSetHash: string }>();
    // WAL checkpointing runs on a timer, never inside a write (mesh-runtime-store-wal.ts).
    private readonly walCheckpoints: WalCheckpointScheduler;
    /** Writes since the last checkpoint tick (tests read it to pin counter independence). */
    get walWriteCounter(): number { return this.walCheckpoints.writesSinceTick; }
    // Independent cadence for the tool-call-log sweep. Must NOT share the WAL write
    // counter: sharing makes each chore's threshold drift by the other's write volume.
    private toolCallLogCounter = 0;

    private constructor(dbPath: string) {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        this.db = new (loadDatabaseCtor())(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma(`busy_timeout = ${DEFAULT_WAL_CHECKPOINT_POLICY.busyTimeoutMs}`);
        // Let SQLite shrink the WAL back to the checkpoint threshold whenever a checkpoint
        // lets it restart; without this the file only ever shrank on a TRUNCATE.
        this.db.pragma(`journal_size_limit = ${DEFAULT_WAL_CHECKPOINT_POLICY.maxBytes}`);
        this.walCheckpoints = new WalCheckpointScheduler(this.db, `${dbPath}-wal`);
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
        this.walCheckpoints.stop();
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

    /** Wiring-unification C3: turn-ledger row CRUD on THIS handle (one txn with mesh_queue). */
    private turnStoreInstance: TurnStore | undefined;
    turnStore(): TurnStore {
        if (!this.turnStoreInstance) this.turnStoreInstance = new TurnStore(this.db);
        return this.turnStoreInstance;
    }

    /** C-W9a: `mesh_local_records` (the local leg of `meshRecord`) on THIS handle. */
    private localRecordStoreInstance: LocalRecordStore | undefined;
    localRecordStore(): LocalRecordStore {
        if (!this.localRecordStoreInstance) this.localRecordStoreInstance = new LocalRecordStore(this.db);
        return this.localRecordStoreInstance;
    }

    /** C3 one-way fold of the legacy turn/outbox/ledger tables (user_version 0 → 1). Boot calls it once. */
    runTurnLedgerMigrationV1(opts: Omit<TurnLedgerMigrationOptions, 'exportPath'> & { exportPath?: string | null }): TurnLedgerMigrationReport {
        const nowMs = opts.nowMs ?? Date.now();
        // v1 drops every legacy table (the schema step creates none of them any
        // more — C-W9a retired the last, the event ledger; v2/v3 drop any
        // that survive on a post-v1 install).
        return migrateTurnLedgerV1(this.db, { ...opts, nowMs, exportPath: opts.exportPath === undefined ? turnLedgerExportPath(getLedgerDir(), nowMs) : opts.exportPath });
    }

    /** C-W8 one-way step (user_version 1 → 2): drop the retired legacy tables, fold post-v1 notes. Boot runs it after v1. */
    runTurnLedgerMigrationV2(opts: { exportPath?: string | null; nowMs?: number }): TurnLedgerMigrationV2Report {
        const nowMs = opts.nowMs ?? Date.now();
        return migrateTurnLedgerV2(this.db, { exportPath: opts.exportPath === undefined ? turnLedgerExportPath(getLedgerDir(), nowMs).replace(/\.jsonl$/, '.v2.jsonl') : opts.exportPath });
    }

    /**
     * C-W9a one-way step (user_version 2 → 3): fold the recent event-ledger rows (and
     * the active per-mesh JSONL mirrors) into `mesh_local_records`, drop the ledger.
     * Boot runs it after v2.
     */
    runTurnLedgerMigrationV3(opts: { exportPath?: string | null; jsonlDir?: string | null; nowMs?: number }): TurnLedgerMigrationV3Report {
        const nowMs = opts.nowMs ?? Date.now();
        return migrateTurnLedgerV3(this.db, {
            nowMs,
            exportPath: opts.exportPath === undefined ? turnLedgerExportPath(getLedgerDir(), nowMs).replace(/\.jsonl$/, '.v3.jsonl') : opts.exportPath,
            jsonlDir: opts.jsonlDir === undefined ? getLedgerDir() : opts.jsonlDir,
        });
    }

    // ── Schema DDL + column migrations ───────────────────────────────────────
    // Implementation lives in ./mesh-runtime-store-schema.ts (behavior-preserving
    // code move, file-size gate). Kept here as thin delegators so the constructor
    // call and every call site are unchanged; the extracted functions reach the db
    // handle via `self` (same pattern as the turn-attempt delegators below).

    private migrate(): void {
        migrateSchema(this);
    }

    /**
     * Public (not private) so the extracted ./mesh-runtime-store-*.ts delegates can reach it
     * via `self`. O(1): records the write for the timer-driven checkpoint (never checkpoints here).
     */
    maybeCheckpointWal(): void {
        this.walCheckpoints.noteWrite();
    }

    /** Public (not private) so the extracted ./mesh-runtime-store-queue-reads.ts delegates can reach it via `self`. */
    ensureLegacyQueueMigrated(meshId: string): void {
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
    hasActiveSessionAssignment(meshId: string, sessionId: string): boolean {
        const row = this.db.prepare(`
            SELECT 1 FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned' AND assigned_session_id = ?
            LIMIT 1
        `).get(meshId, sessionId);
        return row !== undefined;
    }

    /** A node may only execute one write task at a time (worktree isolation). */
    hasActiveNodeAssignment(meshId: string, nodeId: string): boolean {
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
    activeSlotAssignmentCount(
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

    /**
     * Every `assigned` row in the mesh, on ANY node/daemon — the scope H1
     * path-ownership needs (wiring-unification §7c). Unlike
     * {@link assignedRowsForDaemon} (capacity gates: provider/slot maxParallel,
     * node-busy — all correctly scoped to ONE machine's resources), path
     * ownership exists to keep parallel branches from touching the same files
     * before they converge on main, and two worktrees on two DIFFERENT
     * machines are exactly as parallel as two worktrees on one machine. A
     * daemon-scoped query never sees a cross-daemon collision at all (live
     * finding, preview rc.41 runs 3–7: a direct-dispatch row `assigned` on one
     * daemon did not stop an overlapping enqueued task from being claimed on a
     * completely different daemon).
     *
     * Filters on the same indexed `(mesh_id, status, created_at)` prefix as the
     * candidate queries above — `status = 'assigned'` mesh-wide is a single
     * indexed range scan, not a table scan, and excludes every terminal status
     * (`done`/`failed`/`cancelled`/pending) by construction.
     */
    assignedRowsMeshWide(meshId: string): Array<{ payload: string }> {
        return this.db.prepare(`
            SELECT payload FROM mesh_queue
            WHERE mesh_id = ? AND status = 'assigned'
        `).all(meshId) as Array<{ payload: string }>;
    }

    activeProviderAssignmentCount(
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
    claimNextQueueTask(meshId: string, nodeId: string, sessionId: string, capabilityTags: string[] = [], opts?: {
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
            /**
             * GIT-GATE (owner-requested follow-up to H1): the claiming node's git
             * telemetry verdict, resolved by the CALLER (mesh-queue-assignment.ts
             * tryAssignQueueTask, which already has the mesh/node records at hand —
             * mirrors how `nodeIsWorktree` is threaded rather than the store importing
             * config/mesh-node-identity itself) via the SAME predicates the auto-launch
             * spawn gate uses (`isDirtyNode`, `isMeshNodeFreshEnoughToLaunch` +
             * `resolveAutoFastForwardPolicy(mesh).maxBehind`). Omitted or both flags
             * false ⇒ no gating (fail-open on unresolved/absent telemetry, matching
             * those predicates' own fail-open contract). Applies to non-readonly
             * candidates only — a readonly candidate bypasses this gate entirely, same
             * as `nodeConflictAllows` above.
             */
            nodeGitGate?: { dirty: boolean; staleBehind: boolean; behind?: number; maxBehind?: number };
            /** A6-SILENT-REFUSAL: optional sink the claim fills in when it returns null,
             *  naming WHICH predicate refused. See MeshClaimRefusal. Purely diagnostic —
             *  the return contract (`MeshWorkQueueEntry | null`) is unchanged, so every
             *  existing caller that omits it behaves exactly as before. */
            outRefusal?: MeshClaimRefusal;
        }): MeshWorkQueueEntry | null { return claimNextQueueTask(this, meshId, nodeId, sessionId, capabilityTags, opts); }

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
        // Implementation in ./mesh-runtime-store-queue-reads.ts: decides on columns and
        // parses only the returned row (IPC load audit #9 — it runs per worker tool call).
        return findAssignedBySessionImpl(this, meshId, sessionId, occurredAtIso, taskId);
    }

    /** Column-only queue rows (id/status/assignment) — no payload parse. */
    getQueueHeads(meshId: string, statuses?: MeshTaskStatus[]): MeshQueueHead[] {
        return getQueueHeadsImpl(this, meshId, statuses);
    }

    /** Per-row mission/stats scalars via json_extract — no JS payload parse (see queue-reads). */
    getQueueFacts(meshId: string): MeshQueueFacts[] {
        return getQueueFactsImpl(this, meshId);
    }

    /** Whole-queue per-status counts (+ terminal rows older than `olderThanIso`) — columns only. */
    getQueueStatusCounts(meshId: string, olderThanIso?: string): { counts: Record<string, number>; oldHistoricalCount: number } {
        return getQueueStatusCountsImpl(this, meshId, olderThanIso);
    }

    /** id/status/blockedReason/cancelReason for the given row ids. */
    getQueueDependencyHeads(meshId: string, ids: readonly string[]): Array<{ id: string; status: MeshTaskStatus; blockedReason?: string; cancelReason?: string }> {
        return getQueueDependencyHeadsImpl(this, meshId, ids);
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

    // ── Direct dispatches (C-W8: open `mesh_direct` turn-ledger attempts) ────
    // The legacy direct-dispatch table and its writers are retired: the attempt
    // the caller opens (`dispatch_accepted`, scope mesh_direct) IS the pre-recorded
    // dispatch, and its state is the reducer's. Reads: mesh-runtime-store-queue-reads.ts.

    getActiveDirectDispatches(meshId: string): DirectDispatchView[] {
        return selectActiveDirectDispatches(this, meshId);
    }

    getSoleActiveDirectDispatchTaskId(meshId: string, sessionId: string): string | null {
        return selectSoleActiveDirectDispatchTaskId(this, meshId, sessionId);
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
                + `Wait for the next coordinator notice (typed into this session, or attached as pendingCoordinatorEvents to every mesh tool response — drained by get_pending_mesh_events) or an explicit user status request before calling again.`;
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
        return pruneTerminalQueueEntriesImpl(this, olderThanMs);
    }

    /**
     * Same prune, also reporting the non-graph `mesh_task_outputs` rows removed in the
     * same transaction (their retention IS the queue's — see the impl's header).
     */
    pruneTerminalQueue(olderThanMs: number): { queue: number; taskOutputs: number } {
        return pruneTerminalQueueEntriesDetailedImpl(this, olderThanMs);
    }

    // ── M3: Mission Records ─────────────────────────────────────────────────

    upsertMission(mission: {
        id: string;
        meshId: string;
        title: string;
        goal?: string;
        status?: string;
        source?: string;
        /** H2: JSON-encoded MissionBrief, or `null` to explicitly clear it. `undefined`
         *  (the field omitted) preserves whatever brief the mission already had — same
         *  write-once-unless-supplied convention as `source`, but via COALESCE on the
         *  RAW incoming value (null is a legitimate "clear" input, unlike source). */
        briefJson?: string | null;
    }): void {
        const now = new Date().toISOString();
        // `source` is a write-once provenance tag: on conflict we only overwrite it
        // with a non-null incoming value (COALESCE(excluded, existing)), so a later
        // status/goal upsert that omits source never clears a previously-stamped
        // 'magi'/'coordinator' tag.
        // close_candidate_emitted_at is deliberately NOT in the UPDATE set: the G3
        // idempotency marker is owned solely by setMissionCloseCandidateEmittedAt, so a
        // title/goal/status upsert here never clears or overwrites it.
        // brief_json: `undefined` means "caller did not touch the brief" (preserve
        // existing), so it binds SQL NULL for the bind param and the UPDATE SET
        // COALESCEs against the existing column — same idea as `source` but the
        // caller signals "preserve" with `undefined` specifically (not with `null`,
        // which is a real "clear the brief" input) via the ternary below.
        this.db.prepare(
            `INSERT INTO mesh_missions (id, mesh_id, title, goal, status, source, brief_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title,
                 goal = excluded.goal,
                 status = excluded.status,
                 source = COALESCE(excluded.source, mesh_missions.source),
                 brief_json = CASE WHEN ? THEN mesh_missions.brief_json ELSE excluded.brief_json END,
                 updated_at = excluded.updated_at`
        ).run(
            mission.id,
            mission.meshId,
            mission.title,
            mission.goal ?? '',
            mission.status ?? 'active',
            mission.source ?? null,
            mission.briefJson === undefined ? null : mission.briefJson,
            now,
            now,
            mission.briefJson === undefined ? 1 : 0,
        );
        this.maybeCheckpointWal();
    }

    getMission(meshId: string, missionId: string): { id: string; meshId: string; title: string; goal: string; status: string; source?: string; closeCandidateEmittedAt?: string; briefJson?: string; createdAt: string; updatedAt: string } | null {
        const row = this.db.prepare(
            'SELECT * FROM mesh_missions WHERE mesh_id = ? AND id = ?'
        ).get(meshId, missionId) as Record<string, string> | undefined;
        if (!row) return null;
        return { id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, source: row.source ?? undefined, closeCandidateEmittedAt: row.close_candidate_emitted_at ?? undefined, briefJson: row.brief_json ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
    }

    getMissions(meshId: string, statuses?: string[]): Array<{ id: string; meshId: string; title: string; goal: string; status: string; source?: string; closeCandidateEmittedAt?: string; briefJson?: string; createdAt: string; updatedAt: string }> {
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
        return rows.map(row => ({ id: row.id, meshId: row.mesh_id, title: row.title, goal: row.goal, status: row.status, source: row.source ?? undefined, closeCandidateEmittedAt: row.close_candidate_emitted_at ?? undefined, briefJson: row.brief_json ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }));
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

    /** WORKER-MCP decision C: handoff note TEXT (durable, replaces the in-process mirror). */
    upsertHandoffNoteText(row: HandoffNoteTextRow): void { return upsertHandoffNoteText(this.db, row); }
    getHandoffNoteText(meshId: string, taskId: string): HandoffNoteTextRow | null { return selectHandoffNoteText(this.db, meshId, taskId); }
    deleteHandoffNoteTextOlderThan(cutoffIso: string): number { return deleteHandoffNoteTextOlderThan(this.db, cutoffIso); }

}

// Re-export barrel: the retention sweep moved to mesh-runtime-store-turn-rows.ts
// (pure move, file-size gate) — every existing
// `import { X } from './mesh-runtime-store.js'` keeps resolving unchanged.
// A6-SILENT-REFUSAL: the claim-refusal vocabulary lives in its own dependency-free leaf
// (mesh-claim-refusal) because this file is a frozen file-size baseline entry. Re-exported
// here so callers can keep importing it alongside the claim API they already use.
export type { MeshClaimRefusal, MeshClaimRefusalReason } from './mesh-claim-refusal.js';
export {
    MESH_LOCAL_RECORD_RETENTION_MS,
    MESH_TOOL_CALL_LOG_RETENTION_MS,
    MESH_TERMINAL_QUEUE_RETENTION_MS,
    pruneMeshRuntimeRetention,
} from './mesh-runtime-store-turn-rows.js';
