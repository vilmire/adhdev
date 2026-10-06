import { describe, expect, it } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import {
    REVIEW_INPUT_TEXT,
    REVIEW_TRIGGER_RULES,
    buildReviewInput,
    evaluateReviewTrigger,
    isReviewMessageId,
    reviewTurnVerbDecision,
    type ReviewTriggerInput,
} from '../../src/assistant/assistant-review.js';

/**
 * Idle review turn (design 2026-10-07-assistant-layer.md §4.10.7): trigger
 * conditions, the fixed input, and the review-turn verb whitelist.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-07T12:00:00Z');

const due = (over: Partial<ReviewTriggerInput> = {}): ReviewTriggerInput => ({
    now: NOW,
    idleSince: NOW - 11 * MIN,
    humanInputsSinceLastReview: 6,
    reviewAts: [NOW - 3 * HOUR],
    modalOpen: false,
    ...over,
});

describe('evaluateReviewTrigger', () => {
    it('is due when every condition holds (and with no previous review)', () => {
        expect(evaluateReviewTrigger(due())).toEqual({ due: true });
        expect(evaluateReviewTrigger(due({ reviewAts: [] }))).toEqual({ due: true });
        expect(evaluateReviewTrigger(due({ reviewTurnSetting: true }))).toEqual({ due: true });
    });

    it('reports each failing condition', () => {
        const cases: Array<[Partial<ReviewTriggerInput>, string]> = [
            [{ reviewTurnSetting: false }, 'disabled'],
            [{ mcpOnly: true }, 'mcp_only'],
            [{ idleSince: null }, 'not_idle'],
            [{ idleSince: NOW - 9 * MIN }, 'idle_too_short'],
            [{ modalOpen: true }, 'modal_open'],
            [{ humanInputsSinceLastReview: 5 }, 'too_few_inputs'],
            [{ reviewAts: [NOW - 119 * MIN] }, 'too_soon'],
            [{ reviewAts: [NOW - 23 * HOUR, NOW - 15 * HOUR, NOW - 9 * HOUR, NOW - 3 * HOUR] }, 'daily_cap'],
        ];
        for (const [over, reason] of cases) expect(evaluateReviewTrigger(due(over))).toEqual({ due: false, reason });
    });

    it('boundaries are inclusive at exactly 10 min idle and 2 h since the last review; the day is rolling 24 h', () => {
        expect(evaluateReviewTrigger(due({ idleSince: NOW - REVIEW_TRIGGER_RULES.minIdleMs })).due).toBe(true);
        expect(evaluateReviewTrigger(due({ reviewAts: [NOW - REVIEW_TRIGGER_RULES.minSinceLastReviewMs] })).due).toBe(true);
        // four reviews, the oldest just over 24 h ago → only three count
        expect(evaluateReviewTrigger(due({ reviewAts: [NOW - 24 * HOUR - 1, NOW - 15 * HOUR, NOW - 9 * HOUR, NOW - 3 * HOUR] })).due).toBe(true);
    });
});

describe('review input', () => {
    it('is the fixed text with a review:<ts> messageId, assistant origin, always queued', () => {
        const input = buildReviewInput(NOW);
        expect(input).toEqual({ text: REVIEW_INPUT_TEXT, messageId: `review:${NOW}`, origin: 'assistant', policyMode: 'queue' });
        expect(input.text.startsWith('[ADHDev review]')).toBe(true);
        for (const tool of ['memory', 'skill_manage', 'project_note', 'nothing']) expect(input.text).toContain(tool);
        expect(isReviewMessageId(input.messageId)).toBe(true);
        expect(isReviewMessageId('review:abc')).toBe(false);
        expect(isReviewMessageId(`notify:${NOW}`)).toBe(false);
    });
});

describe('review-turn whitelist', () => {
    const allowed = [ASSISTANT_VERB.memory, ASSISTANT_VERB.skillView, ASSISTANT_VERB.skillManage, ASSISTANT_VERB.projectNote];

    it('allows only the four store verbs while the review turn is open', () => {
        for (const v of Object.values(ASSISTANT_VERB)) {
            const d = reviewTurnVerbDecision(v, true);
            if ((allowed as string[]).includes(v)) expect(d).toEqual({ allowed: true });
            else expect(d).toEqual({ allowed: false, code: 'review_turn_tool_denied' });
        }
        expect(reviewTurnVerbDecision(ASSISTANT_VERB.projectSend, true)).toEqual({ allowed: false, code: 'review_turn_tool_denied' });
    });

    it('allows everything when no review turn is open', () => {
        for (const v of Object.values(ASSISTANT_VERB)) expect(reviewTurnVerbDecision(v, false)).toEqual({ allowed: true });
    });
});
