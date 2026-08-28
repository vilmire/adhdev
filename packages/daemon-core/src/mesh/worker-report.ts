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

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { commitTaskTerminalAndAdvanceGraph } from './mesh-graph-transition-runner.js';
import {
    exchangeWorkerSessionBind,
    verifyWorkerTaskToken,
    type WorkerTokenExchangeResult,
} from './worker-mcp-isolation.js';

// ─── Report shapes ──────────────────────────────────────────────────────

export type WorkerReportOutcome = 'completed' | 'blocked' | 'failed';

/**
 * Branch convergence state, mirroring the coordinator operating rule that every
 * touched branch must land in exactly one of these buckets before a task counts
 * as complete. Declared by the worker because the worker is the only party that
 * knows what it actually did with the branch.
 */
export type WorkerBranchState =
    | 'merged_to_main'
    | 'pushed_feature_branch_needs_merge'
    | 'blocked_review'
    | 'cleanup_candidate'
    | 'not_mergeable';

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

export const WORKER_BRANCH_STATES: readonly WorkerBranchState[] = [
    'merged_to_main',
    'pushed_feature_branch_needs_merge',
    'blocked_review',
    'cleanup_candidate',
    'not_mergeable',
];

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
    if (outcome !== 'completed' && outcome !== 'blocked' && outcome !== 'failed') {
        errors.push({ field: 'outcome', message: "outcome must be one of 'completed' | 'blocked' | 'failed'" });
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
            if (n.touchedFiles === undefined || !noteFiles?.length) {
                // Required: the touched-file set is the PRIMARY relevance signal
                // for auto-enclosure (design §5 판정 1). A note with no files can
                // never be matched to a later task, so it would be stored and
                // never delivered — worse than being told to supply one.
                errors.push({
                    field: 'handoffNotes.touchedFiles',
                    message: 'touchedFiles is required and must be non-empty — it is what matches this note to future work',
                });
            }
            const followUps = validateStringList(n.followUps, 'handoffNotes.followUps', WORKER_FOLLOW_UPS_MAX, errors);
            if (intent && noteFiles?.length) {
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

// ─── Report acceptance ──────────────────────────────────────────────────

export type WorkerReportRefusal =
    /** No valid token/bind, or the session holds no assigned task. */
    | 'unauthenticated'
    /** The reducer refused on causal grounds — its typed reason is carried through. */
    | 'rejected_by_reducer'
    /** The task id no longer resolves to a queue row. */
    | 'unknown_task';

export type WorkerReportResult =
    | {
        accepted: true;
        taskId: string;
        attemptId?: string;
        outcome: WorkerReportOutcome;
        /** True when this exact terminal was already committed — an idempotent re-call. */
        duplicate: boolean;
        handoffNoteRecorded: boolean;
    }
    | { accepted: false; refusal: WorkerReportRefusal; detail?: string };

/**
 * Sink for handoff-note CONTENT. Injected (rather than imported) because the
 * seqscribe node lives on the daemon and this module must stay callable from
 * tests and from a daemon with seqscribe disabled.
 *
 * ★The content never goes into `mesh_turn_events`: `safeEvidenceJson` flattens
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

let handoffSink: HandoffNoteSink | null = null;

/** Wire the content sink at daemon boot; pass null to disable (tests, no seqscribe). */
export function configureHandoffNoteSink(sink: HandoffNoteSink | null): void {
    handoffSink = sink;
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

    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const store = MeshRuntimeStore.getInstance();

    // (2) Evidence row — content-free. The summary is NOT stored here; only its
    // length and the structured facts. The summary itself reaches the
    // coordinator through the completion envelope below.
    if (identity.attemptId) {
        try {
            store.insertTurnEvent({
                eventId: randomUUID(),
                meshId: identity.meshId,
                attemptId: identity.attemptId,
                taskId: identity.taskId,
                kind: WORKER_REPORT_EVENT_KIND,
                // UNIQUE(attempt_id, kind, dedupe_key) makes a re-call for the
                // same outcome insert-once, matching the reducer's own idempotency.
                dedupeKey: report.outcome,
                payload: JSON.stringify({
                    outcome: report.outcome,
                    summaryLength: report.summary.length,
                    touchedFileCount: report.touchedFiles?.length ?? 0,
                    blockerCount: report.blockers?.length ?? 0,
                    hasHandoffNotes: !!report.handoffNotes,
                    ...(report.branchState ? { branchState: report.branchState } : {}),
                }),
                occurredAtMs: nowMs,
                recordedAt: nowIso,
            });
        } catch (e: any) {
            LOG.warn('WorkerReport', `Failed to record report evidence for task ${identity.taskId}: ${e?.message || e}`);
        }
    }

    // (3) Handoff note.
    let handoffNoteRecorded = false;
    if (report.handoffNotes) {
        handoffNoteRecorded = recordHandoffNote(identity, report.handoffNotes, nowMs, nowIso);
    }

    // (4) Terminal. 'blocked' is NOT a terminal outcome the ledger knows — it
    // maps to 'failed' with a reason, because a blocked task genuinely did not
    // succeed and must not advance the graph as though it had. The blockers list
    // carries the why, and the coordinator reads it from the envelope.
    const terminalStatus = report.outcome === 'completed' ? 'completed' : 'failed';
    let commit: ReturnType<typeof commitTaskTerminalAndAdvanceGraph>;
    try {
        commit = commitTaskTerminalAndAdvanceGraph({
            meshId: identity.meshId,
            taskId: identity.taskId,
            status: terminalStatus,
            ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
            ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
            occurredAtMs: nowMs,
            // ★A NEW proposal source. The reducer's causal checks apply to it
            // exactly as they do to a provider event — a valid token does not
            // buy an exemption from stale-attempt or session-mismatch.
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
): { accepted: boolean; taskId?: string; refusal?: WorkerReportRefusal } {
    const identity = resolveWorkerIdentity(credential);
    if (!identity) return { accepted: false, refusal: 'unauthenticated' };
    if (!identity.attemptId) return { accepted: true, taskId: identity.taskId };

    const nowMs = opts.nowMs ?? Date.now();
    try {
        MeshRuntimeStore.getInstance().insertTurnEvent({
            eventId: randomUUID(),
            meshId: identity.meshId,
            attemptId: identity.attemptId,
            taskId: identity.taskId,
            kind: WORKER_PROGRESS_EVENT_KIND,
            // Distinct per call — progress updates are a SEQUENCE, unlike the
            // completion report where the UNIQUE constraint provides idempotency.
            dedupeKey: `${nowMs}`,
            payload: JSON.stringify({ noteLength: note.length }),
            occurredAtMs: nowMs,
            recordedAt: new Date(nowMs).toISOString(),
        });
    } catch (e: any) {
        LOG.warn('WorkerReport', `Failed to record progress update for task ${identity.taskId}: ${e?.message || e}`);
    }
    return { accepted: true, taskId: identity.taskId };
}

function recordHandoffNote(
    identity: WorkerTokenExchangeResult,
    notes: WorkerHandoffNotes,
    nowMs: number,
    nowIso: string,
): boolean {
    // Meta index row: WHO/WHEN/WHAT-FILES, no free text. The touched-file list is
    // stored here (and not only in the topic) because it is the lookup key for
    // auto-enclosure — an index nobody can query is not an index. File paths are
    // identifiers, not authored prose, so this stays within the ledger's
    // meta-only rule.
    if (identity.attemptId) {
        try {
            MeshRuntimeStore.getInstance().insertTurnEvent({
                eventId: randomUUID(),
                meshId: identity.meshId,
                attemptId: identity.attemptId,
                taskId: identity.taskId,
                kind: WORKER_HANDOFF_EVENT_KIND,
                dedupeKey: '',
                payload: JSON.stringify({
                    touchedFiles: notes.touchedFiles,
                    intentLength: notes.intent.length,
                    hasConflictGuidance: !!notes.conflictGuidance,
                    followUpCount: notes.followUps?.length ?? 0,
                    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                    ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
                }),
                occurredAtMs: nowMs,
                recordedAt: nowIso,
            });
        } catch (e: any) {
            LOG.warn('WorkerReport', `Failed to index handoff note for task ${identity.taskId}: ${e?.message || e}`);
            return false;
        }
    }

    // Content goes to the sink (content-class seqscribe topic). A missing sink is
    // NOT an error — a daemon without seqscribe still gets the meta index and the
    // auto-enclosure below reads intent from the note store, so the feature
    // degrades rather than failing the report.
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
            LOG.warn('WorkerReport', `Handoff note sink threw for task ${identity.taskId}: ${e?.message || e}`);
        }
    }
    return true;
}
