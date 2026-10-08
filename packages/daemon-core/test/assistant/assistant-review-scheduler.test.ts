/**
 * Idle review turn wiring (design 2026-10-07-assistant-layer.md §4.10.7):
 * the scheduler evaluates the pure trigger from live ports and delivers the
 * fixed review input through the relay (same queue + submit funnel as relays),
 * logged as source `review`. Driven with the real relay and input log.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SendPolicy } from '@adhdev/mesh-shared';
import { AssistantInputLog } from '../../src/assistant/assistant-input-log.js';
import { InMemoryAssistantRelayStore } from '../../src/assistant/assistant-relay-store.js';
import { AssistantRelay, type AssistantRelayBusEvent, type RelayClock } from '../../src/assistant/assistant-relay.js';
import { AssistantRegistry } from '../../src/assistant/assistant-registry.js';
import { AssistantReviewScheduler } from '../../src/assistant/assistant-review-scheduler.js';
import { REVIEW_INPUT_TEXT, REVIEW_TRIGGER_RULES, isReviewMessageId } from '../../src/assistant/assistant-review.js';

const MIN = 60_000;
const ASSISTANT = 'asst_1';
const COORD = 'coord_blog';
const MESH = 'mesh_blog';

class FakeClock implements RelayClock {
    t = Date.parse('2026-10-08T09:00:00Z');
    private timers: Array<{ at: number; fn: () => void; id: number }> = [];
    private next = 1;
    now() { return this.t; }
    setTimeout(fn: () => void, ms: number) { const id = this.next++; this.timers.push({ at: this.t + ms, fn, id }); return id; }
    clearTimeout(h: unknown) { this.timers = this.timers.filter((x) => x.id !== h); }
    advance(ms: number) {
        const end = this.t + ms;
        for (;;) {
            const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            this.timers = this.timers.filter((x) => x !== due);
            this.t = due.at;
            due.fn();
        }
        this.t = end;
    }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adhdev-review-sched-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function harness(opts: { registry?: AssistantRegistry; log?: AssistantInputLog } = {}) {
    const clock = new FakeClock();
    const log = opts.log ?? new AssistantInputLog();
    const registry = opts.registry ?? new AssistantRegistry({ configDir: dir });
    if (!registry.read()) registry.bindSession({ sessionId: ASSISTANT, cliType: 'claude-cli', workspace: '/w', at: clock.now() });
    const submits: Array<{ sessionId: string; text: string; messageId: string; policy: SendPolicy }> = [];
    const state = { ready: true, modal: false, live: ASSISTANT as string | null, quota: 80 as number | null, refuse: false };
    const reviewTurns: number[] = [];
    let handler: (e: AssistantRelayBusEvent) => void = () => {};
    let review: AssistantReviewScheduler | null = null;
    const relay = new AssistantRelay({
        subscribe: (h) => { handler = h; return () => { handler = () => {}; }; },
        coordinatorMeshOf: (sid) => (sid === COORD ? MESH : null),
        projectSlug: () => 'blog',
        readCoordinatorTail: async () => 'Fixed it.',
        meshWork: () => ({ activeMissions: 1, pending: 0, assigned: 1 }),
        hasAssistant: () => true,
        assistantSessionId: () => registry.read()?.sessionId ?? null,
        isAssistantReady: () => state.ready,
        submit: async (sessionId, input) => {
            if (state.refuse) return { kind: 'refused', reason: 'busy' } as never; // stays queued
            submits.push({ sessionId, ...input });
            return { kind: 'delivered' };
        },
        inputLog: log,
        store: new InMemoryAssistantRelayStore(),
        onReviewDelivered: (sid, id, at) => review!.onDelivered(sid, id, at),
        clock,
    });
    relay.start();
    review = new AssistantReviewScheduler({
        liveSessionId: () => state.live,
        isReady: () => state.ready,
        modalOpen: () => state.modal,
        idleSince: (sid) => {
            const t = registry.read()?.lastTurnState;
            return t && t.sessionId === sid && t.state === 'idle' ? t.at : null;
        },
        reviewTurnSetting: () => registry.read()?.reviewTurn ?? null,
        reviewAts: () => registry.read()?.reviewAts ?? [],
        quotaRemainingPct: () => state.quota,
        inputLog: log,
        relayBusy: () => relay.hasPendingInput(),
        isQueued: (id) => relay.isQueued(id),
        enqueue: (input) => relay.enqueueInput(input),
        recordDelivered: (at) => { registry.recordReview(at); reviewTurns.push(at); },
    });
    const emit = (e: AssistantRelayBusEvent) => handler(e);
    /** One assistant turn: started → committed (registry idle edge mirrors subscribeAssistantRegistry). */
    const turnCycle = (n: number) => {
        emit({ kind: 'turn', phase: 'started', sessionId: ASSISTANT, attemptId: `plain:${ASSISTANT}:e${n}`, generation: 0, at: clock.now() } as AssistantRelayBusEvent);
        registry.recordTurnState(ASSISTANT, 'working', clock.now());
        emit({ kind: 'turn', phase: 'committed', sessionId: ASSISTANT, attemptId: `plain:${ASSISTANT}:e${n}`, generation: 0, at: clock.now(), outcome: 'completed', strength: 'genuine' } as AssistantRelayBusEvent);
        registry.recordTurnState(ASSISTANT, 'idle', clock.now());
    };
    const humans = async (count: number) => {
        for (let i = 0; i < count; i++) {
            await relay.submitHuman(`hi ${i}`, { messageId: `h${clock.now()}:${i}` });
            turnCycle(i);
            clock.advance(MIN);
        }
    };
    const settle = async () => { await Promise.resolve(); await relay.idle(); };
    return { relay, review, registry, log, clock, state, submits, reviewTurns, emit, turnCycle, humans, settle };
}

describe('idle review scheduler', () => {
    it('fires once after 10 min idle and 6 human inputs, delivered alone with source review', async () => {
        const h = harness();
        h.log.begin(ASSISTANT);
        await h.humans(REVIEW_TRIGGER_RULES.minHumanInputs);
        expect(h.review.evaluate(h.clock.now())).toMatchObject({ fired: false, reason: 'idle_too_short' });
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        const out = h.review.evaluate(h.clock.now());
        expect(out.fired).toBe(true);
        await h.settle();
        const last = h.submits[h.submits.length - 1]!;
        expect(last.text).toBe(REVIEW_INPUT_TEXT);
        expect(last.text.startsWith('[ADHDev review] ')).toBe(true); // web-core injected-text rule
        expect(isReviewMessageId(last.messageId)).toBe(true);
        expect(last.policy).toEqual({ mode: 'queue' });
        expect(h.log.sources(ASSISTANT).at(-1)).toBe('review');
        expect(h.log.isReviewTurnOpen(ASSISTANT)).toBe(true);
        expect(h.reviewTurns).toHaveLength(1);
        expect(h.registry.read()!.reviewAts).toEqual([h.clock.now()]);
        // Clean window (session start, humans only) → writes apply as `review`.
        expect(h.log.writeContext(ASSISTANT)).toMatchObject({ origin: 'review', reviewTurnId: last.messageId });
    });

    it('a relay delivered since the last review makes the review turn review_tainted', async () => {
        const h = harness();
        h.log.begin(ASSISTANT);
        h.relay.openThread(MESH);
        h.emit({ kind: 'turn', phase: 'committed', sessionId: COORD, attemptId: `plain:${COORD}:e1`, generation: 0, at: h.clock.now(), outcome: 'completed', strength: 'genuine' } as AssistantRelayBusEvent);
        h.clock.advance(20_000);
        await h.settle();
        expect(h.log.sources(ASSISTANT)).toEqual(['relay']);
        h.turnCycle(99);
        await h.humans(6);
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        expect(h.review.evaluate(h.clock.now()).fired).toBe(true);
        await h.settle();
        expect(h.log.writeContext(ASSISTANT).origin).toBe('review_tainted');
    });

    it('skips on low or unknown quota', async () => {
        const h = harness();
        h.log.begin(ASSISTANT);
        await h.humans(6);
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        h.state.quota = 19;
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'low_quota' });
        h.state.quota = null;
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'low_quota' });
        await h.settle();
        expect(h.submits.some((s) => s.text === REVIEW_INPUT_TEXT)).toBe(false);
        expect(h.reviewTurns).toEqual([]);
        h.state.quota = 20;
        expect(h.review.evaluate(h.clock.now()).fired).toBe(true);
    });

    it('does not fire while generating, awaiting approval, or with something queued', async () => {
        const h = harness();
        h.log.begin(ASSISTANT);
        await h.humans(6);
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        h.state.ready = false;
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'not_idle' });
        h.state.ready = true;
        h.registry.recordTurnState(ASSISTANT, 'working', h.clock.now());
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'not_idle' });
        h.registry.recordTurnState(ASSISTANT, 'idle', h.clock.now() - REVIEW_TRIGGER_RULES.minIdleMs);
        h.state.modal = true;
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'modal_open' });
        h.state.modal = false;
        h.state.ready = false; // a queued line waits for the ready edge
        h.relay.enqueueInput({ source: 'first_run', text: '[ADHDev first run] hi', messageId: 'first:1' });
        h.state.ready = true;
        h.registry.recordTurnState(ASSISTANT, 'idle', h.clock.now() - REVIEW_TRIGGER_RULES.minIdleMs);
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'busy' });
    });

    it('never double-fires: in flight, during the review turn, after it, or after a daemon restart', async () => {
        const h = harness();
        h.log.begin(ASSISTANT);
        await h.humans(6);
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        h.state.refuse = true; // held in the relay queue
        expect(h.review.evaluate(h.clock.now()).fired).toBe(true);
        await h.settle();
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'in_flight' });
        h.state.refuse = false;
        h.emit({ kind: 'status', sessionId: ASSISTANT, at: h.clock.now(), providerType: 'claude-cli', prev: 'generating', next: 'idle', cause: 'fsm_state' } as AssistantRelayBusEvent);
        await h.settle();
        expect(h.reviewTurns).toHaveLength(1);
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'in_flight' }); // review turn open
        h.turnCycle(50); // review turn commits
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'too_few_inputs' });
        expect(h.submits.filter((s) => s.text === REVIEW_INPUT_TEXT)).toHaveLength(1);

        // Restart: fresh relay/scheduler/input log over the same assistant.json.
        const r = harness({ registry: new AssistantRegistry({ configDir: dir }) });
        r.clock.t = h.clock.now();
        await r.humans(6);
        r.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        expect(r.review.evaluate(r.clock.now())).toEqual({ fired: false, reason: 'too_soon' });
        r.clock.advance(REVIEW_TRIGGER_RULES.minSinceLastReviewMs);
        expect(r.review.evaluate(r.clock.now()).fired).toBe(true);
    });

    it('withdraws a queued review when a human speaks or the session goes away', async () => {
        const h = harness();
        h.log.begin(ASSISTANT);
        await h.humans(6);
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        h.state.refuse = true;
        const fired = h.review.evaluate(h.clock.now());
        expect(fired.fired).toBe(true);
        await h.settle();
        h.state.refuse = false;
        h.state.ready = false;
        await h.relay.submitHuman('one more thing', { messageId: 'h-late' });
        expect(h.relay.isQueued((fired as { messageId: string }).messageId)).toBe(false);
        expect(h.review.evaluate(h.clock.now()).fired).toBe(false); // in-flight cleared; idle edge is gone
        expect(h.reviewTurns).toEqual([]);

        // Session ended: no live session → nothing is evaluated, a pinned leftover is dropped.
        h.relay.enqueueInput({ source: 'review', text: REVIEW_INPUT_TEXT, messageId: 'review:1', forSessionId: 'asst_old' });
        h.state.live = null;
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'no_session' });
        h.state.ready = true;
        h.emit({ kind: 'status', sessionId: ASSISTANT, at: h.clock.now(), providerType: 'claude-cli', prev: 'generating', next: 'idle', cause: 'fsm_state' } as AssistantRelayBusEvent);
        await h.settle();
        expect(h.submits.some((s) => s.messageId === 'review:1')).toBe(false);
        expect(h.relay.isQueued('review:1')).toBe(false);
    });

    it('reviewTurn:false in assistant.json disables it', async () => {
        const h = harness();
        h.log.begin(ASSISTANT);
        h.registry.updateSettings({ reviewTurn: false });
        await h.humans(6);
        h.clock.advance(REVIEW_TRIGGER_RULES.minIdleMs);
        expect(h.review.evaluate(h.clock.now())).toEqual({ fired: false, reason: 'disabled' });
    });
});
