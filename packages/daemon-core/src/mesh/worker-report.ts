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
    WORKER_REPORT_OUTCOMES,
    isWorkerReportOutcome,
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
import { queueWorkerProgressNotice } from './worker-progress-notify.js';
import { commitTaskTerminalAndAdvanceGraph } from './mesh-graph-transition-runner.js';
import { isTaskReadonly } from './mesh-work-queue.js';
import { meshRecord } from './mesh-record.js';
import {
    exchangeWorkerSessionBind,
    verifyWorkerTaskToken,
    type WorkerTokenExchangeResult,
} from './worker-mcp-isolation.js';

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

export interface WorkerHandoffNotes {
    /** What the change was FOR — the thing a diff cannot say. */
    intent: string;
    /** How to resolve a conflict against this change, in the author's own terms. */
    conflictGuidance?: string;
    touchedFiles: string[];
    followUps?: string[];
}

export interface WorkerCompletionReport {
    outcome: WorkerReportOutcome;
    summary: string;
    handoffNotes?: WorkerHandoffNotes;
    touchedFiles?: string[];
    branchState?: WorkerBranchState;
    blockers?: string[];
}

/**
 * Ledger event kinds this module writes. Free-form TEXT column, so no migration
 * — but the names are part of the contract a reader greps for.
 */
export const WORKER_REPORT_EVENT_KIND = 'worker_tool_report';
export const WORKER_PROGRESS_EVENT_KIND = 'worker_progress_update';
export const WORKER_HANDOFF_EVENT_KIND = 'worker_handoff_note';

/** Caps. Oversized input is REJECTED, never silently clipped (see validate below). */
export const WORKER_SUMMARY_MAX_CHARS = 8_000;
export const WORKER_INTENT_MAX_CHARS = 4_000;
export const WORKER_GUIDANCE_MAX_CHARS = 4_000;
export const WORKER_TOUCHED_FILES_MAX = 200;
export const WORKER_LIST_ITEM_MAX_CHARS = 500;
export const WORKER_BLOCKERS_MAX = 50;
export const WORKER_FOLLOW_UPS_MAX = 50;

// ─── Validation ─────────────────────────────────────────────────────────

export interface WorkerReportValidationError {
    field: string;
    message: string;
}

/**
 * Validate a raw tool payload into a `WorkerCompletionReport`.
 *
 * ★Rejects rather than coerces, and that is the point of decision B. The whole
 * reason the report beats a screen scrape is that its shape is GUARANTEED; a
 * validator that quietly truncated an over-long summary, or dropped an
 * unrecognized `branchState`, would reintroduce exactly the "the value looks
 * fine and is silently wrong" failure the scrape already had. An `isError`
 * response is cheap — the worker is an LLM holding the correct value, and it
 * will fix and re-call.
 *
 * ★Unknown keys are rejected too, same rule as `rejectUnknownMeshToolArgs`: a
 * misspelled `handoff_notes` that is silently ignored produces a report that
 * looks complete and has lost its notes.
 */
export function validateWorkerCompletionReport(raw: unknown): {
    report?: WorkerCompletionReport;
    errors: WorkerReportValidationError[];
} {
    const errors: WorkerReportValidationError[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { errors: [{ field: '', message: 'report must be an object' }] };
    }
    const input = raw as Record<string, unknown>;

    const KNOWN = new Set(['outcome', 'summary', 'handoffNotes', 'touchedFiles', 'branchState', 'blockers']);
    for (const key of Object.keys(input)) {
        if (!KNOWN.has(key)) {
            errors.push({ field: key, message: `unknown field '${key}' (expected one of: ${[...KNOWN].join(', ')})` });
        }
    }

    const outcome = input.outcome;
    if (!isWorkerReportOutcome(outcome)) {
        errors.push({ field: 'outcome', message: `outcome must be one of ${WORKER_REPORT_OUTCOMES.map((o) => `'${o}'`).join(' | ')}` });
    }

    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!summary) {
        errors.push({ field: 'summary', message: 'summary is required and must be a non-empty string' });
    } else if (summary.length > WORKER_SUMMARY_MAX_CHARS) {
        errors.push({
            field: 'summary',
            message: `summary is ${summary.length} chars, over the ${WORKER_SUMMARY_MAX_CHARS} limit — shorten it rather than relying on truncation`,
        });
    }

    const touchedFiles = validateStringList(input.touchedFiles, 'touchedFiles', WORKER_TOUCHED_FILES_MAX, errors);
    const blockers = validateStringList(input.blockers, 'blockers', WORKER_BLOCKERS_MAX, errors);

    if (input.branchState !== undefined && !WORKER_BRANCH_STATES.includes(input.branchState as WorkerBranchState)) {
        errors.push({
            field: 'branchState',
            message: `branchState must be one of: ${WORKER_BRANCH_STATES.join(', ')}`,
        });
    }

    let handoffNotes: WorkerHandoffNotes | undefined;
    if (input.handoffNotes !== undefined) {
        const notes = input.handoffNotes;
        if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
            errors.push({ field: 'handoffNotes', message: 'handoffNotes must be an object' });
        } else {
            const n = notes as Record<string, unknown>;
            const KNOWN_NOTES = new Set(['intent', 'conflictGuidance', 'touchedFiles', 'followUps']);
            for (const key of Object.keys(n)) {
                if (!KNOWN_NOTES.has(key)) {
                    errors.push({ field: `handoffNotes.${key}`, message: `unknown field '${key}'` });
                }
            }
            const intent = typeof n.intent === 'string' ? n.intent.trim() : '';
            if (!intent) {
                errors.push({ field: 'handoffNotes.intent', message: 'intent is required — it is the part a diff cannot convey' });
            } else if (intent.length > WORKER_INTENT_MAX_CHARS) {
                errors.push({ field: 'handoffNotes.intent', message: `intent is over the ${WORKER_INTENT_MAX_CHARS} char limit` });
            }
            let guidance: string | undefined;
            if (n.conflictGuidance !== undefined) {
                if (typeof n.conflictGuidance !== 'string') {
                    errors.push({ field: 'handoffNotes.conflictGuidance', message: 'conflictGuidance must be a string' });
                } else if (n.conflictGuidance.trim().length > WORKER_GUIDANCE_MAX_CHARS) {
                    errors.push({ field: 'handoffNotes.conflictGuidance', message: `conflictGuidance is over the ${WORKER_GUIDANCE_MAX_CHARS} char limit` });
                } else {
                    guidance = n.conflictGuidance.trim() || undefined;
                }
            }
            const noteFiles = validateStringList(n.touchedFiles, 'handoffNotes.touchedFiles', WORKER_TOUCHED_FILES_MAX, errors);
            if (n.touchedFiles === undefined) {
                // Still required to be PRESENT: the touched-file set is the PRIMARY
                // relevance signal for auto-enclosure (design §5 판정 1), and a note
                // that omits the key entirely is one that never thought about it.
                //
                // ★But an EMPTY array is now accepted here, because emptiness is
                // only wrong for a code-changing task — and this validator cannot
                // see the task. checkReportAgainstTaskMode makes that call once
                // identity is resolved; see F6 there. Rejecting empty here is what
                // drove read-only workers to invent placeholder "paths".
                errors.push({
                    field: 'handoffNotes.touchedFiles',
                    message: 'touchedFiles is required — it is what matches this note to future work (use [] on a read-only task)',
                });
            }
            const followUps = validateStringList(n.followUps, 'handoffNotes.followUps', WORKER_FOLLOW_UPS_MAX, errors);
            if (intent && noteFiles) {
                handoffNotes = {
                    intent,
                    ...(guidance ? { conflictGuidance: guidance } : {}),
                    touchedFiles: noteFiles,
                    ...(followUps?.length ? { followUps } : {}),
                };
            }
        }
    }

    if (errors.length) return { errors };
    return {
        report: {
            outcome: outcome as WorkerReportOutcome,
            summary,
            ...(handoffNotes ? { handoffNotes } : {}),
            ...(touchedFiles?.length ? { touchedFiles } : {}),
            ...(input.branchState ? { branchState: input.branchState as WorkerBranchState } : {}),
            ...(blockers?.length ? { blockers } : {}),
        },
        errors: [],
    };
}

function validateStringList(
    value: unknown,
    field: string,
    max: number,
    errors: WorkerReportValidationError[],
): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        errors.push({ field, message: `${field} must be an array of strings` });
        return undefined;
    }
    if (value.length > max) {
        errors.push({ field, message: `${field} has ${value.length} entries, over the ${max} limit` });
        return undefined;
    }
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') {
            errors.push({ field, message: `${field} must contain only strings` });
            return undefined;
        }
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (trimmed.length > WORKER_LIST_ITEM_MAX_CHARS) {
            errors.push({ field, message: `${field} contains an entry over the ${WORKER_LIST_ITEM_MAX_CHARS} char limit` });
            return undefined;
        }
        out.push(trimmed);
    }
    return out;
}

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
export interface PriorWorkerReport {
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
const REPORTED_SUMMARY_STORE = new Map<string, { summary: string; recordedAtMs: number }>();

function summaryKey(meshId: string, taskId: string): string {
    return `${meshId} ${taskId}`;
}

function readReportedSummary(meshId: string, taskId: string): string | undefined {
    return REPORTED_SUMMARY_STORE.get(summaryKey(meshId, taskId))?.summary;
}

/** Drop reported summaries older than `maxAgeMs`. Mirrors the handoff sweep. */
export function pruneReportedSummaries(maxAgeMs: number, nowMs = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of REPORTED_SUMMARY_STORE) {
        if (nowMs - entry.recordedAtMs > maxAgeMs) {
            REPORTED_SUMMARY_STORE.delete(key);
            removed += 1;
        }
    }
    return removed;
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
export type WorkerReportFence = 'ok' | 'unknown_attempt' | 'stale_attempt' | 'session_mismatch' | 'already_terminal';

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
    | 'invalid_for_task_mode';

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
export type HandoffNoteSink = (note: {
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
 * Two halves of one axis, and enforcing only one of them is what produced the
 * measured damage:
 *   - read-only task + non-empty touchedFiles ⇒ REFUSE. The task mode says the
 *     worker was not supposed to change anything; a file list contradicts its
 *     own report, and letting it through records a change nobody authorized.
 *   - code-changing task + empty/absent touchedFiles ⇒ REFUSE. This is the
 *     original requirement, unchanged, now applied where it is actually true.
 *
 * Returns a human-readable reason, or null when the report is consistent.
 *
 * ★Fails OPEN when the task row cannot be read. A queue-lookup failure is not
 * evidence the report is wrong, and refusing on it would make an unrelated
 * storage hiccup look like a worker error — the report path's job is to record
 * what the worker said, not to invent refusals.
 */
function checkReportAgainstTaskMode(
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

    if (readonly) {
        if (declaredFiles.length) {
            return `task ${identity.taskId} is read-only (taskMode=${task.taskMode || 'readonly'}) but the report declares `
                + `${declaredFiles.length} touched file(s) — a read-only task must report an empty touchedFiles. `
                + 'If you did change files, this task was the wrong place to do it; say so in `summary` and report `blocked`.';
        }
        return null;
    }

    // Code-changing task: the file list is what matches this work to future
    // tasks, so an empty one is the same defect the validator used to catch.
    if (report.handoffNotes && !report.handoffNotes.touchedFiles.length) {
        return `task ${identity.taskId} changes code, so handoffNotes.touchedFiles must be non-empty — `
            + 'it is the key that delivers your note to whoever touches this code next.';
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
 *   4. terminal — through the chokepoint, which fences and advances the graph.
 */
export function acceptWorkerCompletionReport(
    credential: { token?: unknown; bind?: unknown },
    report: WorkerCompletionReport,
    opts: { nowMs?: number } = {},
): WorkerReportResult {
    const identity = resolveWorkerIdentity(credential);
    if (!identity) return { accepted: false, refusal: 'unauthenticated' };

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
    // succeed and must not advance the graph as though it had. The blockers list
    // carries the why, and the coordinator reads it from the envelope.
    if (fence !== 'ok') return { accepted: false, refusal: 'rejected_by_reducer', detail: fence };
    let commit: ReturnType<typeof commitTaskTerminalAndAdvanceGraph>;
    try {
        commit = commitTaskTerminalAndAdvanceGraph({
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

/**
 * Record a mid-task progress note. No terminal effect whatsoever — this exists
 * so a long-running worker can say something before it finishes, and so E-T0
 * (mailbox piggyback) has a tool response to ride on later.
 */
export function acceptWorkerProgressUpdate(
    credential: { token?: unknown; bind?: unknown },
    note: string,
    opts: { nowMs?: number } = {},
): {
    accepted: boolean;
    taskId?: string;
    refusal?: WorkerReportRefusal;
    detail?: string;
    /** Whether this note was judged worth paging the coordinator about (F3). */
    surfacedToCoordinator?: boolean;
} {
    const identity = resolveWorkerIdentity(credential);
    if (!identity) return { accepted: false, refusal: 'unauthenticated' };
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
    let recorded = false;
    try {
        recorded = MeshRuntimeStore.getInstance().turnStore().insertWorkerEvent({
            eventId: randomUUID(),
            attemptId: identity.attemptId,
            sessionId: identity.sessionId ?? null,
            kind: WORKER_PROGRESS_EVENT_KIND,
            // Distinct per call — progress updates are a SEQUENCE, unlike the
            // completion report where the UNIQUE constraint provides idempotency.
            dedupeKey: `${nowMs}`,
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

    // ★F3: surface the note to the coordinator. The ledger row above is
    // content-free (length only), so the TEXT rides this call and nothing else.
    // Filtered, not firehosed — see shouldSurfaceProgressToCoordinator.
    const surfaced = notifyCoordinatorOfProgress(identity, note, nowMs);
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
}) => void;

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
    try {
        sink({
            meshId: identity.meshId,
            taskId: identity.taskId,
            ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
            ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
            note: note.trim(),
            coordinatorMessage: buildWorkerProgressNotice({
                taskId: identity.taskId,
                nodeLabel: identity.nodeId || identity.sessionId || identity.taskId,
                note,
            }),
            nowMs,
        });
    } catch (e: any) {
        // Surfacing is an enhancement over the ledger row, which is already
        // written. It must never turn an accepted progress update into a refusal.
        LOG.warn('WorkerReport', `Failed to surface progress for task ${identity.taskId}: ${e?.message || e}`);
        return false;
    }
    PROGRESS_SURFACE_LAST_MS.set(key, nowMs);
    return true;
}

function recordHandoffNote(
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
