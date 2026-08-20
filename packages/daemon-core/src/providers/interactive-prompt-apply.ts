/**
 * Verified interactive-prompt answering (SILENT-SUCCESS DEFECT, 2026-08-20 live).
 *
 * The only way to answer an AskUserQuestion used to be the fire-and-forget
 * `onEvent('interactive_prompt_response')` path, whose callers returned
 * `success: true` the moment the event was handed off — BEFORE any of the
 * things that can fail had run:
 *
 *   1. `resolveInteractivePromptResponse` THROWS on an unmatched option label.
 *   2. The adapter may not implement `setInteractivePromptResponse` at all.
 *   3. The provider's spec may declare no answerable prompt scheme.
 *   4. The key injection itself can reject.
 *
 * Every one of those was log-only, so a coordinator that mistyped a label was
 * told the question was answered while the picker stayed parked — observed
 * live as a session sitting in `awaiting_choice` for ~5 minutes after a
 * `success: true`.
 *
 * These helpers are the awaitable counterpart: resolve against the
 * AUTHORITATIVE held prompt, await the key injection, and THROW on every
 * failure so the caller can return a real error carrying the live option list.
 *
 * Extracted from cli-provider-instance.ts as a pure move (the class keeps thin
 * delegating methods) to respect the file-size gate on that already-frozen file.
 */
import { LOG } from '../logging/logger.js';
import {
    normalizeInteractivePromptResponse,
    resolveInteractivePromptResponse,
    type InteractivePrompt,
    type InteractiveAnswer,
} from './types/interactive-prompt.js';

/** The minimum surface these helpers need from a provider adapter. */
export interface InteractivePromptAnswerTarget {
    setInteractivePromptResponse?(response: { promptId: string; answers: Record<string, InteractiveAnswer> }): Promise<void>;
}

export interface AppliedInteractivePromptAnswer {
    promptId: string;
    answers: Record<string, InteractiveAnswer>;
}

/**
 * A coordinator-facing description of the prompt a session is CURRENTLY
 * holding. Returned alongside a failure so the caller can retry against the
 * real labels instead of guessing.
 */
export interface ActiveInteractivePromptDescription {
    promptId: string;
    questions: Array<{ questionId: string; question: string; multiSelect: boolean; options: string[] }>;
}

export function describeInteractivePrompt(prompt: InteractivePrompt | null): ActiveInteractivePromptDescription | null {
    if (!prompt) return null;
    return {
        promptId: prompt.promptId,
        questions: prompt.questions.map(q => ({
            questionId: q.questionId,
            question: q.question,
            multiSelect: q.multiSelect,
            options: q.options.map(o => o.label),
        })),
    };
}

/**
 * Resolve `data` against `held` and drive it into the adapter, awaiting the
 * injection. Throws — never returns a falsely-successful result.
 *
 * Note the honest contract: awaiting `setInteractivePromptResponse` means the
 * keystrokes were DISPATCHED to the PTY, not that the TUI redrew and committed.
 * Callers carry that distinction in their return shape.
 */
export async function applyInteractivePromptAnswer(options: {
    held: InteractivePrompt | null;
    data: unknown;
    adapter: InteractivePromptAnswerTarget;
    providerType: string;
}): Promise<AppliedInteractivePromptAnswer> {
    const { held, data, adapter, providerType } = options;
    const incomingPromptId = typeof (data as { promptId?: unknown })?.promptId === 'string'
        ? ((data as { promptId: string }).promptId).trim()
        : '';

    if (!held) {
        throw new Error(incomingPromptId
            ? `No active interactive prompt for this session — nothing to answer (received promptId "${incomingPromptId}"). The question may already have been answered or cancelled.`
            : 'No active interactive prompt for this session — nothing to answer.');
    }
    // Same fail-closed stale-promptId rule as the onEvent path: never resolve a
    // foreign promptId against the held prompt's option rows (rc.20 rebind
    // option fidelity — an index could otherwise bind to the wrong row).
    if (incomingPromptId && incomingPromptId !== held.promptId) {
        throw new Error(`Stale promptId "${incomingPromptId}" — the session's active question is "${held.promptId}". The answer was NOT applied; re-answer against the active promptId.`);
    }

    const response = Array.isArray((data as { answers?: unknown })?.answers)
        ? resolveInteractivePromptResponse(held, data)
        : normalizeInteractivePromptResponse(data);

    if (typeof adapter.setInteractivePromptResponse !== 'function') {
        throw new Error(`Provider "${providerType}" does not support answering interactive prompts.`);
    }
    // AWAIT the injection — a rejected promise here used to be swallowed by
    // `void ....catch(log)`, which is precisely how a failed submit became a
    // reported success.
    await adapter.setInteractivePromptResponse(response);
    return { promptId: response.promptId, answers: response.answers };
}

/**
 * LEGACY fire-and-forget answer application (the `onEvent` branch).
 *
 * Behaviour is preserved verbatim from cli-provider-instance.ts — every failure
 * is log-only, because this path has no caller to return an error to (the event
 * bus is void). Callers that need to know whether the answer landed must use
 * `applyInteractivePromptAnswer` above instead.
 *
 * Returns the prompt the instance should now hold: `null` once the answer was
 * applied to the held prompt, otherwise the unchanged `held` value.
 */
export function applyInteractivePromptAnswerFireAndForget(options: {
    held: InteractivePrompt | null;
    data: unknown;
    adapter: InteractivePromptAnswerTarget;
    providerType: string;
}): InteractivePrompt | null {
    const { held, data, adapter, providerType } = options;
    let nextHeld = held;
    try {
        // STALE-PROMPT-ANSWER guard (rc.20 rebind option fidelity): an answer
        // naming a promptId OTHER than the currently held prompt is rejected
        // outright — it is NEVER resolved against (or defaulted into) the
        // active prompt's options and NEVER forwarded to the TUI/transport.
        // Post-restart the coordinator can still hold the pre-restart promptId;
        // silently dropping it (the old log-only path) left the session parked,
        // and resolving it anyway could bind an index to the wrong option row.
        // Rejection here is fail-closed: the picker stays parked and the caller
        // is told to re-answer against the active id.
        const heldPromptId = typeof held?.promptId === 'string' && held.promptId ? held.promptId : '';
        const incomingPromptId = typeof (data as { promptId?: unknown })?.promptId === 'string'
            ? ((data as { promptId: string }).promptId).trim()
            : '';
        if (heldPromptId && incomingPromptId && incomingPromptId !== heldPromptId) {
            LOG.warn('CLI', `[${providerType}] interactive_prompt_response REJECTED: stale promptId "${incomingPromptId}" does not match active prompt "${heldPromptId}" — answer not applied (no index/default fallback); re-answer against the active promptId`);
            return nextHeld;
        }
        // mesh_answer_question (mission f1d25e11) sends a coordinator-friendly
        // answer form (per-question select by label/index) that must be resolved
        // against the AUTHORITATIVE active prompt held here. When the active
        // prompt is present and the promptId matches, resolve it; otherwise fall
        // back to the strict keyed form (dashboard local answers send that shape).
        const response = (held
            && held.promptId === (data as { promptId?: unknown })?.promptId
            && Array.isArray((data as { answers?: unknown })?.answers))
            ? resolveInteractivePromptResponse(held, data)
            : normalizeInteractivePromptResponse(data);
        if (held?.promptId === response.promptId) {
            nextHeld = null;
        }
        if (typeof adapter.setInteractivePromptResponse !== 'function') {
            LOG.warn('CLI', `[${providerType}] interactive_prompt_response ignored: adapter does not support interactive prompts`);
            return nextHeld;
        }
        void adapter.setInteractivePromptResponse(response).catch((e: any) => {
            LOG.warn('CLI', `[${providerType}] interactive_prompt_response failed: ${e?.message || e}`);
        });
    } catch (e: any) {
        LOG.warn('CLI', `[${providerType}] invalid interactive_prompt_response: ${e?.message || e}`);
    }
    return nextHeld;
}
