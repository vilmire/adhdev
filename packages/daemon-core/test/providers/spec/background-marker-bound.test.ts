/**
 * background-marker-bound.ts — the pure half: declaration compile, per-line
 * scan/mask, and the episode/notice/release state machine on an injected clock.
 * The end-to-end behaviour against the shipping specs is in
 * driver-background-marker-bound.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
    BACKGROUND_MARKER_NOTICE_MS, BACKGROUND_MARKER_RELEASE_MS,
    BackgroundMarkerBound, compileBackgroundMarkers, maskLines, scanBackgroundMarkers,
} from '../../../src/providers/spec/background-marker-bound.js';
import type { ResolvedSection } from '../../../src/providers/spec/evaluator.js';

const SHELL = { patterns: [{ regex: '\\b[1-9]\\d*\\s+shells?\\s+still\\s+running\\b' }] };
const noSections: ResolvedSection[] = [];

function bound(decl: unknown = SHELL) {
    return new BackgroundMarkerBound(compileBackgroundMarkers(decl, 'test'));
}
const SCREEN = ['⏺ Background started.', '', '✻ Crunched for 3s · 1 shell still running', '❯ '];

describe('compileBackgroundMarkers', () => {
    it('keeps valid patterns and drops unsafe, uncompilable, flagged or empty ones (fail-closed)', () => {
        const out = compileBackgroundMarkers({
            patterns: [
                { regex: 'ok\\d' },
                { regex: '(a+)+$' },
                { regex: '(' },
                { regex: 'x', flags: 'm' },
                { regex: '' },
                'junk',
            ],
        }, 'test');
        expect(out).toHaveLength(1);
        expect(compileBackgroundMarkers(undefined, 'test')).toEqual([]);
        expect(compileBackgroundMarkers({ patterns: 'nope' }, 'test')).toEqual([]);
    });
});

describe('scan / mask', () => {
    it('scans per line, honours section scope, and blanks hits without moving anything', () => {
        const markers = compileBackgroundMarkers({ patterns: [{ section: 'tail', regex: 'shell still running' }] }, 't');
        const lines = ['1 shell still running', 'x', '2 shell still running'];
        const tail: ResolvedSection = { id: 'tail', fromLine: 2, toLine: 3, text: lines[2] };
        const scan = scanBackgroundMarkers(markers, lines, [tail]);
        expect(scan.hits).toEqual([{ line: 2, start: 2, end: 21 }]);
        expect(maskLines(lines, scan)).toEqual(['1 shell still running', 'x', '2'.padEnd(21, ' ')]);
        // A section that does not exist on this frame never matches (as the spec's own scoped guard).
        expect(scanBackgroundMarkers(markers, lines, noSections).signature).toBe('');
    });

    it('signature is order/duplicate independent and empty when nothing matches', () => {
        const m = compileBackgroundMarkers(SHELL, 't');
        expect(scanBackgroundMarkers(m, ['a'], noSections).signature).toBe('');
        expect(scanBackgroundMarkers(m, ['1 shell still running', '1 shell still running'], noSections).signature)
            .toBe('1 shell still running');
    });
});

describe('BackgroundMarkerBound state machine (fake clock)', () => {
    /** One frame: observe, then fold the probe verdict in, like the driver does. */
    function frame(b: BackgroundMarkerBound, now: number, lines: string[], markerOnly = true) {
        const scan = b.observe(lines, noSections);
        return b.update(now, markerOnly, scan.sample);
    }

    it('marker-only: one notice at the notice bound, release at the release bound, nothing earlier', () => {
        const b = bound();
        let notices = 0;
        let releasedAt: number | null = null;
        for (let t = 0; t <= BACKGROUND_MARKER_RELEASE_MS + 5_000; t += 5_000) {
            const r = frame(b, t, SCREEN);
            if (r.notice) {
                notices++;
                expect(t).toBe(BACKGROUND_MARKER_NOTICE_MS + 5_000); // first quiet frame is t=5s
                expect(r.notice.kind).toBe('background_hold');
                expect(r.notice.params.marker).toBe('1 shell still running');
            }
            if (r.released && releasedAt === null) releasedAt = t;
        }
        expect(notices).toBe(1);
        expect(releasedAt).toBe(BACKGROUND_MARKER_RELEASE_MS + 5_000);
        expect(b.released).toBe(true);
    });

    it('without the bound (no declared markers) nothing is ever noticed or released', () => {
        const b = bound({ patterns: [] });
        expect(b.enabled).toBe(false);
        expect(b.released).toBe(false);
    });

    it('a changed frame, or a probe that says "still working", resets the clock; the notice stays spent', () => {
        const b = bound();
        for (let t = 0; t <= 110_000; t += 10_000) frame(b, t, SCREEN);
        frame(b, 120_000, ['fresh output', ...SCREEN]);          // output arrives
        expect(b.nextWakeMs(120_000)).toBe(5_000);                // counting restarts
        let notices = 0;
        for (let t = 125_000; t <= 125_000 + BACKGROUND_MARKER_NOTICE_MS + 10_000; t += 5_000) {
            if (frame(b, t, ['fresh output', ...SCREEN]).notice) notices++;
        }
        expect(notices).toBe(1);                                  // first notice of the episode, not a repeat
        const c = bound();
        for (let t = 0; t < BACKGROUND_MARKER_RELEASE_MS * 2; t += 5_000) {
            expect(frame(c, t, SCREEN, /* probe: spinner showing */ false)).toEqual({ notice: null, released: false });
        }
    });

    it('a changed or vanished marker is a new episode: latch cleared, notice re-armed', () => {
        const b = bound();
        for (let t = 0; t <= BACKGROUND_MARKER_RELEASE_MS + 5_000; t += 5_000) frame(b, t, SCREEN);
        expect(b.released).toBe(true);
        // While the same marker stays up, the release is latched (the next turn is not re-held).
        expect(frame(b, 1_000_000, SCREEN)).toEqual({ notice: null, released: false });
        expect(b.released).toBe(true);
        // Marker gone ...
        b.observe(['❯ '], noSections);
        expect(b.released).toBe(false);
        // ... and a different job later is a fresh episode with its own notice.
        const other = ['✻ Crunched for 9s · 2 shell still running', '❯ '];
        let notice = false;
        for (let t = 2_000_000; t <= 2_000_000 + BACKGROUND_MARKER_NOTICE_MS + 10_000; t += 5_000) {
            notice = frame(b, t, other).notice !== null || notice;
        }
        expect(notice).toBe(true);
    });
});
