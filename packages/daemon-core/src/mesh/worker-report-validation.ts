/**
 * Worker completion-report validation: the report shape a worker submits through
 * `report_completion`, its field limits, and the validator that turns a raw tool
 * payload into a typed WorkerCompletionReport or a list of field errors.
 */
import { isWorkerReportOutcome, WORKER_REPORT_OUTCOMES, WORKER_BRANCH_STATES, type WorkerReportOutcome, type WorkerBranchState } from '@adhdev/mesh-shared';

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

/** Caps. Oversized input is REJECTED, never silently clipped (see validate below). */
export const WORKER_SUMMARY_MAX_CHARS = 8_000;
export const WORKER_INTENT_MAX_CHARS = 4_000;
export const WORKER_GUIDANCE_MAX_CHARS = 4_000;
export const WORKER_TOUCHED_FILES_MAX = 200;
export const WORKER_LIST_ITEM_MAX_CHARS = 500;
export const WORKER_BLOCKERS_MAX = 50;
export const WORKER_FOLLOW_UPS_MAX = 50;

// ─── Validation ─────────────────────────────────────────────────────────

interface WorkerReportValidationError {
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
            // ★Preserve an EXPLICIT empty array rather than collapsing it to
            // "absent" on `.length`. `touchedFiles: []` is the worker's statement
            // "I changed nothing", and checkReportAgainstTaskMode (below) must be
            // able to tell that apart from the key never being sent at all — that
            // distinction is what requirement (2) of the invalid_for_task_mode fix
            // depends on. `undefined` in, `undefined` out; `[]` or non-empty in,
            // that array out.
            ...(touchedFiles !== undefined ? { touchedFiles } : {}),
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
