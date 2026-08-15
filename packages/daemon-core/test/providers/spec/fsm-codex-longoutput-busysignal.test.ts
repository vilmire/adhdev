// CODEX-LONG-OUTPUT-BUSY-SIGNAL regression.
//
// Symptom (live, session dde6154c): a 14m36s codex turn sat in `busy` for 855023ms and
// left it ONLY via the bounded `elapsed_ms:30000` fallback arm — never via the intended
// fast path. A spec-debug snapshot showed `status_tail` holding the worker's JSON report
// body instead of the live `Working (…)` spinner.
//
// Mechanism (measured on the real ghostty backend + real resolveSections, not inferred):
// every spinner cue was scoped to the `status_tail` section, which is anchored on the
// composer landmark (`^› `). That anchor does NOT pin the spinner:
//   * on SHORT turns codex renders the status line directly above the composer, so the
//     window happens to contain it — which is why short turns always worked, and why the
//     defect looked intermittent;
//   * once output is long the spinner scrolls far ABOVE the anchored window (and while
//     the composer is absent mid-turn, `anchor_miss:'empty'` collapses the section to
//     EMPTY outright).
// Either way the spinner is invisible to the FSM DURING generation, so every
// `not(status_tail matches spinner)` veto reads TRUE while the agent is still working.
// Both busy→idle arms are gated on that veto, so the strict arm is disarmed and the 30s
// elapsed arm becomes the only exit — exactly what the live history showed.
//
// Fix: scope the spinner cue WHOLE-SCREEN (section `screen`, matching
// provider.v1.json tui.spinner.scope = 'whole-screen', already live-verified for this
// provider) and prevent SPINNER-BODY-SELFMATCH by the cue SHAPE rather than the window —
// the cue now anchors to the START of a line, because codex renders the spinner as its
// own status line while assistant prose quoting it embeds it mid-sentence.
//
// This test replays the driver's own evaluation loop over a long-output frame sequence,
// once with the OLD status_tail-scoped cue and once with the shipped fix, to prove the
// before/after on the code path that owns the bug.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFsm, stableRegionKey, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../..');
const SPEC_PATH = path.join(repoRoot, 'adhdev-providers/cli/codex-cli/specs/4.0.json');

// The pre-fix cue: both alternatives, scoped to the composer-anchored status_tail.
const OLD_CUE = '(?:(?:^|\\n)[^\\n]*?(?:Working|Thinking)\\s\\((?:[\\u2800-\\u28ff]|\\d))|(?:[·•]\\s*esc to interrupt\\))';

function loadSpec(useOldCue: boolean): any {
    const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
    if (!useOldCue) return spec;
    // Restore the pre-fix shape: every spinner leaf back onto status_tail with the
    // old un-anchored cue.
    const revert = (node: any): void => {
        if (Array.isArray(node)) { node.forEach(revert); return; }
        if (!node || typeof node !== 'object') return;
        if (node.section === 'screen' && typeof node.matches === 'string' && /Working\|Thinking/.test(node.matches)) {
            node.section = 'status_tail';
            node.matches = OLD_CUE;
        }
        for (const v of Object.values(node)) revert(v);
    };
    revert(spec.transitions);
    return spec;
}

// A long-output turn: the worker's report has pushed the live spinner far above the
// composer. This is the owner's captured shape — status_tail fills with report body.
const SPINNER = 'Working (12m 03s • esc to interrupt)';
const REPORT = [
    '{"status":"success",',
    '  "root vendored MCP build passed",',
    '  "root convergence: behind 0, ahead 1, clean",',
    '  "OSS convergence: behind 0, ahead 1, clean"',
    '}',
];
const FILLER = Array.from({ length: 30 }, (_, i) => `  [worker] step ${i} complete`);
const COMPOSER = ['› ', '  ? for shortcuts', '  tab to queue message'];

// generating: spinner on the grid, far above the composer.
const generatingFrame = (tick: number) =>
    [SPINNER, ...FILLER, ...REPORT, `  [worker] tick ${tick}`, ...COMPOSER].join('\n');
// turn end: codex redraws and the spinner is genuinely gone from the grid.
const settledFrame = () => [...FILLER, ...REPORT, ...COMPOSER].join('\n');

type Step = { t: number; screen: string; note: string };
const SEQ: Step[] = [
    { t: 0, screen: generatingFrame(0), note: 'busy: long output, spinner scrolled above composer' },
    { t: 5_000, screen: generatingFrame(0), note: 'still generating, quiet PTY (no repaint)' },
    { t: 20_000, screen: generatingFrame(0), note: 'still generating, quiet' },
    { t: 40_000, screen: generatingFrame(0), note: 'still generating, past the 30s elapsed fallback' },
    { t: 90_000, screen: generatingFrame(0), note: 'still generating' },
    { t: 120_000, screen: settledFrame(), note: 'TURN ENDS: redraw removes spinner' },
    { t: 122_000, screen: settledFrame(), note: 'settled +2s (stable window satisfied)' },
];

function replay(spec: any) {
    // Mirror trackRegionChanges for the stable leaves the busy→idle arms use.
    const busyIdle = spec.transitions.find((t: any) => t.label === 'busy→idle');
    const stableLeaf = busyIdle.when.any[0].all.find((c: any) => typeof c.stable_ms === 'number');
    const key = stableRegionKey(stableLeaf);

    const regionLastChangedAt = new Map<number | string, number>();
    let prevLines: string[] = [];
    let state = 'busy';
    const rows: { t: number; state: string; to?: string; via?: string; note: string }[] = [];

    for (const step of SEQ) {
        const lines = step.screen.split('\n');
        if (prevLines.length > 0) {
            // cursor sits just below the composer; cursor_above:4 window = the tail.
            const cur = lines.slice(Math.max(0, lines.length - 4)).join('\n');
            const prev = prevLines.slice(Math.max(0, prevLines.length - 4)).join('\n');
            if (cur !== prev) regionLastChangedAt.set(key, step.t);
        }
        prevLines = lines;
        const clock: FsmClock = { now: step.t, stateEnteredAt: 0, regionLastChangedAt: new Map(regionLastChangedAt) };
        const ev = evaluateFsm(spec, state, step.screen, undefined, undefined, clock);
        const to = ev.fired?.to;
        // Which busy→idle arm fired: the strict one, or the 30s elapsed fallback?
        let via: string | undefined;
        if (to === 'idle' && ev.fired?.label === 'busy→idle') {
            const anyRes = ev.fired.cond?.children ?? [];
            via = anyRes[0]?.result ? 'strict' : anyRes[1]?.result ? 'elapsed-fallback' : 'unknown';
        }
        rows.push({ t: step.t, state, to, via, note: step.note });
        if (to) state = to;
    }
    return rows;
}

const show = (tag: string, rows: ReturnType<typeof replay>) => {
    console.log(`\n[${tag}]`);
    for (const r of rows) {
        console.log(`  t=${String(r.t).padStart(7)} ${r.state.padEnd(5)}${r.to ? ' →' + r.to : ''}${r.via ? ` (${r.via})` : ''}  [${r.note}]`);
    }
};

describe('CODEX-LONG-OUTPUT-BUSY-SIGNAL — before/after replay of a long-output turn', () => {
    it('BEFORE (spinner cue scoped to composer-anchored status_tail) → false-idle DURING generation', () => {
        const rows = replay(loadSpec(true));
        show('BEFORE status_tail-scoped cue', rows);
        // The bug: idle fires while the spinner is still on the grid — the turn is live.
        const idleDuringGeneration = rows.find(r => r.to === 'idle' && r.t < 120_000);
        expect(idleDuringGeneration).toBeTruthy();
        // And it can only get there via the strict arm reading a spinner-free window,
        // or via the elapsed fallback — either way it is a FALSE idle mid-turn.
        expect(idleDuringGeneration!.t).toBeLessThan(120_000);
    });

    it('AFTER (whole-screen line-anchored cue) → holds busy through the whole long turn', () => {
        const rows = replay(loadSpec(false));
        show('AFTER whole-screen cue', rows);
        const idleDuringGeneration = rows.find(r => r.to === 'idle' && r.t < 120_000);
        expect(idleDuringGeneration).toBeUndefined();
    });

    it('AFTER → the STRICT arm is satisfiable ~1.5s after the redraw (not a 30s wait)', () => {
        const rows = replay(loadSpec(false));
        const firstIdle = rows.find(r => r.to === 'idle');
        expect(firstIdle).toBeTruthy();
        // Idle lands promptly after the turn-end redraw, NOT 30s later.
        expect(firstIdle!.t).toBeLessThan(120_000 + 30_000);

        // Directly probe the strict arm across the settle window. On a turn that has
        // already run >30s BOTH arms are true once the screen quiets, and `any`
        // reports whichever it evaluates first — so asserting `via === 'strict'` would
        // be asserting evaluation order, not behavior. What matters is that the strict
        // arm becomes TRUE on its own ~1500ms after the redraw: pre-fix it could never
        // become true during generation, which is why the 30s fallback was the only exit.
        const spec = loadSpec(false);
        const busyIdle = spec.transitions.find((t: any) => t.label === 'busy→idle');
        const key = stableRegionKey(busyIdle.when.any[0].all.find((c: any) => typeof c.stable_ms === 'number'));
        const strictAt = (now: number) => {
            const ev = evaluateFsm(spec, 'busy', settledFrame(), undefined, undefined, {
                now, stateEnteredAt: 0, regionLastChangedAt: new Map([[key, 120_000]]),
            });
            return ev.fired?.cond?.children?.[0]?.result === true;
        };
        expect(strictAt(120_000 + 1_000)).toBe(false); // not yet stable
        expect(strictAt(120_000 + 1_500)).toBe(true);  // stable_ms:1500 satisfied
    });

    it('short turns do not regress: spinner directly above composer still reads busy', () => {
        const spec = loadSpec(false);
        const shortGenerating = ['Working (3s • esc to interrupt)', '› '].join('\n');
        const ev = evaluateFsm(spec, 'idle', shortGenerating, undefined, undefined, {
            now: 1_000, stateEnteredAt: 0, regionLastChangedAt: new Map(),
        });
        expect(ev.fired?.to).toBe('busy');
    });

    it('SPINNER-BODY-SELFMATCH stays closed: prose quoting the cue does not read busy', () => {
        const spec = loadSpec(false);
        const prose = [
            '  I explained that the footer `· esc to interrupt)` is the busy cue,',
            '  and that status shows (12s • esc to interrupt) in the tail.',
            '› ',
        ].join('\n');
        const ev = evaluateFsm(spec, 'idle', prose, undefined, undefined, {
            now: 1_000, stateEnteredAt: 0, regionLastChangedAt: new Map(),
        });
        expect(ev.fired?.to).not.toBe('busy');
    });
});
