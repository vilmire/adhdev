/**
 * TX-FSM Stage 0 (shadow) — `signal` condition evaluation tests.
 *
 * Locks the two Stage-0 invariants:
 *  1. BEHAVIOR ZERO: a `signal` leaf is pass-through for the real verdict —
 *     it can never change which transition fires, no matter what the injected
 *     snapshot says (or whether one exists at all).
 *  2. SHADOW FIDELITY: the counterfactual verdict (TransitionEval.shadow) is
 *     recorded for every signal-guarded transition, composes through
 *     all/any/not, and fails OPEN when the signal is missing.
 */
import { describe, it, expect } from 'vitest';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import {
    SIGNAL_SNAPSHOT_KIND,
    unavailableSignalSnapshot,
    type SignalSnapshot,
} from '../../../src/providers/spec/signal-envelope.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

const NOW = 1_000_000;

function clk(now = NOW, entered = NOW - 10_000): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

function makeSpec(when: unknown): CliSpecV4 {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'signal-test',
        name: 'signal-test',
        binary: 'true',
        send_message: { submit_key: '\r' },
        sections: {},
        states: [
            { id: 'busy', label: 'busy', initial: true },
            { id: 'idle', label: 'idle' },
        ],
        transitions: [
            { from: 'busy', to: 'idle', when: when as CliSpecV4['transitions'][number]['when'] },
        ],
    } as CliSpecV4;
}

function snapshotWith(signals: Partial<SignalSnapshot['signals']>): SignalSnapshot {
    return {
        kind: SIGNAL_SNAPSHOT_KIND,
        sampledAt: NOW,
        available: true,
        profile: { class: 'native-source', timing: 'floor' },
        signals: {
            final_assistant_present: null,
            in_turn_progress: null,
            transcript_growing: null,
            ...signals,
        },
        detail: { msgCount: 10, sourceMtimeMs: NOW - 1_000, ageMs: 1_000 },
    };
}

const quietScreen = 'some quiet prompt\n❯';

describe('fsm-loader — signal condition validation', () => {
    it('accepts a signal leaf with and without equals', () => {
        expect(validateFsmSpec(makeSpec({ signal: 'transcript_growing' }))).toEqual([]);
        expect(validateFsmSpec(makeSpec({ signal: 'final_assistant_present', equals: false }))).toEqual([]);
    });

    it('accepts signal leaves nested in all/any/not', () => {
        expect(validateFsmSpec(makeSpec({
            all: [
                { matches: '❯' },
                { any: [{ signal: 'in_turn_progress' }, { not: { signal: 'transcript_growing' } }] },
            ],
        }))).toEqual([]);
    });

    it('rejects an empty signal name and a non-boolean equals', () => {
        const errs1 = validateFsmSpec(makeSpec({ signal: '' }));
        expect(errs1.some(e => e.includes('.signal must be a non-empty string'))).toBe(true);
        const errs2 = validateFsmSpec(makeSpec({ signal: 'x', equals: 'yes' }));
        expect(errs2.some(e => e.includes('.equals must be a boolean'))).toBe(true);
    });
});

describe('fsm-evaluator — Stage-0 signal pass-through (behavior zero)', () => {
    it('a signal-only guard FIRES the transition even when the shadow signal is false', () => {
        const spec = makeSpec({ signal: 'transcript_growing' });
        const snap = snapshotWith({ transcript_growing: false });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snap);
        // Stage-0 pass-through: the false signal does NOT block the transition.
        expect(ev.fired?.to).toBe('idle');
        const t = ev.transitions[0];
        expect(t.fires).toBe(true);
        expect(t.condResult).toBe(true);
        // …but the shadow records what the signal-gated verdict WOULD be.
        expect(t.shadow).toEqual({ condResult: false, fires: false, unknown: false });
        expect(t.cond?.kind).toBe('signal');
        expect(t.cond?.signal).toMatchObject({
            name: 'transcript_growing',
            available: true,
            value: false,
            shadowResult: false,
        });
    });

    it('fires identically with NO snapshot at all (fail-open, shadow unknown)', () => {
        const spec = makeSpec({ signal: 'final_assistant_present' });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), null);
        expect(ev.fired?.to).toBe('idle');
        const t = ev.transitions[0];
        expect(t.shadow).toEqual({ condResult: true, fires: true, unknown: true });
        expect(t.cond?.signal?.shadowResult).toBeNull();
    });

    it('fires identically with an UNAVAILABLE snapshot (fail-open)', () => {
        const spec = makeSpec({ signal: 'final_assistant_present' });
        const snap = unavailableSignalSnapshot(NOW, 'no_native_source', { class: 'daemon-owned', timing: 'immediate' });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snap);
        expect(ev.fired?.to).toBe('idle');
        expect(ev.transitions[0].shadow?.unknown).toBe(true);
        expect(ev.transitions[0].cond?.signal?.available).toBe(false);
    });

    it('honors equals:false in the shadow verdict only', () => {
        const spec = makeSpec({ signal: 'transcript_growing', equals: false });
        const snap = snapshotWith({ transcript_growing: true });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snap);
        expect(ev.transitions[0].fires).toBe(true); // pass-through
        expect(ev.transitions[0].shadow).toEqual({ condResult: false, fires: false, unknown: false });
    });

    it('min_hold_ms still gates the real verdict AND the shadow verdict', () => {
        const spec = makeSpec({ signal: 'transcript_growing' });
        spec.transitions[0].min_hold_ms = 60_000;
        const snap = snapshotWith({ transcript_growing: false });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snap);
        expect(ev.fired).toBeNull();
        expect(ev.transitions[0].fires).toBe(false);
        expect(ev.transitions[0].shadow?.fires).toBe(false);
    });
});

describe('fsm-evaluator — signal composition through all/any/not', () => {
    it('all(regex, signal): real verdict follows the regex only; shadow combines both', () => {
        const spec = makeSpec({ all: [{ matches: '^present-line$' }, { signal: 'final_assistant_present' }] });
        const snap = snapshotWith({ final_assistant_present: false });

        // Regex fails → real verdict false, shadow false (definite).
        const miss = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snap);
        expect(miss.fired).toBeNull();
        expect(miss.transitions[0].shadow).toEqual({ condResult: false, fires: false, unknown: false });

        // Regex passes → real verdict true even though the signal is false;
        // shadow says the signal-gated verdict would NOT have fired.
        const hit = evaluateFsm(spec, 'busy', 'present-line', undefined, undefined, clk(), snap);
        expect(hit.fired?.to).toBe('idle');
        expect(hit.transitions[0].shadow).toEqual({ condResult: false, fires: false, unknown: false });
    });

    it('any(regex, signal): a true signal rescues the shadow verdict but the real verdict is regex-driven', () => {
        const spec = makeSpec({ any: [{ matches: '^absent$' }, { signal: 'final_assistant_present' }] });
        const snap = snapshotWith({ final_assistant_present: true });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snap);
        // Real: regex false, signal pass-through true → any true → fires.
        expect(ev.fired?.to).toBe('idle');
        // Shadow: regex false, signal true → would also fire.
        expect(ev.transitions[0].shadow).toEqual({ condResult: true, fires: true, unknown: false });
    });

    it('not(signal): pass-through makes the real verdict false (documented Stage-0 composition); shadow folds the negation', () => {
        const spec = makeSpec({ not: { signal: 'in_turn_progress' } });
        const snap = snapshotWith({ in_turn_progress: true });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snap);
        // Real: signal leaf pass-through true → not → false. Stage 0 ships no
        // spec with a signal condition, so this blocks nothing in practice;
        // it is the deterministic composition rule, locked here.
        expect(ev.fired).toBeNull();
        expect(ev.transitions[0].fires).toBe(false);
        // Shadow: signal true → not → false.
        expect(ev.transitions[0].shadow).toEqual({ condResult: false, fires: false, unknown: false });
    });

    it('unknown signal under all(): definite-false child decides; otherwise unknown', () => {
        const spec = makeSpec({ all: [{ matches: '^absent$' }, { signal: 'final_assistant_present' }] });
        // No snapshot → signal unknown; regex false decides the all() definitely.
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), null);
        expect(ev.transitions[0].shadow).toEqual({ condResult: false, fires: false, unknown: false });

        // Regex true → the unknown signal makes the shadow verdict unknown.
        const spec2 = makeSpec({ all: [{ matches: '^present$' }, { signal: 'final_assistant_present' }] });
        const ev2 = evaluateFsm(spec2, 'busy', 'present', undefined, undefined, clk(), null);
        expect(ev2.transitions[0].shadow?.unknown).toBe(true);
        expect(ev2.transitions[0].shadow?.condResult).toBe(true); // fail-open placeholder
    });

    it('transitions without signal leaves carry NO shadow payload', () => {
        const spec = makeSpec({ matches: '❯' });
        const ev = evaluateFsm(spec, 'busy', quietScreen, undefined, undefined, clk(), snapshotWith({}));
        expect(ev.transitions[0].shadow).toBeUndefined();
    });
});
