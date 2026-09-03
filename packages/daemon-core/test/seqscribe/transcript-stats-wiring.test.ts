/**
 * §8 unit 2 — `getSeqscribeStats` must actually PASS the transcript counters.
 *
 * The publisher and its parity self-check were both live in production
 * (`createLiveTranscriptPublisher` compares on every append; step 10a arms
 * `configureTranscriptProjection` against the real node), and the allow-listed
 * `transcript*` fields already existed the whole way through `stats.ts` →
 * `status/reporter.ts` → the server's `daemon-status.ts` sanitizer. The ONLY
 * missing link was the argument: neither production `summarizeSeqscribeStats`
 * call site passed `transcript`/`transcriptParity`, so `transcriptParityRan`
 * was reported as a permanent `false` by a daemon that was actively
 * publishing — measured live at 204 session topics / 331,041 appends.
 *
 * That is a false NEGATIVE on the Phase 4 promotion gate's evidence field, the
 * same defect class as the cloud daemon's old `parityRan: false`
 * (`packages/daemon-cloud/test/status-report-seqscribe-parity-wiring.test.ts`,
 * whose header calls it "a status-path lie, not just a missing feature") and
 * the same class as `beacon-diagnostics.ts` ("the board round-trips live in
 * production and NOTHING reads it").
 *
 * `initDaemonComponents` cannot be instantiated in a unit test — it wires real
 * CDP managers, a provider loader, a seqscribe node and a dev server. So this
 * pins the SOURCE-level wiring of the closure, exactly as the daemon-cloud
 * test above does for its half. Removing either option object from the call
 * makes this fail.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const lifecycleSrc = readFileSync(
    join(here, '../../src/boot/daemon-lifecycle.ts'),
    'utf-8',
);

/** Brace-match the `getSeqscribeStats: () => {...}` closure body. */
function extractGetSeqscribeStatsBody(src: string): string {
    const start = src.indexOf('getSeqscribeStats: () => {');
    expect(start).toBeGreaterThanOrEqual(0);
    const braceStart = src.indexOf('{', start + 'getSeqscribeStats: () => '.length);
    let depth = 0;
    let i = braceStart;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    return src.slice(braceStart, i + 1);
}

describe('daemon-lifecycle getSeqscribeStats — transcript counter wiring (§8 unit 2)', () => {
    it('imports the publisher service accessor and the parity counters', () => {
        expect(lifecycleSrc).toMatch(/\bactiveTranscriptProjectionService\b/);
        expect(lifecycleSrc).toMatch(/\btranscriptParityCounters\b/);
    });

    it('forwards both option objects into summarizeSeqscribeStats', () => {
        const body = extractGetSeqscribeStatsBody(lifecycleSrc);

        expect(body).toMatch(/activeTranscriptProjectionService\(\)/);
        expect(body).toMatch(/transcriptParityCounters\(\)/);

        const callStart = body.indexOf('summarizeSeqscribeStats(');
        expect(callStart).toBeGreaterThanOrEqual(0);
        const tail = body.slice(callStart);

        // Computed-but-discarded is the exact bug being guarded against, so
        // assert the values land in the CALL, not merely in the closure.
        expect(tail).toMatch(/transcript:\s*\{/);
        expect(tail).toMatch(/transcriptParity:\s*\{/);
        expect(tail).toMatch(/published:\s*transcriptCounters\.published/);
        expect(tail).toMatch(/runs:\s*transcriptParity\.runs/);
    });

    it('passes persistentMismatches on THIS (local) call site', () => {
        // Asymmetry with the cloud call site is deliberate and mirrors the
        // mesh-axis `parity` block: `get_status_metadata` is a local operator
        // read and is the only surface that can serve the Phase 4 promotion
        // gate's `persistent mismatch 0` condition. The reporter's allow-list
        // drops it before anything leaves the machine.
        const body = extractGetSeqscribeStatsBody(lifecycleSrc);
        const tail = body.slice(body.indexOf('transcriptParity:'));
        expect(tail).toMatch(/persistentMismatches:\s*transcriptParity\.persistentMismatches/);
    });

    it('keys transcript.active off the SERVICE, not the mode', () => {
        // Mode `shadow` still publishes — it is the safe default precisely
        // because it writes the seqscribe leg without moving any read. Keying
        // `active` off `mode === 'primary'` would report `false` on every
        // daemon in the fleet today, reintroducing the same false negative one
        // layer down.
        const body = extractGetSeqscribeStatsBody(lifecycleSrc);
        const tail = body.slice(body.indexOf('transcript:'));
        expect(tail).toMatch(/active:\s*true/);
        expect(tail).not.toMatch(/active:\s*[^,\n]*primary/);
    });
});
