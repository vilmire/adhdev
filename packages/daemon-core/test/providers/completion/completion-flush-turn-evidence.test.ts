/**
 * completion-flush.ts's emitGeneratingCompleted — the SINGLE chokepoint every
 * verdict site in status-transition.ts / completion-flush.ts / stall-rescue.ts
 * funnels through (wiring-unification C5/C-W5, phase-C-W5 brief §1). Pins:
 * the emit* call is made exactly once per completion, `strength` never
 * disagrees with the wire event's own `isWeakCompletionEvidence` weakness,
 * `blockReason` narrows to the closed TurnEndBlockReason enum, and the
 * function does not throw / does not compute a second, independent verdict.
 */
import { describe, expect, it, vi } from 'vitest';
import { emitGeneratingCompleted, type CompletionEmitHost } from '../../../src/providers/completion/completion-flush.js';
import { createTurnEvidencePort } from '../../../src/providers/turn-evidence-port.js';
import type { TurnEvidence } from '@adhdev/mesh-shared';

function makeHost(overrides: Partial<CompletionEmitHost> = {}): { host: CompletionEmitHost; observed: TurnEvidence[]; pushed: any[] } {
    const observed: TurnEvidence[] = [];
    const pushed: any[] = [];
    const port = createTurnEvidencePort({ observe: (e) => { observed.push(e); } });
    const host: CompletionEmitHost = {
        instanceId: 'sess_1',
        settings: {},
        busyEpoch: 0,
        lastCompletionSummary: null,
        lastEmittedCompletion: null,
        pushEvent: (e) => pushed.push(e),
        updateSettings: () => {},
        turnEvidencePort: port,
        currentAttemptRef: () => ({ attemptId: 'attempt_1', generation: 3 }),
        ...overrides,
    };
    return { host, observed, pushed };
}

describe('completion-flush emitGeneratingCompleted -> turn_end evidence (chokepoint)', () => {
    it('emits exactly one turn_end evidence per completion, genuine strength for a clean finish', () => {
        const { host, observed, pushed } = makeHost();
        emitGeneratingCompleted(host, { chatTitle: 'x', duration: 5, timestamp: 1000, taskId: 't1', finalSummary: 'done' });
        expect(pushed).toHaveLength(1);
        expect(observed).toHaveLength(1);
        const ev = observed[0] as Extract<TurnEvidence, { kind: 'turn_end' }>;
        expect(ev.kind).toBe('turn_end');
        expect(ev.strength).toBe('genuine');
        expect(ev.sessionId).toBe('sess_1');
        expect(ev.attemptRef).toEqual({ attemptId: 'attempt_1', generation: 3 });
        expect(ev.taskId).toBeUndefined(); // attemptRef present -> taskId omitted (envelope rule)
        expect(ev.at).toBe(1000);
    });

    it('emits weak strength when evidenceLevel is weak, matching isWeakCompletionEvidence exactly', () => {
        const { host, observed } = makeHost();
        emitGeneratingCompleted(host, {
            chatTitle: 'x', duration: undefined, timestamp: 2000, taskId: 't2',
            evidenceLevel: 'weak',
            completionDiagnostic: { blockReason: 'missing_final_assistant' },
        });
        const ev = observed[0] as Extract<TurnEvidence, { kind: 'turn_end' }>;
        expect(ev.strength).toBe('weak');
        expect(ev.blockReason).toBe('missing_final_assistant');
        // The wire event's own weakness (read off lastEmittedCompletion, computed
        // via the SAME isWeakCompletionEvidence classification) must never disagree.
        expect(host.lastEmittedCompletion?.weak).toBe(true);
    });

    it('emits genuine strength even when completionDiagnostic carries an unrelated field', () => {
        const { host, observed } = makeHost();
        emitGeneratingCompleted(host, {
            chatTitle: 'x', duration: 1, timestamp: 3000,
            completionDiagnostic: { source: 'clean_final_assistant', cleanPath: true },
        });
        const ev = observed[0] as Extract<TurnEvidence, { kind: 'turn_end' }>;
        expect(ev.strength).toBe('genuine');
        expect(ev.blockReason).toBeUndefined();
    });

    it('narrows an unrecognized blockReason string to undefined rather than leaking a free-text value', () => {
        const { host, observed } = makeHost();
        emitGeneratingCompleted(host, {
            chatTitle: 'x', duration: 1, timestamp: 4000,
            completionDiagnostic: { blockReason: 'some_future_reason_not_in_the_closed_enum' },
        });
        const ev = observed[0] as Extract<TurnEvidence, { kind: 'turn_end' }>;
        expect(ev.blockReason).toBeUndefined();
    });

    it('never computes a verdict independent of the wire event: strength is derived from the SAME classification, not recomputed', () => {
        // Break the coupling by constructing a host whose port spy checks the
        // invariant directly — strength must equal weak iff lastEmittedCompletion.weak.
        const { host, observed } = makeHost();
        emitGeneratingCompleted(host, { chatTitle: 'x', duration: 1, timestamp: 5000, evidenceLevel: 'insufficient' });
        const ev = observed[0] as Extract<TurnEvidence, { kind: 'turn_end' }>;
        expect(ev.strength === 'weak').toBe(host.lastEmittedCompletion?.weak);
    });

    it('is a no-op on the evidence path when turnEvidencePort is null (guarded, never throws)', () => {
        const { host, pushed } = makeHost({ turnEvidencePort: null });
        expect(() => emitGeneratingCompleted(host, { chatTitle: 'x', duration: 1, timestamp: 6000 })).not.toThrow();
        expect(pushed).toHaveLength(1); // the wire event itself is unaffected
    });

    it('a throwing sink does not prevent the wire event from being pushed', () => {
        const pushed: any[] = [];
        const port = createTurnEvidencePort({ observe: () => { throw new Error('ledger down'); } });
        const host: CompletionEmitHost = {
            instanceId: 'sess_1', settings: {}, busyEpoch: 0, lastCompletionSummary: null, lastEmittedCompletion: null,
            pushEvent: (e) => pushed.push(e), updateSettings: () => {}, turnEvidencePort: port,
        };
        expect(() => emitGeneratingCompleted(host, { chatTitle: 'x', duration: 1, timestamp: 7000 })).not.toThrow();
        expect(pushed).toHaveLength(1);
    });
});
