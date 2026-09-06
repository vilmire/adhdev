/**
 * Trigger attribution + stage-latency sampling (seqscribe/transcript-latency.ts,
 * and its wiring through TranscriptProjectionService).
 *
 * The distribution assertions below deliberately use a NEAREST-RANK expectation
 * rather than an interpolated one: with a bimodal input (a ~350ms throttled PTY
 * pull vs. a ~3000ms stat poll) an interpolated p95 lands between the two modes,
 * at a latency that never actually occurred. Every reported value must be a real
 * observed sample.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    TranscriptLatencyRecorder,
    TRANSCRIPT_TRIGGER_SOURCES,
    type TranscriptTriggerSource,
} from '../../src/seqscribe/transcript-latency.js';
import {
    TranscriptProjectionService,
    type TranscriptProjectionDeps,
} from '../../src/seqscribe/transcript-publisher.js';
import type { TranscriptObservation } from '../../src/seqscribe/transcript-observation.js';

describe('TranscriptLatencyRecorder', () => {
    it('reports count/p50/p95/max per stage, nearest-rank', () => {
        const rec = new TranscriptLatencyRecorder();
        // 1..100 makes the expected ranks arithmetic rather than a magic number:
        // nearest-rank p50 of 100 ascending samples is the 50th, p95 the 95th.
        for (let i = 1; i <= 100; i++) rec.recordStage('trigger_to_publish', i);

        const dist = rec.detail().stages.trigger_to_publish;
        expect(dist).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
    });

    it('keeps the all-time max even after the sample ring wraps', () => {
        const rec = new TranscriptLatencyRecorder();
        // One huge sample, then enough small ones to evict it from the 256-slot
        // ring. Forgetting the worst case would defeat the point of measuring —
        // the tail is what a user feels.
        rec.recordStage('trigger_to_publish', 9_000);
        for (let i = 0; i < 300; i++) rec.recordStage('trigger_to_publish', 5);

        const dist = rec.detail().stages.trigger_to_publish!;
        expect(dist.p50).toBe(5);
        expect(dist.max).toBe(9_000);
    });

    it('omits a stage with no samples rather than reporting it as zero', () => {
        // `{count: 0, p50: 0}` reads as "measured, and it was instant", which is
        // the opposite of "never observed".
        const detail = new TranscriptLatencyRecorder().detail();
        expect(detail.stages).toEqual({});
        expect(detail.triggerToPublishBySource).toEqual({});
    });

    it('splits trigger_to_publish by source so a slow lane is attributable', () => {
        const rec = new TranscriptLatencyRecorder();
        for (let i = 0; i < 10; i++) rec.recordTriggerToPublish('pty_output', 12);
        for (let i = 0; i < 4; i++) rec.recordTriggerToPublish('stat_poll', 3_010);

        const detail = rec.detail();
        expect(detail.triggerToPublishBySource.pty_output).toMatchObject({ count: 10, p50: 12 });
        expect(detail.triggerToPublishBySource.stat_poll).toMatchObject({ count: 4, p50: 3_010 });
        // The combined stage sees both, so the aggregate alone cannot tell a
        // slow pipeline from a lane driven only by its slowest trigger — which
        // is exactly why the per-source split exists.
        expect(detail.stages.trigger_to_publish!.count).toBe(14);
    });

    it('always lists every source, so a zero is distinct from an unwired source', () => {
        const detail = new TranscriptLatencyRecorder().detail();
        for (const source of TRANSCRIPT_TRIGGER_SOURCES) {
            expect(detail.bySource[source]).toEqual({
                triggered: 0, admitted: 0, coalesced: 0, published: 0,
            });
        }
    });

    it('names the unmeasurable stages with reasons, in the payload itself', () => {
        // Kept in the payload rather than only in comments: the payload is what
        // gets pasted into an issue, and an absent stage must never read as
        // "zero latency".
        const stages = new TranscriptLatencyRecorder().detail().notMeasurable.map((n) => n.stage);
        expect(stages).toContain('publish_to_worker_onsnapshot');
        expect(stages).toContain('worker_onsnapshot_to_controller_apply');
        for (const entry of new TranscriptLatencyRecorder().detail().notMeasurable) {
            expect(entry.reason.length).toBeGreaterThan(0);
        }
    });

    it('ignores negative elapsed values rather than recording them', () => {
        // A wall-clock elapsed can go negative across an NTP step. A negative
        // "latency" is not a fast sample, it is a broken one.
        const rec = new TranscriptLatencyRecorder();
        rec.recordStage('trigger_to_publish', -5);
        rec.recordStage('trigger_to_publish', Number.NaN);
        expect(rec.detail().stages.trigger_to_publish).toBeUndefined();
    });

    it('returns a snapshot that does not mutate under later triggers', () => {
        const rec = new TranscriptLatencyRecorder();
        rec.recordTriggered('pty_output');
        const before = rec.detail();
        rec.recordTriggered('pty_output');
        expect(before.bySource.pty_output.triggered).toBe(1);
        expect(rec.detail().bySource.pty_output.triggered).toBe(2);
    });
});

// ── Wiring through the publisher ──────────────────────────────────────────

function observation(overrides: Partial<TranscriptObservation> = {}): TranscriptObservation {
    return {
        sessionId: 'sess-1',
        providerType: 'claude',
        status: 'idle',
        messages: [{ role: 'assistant', text: 'hello' }],
        coverage: { complete: true },
        ...overrides,
    } as TranscriptObservation;
}

function makeService(
    overrides: Partial<TranscriptProjectionDeps> = {},
): { service: TranscriptProjectionService; published: string[] } {
    const published: string[] = [];
    const service = new TranscriptProjectionService({
        daemonId: () => 'daemon-1',
        writerId: () => 'writer-1',
        epoch: 'epoch-1',
        publishRevision: async (sessionId) => {
            published.push(sessionId);
        },
        ...overrides,
    });
    return { service, published };
}

describe('TranscriptProjectionService — trigger attribution', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('attributes a stat_poll-triggered publish to stat_poll, not to the default', () => {
        const { service } = makeService({
            collectObservation: async () => ({ observation: observation() }),
        });
        service.markDirty('sess-1', 'stat_poll');

        const detail = service.getLatencyDetail();
        expect(detail.bySource.stat_poll.triggered).toBe(1);
        expect(detail.bySource.stat_poll.admitted).toBe(1);
        expect(detail.bySource.unspecified.triggered).toBe(0);
    });

    it('counts an unlabelled markDirty as unspecified rather than folding it into a real source', () => {
        // `unspecified` means "browser-originated read_chat, source unknown".
        // Silently attributing it to whichever source is listed first would
        // manufacture an attribution that was never observed.
        const { service } = makeService({
            collectObservation: async () => ({ observation: observation() }),
        });
        service.markDirty('sess-1');

        const detail = service.getLatencyDetail();
        expect(detail.bySource.unspecified.triggered).toBe(1);
        expect(detail.bySource.pty_output.triggered).toBe(0);
    });

    it('labels the PTY leading edge as pty_output and counts the collapsed burst', () => {
        vi.useFakeTimers();
        const { service } = makeService({
            collectObservation: async () => ({ observation: observation() }),
        });

        service.markPtyOutputActivity('sess-1'); // leading edge
        service.markPtyOutputActivity('sess-1'); // collapsed into the window
        service.markPtyOutputActivity('sess-1'); // collapsed into the window

        const detail = service.getLatencyDetail();
        expect(detail.bySource.pty_output.triggered).toBe(3);
        // Two of the three never reach markDirty at all — counting them only
        // there would under-report exactly the source whose burst behaviour is
        // the point of measuring.
        expect(detail.bySource.pty_output.coalesced).toBe(2);
        service.dispose();
    });

    it('attributes the seed-read path to seed', () => {
        const { service } = makeService({
            collectObservation: async () => ({ observation: observation() }),
        });
        service.seedSession('sess-1');
        expect(service.getLatencyDetail().bySource.seed.triggered).toBe(1);
    });

    it('counts a trigger even when no collector is configured', () => {
        // Otherwise a misconfigured daemon looks idle rather than broken: the
        // triggers are firing, they just cannot do anything.
        const { service } = makeService();
        service.markDirty('sess-1', 'status_event');
        service.markPtyOutputActivity('sess-1');

        const detail = service.getLatencyDetail();
        expect(detail.bySource.status_event.triggered).toBe(1);
        expect(detail.bySource.pty_output.triggered).toBe(1);
        expect(detail.bySource.status_event.admitted).toBe(0);
    });

    it('records a published sample against the triggering source', async () => {
        const { service, published } = makeService({
            collectObservation: async () => ({ observation: observation() }),
        });
        service.markDirty('sess-1', 'post_chat');
        await vi.waitFor(() => expect(published).toHaveLength(1));

        const detail = service.getLatencyDetail();
        expect(detail.bySource.post_chat.published).toBe(1);
        expect(detail.stages.trigger_to_publish!.count).toBe(1);
        expect(detail.triggerToPublishBySource.post_chat!.count).toBe(1);
    });

    it('keeps the original source when a pull re-enters through the nested observe()', async () => {
        // The live collector re-enters the read_chat choke point, which calls
        // observe() while the session is still inFlight. That nested call is the
        // pull's OWN work, so overwriting the attribution would report every
        // pull-driven publish as `unspecified` — and restart the latency clock
        // mid-measurement, reporting it as instant.
        let service!: TranscriptProjectionService;
        const published: string[] = [];
        service = new TranscriptProjectionService({
            daemonId: () => 'daemon-1',
            writerId: () => 'writer-1',
            epoch: 'epoch-1',
            publishRevision: async (sessionId) => {
                published.push(sessionId);
            },
            collectObservation: async (sessionId) => {
                service.observe(sessionId, observation());
                return null;
            },
        });

        service.markDirty('sess-1', 'pty_output');
        await vi.waitFor(() => expect(published).toHaveLength(1));

        const detail = service.getLatencyDetail();
        expect(detail.bySource.pty_output.published).toBe(1);
        expect(detail.bySource.unspecified.published).toBe(0);
        expect(detail.triggerToPublishBySource.pty_output!.count).toBe(1);
    });

    it('does not sample a failed publish as a latency observation', async () => {
        // A failed sink returns fast and would drag the distribution down while
        // representing nothing a user ever saw rendered.
        const { service } = makeService({
            collectObservation: async () => ({ observation: observation() }),
            publishRevision: async () => {
                throw new Error('sink down');
            },
        });
        service.markDirty('sess-1', 'status_event');
        await vi.waitFor(() => expect(service.getCounters().publishFailed).toBe(1));

        const detail = service.getLatencyDetail();
        expect(detail.stages.trigger_to_publish).toBeUndefined();
        expect(detail.bySource.status_event.published).toBe(0);
    });
});
