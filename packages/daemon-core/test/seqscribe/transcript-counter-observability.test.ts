import { describe, expect, it } from 'vitest';
import { summarizeSeqscribeStats } from '../../src/seqscribe/stats.js';
import type { NodeStats } from 'seqscribe';

/**
 * (TRANSCRIPT-COUNTER-OBSERVABILITY) Four of the transcript publisher's nine
 * counters were incremented on every daemon and readable on NO surface.
 *
 * ★ The premise correction worth recording: this was NOT a missing accessor.
 * `TranscriptProjectionService.getCounters()` is public, returns a defensive
 * copy, and is already called from `daemon-lifecycle.ts` — exactly matching its
 * sibling seqscribe modules. The loss happened one layer later, in the status
 * projection, which hand-picked FIVE of the nine fields (published /
 * publishFailed / deduped / oversized / dropped) and silently dropped the rest.
 *
 * `ptyDirtyCoalesced` is the field that matters. It is the only evidence that
 * the per-session PTY throttle actually collapses bursts: `published` alone
 * cannot distinguish "the throttle merged 200 triggers into 3 publishes" from
 * "only 3 triggers ever fired". Without it the throttle window cannot be tuned
 * against measurement.
 *
 * ★ Content boundary: these are fixed numeric keys and are LOCAL-ONLY, gated
 * behind `includeLocalDiagnostics` exactly like `transcriptLatencyDetail`. The
 * last test below pins that they never appear without the opt-in.
 */

function topic(over: Partial<NodeStats['topics'][string]> = {}): NodeStats['topics'][string] {
    return {
        writers: 1,
        logRows: 0,
        pending: 0,
        quarantined: 0,
        archived: 0,
        finalityGeneration: null,
        certOrderAgeMs: null,
        consumers: {},
        ...over,
    };
}

const STATS: NodeStats = { topics: { 'assistant.journal': topic() }, peers: [] };

/** The full nine-field shape `getCounters()` returns. */
const FULL_COUNTERS = {
    active: true,
    published: 12,
    publishFailed: 1,
    deduped: 4,
    oversized: 0,
    dropped: 0,
    ptyDirtyCoalesced: 187,
    emptyGuarded: 3,
    collectorUnavailable: 2,
    sourcePending: 5,
};

describe('transcript counter observability', () => {
    it('★ surfaces ptyDirtyCoalesced — the throttle-effectiveness signal', () => {
        const summary = summarizeSeqscribeStats(STATS, {
            authorityEnabled: false,
            includeLocalDiagnostics: true,
            transcript: FULL_COUNTERS,
        });

        // RED WITHOUT THE FIX: the five-field projection never carried this, so
        // the whole key was absent and the 350ms throttle was unmeasurable.
        expect(summary.transcriptCounterDetail).toBeDefined();
        expect(summary.transcriptCounterDetail?.ptyDirtyCoalesced).toBe(187);
    });

    it('★ surfaces the other three dropped counters too', () => {
        const summary = summarizeSeqscribeStats(STATS, {
            authorityEnabled: false,
            includeLocalDiagnostics: true,
            transcript: FULL_COUNTERS,
        });

        expect(summary.transcriptCounterDetail).toEqual({
            ptyDirtyCoalesced: 187,
            emptyGuarded: 3,
            collectorUnavailable: 2,
            sourcePending: 5,
        });
    });

    it('still reports the five bucketed fields it always did', () => {
        // The detail field is additive — it must not disturb the existing
        // projection the cloud frame is built from.
        const summary = summarizeSeqscribeStats(STATS, {
            authorityEnabled: false,
            includeLocalDiagnostics: true,
            transcript: FULL_COUNTERS,
        });
        expect(summary.transcriptPublish).toBe(true);
        expect(summary.transcriptPublishedBucket).toBeTypeOf('number');
    });

    it('omits the key entirely when the caller passed only the bucket fields', () => {
        // "not measured" and "measured zero" are different answers to "is the
        // throttle coalescing?". Reporting a fabricated 0 would assert the
        // throttle is doing nothing, which is a stronger claim than the data
        // supports.
        const summary = summarizeSeqscribeStats(STATS, {
            authorityEnabled: false,
            includeLocalDiagnostics: true,
            transcript: { active: true, published: 12, publishFailed: 1, deduped: 4, oversized: 0, dropped: 0 },
        });
        expect(summary.transcriptCounterDetail).toBeUndefined();
    });

    it('★ CONTENT BOUNDARY: stays out of the summary without includeLocalDiagnostics', () => {
        // Raw monotonic counters would change every tick and defeat the
        // status-frame dedup, turning an idle daemon into a permanent
        // transmitter — the exact failure the bucket discipline prevents.
        const summary = summarizeSeqscribeStats(STATS, {
            authorityEnabled: false,
            transcript: FULL_COUNTERS,
        });
        expect(summary.transcriptCounterDetail).toBeUndefined();
    });

    it('★ CONTENT BOUNDARY: carries only fixed numeric keys — no identifiers', () => {
        const summary = summarizeSeqscribeStats(STATS, {
            authorityEnabled: false,
            includeLocalDiagnostics: true,
            transcript: FULL_COUNTERS,
        });
        const detail = summary.transcriptCounterDetail!;
        expect(Object.keys(detail).sort()).toEqual([
            'collectorUnavailable',
            'emptyGuarded',
            'ptyDirtyCoalesced',
            'sourcePending',
        ]);
        for (const value of Object.values(detail)) {
            expect(typeof value).toBe('number');
        }
    });
});
