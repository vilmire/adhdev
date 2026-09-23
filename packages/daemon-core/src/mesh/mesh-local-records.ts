// ---------------------------------------------------------------------------
// mesh-local-records — the read API over this daemon's mesh records (C-W9a)
// ---------------------------------------------------------------------------
// Successor of the retired event-ledger readers (`readLedgerEntries*`,
// `readLedgerSlice*`, `getLedgerSummary`, the JSONL read cache). Three stores,
// one question each:
//
//   · `mesh_local_records` (mesh-local-record-store.ts) — the full nested
//     payload of every non-turn record THIS machine wrote through
//     `meshRecord(..., { local })` (the daemon and its mcp-server share the
//     `mesh-runtime.db` file). Refine jobs, MAGI, dispatch failure errors,
//     worktree / quota / routing diagnostics read here.
//   · `turn_attempts` — the terminal truth of every queue / direct task turn
//     since C: a reader that asks for `task_completed` / `task_failed` gets
//     one view per committed attempt ({@link readTurnTerminalViews}), with the
//     commit strength / reason mapped onto the payload fields the old ledger
//     readers already inspect (`evidenceLevel`, `intentional`).
//   · `mesh_topic_index` (mesh-topic-index.ts) — the content-free FLEET view
//     (other daemons' records). Not merged here: a fleet reader picks it
//     explicitly (`readFleetTaskActivity`), because a projected peer row has
//     no nested payload and must never be mistaken for a local one.
// ---------------------------------------------------------------------------

import { daemonIdsEquivalent, isMeshTaskDifficulty, sessionIdsEquivalent, type MeshTaskDifficulty } from '@adhdev/mesh-shared';
import { MeshRuntimeStore, MESH_LOCAL_RECORD_RETENTION_MS } from './mesh-runtime-store.js';
import {
    ACTIVE_WORK_LEDGER_PROJECTION,
    REFINE_JOB_LEDGER_KINDS,
    REFINE_JOB_LEDGER_PROJECTION,
    isIntentionalCleanupStopEntry,
    type MeshLedgerEntry,
    type MeshLedgerKind,
    type MeshLedgerSlice,
    type MeshLedgerSummary,
    type ReadLedgerOptions,
    type ReadLedgerSliceOptions,
    type SessionRecoveryContext,
} from './mesh-ledger.js';
import type { LocalRecordProjection } from './mesh-local-record-store.js';

export const DEFAULT_LOCAL_RECORD_SLICE_LIMIT = 100;
export const MAX_LOCAL_RECORD_SLICE_LIMIT = 500;
const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000;


const TERMINAL_KINDS: ReadonlySet<string> = new Set(['task_completed', 'task_failed']);

function sinceToMs(since: string | undefined): number | undefined {
    if (typeof since !== 'string') return undefined;
    const ms = new Date(since).getTime();
    return Number.isFinite(ms) ? ms : undefined;
}

function store() {
    return MeshRuntimeStore.getInstance().localRecordStore();
}

// ─── turn terminal views (task_completed / task_failed after C) ─────────────

interface TerminalRow {
    attempt_id: string; task_id: string; session_id: string; node_id: string | null; provider_type: string | null;
    terminal_outcome: string; terminal_reason: string | null; terminal_strength: string | null; terminal_source: string | null;
    terminal_at: number | null;
}

/**
 * One `task_completed` / `task_failed` view per committed queue/direct attempt
 * of a mesh. The payload carries the commit's closed-vocabulary fields plus
 * the two the legacy readers key on: `evidenceLevel: 'weak'` for a weak commit
 * (`isWeakCompletionEvidence`) and `intentional` + `intentionalStopReason` for
 * a cancel (`isIntentionalCleanupStopEntry` — a cancel is not a failure).
 */
export function readTurnTerminalViews(meshId: string, opts: { sinceMs?: number; taskId?: string; tail?: number; kinds?: readonly string[] } = {}): MeshLedgerEntry[] {
    const where = ['mesh_id = ?', 'task_id IS NOT NULL', 'terminal_outcome IS NOT NULL'];
    const args: unknown[] = [meshId];
    if (opts.kinds && opts.kinds.length > 0) {
        // kind → outcomes BEFORE the tail, so completions never crowd failures out.
        const outcomes = [
            ...(opts.kinds.includes('task_completed') ? ['completed'] : []),
            ...(opts.kinds.includes('task_failed') ? ['failed', 'cancelled'] : []),
        ];
        if (outcomes.length === 0) return [];
        where.push(`terminal_outcome IN (${outcomes.map(() => '?').join(', ')})`);
        args.push(...outcomes);
    }
    if (opts.sinceMs !== undefined) { where.push('terminal_at >= ?'); args.push(opts.sinceMs); }
    if (opts.taskId) { where.push('task_id = ?'); args.push(opts.taskId); }
    const tail = opts.tail && opts.tail > 0 ? Math.floor(opts.tail) : null;
    const rows = MeshRuntimeStore.getInstance().db.prepare(
        `SELECT attempt_id, task_id, session_id, node_id, provider_type, terminal_outcome, terminal_reason, terminal_strength,
                terminal_source, terminal_at
         FROM turn_attempts WHERE ${where.join(' AND ')} ORDER BY terminal_at DESC${tail ? ` LIMIT ${tail}` : ''}`,
    ).all(...args) as TerminalRow[];
    return rows.reverse().map((row): MeshLedgerEntry => {
        const completed = row.terminal_outcome === 'completed';
        const cancelled = row.terminal_outcome === 'cancelled';
        return {
            id: `${row.attempt_id}#committed`,
            meshId,
            timestamp: new Date(row.terminal_at ?? 0).toISOString(),
            kind: completed ? 'task_completed' : 'task_failed',
            sessionId: row.session_id,
            ...(row.node_id ? { nodeId: row.node_id } : {}),
            ...(row.provider_type ? { providerType: row.provider_type } : {}),
            taskId: row.task_id,
            payload: {
                taskId: row.task_id,
                attemptId: row.attempt_id,
                source: 'turn_ledger',
                outcome: row.terminal_outcome,
                ...(row.terminal_reason ? { reason: row.terminal_reason } : {}),
                ...(row.terminal_strength ? { strength: row.terminal_strength } : {}),
                ...(row.terminal_source ? { terminalSource: row.terminal_source } : {}),
                ...(completed && row.terminal_strength === 'weak' ? { evidenceLevel: 'weak' } : {}),
                ...(!completed && !cancelled && row.terminal_reason ? { error: row.terminal_reason } : {}),
                ...(cancelled ? { intentional: true, intentionalStopReason: 'operator_cleanup' } : {}),
            },
        };
    });
}

function byTime(a: MeshLedgerEntry, b: MeshLedgerEntry): number {
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}

/**
 * Merge turn terminal views into a local read of `kinds`: a view is added only
 * for a requested terminal kind whose task has no local terminal record of the
 * same kind (refine jobs / the dispatch-failure auto-fail still write one).
 */
function withTurnTerminals(meshId: string, local: MeshLedgerEntry[], kinds: readonly string[] | undefined, opts: { sinceMs?: number; tail?: number }): MeshLedgerEntry[] {
    const wanted = kinds && kinds.length > 0 ? kinds.filter((k) => TERMINAL_KINDS.has(k)) : ['task_completed', 'task_failed'];
    if (wanted.length === 0) return local;
    let views: MeshLedgerEntry[];
    try {
        // A merged tail of N never needs more than the N newest views.
        views = readTurnTerminalViews(meshId, {
            kinds: wanted,
            ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
            ...(opts.tail ? { tail: opts.tail } : {}),
        });
    } catch {
        return local;
    }
    const seen = new Set(local.filter((e) => TERMINAL_KINDS.has(e.kind) && e.taskId).map((e) => `${e.kind}\u0000${e.taskId}`));
    const extra = views.filter((v) => wanted.includes(v.kind) && !seen.has(`${v.kind}\u0000${v.taskId}`));
    if (extra.length === 0) return local;
    return [...local, ...extra].sort(byTime);
}

// ─── reads ──────────────────────────────────────────────────────────────────

export interface ReadLocalRecordOptions extends ReadLedgerOptions {
    /**
     * Also answer `task_completed` / `task_failed` from `turn_attempts` (the
     * terminal truth since C). Default true: every legacy reader of those kinds
     * meant "did the task finish", which the turn ledger now owns.
     */
    turnTerminals?: boolean;
}

/**
 * Read this machine's records with the legacy ledger read semantics: `since`
 * (inclusive), `kind` (any of), `node` (daemon-id equivalent), `tail` (most
 * recent N after every filter), ascending order.
 */
export function readLocalRecords(meshId: string, opts: ReadLocalRecordOptions = {}): MeshLedgerEntry[] {
    const sinceMs = sinceToMs(opts.since);
    const kinds = opts.kind?.length ? opts.kind : undefined;
    const node = typeof opts.node === 'string' && opts.node.trim() ? opts.node.trim() : undefined;
    // The node filter is daemon-id EQUIVALENCE (mach_X vs daemon_mach_X), applied
    // in JS — so the SQL tail must not run before it.
    const sqlTail = !node && opts.tail && opts.tail > 0 ? opts.tail : undefined;
    let entries: MeshLedgerEntry[];
    try {
        entries = store().query(meshId, {
            ...(kinds ? { kinds } : {}),
            ...(sinceMs !== undefined ? { sinceMs } : {}),
            ...(sqlTail ? { tail: sqlTail } : {}),
        });
    } catch {
        return [];
    }
    if (opts.turnTerminals !== false) {
        entries = withTurnTerminals(meshId, entries, kinds, { ...(sinceMs !== undefined ? { sinceMs } : {}), ...(sqlTail ? { tail: sqlTail } : {}) });
    }
    if (node) entries = entries.filter((e) => e.nodeId && daemonIdsEquivalent(e.nodeId, node));
    if (opts.tail && opts.tail > 0 && entries.length > opts.tail) entries = entries.slice(-opts.tail);
    return entries;
}

/** Kind-first read (LEDGER-KIND-TAIL-BLINDSPOT): the most recent `cap` records of `kinds`. */
export function readLocalRecordsByKind(meshId: string, kinds: MeshLedgerKind[], cap?: number, opts: { turnTerminals?: boolean } = {}): MeshLedgerEntry[] {
    return readLocalRecords(meshId, { kind: kinds, ...(cap && cap > 0 ? { tail: cap } : {}), ...opts });
}

/**
 * Projection read: entries carry only `projection.paths` of their payload.
 * Turn terminal views (whose payloads are already tiny) are merged in whole.
 */
export function readLocalRecordHeads(meshId: string, kinds: MeshLedgerKind[], projection: LocalRecordProjection, opts: { turnTerminals?: boolean } = {}): MeshLedgerEntry[] {
    let entries: MeshLedgerEntry[];
    try {
        entries = store().heads(meshId, { kinds, projection });
    } catch {
        return [];
    }
    return opts.turnTerminals === false ? entries : withTurnTerminals(meshId, entries, kinds, {});
}

/**
 * Active-work evidence for buildMeshActiveWork (auto-prune, idle reminder,
 * notification status line, mesh_status): ACTIVE_WORK_LEDGER_PROJECTION's
 * payload fields of local records, plus the turn ledger's task outcomes (the
 * terminal authority a direct dispatch is matched against).
 */
export function readActiveWorkRecords(meshId: string, kinds: MeshLedgerKind[]): MeshLedgerEntry[] {
    return readLocalRecordHeads(meshId, kinds, ACTIVE_WORK_LEDGER_PROJECTION);
}

/**
 * Refine-job lifecycle records for buildMeshAsyncRefineJobs (REFINE_JOB_LEDGER_PROJECTION).
 * Local only: a refine job is not a turn — its dispatch and terminal are both records.
 */
export function readRefineJobRecords(meshId: string): MeshLedgerEntry[] {
    return readLocalRecordHeads(meshId, REFINE_JOB_LEDGER_KINDS, REFINE_JOB_LEDGER_PROJECTION, { turnTerminals: false });
}

// ─── summary / slice (get_mesh_ledger, mesh_status, coordinator briefing) ────

/**
 * The mesh activity summary: per-kind counts of this machine's records plus
 * the turn ledger's committed outcomes (completed / failed; a cancel is not a
 * failure). Operator-cleanup stops are excluded from the failure counts.
 */
export function getLocalRecordSummary(meshId: string): MeshLedgerSummary {
    const counts = new Map<string, number>();
    let total = 0;
    let lastAtMs: number | null = null;
    try {
        for (const row of store().kindCounts(meshId)) {
            counts.set(row.kind, row.count);
            total += row.count;
            if (row.lastAtMs !== null && (lastAtMs === null || row.lastAtMs > lastAtMs)) lastAtMs = row.lastAtMs;
        }
    } catch { /* store unavailable → empty summary */ }
    const recentFailureCutoff = Date.now() - RECENT_FAILURE_WINDOW_MS;
    let taskCompleted = counts.get('task_completed') ?? 0;
    let taskFailed = 0;
    let taskStalled = 0;
    let recentFailures = 0;
    const failureRows = (counts.get('task_failed') || counts.get('task_stalled'))
        ? readLocalRecordHeads(meshId, ['task_failed', 'task_stalled'], CLEANUP_STOP_PROJECTION, { turnTerminals: false })
        : [];
    const localTerminalTasks = new Set<string>();
    for (const row of failureRows) {
        if (row.taskId) localTerminalTasks.add(`${row.kind}\u0000${row.taskId}`);
        if (isIntentionalCleanupStopEntry(row)) continue;
        if (row.kind === 'task_stalled') { taskStalled++; continue; }
        taskFailed++;
        if (new Date(row.timestamp).getTime() >= recentFailureCutoff) recentFailures++;
    }
    let views: MeshLedgerEntry[] = [];
    try { views = readTurnTerminalViews(meshId); } catch { /* no turn tables */ }
    for (const view of views) {
        if (localTerminalTasks.has(`${view.kind}\u0000${view.taskId}`)) continue;
        total++;
        const at = new Date(view.timestamp).getTime();
        if (lastAtMs === null || at > lastAtMs) lastAtMs = at;
        if (view.kind === 'task_completed') { taskCompleted++; continue; }
        if (isIntentionalCleanupStopEntry(view)) continue;
        taskFailed++;
        if (at >= recentFailureCutoff) recentFailures++;
    }
    return {
        meshId,
        totalEntries: total,
        taskDispatched: counts.get('task_dispatched') ?? 0,
        taskCompleted,
        taskFailed,
        taskStalled,
        sessionLaunched: counts.get('session_launched') ?? 0,
        checkpointCreated: counts.get('checkpoint_created') ?? 0,
        lastActivityAt: total > 0 && lastAtMs !== null ? new Date(lastAtMs).toISOString() : null,
        recentFailures,
    };
}

/** Payload fields isIntentionalCleanupStopEntry reads. */
const CLEANUP_STOP_PROJECTION: LocalRecordProjection = {
    name: 'cleanup_stop',
    paths: ['$.intentional', '$.reason', '$.intentionalStopReason', '$.source'],
};

function clampSliceLimit(limit: unknown): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LOCAL_RECORD_SLICE_LIMIT;
    return Math.max(1, Math.min(MAX_LOCAL_RECORD_SLICE_LIMIT, Math.floor(limit)));
}

/**
 * A bounded, cursor-addressable slice of this machine's records — what a
 * remote coordinator reads over P2P (`get_mesh_ledger_slice`) to see this
 * daemon's refine results / diagnostics. Local records only: turn outcomes
 * are the owner's `turn_attempts`, read through `turn_query`.
 */
export function readLocalRecordSlice(meshId: string, opts: ReadLedgerSliceOptions = {}): MeshLedgerSlice {
    const limit = clampSliceLimit(opts.limit);
    const afterId = typeof opts.afterId === 'string' && opts.afterId.trim() ? opts.afterId.trim() : null;
    const sinceMs = sinceToMs(opts.since);
    let page: { entries: MeshLedgerEntry[]; hasMore: boolean } = { entries: [], hasMore: false };
    try {
        page = store().slice(meshId, {
            ...(opts.kind?.length ? { kinds: opts.kind } : {}),
            ...(sinceMs !== undefined ? { sinceMs } : {}),
            afterEventId: afterId,
            limit,
        });
    } catch { /* store unavailable → empty page */ }
    return {
        protocol: 'adhdev.mesh.ledger.slice.v1',
        meshId,
        entries: page.entries,
        cursor: {
            afterId,
            nextAfterId: page.entries.length ? page.entries[page.entries.length - 1].id : afterId,
            limit,
            hasMore: page.hasMore,
        },
        summary: getLocalRecordSummary(meshId),
        sourceOfTruth: { kind: 'local_sqlite', table: 'mesh_local_records', bounded: true, maxLimit: MAX_LOCAL_RECORD_SLICE_LIMIT },
    };
}

// ─── recovery context (mesh_session_recovery) ─────────────────────────────────

/**
 * Build recovery context for a failed session.
 * Looks up the ledger to find the original task, count failures, and advise on retry.
 */
export function getSessionRecoveryContext(
    meshId: string,
    opts: {
        sessionId?: string;
        nodeId?: string;
        maxRetries?: number;
    },
): SessionRecoveryContext {
    const maxRetries = opts.maxRetries ?? 1;
    // tail:500 is sufficient — task_dispatched is never archived (only terminal kinds are),
    // so dispatch history is always present. The 30-min failure window means we never need
    // more than a few dozen recent entries for consecutiveNodeFailures. Bounding to 500
    // avoids a full O(n) scan for meshes with many historical entries.
    const entries = readLocalRecords(meshId, { tail: 500 });

    // Single backward pass: find last task_dispatched AND count consecutive recent failures.
    const now = Date.now();
    const recentWindow = now - RECENT_FAILURE_WINDOW_MS;
    let lastDispatch: MeshLedgerEntry | null = null;
    let consecutiveNodeFailures = 0;
    let failureCountDone = false;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const ts = new Date(e.timestamp).getTime();

        // Failure counting: scan until we exit the recent window or hit a chain-breaker
        if (!failureCountDone) {
            if (ts < recentWindow) {
                failureCountDone = true;
            } else if (opts.nodeId && !daemonIdsEquivalent(e.nodeId, opts.nodeId)) {
                // Entry for a different node — skip for failure counting but continue scanning for dispatch
            } else if (e.kind === 'task_failed') {
                if (!isIntentionalCleanupStopEntry(e)) consecutiveNodeFailures++;
            } else if (e.kind === 'task_completed' || e.kind === 'task_dispatched') {
                // A completion or new dispatch breaks the consecutive failure chain
                failureCountDone = true;
            }
        }

        // Dispatch search: find the last dispatch matching this session or node
        if (lastDispatch === null && e.kind === 'task_dispatched') {
            if (opts.sessionId && sessionIdsEquivalent(e.sessionId, opts.sessionId)) { lastDispatch = e; }
            else if (!opts.sessionId && opts.nodeId && daemonIdsEquivalent(e.nodeId, opts.nodeId)) { lastDispatch = e; }
        }

        // Stop once both tasks are done
        if (lastDispatch !== null && failureCountDone) break;
    }

    const lastTaskMessage = typeof lastDispatch?.payload?.message === 'string'
        ? lastDispatch.payload.message
        : null;

    // DIFFICULTY-REQUIRED (recovery inheritance): recover the difficulty the failed task
    // ran with, from the SAME task_dispatched entry the message came from — so the
    // relaunch re-enqueues with the coordinator's original classification instead of
    // guessing a new one. recordTaskDispatchedLedger (mesh-queue-assignment.ts) writes it
    // to payload.routingDecision.resolvedDifficulty. Best-effort by design: a legacy entry
    // predating the field, or one carrying a value no longer in the axis, yields null and
    // the caller falls back — never a throw, because this runs on the failure-recovery path.
    let lastTaskDifficulty: MeshTaskDifficulty | null = null;
    const routingDecision = lastDispatch?.payload?.routingDecision;
    if (routingDecision && typeof routingDecision === 'object') {
        const resolved = (routingDecision as Record<string, unknown>).resolvedDifficulty;
        if (isMeshTaskDifficulty(resolved)) lastTaskDifficulty = resolved;
    }

    // Count how many times the same task was attempted.
    // Prefer exact taskId match (payload.taskId) to avoid 200-char prefix collisions.
    let taskAttemptCount = 0;
    if (lastDispatch) {
        const taskId = typeof lastDispatch.payload?.taskId === 'string' ? lastDispatch.payload.taskId : null;
        if (taskId) {
            for (const e of entries) {
                if (e.kind === 'task_dispatched' && e.payload?.taskId === taskId) taskAttemptCount++;
            }
        } else if (lastTaskMessage) {
            const prefix = lastTaskMessage.slice(0, 200);
            for (const e of entries) {
                if (e.kind === 'task_dispatched' && typeof e.payload?.message === 'string') {
                    if (e.payload.message.startsWith(prefix)) taskAttemptCount++;
                }
            }
        }
    }

    const retryRecommended = consecutiveNodeFailures <= maxRetries;

    // Build advice string
    let advice: string;
    if (consecutiveNodeFailures === 0) {
        advice = 'No recent failures detected. This may be a normal stop.';
    } else if (retryRecommended) {
        const remaining = maxRetries - consecutiveNodeFailures + 1;
        advice = `Retry recommended (${consecutiveNodeFailures}/${maxRetries + 1} attempts used, ${remaining} remaining). `
            + (lastTaskMessage
                ? `Re-launch the session and resend the original task.`
                : `Re-launch the session. Original task message not found in ledger.`);
    } else {
        advice = `Max retries exceeded (${consecutiveNodeFailures} consecutive failures). `
            + `Consider: (1) reassigning to a different node, (2) simplifying the task, or (3) escalating to the user.`;
    }

    return {
        lastTaskMessage,
        lastTaskDifficulty,
        failedNodeId: opts.nodeId || null,
        failedSessionId: opts.sessionId || null,
        failedProviderType: null, // filled by caller if available
        consecutiveNodeFailures,
        taskAttemptCount,
        retryRecommended,
        advice,
    };
}

// ─── retention / tests ──────────────────────────────────────────────────────

/** Retention sweep leg (hourly, `pruneMeshRuntimeRetention`). Returns rows deleted. */
export function pruneLocalRecords(olderThanMs: number = MESH_LOCAL_RECORD_RETENTION_MS, nowMs: number = Date.now()): number {
    return store().prune(olderThanMs, nowMs);
}

/** Test helper: drop every local record of one mesh. */
export function __clearLocalRecordsForTests(meshId: string): void {
    try { store().clear(meshId); } catch { /* store unavailable — nothing to clear */ }
}
