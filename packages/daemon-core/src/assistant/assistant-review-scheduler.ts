/**
 * Idle review turn — the scheduler that decides WHEN to send the fixed review
 * input and hands it to the relay (design 2026-10-07-assistant-layer.md
 * §4.10.7). `assistant-review.ts` stays pure (rules, input text, whitelist);
 * this module only gathers the trigger inputs from ports and delivers.
 *
 * Evaluated on the assistant runtime's relay tick (1 min). One review at a
 * time: from enqueue until the relay delivers it, and then until the review
 * turn closes (`turn{committed}` → input log `closeTurn`). Nothing here judges
 * turn completion; it reads the input log the relay keeps.
 *
 * Delivery is the relay's `enqueueInput` — the same queue/funnel relays use
 * (always `queue`, held while the assistant is busy), logged in the input log
 * with source `review`, so `classifyWriteOrigin` sees the review window and the
 * store verbs see the whitelist window. The input is pinned to the session it
 * was evaluated for and goes alone (never combined with a relay).
 *
 * Restart: review times persist in `assistant.json` (`reviewAts`), and the
 * in-memory input log starts empty, so a restarted daemon neither re-fires
 * within 2 h nor counts pre-restart human inputs toward the next review.
 */

import { buildReviewInput, evaluateReviewTrigger, type ReviewSkipReason, REVIEW_TRIGGER_RULES } from './assistant-review.js';
import type { AssistantInputLog } from './assistant-input-log.js';

export interface AssistantReviewPorts {
    /** The bound assistant session when its instance is live on this daemon (PTY-hosted), else null. */
    liveSessionId(): string | null;
    /** Ready status class (not generating, not awaiting approval/choice). */
    isReady(sessionId: string): boolean;
    /** An approval/choice modal is open or parked on the assistant. */
    modalOpen(sessionId: string): boolean;
    /** Epoch ms of the session's last idle edge (registry `lastTurnState`), or null when not idle. */
    idleSince(sessionId: string): number | null;
    /** `assistant.json` `reviewTurn`. */
    reviewTurnSetting(): boolean | null;
    /** Persisted review times (`assistant.json` `reviewAts`). */
    reviewAts(): readonly number[];
    /** `AssistantQuotaPort` reading for the assistant CLI; null = unknown. */
    quotaRemainingPct(now: number): number | null;
    inputLog: AssistantInputLog;
    /** The relay already has something on its way to the assistant. */
    relayBusy(): boolean;
    /** Whether the enqueued review is still waiting in the relay queue. */
    isQueued(messageId: string): boolean;
    enqueue(input: { source: 'review'; text: string; messageId: string; forSessionId: string }): void;
    /** The review reached the assistant: persist its time and bump `review_turns`. */
    recordDelivered(at: number): void;
}

export type ReviewSchedulerOutcome =
    | { fired: true; messageId: string }
    | { fired: false; reason: ReviewSkipReason | 'no_session' | 'in_flight' | 'busy' };

interface InFlight {
    sessionId: string;
    messageId: string;
    delivered: boolean;
}

export class AssistantReviewScheduler {
    private inFlight: InFlight | null = null;
    /** Session → input-log human count when its last review was delivered. */
    private readonly humanAtLastReview = new Map<string, number>();

    constructor(private readonly ports: AssistantReviewPorts, private readonly rules: typeof REVIEW_TRIGGER_RULES = REVIEW_TRIGGER_RULES) {}

    /** Evaluate once (relay tick). Enqueues the review input when due. */
    evaluate(now: number): ReviewSchedulerOutcome {
        const sid = this.ports.liveSessionId();
        if (!sid) {
            this.inFlight = null;
            return { fired: false, reason: 'no_session' };
        }
        if (this.stillInFlight(sid)) return { fired: false, reason: 'in_flight' };
        const ready = this.ports.isReady(sid);
        const decision = evaluateReviewTrigger({
            now,
            idleSince: ready ? this.ports.idleSince(sid) : null,
            humanInputsSinceLastReview: this.ports.inputLog.humanInputCount(sid) - (this.humanAtLastReview.get(sid) ?? 0),
            reviewAts: this.ports.reviewAts(),
            modalOpen: this.ports.modalOpen(sid),
            reviewTurnSetting: this.ports.reviewTurnSetting(),
            quotaRemainingPct: this.ports.quotaRemainingPct(now),
        }, this.rules);
        if (!decision.due) return { fired: false, reason: decision.reason };
        if (this.ports.relayBusy()) return { fired: false, reason: 'busy' };
        const input = buildReviewInput(now);
        this.inFlight = { sessionId: sid, messageId: input.messageId, delivered: false };
        this.ports.enqueue({ source: 'review', text: input.text, messageId: input.messageId, forSessionId: sid });
        return { fired: true, messageId: input.messageId };
    }

    /** Relay delivery hook for a review input. */
    onDelivered(sessionId: string, messageId: string, at: number): void {
        this.humanAtLastReview.set(sessionId, this.ports.inputLog.humanInputCount(sessionId));
        if (this.inFlight?.messageId === messageId) this.inFlight.delivered = true;
        this.ports.recordDelivered(at);
    }

    /** Test/diagnostic view. */
    inFlightMessageId(): string | null {
        return this.inFlight?.messageId ?? null;
    }

    private stillInFlight(sid: string): boolean {
        const f = this.inFlight;
        if (!f) return false;
        const alive = f.sessionId === sid && (f.delivered ? this.ports.inputLog.isReviewTurnOpen(sid) : this.ports.isQueued(f.messageId));
        if (!alive) this.inFlight = null;
        return alive;
    }
}
