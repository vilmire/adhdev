/**
 * Worker progress updates (`report_progress`): accepted for the worker's current
 * attempt, recorded on the ledger, and surfaced to the coordinator only when enough
 * time and text have accumulated since the last surfaced update.
 */
import { afterBridgeCommit, bridgeReceiptTransaction, inBridgeReceiptTransaction } from './worker-bridge-transaction.js';
import { getActiveTurnLedger } from './turn-ledger/active-ledger.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { resolveWorkerIdentity, classifyUnresolvedWorkerCredential, normalizeWorkerReportedAtMs, workerIdentityPostdates, WORKER_PROGRESS_EVENT_KIND, summaryKey, type WorkerReportRefusal } from './worker-report.js';
import { resolveForwardedWorkerIdentity, type ForwardedWorkerReportClaim, type ForwardedReportSender, type ForwardedReportRefusalReason } from './worker-report-forwarded.js';
import type { WorkerTokenExchangeResult } from './worker-mcp-isolation.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';
import { queueWorkerProgressNotice } from './worker-progress-notify.js';

/**
 * Record a mid-task progress note. No terminal effect whatsoever — this exists
 * so a long-running worker can say something before it finishes, and so E-T0
 * (mailbox piggyback) has a tool response to ride on later.
 */
export function acceptWorkerProgressUpdate(
    credential: { token?: unknown; bind?: unknown },
    note: string,
    opts: { nowMs?: number; reportedAtMs?: unknown; deliveryId?: string } = {},
): WorkerProgressUpdateResult {
    const identity = resolveWorkerIdentity(credential);
    if (!identity) {
        const unresolved = classifyUnresolvedWorkerCredential(credential);
        return { accepted: false, refusal: unresolved.refusal, ...(unresolved.detail ? { detail: unresolved.detail } : {}) };
    }
    // Durable delivery: a queued note written before this session's CURRENT task was
    // dispatched belongs to a finished task — never file it against the new one.
    const reportedAt = normalizeWorkerReportedAtMs(opts.reportedAtMs, opts.nowMs ?? Date.now());
    if (reportedAt === 'too_old' || (reportedAt !== undefined && workerIdentityPostdates(identity, reportedAt))) {
        return {
            accepted: false,
            taskId: identity.taskId,
            refusal: 'stale_report',
            detail: `the note was written before task ${identity.taskId} was dispatched to this session (or is past the delivery window) — not recorded`,
        };
    }
    return acceptWorkerProgressUpdateForIdentity(identity, note, opts);
}

/** What a progress update answers — local and forwarded alike. */
export interface WorkerProgressUpdateResult {
    accepted: boolean;
    taskId?: string;
    refusal?: WorkerReportRefusal;
    detail?: string;
    /** Inline surfacing only; a durable notice intent does not promise external consumption. */
    surfacedToCoordinator?: boolean;
}

/**
 * F7 (progress axis), OWNER side: a progress note a REMOTE worker daemon
 * relayed here. Authorised by the SAME resolution a forwarded completion report
 * takes (`resolveForwardedWorkerIdentity`: the owner's own `assigned` row for
 * the session + the relaying daemon owning the row's node + agreeing
 * task/attempt), then recorded by the same body a local update runs.
 *
 * A recently-terminal attempt (the completion report's F7b grace) is refused
 * `no_live_task`: a progress note carries no terminal information and has
 * nothing to add once the ledger closed the attempt — the local path refuses it
 * the same way (`resolveWorkerIdentity` finds no assigned row). A refusal's
 * `detail` starts with its typed reason (`<reason>: <what the owner holds>`).
 */
export function acceptForwardedWorkerProgressUpdate(
    claim: ForwardedWorkerReportClaim,
    note: string,
    opts: { sender: ForwardedReportSender; nowMs?: number; isSelfDaemon?: (daemonId: string) => boolean; reportedAtMs?: number; deliveryId?: string },
): WorkerProgressUpdateResult {
    const nowMs = opts.nowMs ?? Date.now();
    const resolved = resolveForwardedWorkerIdentity(claim, opts.sender, nowMs, opts.isSelfDaemon);
    if ('refused' in resolved) return { accepted: false, refusal: 'unauthenticated', detail: `${resolved.refused}: ${resolved.detail}` };
    if ('late' in resolved) {
        const reason: ForwardedReportRefusalReason = 'no_live_task';
        return {
            accepted: false,
            taskId: resolved.late.taskId,
            refusal: 'unauthenticated',
            detail: `${reason}: task ${resolved.late.taskId}'s attempt ${resolved.late.attemptId} already ended (${resolved.late.terminalOutcome}) on the owner — progress is only recorded against a live attempt`,
        };
    }
    const reportedAt = normalizeWorkerReportedAtMs(opts.reportedAtMs, nowMs);
    if (reportedAt === 'too_old' || (reportedAt !== undefined && workerIdentityPostdates(resolved.live, reportedAt))) return { accepted: false, refusal: 'stale_report' };
    return acceptWorkerProgressUpdateForIdentity(resolved.live, note, { nowMs, deliveryId: opts.deliveryId });
}

/** The progress body, once identity is PROVEN (local bind/token, or a forwarded claim the owner re-resolved). */
export function acceptWorkerProgressUpdateForIdentity(
    identity: WorkerTokenExchangeResult,
    note: string,
    opts: { nowMs?: number; deliveryId?: string } = {},
    localNoticeId?: string,
): WorkerProgressUpdateResult {
    // ★F4: previously `return { accepted: true }` without writing a single row.
    // The worker was told "Progress noted for task …" and nothing existed to
    // note it. No attempt means there is no row to hang a turn event off, so the
    // honest answer is a refusal the worker can see, not a fabricated success.
    if (!identity.attemptId) {
        return {
            accepted: false,
            taskId: identity.taskId,
            refusal: 'storage_failed',
            detail: `task ${identity.taskId} has no active attempt to record progress against`,
        };
    }

    const nowMs = opts.nowMs ?? Date.now();
    const runtime = MeshRuntimeStore.getInstance();
    // Local calls need the same outer commit boundary as relayed receipts: the
    // audit dedupe, consumption and notice must either all survive or all roll back.
    if (!inBridgeReceiptTransaction(runtime.db)) {
        return bridgeReceiptTransaction(runtime.db, () => acceptWorkerProgressUpdateForIdentity(identity, note, opts,
            `local:${identity.attemptId}:t${nowMs}`));
    }
    const ledger = getActiveTurnLedger();
    const attempt = runtime.turnStore().getAttempt(identity.attemptId);
    if (!attempt || attempt.terminal || attempt.taskId !== identity.taskId
        || attempt.meshId !== identity.meshId || attempt.sessionId !== identity.sessionId
        || (ledger && !daemonIdsEquivalent(attempt.ownerDaemonId, ledger.selfDaemonId))) {
        return { accepted: false, taskId: identity.taskId, refusal: 'unauthenticated', detail: 'progress identity is not the current owner attempt' };
    }
    if (!ledger) return { accepted: false, taskId: identity.taskId, refusal: 'storage_failed', detail: 'the owner turn ledger is not ready to consume this progress; retry' };
    let recorded = false;
    try {
        recorded = MeshRuntimeStore.getInstance().turnStore().insertWorkerEvent({
            eventId: randomUUID(),
            attemptId: identity.attemptId,
            sessionId: identity.sessionId ?? null,
            kind: WORKER_PROGRESS_EVENT_KIND,
            // Distinct per call — progress updates are a SEQUENCE, unlike the
            // completion report where the UNIQUE constraint provides idempotency.
            dedupeKey: opts.deliveryId ? `delivery:${opts.deliveryId}` : `${nowMs}`,
            payload: { noteLength: note.length },
            atMs: nowMs,
        });
    } catch (e: any) {
        LOG.error('WorkerReport', `Failed to record progress update for task ${identity.taskId}: ${e?.message || e}`);
        return {
            accepted: false,
            taskId: identity.taskId,
            refusal: 'storage_failed',
            detail: e?.message || String(e),
        };
    }
    if (!recorded && !MeshRuntimeStore.getInstance().turnStore().getAttempt(identity.attemptId)) {
        // The token names an attempt the turn ledger does not hold (C-W8: the
        // row hangs off `turn_attempts`) — the same honest refusal as no attempt.
        return {
            accepted: false,
            taskId: identity.taskId,
            refusal: 'storage_failed',
            detail: `task ${identity.taskId} has no active attempt to record progress against`,
        };
    }
    if (!recorded && opts.deliveryId) return { accepted: true, taskId: identity.taskId, surfacedToCoordinator: false };
    if (!recorded) {
        // dedupeKey is the millisecond timestamp, so a false here means two
        // updates landed in the same millisecond on one attempt — the note IS
        // lost, and saying "noted" would be the same silent success as F4.
        return {
            accepted: false,
            taskId: identity.taskId,
            refusal: 'storage_failed',
            detail: 'a progress update for this attempt already exists at this timestamp — retry',
        };
    }

    {
        const result = ledger.observe({
            eventId: `worker_progress:${attempt.attemptId}:g${attempt.generation}:${opts.deliveryId ?? nowMs}`,
            kind: 'worker_progress', source: 'worker_tool', at: nowMs,
            sessionId: attempt.sessionId, taskId: identity.taskId,
            attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
            observedBy: ledger.selfDaemonId,
        });
        // Throw inside the receipt transaction so a rejected consume cannot
        // leave an audit receipt which would suppress the next valid delivery.
        if (result.verdict !== 'applied') throw new Error(`worker_progress_not_applied:${result.verdict}`);
    }

    // ★F3: surface the note to the coordinator. The ledger row above is
    // content-free (length only), so the TEXT rides this call and nothing else.
    // Filtered, not firehosed — see shouldSurfaceProgressToCoordinator.
    // Legacy calls without a transport delivery id still need an atomic local
    // notice intent. This correlation never becomes a worker receipt or ACK.
    const surfaced = notifyCoordinatorOfProgress(identity, note, nowMs, opts.deliveryId ?? localNoticeId);
    return { accepted: true, taskId: identity.taskId, surfacedToCoordinator: surfaced };
}

// ─── F3: progress → coordinator ─────────────────────────────────────────

/**
 * Minimum gap between two progress notes that reach the coordinator, per task.
 *
 * ★The owner's requirement is explicit about what should get through: "큰줄기와
 * 오래걸리는것들" — the main thread of the work and the things that take a long
 * time — and NOT "자잘한부분". A worker that narrates every file it opens would
 * turn the coordinator's inbox into a log tail, which is the failure mode that
 * makes a notification channel worth ignoring. So the first note on a task is
 * always surfaced (that is the "it has started and here is what it is doing"
 * signal), and after that a note must be spaced by this interval.
 */
export const WORKER_PROGRESS_SURFACE_MIN_GAP_MS = 5 * 60 * 1000;

/** Notes shorter than this are treated as chatter, not a milestone. */
export const WORKER_PROGRESS_SURFACE_MIN_CHARS = 40;

/** Last surfaced time per `${meshId}\0${taskId}`. */
const PROGRESS_SURFACE_LAST_MS = new Map<string, number>();

/** Test-only reset. */
export function __resetProgressSurfaceForTest(): void {
    PROGRESS_SURFACE_LAST_MS.clear();
}

/**
 * Decide whether a progress note is worth paging the coordinator about.
 *
 * Deliberately a pure predicate so the policy is testable without a store: the
 * alternative (deciding inside the notifier) is what makes a filter impossible
 * to characterize later.
 */
export function shouldSurfaceProgressToCoordinator(opts: {
    note: string;
    nowMs: number;
    lastSurfacedAtMs?: number;
}): boolean {
    const note = opts.note.trim();
    if (note.length < WORKER_PROGRESS_SURFACE_MIN_CHARS) return false;
    // First note on this task — always the most informative one the coordinator
    // gets, because it is the only evidence the work actually started.
    if (opts.lastSurfacedAtMs === undefined) return true;
    return opts.nowMs - opts.lastSurfacedAtMs >= WORKER_PROGRESS_SURFACE_MIN_GAP_MS;
}

/** The coordinator-facing line for a surfaced progress note. */
export function buildWorkerProgressNotice(opts: {
    taskId: string;
    nodeLabel: string;
    note: string;
}): string {
    return `[System] ${opts.nodeLabel} progress on task ${opts.taskId}: ${opts.note.trim()}`
        + ' — this is an informational mid-task update, NOT a completion. The task is still running;'
        + ' do not dispatch it elsewhere and do not poll. Wait for its completion event.';
}

/**
 * Sink that queues a coordinator-facing progress notice. Injected for the same
 * reason the handoff sink is: worker-report.ts must stay importable from tests
 * and from a daemon with no pending-event store wired.
 */
export type WorkerProgressNoticeSink = (notice: {
    meshId: string;
    taskId: string;
    nodeId?: string;
    sessionId?: string;
    note: string;
    coordinatorMessage: string;
    nowMs: number;
    eventId?: string;
}) => boolean | void;

/** `undefined` = the production sink (`queueWorkerProgressNotice`); `null` = disabled. TESTS set it. */
let progressNoticeSinkOverride: WorkerProgressNoticeSink | null | undefined;

/** TESTS ONLY — replace the progress-notice sink; see `__setHandoffNoteSinkForTests`. */
export function __setWorkerProgressNoticeSinkForTests(sink: WorkerProgressNoticeSink | null | undefined): void {
    progressNoticeSinkOverride = sink;
}

function notifyCoordinatorOfProgress(
    identity: WorkerTokenExchangeResult,
    note: string,
    nowMs: number,
    deliveryId?: string,
): boolean {
    const key = summaryKey(identity.meshId, identity.taskId);
    if (!shouldSurfaceProgressToCoordinator({
        note,
        nowMs,
        lastSurfacedAtMs: PROGRESS_SURFACE_LAST_MS.get(key),
    })) {
        return false;
    }
    const sink = progressNoticeSinkOverride === undefined ? queueWorkerProgressNotice : progressNoticeSinkOverride;
    if (!sink) return false;
    const notice = {
        meshId: identity.meshId, taskId: identity.taskId,
        ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
        ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
        note: note.trim(), coordinatorMessage: buildWorkerProgressNotice({
            taskId: identity.taskId, nodeLabel: identity.nodeId || identity.sessionId || identity.taskId, note,
        }), nowMs,
        ...(deliveryId ? { eventId: `worker-progress:${identity.attemptId}:delivery:${deliveryId}` } : {}),
    };
    const db = MeshRuntimeStore.getInstance().db;
    if (inBridgeReceiptTransaction(db)) {
        if (!deliveryId) throw new Error('bridge_progress_requires_delivery_identity');
        ensureProgressNoticeSchema(db);
        // Content stays local. This intent and the worker evidence commit with
        // the exact receipt, so neither a crash nor an unbound consumer loses it.
        db.prepare("INSERT OR IGNORE INTO worker_bridge_progress_notice(event_id,mesh_id,notice_json,state) VALUES (?,?,?,'pending')")
            .run(notice.eventId, identity.meshId, JSON.stringify(notice));
        afterBridgeCommit(db, () => { resumeBridgeProgressNotices(db); });
        return false; // Durably queued; never claim an external side effect yet.
    }
    try {
        if (sink(notice) === false) return false;
    } catch (e: any) {
        LOG.warn('WorkerReport', `Failed to surface progress for task ${identity.taskId}: ${e?.message || e}`);
        return false;
    }
    PROGRESS_SURFACE_LAST_MS.set(key, nowMs);
    return true;
}


function ensureProgressNoticeSchema(db: import('better-sqlite3').Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS worker_bridge_progress_notice (
        event_id TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, notice_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered')))`);
}
/** Retry after daemon restart or consumer/storage failure. The stable event id
 * deduplicates a crash after enqueue but before marking the local intent done. */
export function resumeBridgeProgressNotices(db: import('better-sqlite3').Database): void {
    ensureProgressNoticeSchema(db);
    const sink = progressNoticeSinkOverride === undefined ? queueWorkerProgressNotice : progressNoticeSinkOverride;
    if (!sink) return;
    const pending = db.prepare("SELECT event_id,notice_json FROM worker_bridge_progress_notice WHERE state='pending'").all() as Array<{ event_id: string; notice_json: string }>;
    for (const row of pending) {
        try {
            const notice = JSON.parse(row.notice_json) as Parameters<WorkerProgressNoticeSink>[0];
            if (sink(notice) === false) continue;
            db.prepare("UPDATE worker_bridge_progress_notice SET state='delivered' WHERE event_id=?").run(row.event_id);
            PROGRESS_SURFACE_LAST_MS.set(summaryKey(notice.meshId, notice.taskId), notice.nowMs);
        } catch { /* Original intent remains pending; retry unchanged. */ }
    }
}
