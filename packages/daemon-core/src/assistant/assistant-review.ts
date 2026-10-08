/**
 * Idle review turn — trigger evaluation, the fixed review input, and the
 * review-turn verb whitelist (design 2026-10-07-assistant-layer.md §4.10.7).
 *
 * Pure: no timer, no bus, no session I/O. The boot/relay unit owns when this
 * is evaluated and how the input is delivered (`origin:'assistant'`, always
 * `queue`); the store verbs call `reviewTurnVerbDecision` with the input log's
 * `isReviewTurnOpen`.
 *
 * The numbers (10 min, 6 inputs, 2 h, 4 per day, 20 % quota) are chosen
 * values, not measurements — M7 and the standalone-retirement condition judge
 * them. The quota floor mirrors Codex's `min_rate_limit_remaining_percent`
 * (research 2026-10-08 Q7): a background review must not spend the last of
 * the plan the person is working with.
 */

import { ASSISTANT_REVIEW_TURN_VERBS } from '@adhdev/mesh-shared';

export const REVIEW_TRIGGER_RULES = {
    /** Assistant idle at least this long. */
    minIdleMs: 10 * 60 * 1000,
    /** Human inputs since the last review. */
    minHumanInputs: 6,
    /** Since the last review. */
    minSinceLastReviewMs: 2 * 60 * 60 * 1000,
    /** Reviews per rolling 24 h. */
    maxPerDay: 4,
    /** Skip below this remaining % of the assistant CLI's tightest quota window. */
    minQuotaRemainingPct: 20,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewTriggerInput {
    /** Epoch ms. */
    now: number;
    /** Epoch ms the assistant went idle; null when it is not idle (generating, starting, stopped). */
    idleSince: number | null;
    humanInputsSinceLastReview: number;
    /** Epoch ms of previous review inputs (any order). The latest is "last review". */
    reviewAts: readonly number[];
    modalOpen: boolean;
    /** `assistant.json` `reviewTurn`; only an explicit `false` disables. */
    reviewTurnSetting?: boolean | null;
    /** MCP-only assistants have no PTY to deliver into (§4.10.7) — never due. */
    mcpOnly?: boolean;
    /**
     * Remaining % of the assistant CLI's quota (`AssistantQuotaPort`,
     * assistant-quota.ts). null = unknown, which skips (fail-closed).
     */
    quotaRemainingPct: number | null;
}

export type ReviewSkipReason =
    | 'disabled'
    | 'mcp_only'
    | 'not_idle'
    | 'idle_too_short'
    | 'modal_open'
    | 'too_few_inputs'
    | 'too_soon'
    | 'daily_cap'
    | 'low_quota';

export type ReviewTriggerDecision = { due: true } | { due: false; reason: ReviewSkipReason };

/** All conditions must hold; the first failing one is reported. */
export function evaluateReviewTrigger(input: ReviewTriggerInput, rules: typeof REVIEW_TRIGGER_RULES = REVIEW_TRIGGER_RULES): ReviewTriggerDecision {
    if (input.reviewTurnSetting === false) return { due: false, reason: 'disabled' };
    if (input.mcpOnly) return { due: false, reason: 'mcp_only' };
    if (input.idleSince === null || !Number.isFinite(input.idleSince)) return { due: false, reason: 'not_idle' };
    if (input.now - input.idleSince < rules.minIdleMs) return { due: false, reason: 'idle_too_short' };
    if (input.modalOpen) return { due: false, reason: 'modal_open' };
    if (input.humanInputsSinceLastReview < rules.minHumanInputs) return { due: false, reason: 'too_few_inputs' };
    const reviews = input.reviewAts.filter((t) => Number.isFinite(t));
    const last = reviews.length ? Math.max(...reviews) : null;
    if (last !== null && input.now - last < rules.minSinceLastReviewMs) return { due: false, reason: 'too_soon' };
    const inLastDay = reviews.filter((t) => input.now - t < DAY_MS).length;
    if (inLastDay >= rules.maxPerDay) return { due: false, reason: 'daily_cap' };
    const q = input.quotaRemainingPct;
    if (typeof q !== 'number' || !Number.isFinite(q) || q < rules.minQuotaRemainingPct) return { due: false, reason: 'low_quota' };
    return { due: true };
}

/** Fixed review input text. English like every other daemon-authored prompt text. */
export const REVIEW_INPUT_TEXT =
    '[ADHDev review] If the conversation since the last review produced rules, environment facts, '
    + 'user preferences or recurring procedures that the next session will need, save them with '
    + 'memory / skill_manage / project_note. Merge or fix entries that already exist. '
    + 'If there is nothing to save, reply with the single word "nothing". Do not use any other tool.';

export const REVIEW_MESSAGE_ID_PREFIX = 'review:';

export interface ReviewInput {
    text: string;
    messageId: string;
    origin: 'assistant';
    /** Busy policy: the review input always queues behind whatever is running. */
    policyMode: 'queue';
}

export function buildReviewInput(now: number): ReviewInput {
    return { text: REVIEW_INPUT_TEXT, messageId: `${REVIEW_MESSAGE_ID_PREFIX}${now}`, origin: 'assistant', policyMode: 'queue' };
}

export function isReviewMessageId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(REVIEW_MESSAGE_ID_PREFIX) && /^\d+$/.test(id.slice(REVIEW_MESSAGE_ID_PREFIX.length));
}

// ── whitelist ───────────────────────────────────────────────────────────────

export const REVIEW_TURN_TOOL_DENIED = 'review_turn_tool_denied' as const;

const REVIEW_TURN_VERB_SET: ReadonlySet<string> = new Set(ASSISTANT_REVIEW_TURN_VERBS);

export type ReviewTurnVerbDecision = { allowed: true } | { allowed: false; code: typeof REVIEW_TURN_TOOL_DENIED };

/**
 * Whether the assistant may run `verb` now. While the review turn is open only
 * the four store verbs pass. Applies to verbs the ASSISTANT calls (tool verbs);
 * owner verbs from the dashboard are not the assistant and do not consult it.
 */
export function reviewTurnVerbDecision(verb: string, reviewTurnOpen: boolean): ReviewTurnVerbDecision {
    if (!reviewTurnOpen || REVIEW_TURN_VERB_SET.has(verb)) return { allowed: true };
    return { allowed: false, code: REVIEW_TURN_TOOL_DENIED };
}
