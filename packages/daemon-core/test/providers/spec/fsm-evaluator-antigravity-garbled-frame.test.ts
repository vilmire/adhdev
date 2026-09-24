/**
 * GARBLED-FRAME FALSE BUSY — antigravity-cli 4.0 spec, busy→idle arm 3
 * (preview live defect 2026-09-24; see the spec's `_garbled_frame_note`).
 *
 * The fixture is the live `mesh_read_terminal` capture of a finished agy worker
 * that sat in `busy` for 80+ minutes: a frozen `⡿  Running command...` line and
 * a stale `esc to cancel` row from an earlier frame above the real idle footer,
 * cursor parked at (0,0). Pure evaluator tests: the clock is set explicitly so
 * each arm's blocker is visible.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadSpec(): CliSpecV4 {
    const repoRoot = path.resolve(TEST_DIR, '../../../../../..');
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'adhdev-providers/cli/antigravity-cli/specs/4.0.json'), 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}
const spec = loadSpec();

const fixture = (name: string) => fs.readFileSync(path.join(TEST_DIR, 'fixtures', name), 'utf8').replace(/\n$/, '');
/** ghostty getText trims trailing blank rows; the capture's last row is the footer. */
const GARBLED = fixture('antigravity-garbled-false-busy-2026-09-24.txt');
const REDRAWN = fixture('antigravity-redrawn-idle-2026-09-24.txt');

const WHOLE_SCREEN = -1;
const CURSOR_ABOVE_4 = 4;

/**
 * `wholeScreenQuietMs` = how long the whole screen has been unchanged. The
 * cursor_above:4 region is always "just changed": with the cursor at row 0 its
 * window is unmeasurable, and the driver invariant resets that clock on every
 * evaluation (driver-degenerate-stable-window) — the live arm-1 blocker.
 */
function clock(busyForMs: number, wholeScreenQuietMs: number): FsmClock {
    const now = 1_000_000;
    return {
        now,
        stateEnteredAt: now - busyForMs,
        regionLastChangedAt: new Map<number | string, number>([
            [WHOLE_SCREEN, now - wholeScreenQuietMs],
            [CURSOR_ABOVE_4, now],
        ]),
    };
}

function busyToIdle(screen: string, cursor: { row: number; col: number }, c: FsmClock) {
    const ev = evaluateFsm(spec, 'busy', screen, cursor, undefined, c);
    const t = ev.transitions.find(x => x.label === 'busy→idle')!;
    return { ev, t };
}

describe('antigravity-cli busy→idle on the live torn frame', () => {
    it('busy→idle carries three arms (strict, braille-vetoed fallback, frozen-screen fallback)', () => {
        const t = spec.transitions.find(x => x.label === 'busy→idle')!;
        expect((t.when as { any: unknown[] }).any).toHaveLength(3);
    });

    it('the torn frame is what fired idle→busy (frozen braille marker in body)', () => {
        const ev = evaluateFsm(spec, 'idle', GARBLED, { row: 0, col: 0 }, undefined, clock(0, 0));
        expect(ev.fired?.to).toBe('busy');
    });

    it('before the fix window: busy (arm 1 unmeasurable, arm 2 braille-vetoed, arm 3 not yet frozen long enough)', () => {
        const { ev } = busyToIdle(GARBLED, { row: 0, col: 0 }, clock(120_000, 5_000));
        expect(ev.fired).toBeNull();
    });

    it('arm 3: whole screen frozen ≥15s and ≥60s in busy → idle', () => {
        const { ev, t } = busyToIdle(GARBLED, { row: 0, col: 0 }, clock(60_000, 15_000));
        expect(t.fires).toBe(true);
        expect(ev.fired?.to).toBe('idle');
    });

    it('arm 3 respects the 60s floor even when frozen', () => {
        const { ev } = busyToIdle(GARBLED, { row: 0, col: 0 }, clock(45_000, 45_000));
        expect(ev.fired).toBeNull();
    });

    it('a live generating frame (footer esc to cancel) never idles, however quiet', () => {
        const lines = REDRAWN.split('\n');
        lines.splice(lines.length - 1, 1, 'esc to cancel                                            Gemini 3.7 Flash · high');
        lines.splice(4, 0, '⣾  Running command...');
        const { ev } = busyToIdle(lines.join('\n'), { row: 8, col: 2 }, clock(600_000, 600_000));
        expect(ev.fired).toBeNull();
    });

    it('an approval modal on screen never idles via arm 3', () => {
        const withModal = GARBLED.replace('  Outcome: completed.', '  Requesting permission for: rm -rf build\nDo you want to proceed?\n> 1. Yes\n  2. No');
        const ev = evaluateFsm(spec, 'busy', withModal, { row: 0, col: 0 }, undefined, clock(600_000, 600_000));
        expect(ev.fired?.to).toBe('approval');
    });

    it('the redrawn (clean) frame idles through arm 1 once its cursor window is stable', () => {
        const c = clock(3_000, 3_000);
        c.regionLastChangedAt.set(CURSOR_ABOVE_4, c.now - 1_600);
        const row = REDRAWN.split('\n').indexOf('> ');
        const { ev } = busyToIdle(REDRAWN, { row, col: 2 }, c);
        expect(ev.fired?.to).toBe('idle');
    });
});
