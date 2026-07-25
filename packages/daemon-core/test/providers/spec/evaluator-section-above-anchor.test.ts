/**
 * Coverage for the section geometry added by the CODEX-FSM-DEGENERATE-STABLE
 * status_tail re-anchor (defect 1):
 *
 *  - `above: K` extends an anchored section K lines ABOVE its anchor line, so
 *    a status block that sits directly above its landmark (codex's live
 *    `Working (…)` spinner above the `› ` composer) stays inside the window
 *    regardless of output volume. The old landmark-less `from_bottom` counts
 *    from the LAST NON-BLANK line of the blank-trimmed viewport, so long
 *    output filled the 12-line window with body text and the spinner escaped.
 *  - `anchor_miss: 'empty'` resolves the section to EMPTY when the anchor is
 *    absent, instead of the historical whole-screen fallback — a whole-screen
 *    status_tail would re-open SPINNER-BODY-SELFMATCH (assistant prose quoting
 *    `esc to interrupt` matching the busy cue) on mid-redraw frames.
 */
import { describe, it, expect } from 'vitest';
import { resolveSections } from '../../../src/providers/spec/evaluator.js';

const LINES = Array.from({ length: 30 }, (_, i) => `body line ${i}`);
// Spinner directly above the composer prompt at the bottom of the screen.
LINES[26] = 'Working (12s · esc to interrupt)';
LINES[27] = '› ';
LINES[28] = '? for shortcuts';
LINES[29] = 'tab to queue message';

function sectionText(sections: ReturnType<typeof resolveSections>, id: string): string {
    return sections.find(s => s.id === id)?.text ?? '<absent>';
}

describe('resolveSections — anchored `above` geometry (codex status_tail re-anchor)', () => {
    const statusTail = {
        anchor: '^›\\s',
        anchor_last: true,
        above: 12,
        anchor_miss: 'empty' as const,
    };

    it('pins the window to the composer landmark, capturing the spinner above it', () => {
        const sections = resolveSections({ status_tail: statusTail }, LINES);
        const text = sectionText(sections, 'status_tail');
        expect(text).toContain('Working (12s · esc to interrupt)');
        expect(text).toContain('› ');
        // Window starts 12 lines above the composer (line 27 → line 15) and
        // runs to the end — NOT the last 12 lines of the screen.
        expect(text).toContain('body line 15');
        expect(text).not.toContain('body line 14');
    });

    it('stays on the landmark as output volume grows (the from_bottom defect)', () => {
        // Push the spinner/composer far down a taller screen: an from_bottom:12
        // window would be all body text here; the anchored window still finds
        // the spinner.
        const tall = Array.from({ length: 60 }, (_, i) => `streamed output ${i}`);
        tall[56] = 'Working (45s · esc to interrupt)';
        tall[57] = '› ';
        const sections = resolveSections({ status_tail: statusTail }, tall);
        const text = sectionText(sections, 'status_tail');
        expect(text).toContain('Working (45s · esc to interrupt)');
        expect(text).not.toContain('streamed output 44');
    });

    it('anchor_last picks the LAST composer line when several match', () => {
        // The earlier prompt sits MORE than `above` lines above the last
        // composer, so the window must exclude it while still capturing the
        // spinner directly above the last composer.
        const lines = ['› earlier prompt'];
        for (let i = 0; i < 17; i++) lines.push(`answer body ${i}`);
        lines.push('Working (3s · esc to interrupt)');
        lines.push('› ');
        const sections = resolveSections({ status_tail: statusTail }, lines);
        const text = sectionText(sections, 'status_tail');
        expect(text).toContain('Working (3s · esc to interrupt)');
        expect(text).not.toContain('› earlier prompt');
    });

    it("anchor_miss: 'empty' resolves EMPTY when the landmark is absent", () => {
        const noComposer = ['only body text', 'nothing anchored here'];
        const sections = resolveSections({ status_tail: statusTail }, noComposer);
        expect(sectionText(sections, 'status_tail')).toBe('');
    });

    it('default anchor-miss behavior (no anchor_miss) still falls back to the whole screen', () => {
        const sections = resolveSections(
            { modal: { anchor: 'Would you like to run the following command\\?' } },
            ['unrelated', 'screen'],
        );
        expect(sectionText(sections, 'modal')).toBe('unrelated\nscreen');
    });

    it('clamps the extended start to line 0 when the anchor is near the top', () => {
        const lines = ['› ', 'footer'];
        const sections = resolveSections({ status_tail: statusTail }, lines);
        expect(sectionText(sections, 'status_tail')).toBe('› \nfooter');
    });
});
