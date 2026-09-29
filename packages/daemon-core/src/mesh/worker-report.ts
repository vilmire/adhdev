/**
 * Worker structured reporting — Phase B/C.
 *
 * Design SoT: docs/design/2026-08-28-worker-mcp.md §4 (decision B), §5 (C),
 * §9.1 (F: channel/storage), §12.1a (token delivery).
 *
 * ─── What this replaces, and what it deliberately does NOT ───────────────
 *
 * Today a worker's completion is INFERRED: the daemon watches a PTY, decides the
 * turn ended, scrapes the screen for a summary, and attributes the result to
 * whatever task a session-level scalar happens to name. Each of those three
 * steps has a measured defect family behind it (design §4 표):
 *
 *   - summary truncation  — the scrape is an arbitrary-length prefix of a
 *     wrapped/scrolled terminal, and `mayBeTruncated` is the only tell.
 *   - misattribution      — `meshActiveTaskId` is a last-write-wins scalar, so a
 *     second task attaching mid-turn overwrites the first.
 *   - phantom turns       — an event emitted before a task was ever assigned
 *     carries no taskId and flips a sibling's row.
 *
 * A structured report removes the inference: the summary is an ARGUMENT, and the
 * attribution comes from a daemon-minted token rather than from session state.
 *
 * ★It does NOT replace the PTY (design §4 "절반만 승격"). A worker that dies, or
 * never calls the tool, or never reaches MCP at all, produces no report — and
 * making the report the only path would turn "did not report" into "never
 * completes", which is strictly worse than today. stall-rescue and the watchdogs
 * remain the last line. This module ADDS an evidence grade; it removes none.
 *
 * ★And it does not soften "a timeout is never proof of completion". A turn that
 * times out WITHOUT a report is still `failed`, exactly as before.
 *
 * ─── Why everything routes through proposeTurnCompletion ─────────────────
 *
 * `proposeTurnCompletion` is the single terminal writer, and it checks stale
 * attempt / session mismatch / epoch / already-terminal IN THAT ORDER before it
 * commits. This module never writes a terminal row itself. Two reasons, both
 * load-bearing:
 *
 *  1. Those causal checks are a SECOND defence, independent of the token. A
 *     token can be perfectly valid and the report still wrong to accept — a
 *     report arriving after the task was reassigned is the ordinary case. The
 *     reducer is what knows that; the token cannot.
 *  2. Replay and duplicate handling already live in there. Re-implementing them
 *     out here would create a second truth about what "already terminal" means.
 */

import { randomUUID } from 'crypto';
import {
    WORKER_BRANCH_STATES,
    sessionIdsEquivalent,
    touchedFilesOutsideOwnership,
    type WorkerBranchState,
    type WorkerReportOutcome,
} from '@adhdev/mesh-shared';

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
// Direct imports (B4): the boot-time sinks existed only to break a boot
// ordering dependency the staged boot no longer has. Both are only called at
// report time, so the worker-handoff-notes ↔ worker-report cycle is safe.
import { storeHandoffNote } from './worker-handoff-notes.js';
import { commitTaskTerminal } from './mesh-task-terminal.js';
import { isTaskReadonly } from './mesh-work-queue.js';
import { meshRecord } from './mesh-record.js';
import { getActiveTurnLedger } from './turn-ledger/active-ledger.js';
import { observeAcceptedWorkerReport } from './turn-ledger/worker-report-evidence.js';
import { exchangeWorkerSessionBind, verifyWorkerTaskToken, type WorkerTokenExchangeResult } from './worker-mcp-isolation.js';
import type { WorkerHandoffNotes, WorkerCompletionReport } from './worker-report-validation.js';
import { resolveLateWorkerIdentity, acceptLateWorkerCompletionReport } from './worker-report-late.js';

// ─── Report shapes ──────────────────────────────────────────────────────

/**
 * Outcome and branch-state vocabularies are declared ONCE in
 * `@adhdev/mesh-shared` (mesh-vocabulary.ts) so the MCP tool schema, this
 * validator and the coordinator prompt cannot drift apart. Re-exported under
 * their historical names for existing consumers.
 *
 * `WorkerBranchState` mirrors the coordinator operating rule that every touched
 * branch must land in exactly one bucket before a task counts as complete.
 * Declared by the worker because the worker is the only party that knows what
 * it actually did with the branch.
 */
export { WORKER_BRANCH_STATES, type WorkerBranchState, type WorkerReportOutcome };

/**
 * Ledger event kinds this module writes. Free-form TEXT column, so no migration
 * — but the names are part of the contract a reader greps for.
 */
export const WORKER_REPORT_EVENT_KIND = 'worker_tool_report';
export const WORKER_PROGRESS_EVENT_KIND = 'worker_progress_update';
export const WORKER_HANDOFF_EVENT_KIND = 'worker_handoff_note';

// ─── Prior-report lookup (shadowing guard) ──────────────────────────────

/**
 * What a worker already reported for a task, read back out of the ledger.
 *
 * ★Why this exists: a completion is emitted TWICE by two independent producers.
 * The worker's `report_completion` terminalizes the row immediately; the PTY
 * scrape then emits `agent:generating_completed` for the same turn seconds later
 * (measured: 25.4s). Both paths write a ledger entry and a coordinator message,
 * and the LATER one wins by arriving last — so the coordinator reads a truncated
 * screen scrape while the authoritative structured report sits in the ledger,
 * unread. The ledger was never wrong; the coordinator's view was.
 *
 * `mesh-event-forwarding.ts` already refuses to re-open a row "arriving after
 * worker_tool_report already terminalized" it on the hollow-completion requeue
 * path. This is the same predicate, made readable from the ledger-append and
 * coordinator-notify paths that never got the guard.
 */
interface PriorWorkerReport {
    taskId: string;
    attemptId: string;
    outcome: WorkerReportOutcome;
    /** The verbatim summary, when this daemon still holds the content row. */
    summary?: string;
    recordedAt: string;
}

/**
 * Look up the worker's own completion report for a task, if one was filed.
 *
 * Returns null when no report exists — which is the ordinary case for a worker
 * that never reached MCP, and the reason the PTY path must stay the fallback
 * rather than being replaced (design §4 "절반만 승격").
 */
export function findPriorWorkerReport(meshId: string, taskId: string): PriorWorkerReport | null {
    if (!meshId || !taskId) return null;
    let rows: ReturnType<ReturnType<MeshRuntimeStore['turnStore']>['listWorkerEventsForTask']>;
    try {
        rows = MeshRuntimeStore.getInstance().turnStore().listWorkerEventsForTask(meshId, taskId, WORKER_REPORT_EVENT_KIND);
    } catch {
        // A lookup failure must not turn into "no report" silently at a call
        // site that would then let the scrape win — callers treat null as
        // "unknown", and the scrape is still the documented fallback.
        return null;
    }
    const row = rows.pop();
    if (!row || !row.attemptId) return null;
    const payload = row.payload as { outcome?: unknown };
    const outcome = payload.outcome === 'completed' || payload.outcome === 'blocked' || payload.outcome === 'failed'
        ? payload.outcome
        : 'completed';
    const summary = readReportedSummary(meshId, taskId);
    return {
        taskId,
        attemptId: row.attemptId,
        outcome,
        ...(summary ? { summary } : {}),
        recordedAt: new Date(row.atMs).toISOString(),
    };
}

/**
 * Verbatim report summaries, keyed `${meshId}\0${taskId}`.
 *
 * ★The ledger row is content-free by design (§9.1) — it stores the summary's
 * LENGTH, not its text — so the text has to be held somewhere for the shadowing
 * guard to substitute it back in. This mirror is the same shape and lifetime as
 * the handoff-note mirror, and like it, it is bounded by the retention sweep.
 *
 * A miss is not a failure: the guard then suppresses the scrape's ledger append
 * without substituting a summary, which still beats letting a truncated scrape
 * overwrite the structured record.
 */
export const REPORTED_SUMMARY_STORE = new Map<string, { summary: string; recordedAtMs: number }>();

export function summaryKey(meshId: string, taskId: string): string {
    return `${meshId} ${taskId}`;
}

function readReportedSummary(meshId: string, taskId: string): string | undefined {
    return REPORTED_SUMMARY_STORE.get(summaryKey(meshId, taskId))?.summary;
}

/** Test-only reset. */
export function __resetReportedSummariesForTest(): void {
    REPORTED_SUMMARY_STORE.clear();
}

// ─── Identity resolution ────────────────────────────────────────────────

/**
 * Resolve a worker's credential — either a bind (the normal case) or an
 * already-held token — into the authoritative (meshId, taskId, attemptId,
 * sessionId).
 *
 * ★Fail-closed at every branch. A null return means "this caller has no proven
 * task", and every caller must treat it as a refusal rather than as "unknown,
 * proceed". §2.4 is the reason: the only thing separating this from the
 * spoofable `ADHDEV_COORDINATOR_SESSION_ID` is that the daemon minted the value
 * and verifies it here.
 */
export function resolveWorkerIdentity(credential: {
    token?: unknown;
    bind?: unknown;
}): WorkerTokenExchangeResult | null {
    // A directly-held token wins: it already names its own attempt, so there is
    // nothing to resolve and no window in which the session could have moved on.
    const direct = verifyWorkerTaskToken(credential.token);
    if (direct) {
        return {
            token: direct.token,
            meshId: direct.meshId,
            taskId: direct.taskId,
            ...(direct.attemptId ? { attemptId: direct.attemptId } : {}),
            sessionId: direct.sessionId || '',
            ...(direct.nodeId ? { nodeId: direct.nodeId } : {}),
        };
    }
    return exchangeWorkerSessionBind(credential.bind, resolveCurrentTaskForSession);
}

/**
 * "Which task is this session working on right now?"
 *
 * Reuses `findAssignedBySession` — the SAME lookup the completion-event path
 * uses. Sharing it is deliberate: if the report path resolved the session→task
 * question by a different rule than the event path, the two evidence sources
 * could attribute one turn to two different tasks, which is precisely the
 * misattribution class this feature exists to close.
 */
function resolveCurrentTaskForSession(
    meshId: string,
    sessionId: string,
): { taskId: string; attemptId?: string } | null {
    try {
        const entry = MeshRuntimeStore.getInstance().findAssignedBySession(meshId, sessionId);
        if (!entry?.id) return null;
        return {
            taskId: entry.id,
            ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
        };
    } catch {
        return null;
    }
}

// ─── Ledger fence (C-W8) ────────────────────────────────────────────────

/** `ok` = the report may commit; otherwise the typed causal refusal (the retired reducer's vocabulary). */
type WorkerReportFence = 'ok' | 'unknown_attempt' | 'stale_attempt' | 'session_mismatch' | 'already_terminal';

/**
 * The worker report's causal fence over the turn ledger's `turn_attempts`.
 * Mirrors the retired Stage-5 `proposeTurnCompletion` checks: the attempt must
 * exist for this task, be the task's CURRENT (highest attempt_no) attempt, belong
 * to the reporting session, and — when the ledger already committed it — carry
 * the same outcome (a same-outcome re-report is an idempotent `ok`).
 */
export function fenceWorkerReportOnLedger(
    store: MeshRuntimeStore,
    identity: { meshId: string; taskId: string; attemptId?: string; sessionId?: string },
    terminalStatus: 'completed' | 'failed',
): WorkerReportFence {
    const turns = store.turnStore();
    const current = turns.findLatestAttemptForTask(identity.meshId, identity.taskId);
    // A token minted without an attempt id (pre-ledger path) speaks for the
    // task's current attempt; one WITH an id must name exactly that attempt.
    const attempt = identity.attemptId ? turns.getAttempt(identity.attemptId) : current;
    if (!attempt || attempt.meshId !== identity.meshId || attempt.taskId !== identity.taskId) return 'unknown_attempt';
    if (current && current.attemptId !== attempt.attemptId) return 'stale_attempt';
    if (identity.sessionId && attempt.sessionId && !sessionIdsEquivalent(identity.sessionId, attempt.sessionId)) return 'session_mismatch';
    if (attempt.terminal && attempt.terminal.outcome !== terminalStatus) return 'already_terminal';
    return 'ok';
}

// ─── Report acceptance ──────────────────────────────────────────────────

export type WorkerReportRefusal =
    /** No valid token/bind, or the session holds no assigned task. */
    | 'unauthenticated'
    /** The reducer refused on causal grounds — its typed reason is carried through. */
    | 'rejected_by_reducer'
    /** The task id no longer resolves to a queue row. */
    | 'unknown_task'
    /**
     * The report could not be PERSISTED. Distinct from a reducer rejection: the
     * report was causally fine, the write failed. A worker that sees this should
     * re-call, because nothing was recorded — which is precisely what the old
     * `accepted: true`-on-write-failure path made impossible to know.
     */
    | 'storage_failed'
    /**
     * `touchedFiles` was supplied on a task declared read-only, or omitted on a
     * code-changing task. Carried as a refusal rather than a validation error
     * because the read-only bit is only knowable after identity resolution.
     */
    | 'invalid_for_task_mode'
    /**
     * Durable delivery: the report carries a `reportedAtMs` that predates every attempt
     * this session could still take it for — it was written before the session's
     * CURRENT task was dispatched, and the attempt it belonged to is no longer within the
     * late-report window (or the report is older than the delivery window). Refused
     * rather than filed against the wrong task.
     */
    | 'stale_report';

export type WorkerReportResult =
    | {
        accepted: true;
        taskId: string;
        attemptId?: string;
        outcome: WorkerReportOutcome;
        /** True when this exact terminal was already committed — an idempotent re-call. */
        duplicate: boolean;
        handoffNoteRecorded: boolean;
        /** Why the note did not persist, when `handoffNoteRecorded` is false. */
        handoffNoteError?: string;
        /**
         * H1 (path ownership, wiring-unification Phase H — docs/design/2026-09-23-wiring-
         * unification.md §7c): present only when the task carried a declared `owned_paths`
         * AND `report.touchedFiles` touched something outside it. Surfaced as EVIDENCE, never
         * a rejection — the completion above still commits unconditionally. Absent when the
         * task declared no owned_paths (opt-out) or every touched file was covered.
         */
        ownedPathsMismatch?: { declared: string[]; touched: string[]; undeclaredTouched: string[] };
        /**
         * F7b: the report arrived after the ledger had already terminalized the
         * attempt (within `WORKER_LATE_REPORT_GRACE_MS`). Recorded as evidence and
         * surfaced to the coordinator once; the terminal state is unchanged.
         */
        late?: { terminalOutcome: string };
    }
    | { accepted: false; refusal: WorkerReportRefusal; detail?: string };

/**
 * Sink for handoff-note CONTENT. Injected (rather than imported) because the
 * seqscribe node lives on the daemon and this module must stay callable from
 * tests and from a daemon with seqscribe disabled.
 *
 * ★The content never goes into `turn_events`: `safeEvidenceJson` flattens
 * any object to the literal string '[object]', and more importantly the ledger
 * is the META index by design (§9.1) — ids, times, hashes, counts. Free-text
 * intent is content class and belongs in the content-class topic.
 */
type HandoffNoteSink = (note: {
    meshId: string;
    taskId: string;
    attemptId?: string;
    sessionId?: string;
    nodeId?: string;
    notes: WorkerHandoffNotes;
    recordedAtIso: string;
}) => void;

/** `undefined` = the production sink (`storeHandoffNote`); `null` = disabled. TESTS set it. */
let handoffSinkOverride: HandoffNoteSink | null | undefined;

/**
 * TESTS ONLY — replace the handoff-note content sink (`null` disables it,
 * `undefined` restores production). Wiring-unification B4 deleted the boot-time
 * `configureHandoffNoteSink`: production imports `storeHandoffNote` directly.
 */
export function __setHandoffNoteSinkForTests(sink: HandoffNoteSink | null | undefined): void {
    handoffSinkOverride = sink;
}

function currentHandoffSink(): HandoffNoteSink | null {
    return handoffSinkOverride === undefined ? storeHandoffNote : handoffSinkOverride;
}

/**
 * The `touchedFiles` rule that depends on the TASK, not on the payload shape.
 *
 * Three axes, and conflating any two of them is what produced the measured
 * damage (preview rc.40, task 441a2f87 — a pure inspection task that was not
 * declared read-only got refused on BOTH its completion and its attempt to
 * explain the refusal):
 *
 *   - read-only task + non-empty touchedFiles ⇒ REFUSE, regardless of outcome.
 *     The task mode says the worker was not supposed to change anything; a
 *     file list contradicts its own report, and letting it through records a
 *     change nobody authorized. This is unconditional — a `blocked` or
 *     `failed` report making the same false claim is just as wrong.
 *
 *   - `blocked` / `failed` on a code-changing task ⇒ NEVER require
 *     touchedFiles. A worker that could not do the work has nothing to list;
 *     refusing its report — which is precisely what happened to task
 *     441a2f87's `blocked` follow-up — hides the blocker from the coordinator
 *     instead of recording it. The original requirement below applies to
 *     `completed` only: that is the outcome for which "what did you touch"
 *     is actually answerable.
 *
 *   - `completed` on a code-changing task:
 *       - touchedFiles MISSING entirely (no top-level key, no handoffNotes)
 *         ⇒ REFUSE, naming the exact wire field so the worker's next call
 *         succeeds instead of guessing.
 *       - touchedFiles an EXPLICIT `[]` (top-level and/or
 *         handoffNotes.touchedFiles) ⇒ ACCEPT. That is the worker's
 *         statement "I changed nothing", which is a real and useful answer —
 *         refusing it is what drove a read-only-shaped worker to invent a
 *         placeholder path just to get an empty list past this gate.
 *
 * Returns a human-readable reason, or null when the report is consistent.
 *
 * ★Fails OPEN when the task row cannot be read. A queue-lookup failure is not
 * evidence the report is wrong, and refusing on it would make an unrelated
 * storage hiccup look like a worker error — the report path's job is to record
 * what the worker said, not to invent refusals.
 */
export function checkReportAgainstTaskMode(
    identity: WorkerTokenExchangeResult,
    report: WorkerCompletionReport,
): string | null {
    let task: { readonly?: boolean; taskMode?: string } | null | undefined;
    try {
        task = MeshRuntimeStore.getInstance().findQueueEntryById(identity.meshId, identity.taskId);
    } catch {
        return null;
    }
    if (!task) return null;

    const readonly = isTaskReadonly(task);
    const declaredFiles = [
        ...(report.touchedFiles || []),
        ...(report.handoffNotes?.touchedFiles || []),
    ];

    // Unconditional: a file list on a read-only task is a contradiction no
    // matter what outcome the worker reports.
    if (readonly) {
        if (declaredFiles.length) {
            return `task ${identity.taskId} is read-only (taskMode=${task.taskMode || 'readonly'}) but the report declares `
                + `${declaredFiles.length} touched file(s) — a read-only task must report an empty touchedFiles. `
                + 'If you did change files, this task was the wrong place to do it; say so in `summary` and report `blocked`.';
        }
        return null;
    }

    // Code-changing task, outcome 'blocked'/'failed': nothing to list. A
    // worker reporting it could not finish has no touched-file obligation —
    // requiring one here is what turned a refusal explanation into a second
    // refusal.
    if (report.outcome !== 'completed') return null;

    // Code-changing task, outcome 'completed': the file list is what matches
    // this work to future tasks (and to H1 path-ownership), so SOME statement
    // about it must be PRESENT — but present-and-empty is an answer, not a
    // violation. "Present" means either the top-level `touchedFiles` key or a
    // `handoffNotes` object was sent at all (handoffNotes, when sent, always
    // carries a touchedFiles array — `[]` included — because the schema
    // validator requires that key whenever handoffNotes is present).
    const topLevelProvided = report.touchedFiles !== undefined;
    const noteFilesProvided = report.handoffNotes !== undefined;
    if (!topLevelProvided && !noteFilesProvided) {
        return `task ${identity.taskId} changes code, so it must report touchedFiles — send the wire field `
            + '`touched_files` (top-level array; `[]` is acceptable if you changed nothing) and call again.';
    }
    return null;
}

/**
 * Accept a validated worker completion report.
 *
 * Order matters and is not arbitrary:
 *   1. identity — no proven task ⇒ refuse before touching any state.
 *   2. ledger evidence row — recorded even if the terminal is later refused, so
 *      "the worker DID report" survives a rejection. Diagnosing a rejected
 *      report is impossible if the report itself left no trace.
 *   3. handoff note — stored before the terminal flip, because the flip expires
 *      the token and can trigger downstream dispatch that WANTS this note.
 *   4. terminal — through the chokepoint, which fences and flips the row.
 */
export function acceptWorkerCompletionReport(
    credential: { token?: unknown; bind?: unknown },
    report: WorkerCompletionReport,
    opts: { nowMs?: number; isSelfDaemon?: (daemonId: string) => boolean; reportedAtMs?: unknown } = {},
): WorkerReportResult {
    const nowMs = opts.nowMs ?? Date.now();
    const reportedAt = normalizeWorkerReportedAtMs(opts.reportedAtMs, nowMs);
    if (reportedAt === 'too_old') {
        return {
            accepted: false,
            refusal: 'stale_report',
            detail: `the report was written more than ${Math.round(WORKER_REPORT_MAX_DELIVERY_DELAY_MS / 60_000)} min ago`,
        };
    }
    const live = resolveWorkerIdentity(credential);
    // Durable delivery: a report written before the session was handed its CURRENT task
    // belongs to the attempt that was live when it was written — never to the current one.
    const liveIsNewer = !!live && reportedAt !== undefined && workerIdentityPostdates(live, reportedAt);
    if (live && !liveIsNewer) return acceptWorkerCompletionReportForIdentity(live, report, { ...opts, nowMs });
    // F7b: the task went terminal before the report arrived (a completion flush
    // that beat a pending MCP call). A recently-terminal attempt still takes it.
    const late = resolveLateWorkerIdentity(credential, nowMs, opts.isSelfDaemon, reportedAt);
    if (late) return acceptLateWorkerCompletionReport(late, report, nowMs);
    if (liveIsNewer) {
        return {
            accepted: false,
            refusal: 'stale_report',
            detail: `the report predates task ${live!.taskId}, which this session holds now, and the attempt it was written for is no longer open to a late report`,
        };
    }
    return { accepted: false, refusal: 'unauthenticated' };
}

/**
 * How long after it was WRITTEN a queued worker report is still accepted. The mcp-server's
 * durable outbox (mcp-server worker-report-outbox.ts, same value) stops retrying at this
 * age, so the two sides agree on when a report is abandoned. Two hours spans a daemon
 * overload or restart-free stall many times over while staying short of the point where a
 * report is more likely a confused replay than a delayed delivery.
 */
export const WORKER_REPORT_MAX_DELIVERY_DELAY_MS = 2 * 60 * 60 * 1000;

/** Tolerated clock drift for a client-stamped `reportedAtMs` in the future (same machine in practice). */
const WORKER_REPORT_CLOCK_SKEW_MS = 5_000;

/**
 * Normalize the client-stamped creation time of a report/note. `undefined` = absent or
 * unusable (an older client, a non-number, a time in the future) — the caller then behaves
 * exactly as before this field existed. `'too_old'` = beyond the delivery window.
 *
 * ★The value is caller-asserted. That is acceptable for the same reason the bind is: it can
 * only move a report between attempts of the caller's OWN session, and only toward the
 * attempt that was live at the claimed time — it cannot reach another session's task.
 */
export function normalizeWorkerReportedAtMs(raw: unknown, nowMs: number): number | undefined | 'too_old' {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
    if (raw > nowMs + WORKER_REPORT_CLOCK_SKEW_MS) return undefined;
    if (nowMs - raw > WORKER_REPORT_MAX_DELIVERY_DELAY_MS) return 'too_old';
    return raw;
}

/** Was this identity's attempt dispatched AFTER `atMs` (so a report written at `atMs` cannot be for it)? */
export function workerIdentityPostdates(identity: WorkerTokenExchangeResult, atMs: number): boolean {
    try {
        const turns = MeshRuntimeStore.getInstance().turnStore();
        const attempt = identity.attemptId
            ? turns.getAttempt(identity.attemptId)
            : turns.findLatestAttemptForTask(identity.meshId, identity.taskId);
        return !!attempt && attempt.acceptedAt > atMs;
    } catch {
        return false;
    }
}

/**
 * Does this daemon itself hold the worker's task — live, or recently terminal?
 * `false` is what sends the command layer to the remote-owner path (F7).
 */
export function hasLocalWorkerIdentity(
    credential: { token?: unknown; bind?: unknown },
    opts: { nowMs?: number; isSelfDaemon?: (daemonId: string) => boolean; reportedAtMs?: unknown } = {},
): boolean {
    const nowMs = opts.nowMs ?? Date.now();
    const reportedAt = normalizeWorkerReportedAtMs(opts.reportedAtMs, nowMs);
    return !!resolveWorkerIdentity(credential)
        || !!resolveLateWorkerIdentity(credential, nowMs, opts.isSelfDaemon, reportedAt === 'too_old' ? undefined : reportedAt);
}

/**
 * The acceptance body, once identity is PROVEN. Shared by the local path
 * (bind/token resolved on this daemon) and the forwarded path (F7: a remote
 * worker's report, re-resolved against this — the owning — daemon's queue row,
 * ledger attempt and mesh roster by `resolveForwardedWorkerIdentity`). One body means a
 * forwarded report records exactly the rows a local one does.
 */
export function acceptWorkerCompletionReportForIdentity(
    identity: WorkerTokenExchangeResult,
    report: WorkerCompletionReport,
    opts: { nowMs?: number },
): WorkerReportResult {
    // ★F6: the read-only axis is only knowable HERE. `validateWorkerCompletionReport`
    // sees the raw payload and no task, so it cannot tell a read-only verification
    // task (which touches nothing by definition) from a code change that forgot to
    // declare its files. Deciding it post-identity is what lets both halves be
    // enforced instead of neither: measured, a read-only worker wrote the literal
    // placeholder "N/A (read-only verification task, no files touched)" into
    // handoffNotes.touchedFiles to satisfy the blanket requirement — a string that
    // is not a path, stored as one, poisoning the enclosure matching key.
    const taskModeError = checkReportAgainstTaskMode(identity, report);
    if (taskModeError) {
        return { accepted: false, refusal: 'invalid_for_task_mode', detail: taskModeError };
    }

    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const store = MeshRuntimeStore.getInstance();

    // ★Hold the verbatim summary for the shadowing guard (findPriorWorkerReport).
    // Written BEFORE the terminal commit: the commit can synchronously trigger
    // downstream dispatch, and a late PTY completion for this same turn must find
    // the authoritative text already present rather than racing it.
    REPORTED_SUMMARY_STORE.set(summaryKey(identity.meshId, identity.taskId), {
        summary: report.summary,
        recordedAtMs: nowMs,
    });

    // (1b) C-W8: the causal fence on the TURN LEDGER (the legacy Stage-5
    // proposeTurnCompletion fence is retired). A report is a better SUMMARY,
    // never a stronger claim on the attempt: it must name the task's CURRENT
    // attempt, from that attempt's session, and may not flip an attempt the
    // ledger already committed to a different outcome. An unknown attempt has
    // no row to hang the evidence on, so it is refused before anything is written.
    const terminalStatus = report.outcome === 'completed' ? 'completed' : 'failed';
    let fence: WorkerReportFence;
    try {
        fence = fenceWorkerReportOnLedger(store, identity, terminalStatus);
    } catch (e: any) {
        return { accepted: false, refusal: 'rejected_by_reducer', detail: e?.message || String(e) };
    }
    if (fence === 'unknown_attempt') return { accepted: false, refusal: 'rejected_by_reducer', detail: fence };

    // (2) Evidence row — content-free. The summary is NOT stored here; only its
    // length and the structured facts. The summary itself reaches the
    // coordinator through the completion envelope below.
    const evidenceAttemptId = identity.attemptId
        ?? store.turnStore().findLatestAttemptForTask(identity.meshId, identity.taskId)?.attemptId;
    let evidenceRecorded = !evidenceAttemptId;
    if (evidenceAttemptId) {
        try {
            evidenceRecorded = store.turnStore().insertWorkerEvent({
                eventId: randomUUID(),
                attemptId: evidenceAttemptId,
                sessionId: identity.sessionId ?? null,
                kind: WORKER_REPORT_EVENT_KIND,
                // UNIQUE(attempt_id, generation, kind, dedupe_key) makes a re-call for
                // the same outcome insert-once, matching the reducer's own idempotency.
                dedupeKey: report.outcome,
                payload: {
                    outcome: report.outcome,
                    summaryLength: report.summary.length,
                    touchedFileCount: report.touchedFiles?.length ?? 0,
                    blockerCount: report.blockers?.length ?? 0,
                    hasHandoffNotes: !!report.handoffNotes,
                    ...(report.branchState ? { branchState: report.branchState } : {}),
                },
                atMs: nowMs,
            });
        } catch (e: any) {
            // ★F7: a throw here means the evidence row is GONE — the row that
            // proves "the worker did report" and that the shadowing guard reads
            // back. Returning accepted:true anyway told the worker its report
            // landed while leaving no trace of it, which is the silent-success
            // class this module exists to remove. `false` (INSERT OR IGNORE hit
            // the UNIQUE key) is NOT a failure — that is the idempotent re-call
            // the dedupeKey was chosen to produce, so it must not be conflated.
            LOG.error('WorkerReport', `Failed to record report evidence for task ${identity.taskId}: ${e?.message || e}`);
            evidenceRecorded = false;
        }
        if (!evidenceRecorded) {
            // A duplicate insert still means the row exists; only a genuine
            // write failure reaches here with the row absent.
            const existing = findPriorWorkerReport(identity.meshId, identity.taskId);
            if (!existing) {
                return {
                    accepted: false,
                    refusal: 'storage_failed',
                    detail: `could not persist the report evidence row for task ${identity.taskId}`,
                };
            }
            evidenceRecorded = true;
        }
    }

    // (3) Handoff note. ★F5: `handoffNoteRecorded` now reflects whether the note
    // was actually PERSISTED. It used to return true after skipping the insert
    // (no attemptId) and after swallowing a sink throw, which is what put
    // "Handoff note stored — it will be delivered to related future tasks
    // automatically." in front of a worker whose note was not stored.
    let handoffNoteRecorded = false;
    let handoffNoteError: string | null = null;
    if (report.handoffNotes) {
        const noteResult = recordHandoffNote(identity, report.handoffNotes, nowMs, nowIso);
        handoffNoteRecorded = noteResult.recorded;
        handoffNoteError = noteResult.error;
    }

    // (4) Terminal. 'blocked' is NOT a terminal outcome the ledger knows — it
    // maps to 'failed' with a reason, because a blocked task genuinely did not
    // succeed and must not unblock its dependents as though it had. The blockers list
    // carries the why, and the coordinator reads it from the envelope.
    if (fence !== 'ok') return { accepted: false, refusal: 'rejected_by_reducer', detail: fence };
    let commit: ReturnType<typeof commitTaskTerminal>;
    try {
        commit = commitTaskTerminal({
            meshId: identity.meshId,
            taskId: identity.taskId,
            status: terminalStatus,
            ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
            ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
            occurredAtMs: nowMs,
            // The causal checks ran above (fenceWorkerReportOnLedger) — a valid
            // token buys no exemption from stale-attempt or session-mismatch.
            source: 'worker_tool_report',
            reason: report.outcome === 'blocked'
                ? `worker_reported_blocked:${(report.blockers || []).length}`
                : `worker_reported:${report.outcome}`,
            envelope: {
                finalSummary: report.summary,
                ...(report.touchedFiles?.length ? { artifacts: { touchedFiles: report.touchedFiles } } : {}),
                evidence: {
                    // The grade this report earns (design §4 등급표): declared by
                    // the worker, so it is complete by construction and carries
                    // no truncation risk the way a screen scrape does.
                    summarySource: 'tool_report',
                    mayBeTruncated: false,
                    reportedOutcome: report.outcome,
                    ...(report.branchState ? { branchState: report.branchState } : {}),
                    ...(report.blockers?.length ? { blockers: report.blockers.join('; ') } : {}),
                },
                ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
                completedAt: nowIso,
            },
        });
    } catch (e: any) {
        LOG.warn('WorkerReport', `Terminal commit threw for task ${identity.taskId}: ${e?.message || e}`);
        return { accepted: false, refusal: 'rejected_by_reducer', detail: e?.message || String(e) };
    }

    if (!commit.committed) {
        return { accepted: false, refusal: 'unknown_task', detail: `no queue row for task ${identity.taskId}` };
    }

    // (5) Design §F2: the report is the primary completion evidence — the turn
    // ledger reduces it (R17 commit after the idle edge; R17g record + await_end
    // while still generating). AFTER the queue commit above, so that commit's
    // output version (report envelope) is the one persisted; the ledger's own
    // task_terminal then hits the replay fence. Best-effort: the report is
    // already accepted, and without a ledger the idle end still commits.
    const ledger = getActiveTurnLedger();
    if (ledger) {
        try {
            observeAcceptedWorkerReport(ledger, {
                meshId: identity.meshId,
                taskId: identity.taskId,
                ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
                ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                outcome: report.outcome,
                summary: report.summary,
                hasHandoffNotes: !!report.handoffNotes,
                touchedFileCount: report.touchedFiles?.length ?? 0,
                ...(report.branchState ? { branchState: report.branchState } : {}),
                atMs: nowMs,
            });
        } catch (e: any) {
            LOG.warn('WorkerReport', `Turn-ledger observe of the report for task ${identity.taskId} failed: ${e?.message || e}`);
        }
    }

    // H1 (path ownership): compare the worker's reported touchedFiles against the
    // task's declared owned_paths (if any). Best-effort and purely additive — a
    // lookup/parse failure here must never turn an otherwise-accepted completion
    // into a refusal, so any error just omits the mismatch field.
    let ownedPathsMismatch: { declared: string[]; touched: string[]; undeclaredTouched: string[] } | undefined;
    try {
        const taskEntry = store.findQueueEntryById(identity.meshId, identity.taskId);
        const owned = taskEntry?.ownedPaths;
        if (owned && owned.paths.length > 0) {
            const touched = [...(report.touchedFiles || []), ...(report.handoffNotes?.touchedFiles || [])];
            const { undeclaredTouched } = touchedFilesOutsideOwnership(touched, owned);
            if (undeclaredTouched.length > 0) {
                ownedPathsMismatch = {
                    declared: owned.paths.map(p => p.subtree ? `${p.path}/**` : p.path),
                    touched,
                    undeclaredTouched: [...undeclaredTouched],
                };
                // Scalars only (task id, counts) — never the path text itself, matching
                // the server content-boundary discipline this module's evidence rows
                // already follow (see the "content-free" notes above).
                try {
                    meshRecord(identity.meshId, 'ownership_violation', {
                        ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
                        ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                        payload: {
                            taskId: identity.taskId,
                            declaredCount: ownedPathsMismatch.declared.length,
                            touchedCount: ownedPathsMismatch.touched.length,
                            undeclaredTouchedCount: ownedPathsMismatch.undeclaredTouched.length,
                        },
                    }, { local: true });
                } catch { /* diagnostics must never break an accepted report */ }
            }
        }
    } catch { /* best-effort — see comment above */ }

    LOG.info(
        'WorkerReport',
        `Accepted ${report.outcome} report for task ${identity.taskId}`
        + (identity.attemptId ? ` attempt ${identity.attemptId}` : '')
        + (commit.duplicate ? ' (duplicate replay)' : '')
        + (handoffNoteRecorded ? ' with handoff note' : ''),
    );

    return {
        accepted: true,
        taskId: identity.taskId,
        ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
        outcome: report.outcome,
        duplicate: commit.duplicate,
        handoffNoteRecorded,
        // ★The completion itself still stands — the terminal committed, and
        // discarding a valid completion because its optional note failed would
        // trade a small loss for a large one. But the worker is TOLD, so it can
        // put the context somewhere else rather than believing it was filed.
        ...(handoffNoteError ? { handoffNoteError } : {}),
        ...(ownedPathsMismatch ? { ownedPathsMismatch } : {}),
    };
}

export function recordHandoffNote(
    identity: WorkerTokenExchangeResult,
    notes: WorkerHandoffNotes,
    nowMs: number,
    nowIso: string,
): { recorded: boolean; error: string | null } {
    // ★F5: no attemptId means the META INDEX ROW cannot be written, and that row
    // is the only thing selectRelevantHandoffNotes queries. Storing the text with
    // no index produces a note that exists and can never be delivered — so this
    // is a failure, reported as one, rather than the `true` it used to return.
    if (!identity.attemptId) {
        return {
            recorded: false,
            error: `task ${identity.taskId} has no active attempt, so the note has no index row and could never be delivered`,
        };
    }

    // Meta index row: WHO/WHEN/WHAT-FILES, no free text. The touched-file list is
    // stored here (and not only in the topic) because it is the lookup key for
    // auto-enclosure — an index nobody can query is not an index. File paths are
    // identifiers, not authored prose, so this stays within the ledger's
    // meta-only rule.
    {
        try {
            MeshRuntimeStore.getInstance().turnStore().insertWorkerEvent({
                eventId: randomUUID(),
                attemptId: identity.attemptId,
                sessionId: identity.sessionId ?? null,
                kind: WORKER_HANDOFF_EVENT_KIND,
                dedupeKey: '',
                payload: {
                    touchedFiles: notes.touchedFiles,
                    intentLength: notes.intent.length,
                    hasConflictGuidance: !!notes.conflictGuidance,
                    followUpCount: notes.followUps?.length ?? 0,
                    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                    ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
                },
                atMs: nowMs,
            });
        } catch (e: any) {
            LOG.error('WorkerReport', `Failed to index handoff note for task ${identity.taskId}: ${e?.message || e}`);
            return { recorded: false, error: `handoff note index write failed: ${e?.message || e}` };
        }
    }

    // Content goes to the sink (content-class seqscribe topic). A missing sink is
    // NOT an error — a daemon without seqscribe still gets the meta index and the
    // auto-enclosure below reads intent from the note store, so the feature
    // degrades rather than failing the report.
    const handoffSink = currentHandoffSink();
    if (handoffSink) {
        try {
            handoffSink({
                meshId: identity.meshId,
                taskId: identity.taskId,
                ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
                ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
                notes,
                recordedAtIso: nowIso,
            });
        } catch (e: any) {
            // ★F5: the sink is what persists the note TEXT. A throw here leaves
            // an index row pointing at nothing, so enclosure will skip it — the
            // note is effectively lost and the worker must be told, not thanked.
            LOG.error('WorkerReport', `Handoff note sink threw for task ${identity.taskId}: ${e?.message || e}`);
            return { recorded: false, error: `handoff note text could not be stored: ${e?.message || e}` };
        }
    }
    return { recorded: true, error: null };
}
