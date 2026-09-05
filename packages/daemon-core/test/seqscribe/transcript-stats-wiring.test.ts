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
        expect(tail).toMatch(/published:\s*transcriptCounters\.published/);
        // ★ The parity counters must arrive WHOLE — shorthand `transcriptParity,`
        // rather than a re-keyed subset. See the dedicated test below for why a
        // subset is a defect and not a style choice.
        expect(tail).toMatch(/(?<![.\w])transcriptParity,/);
    });

    it('★passes the WHOLE parity counter object, never a narrowed subset', () => {
        // §5.6's remaining promotion condition is `persistent mismatch 0`, and
        // the old three-field slice `{runs, mismatches, persistentMismatches}`
        // could not DECIDE it. `missing_complete_revision` is promoted to
        // persistent only when the same session key is compared a SECOND time,
        // and the sole non-test caller of `compareTranscriptRevision` is the
        // per-append self-check in `transcript-publish-runtime.ts`. So `runs: 2`
        // spread over two different sessions leaves `persistentMismatches: 0`
        // meaning "the recurrence rule never fired" — indistinguishable, on the
        // wire, from "checked repeatedly and clean". `sessionsRepeated` and
        // `pendingMissingRevisits` are what separate those two, `compared` plus
        // the six-class split says which axis is dirty, and `since` dates the
        // zero so a fresh restart is not misread as parity.
        //
        // Every one of those fields is dropped again by the narrowing, so the
        // narrowing itself is the defect this test pins. `summarizeSeqscribeStats`
        // gates them behind `includeLocalDiagnostics` (this call site sets it;
        // the cloud one does not), and `buildCloudSeqscribeSummary` is a fixed-key
        // allow-list that never names `transcriptParityDetail` — so passing the
        // whole object here widens no server-facing surface. The companion
        // assertion lives in `test/status/cloud-status-content-boundary.test.ts`.
        const body = extractGetSeqscribeStatsBody(lifecycleSrc);
        const callTail = body.slice(body.indexOf('summarizeSeqscribeStats('));
        const narrowed = /transcriptParity:\s*\{/.test(callTail);
        expect(narrowed).toBe(false);
        expect(callTail).toMatch(/(?<![.\w])transcriptParity,/);
        // And the local-diagnostics opt-in must be ON here, or the detail block
        // is computed and then dropped by summarizeSeqscribeStats.
        expect(callTail).toMatch(/includeLocalDiagnostics:\s*true/);
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
