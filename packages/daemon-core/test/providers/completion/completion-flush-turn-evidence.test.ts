/**
 * completion-flush.ts's emitGeneratingCompleted — the SINGLE chokepoint every
 * verdict site in status-transition.ts / completion-flush.ts / stall-rescue.ts
 * funnels through (wiring-unification C5/C-W5/C-W5c, phase-C-W5 brief §1).
 * Pins: the emit* call is made exactly once per completion, `strength` never
 * disagrees with the wire event's own `isWeakCompletionEvidence` weakness,
 * `blockReason` narrows to the closed TurnEndBlockReason enum, the function
 * does not throw / does not compute a second, independent verdict, and
 * (C-W5c) NO legacy `agent:generating_completed` wire literal is constructed
 * any more — the port is the sole producer, with `envelope.finalSummary`/
 * `envelope.workerResult` carrying what that literal used to carry.
 */
import { describe, expect, it, vi } from 'vitest';
import { emitGeneratingCompleted, type CompletionEmitHost } from '../../../src/providers/completion/completion-flush.js';
import { createTurnEvidencePort } from '../../../src/providers/turn-evidence-port.js';
import type { TurnEvidence } from '@adhdev/mesh-shared';

function makeHost(overrides: Partial<CompletionEmitHost> = {}): { host: CompletionEmitHost; observed: TurnEvidence[]; observedOpts: any[]; pushed: any[] } {
    const observed: TurnEvidence[] = [];
    const observedOpts: any[] = [];
    const pushed: any[] = [];
    const port = createTurnEvidencePort({ observe: (e, opts) => { observed.push(e); observedOpts.push(opts); } });
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
    return { host, observed, observedOpts, pushed };
}

describe('completion-flush emitGeneratingCompleted -> turn_end evidence (chokepoint)', () => {
    it('C-W5c: constructs NO legacy agent:generating_completed wire event — pushEvent is never called from this path', () => {
        const { host, pushed } = makeHost();
        emitGeneratingCompleted(host, { chatTitle: 'x', duration: 5, timestamp: 1000, taskId: 't1', finalSummary: 'done' });
        expect(pushed).toHaveLength(0);
    });

    it('emits exactly one turn_end evidence per completion, genuine strength for a clean finish', () => {
        const { host, observed } = makeHost();
        emitGeneratingCompleted(host, { chatTitle: 'x', duration: 5, timestamp: 1000, taskId: 't1', finalSummary: 'done' });
        expect(observed).toHaveLength(1);
        const ev = observed[0] as Extract<TurnEvidence, { kind: 'turn_end' }>;
        expect(ev.kind).toBe('turn_end');
        expect(ev.strength).toBe('genuine');
        expect(ev.sessionId).toBe('sess_1');
        expect(ev.attemptRef).toEqual({ attemptId: 'attempt_1', generation: 3 });
        expect(ev.taskId).toBeUndefined(); // attemptRef present -> taskId omitted (envelope rule)
        expect(ev.at).toBe(1000);
    });

    it('carries finalSummary on the envelope opt — content-free evidence body, text only in envelope', () => {
        const { host, observed, observedOpts } = makeHost();
        emitGeneratingCompleted(host, { chatTitle: 'x', duration: 5, timestamp: 1000, finalSummary: 'SENTINEL-final-answer' });
        expect(observedOpts[0]?.envelope?.finalSummary).toBe('SENTINEL-final-answer');
        expect(JSON.stringify(observed[0])).not.toContain('SENTINEL-final-answer');
    });

    it('C-W5c: parses a worker-report-shaped final summary into envelope.workerResult (graph output envelope pointer target)', () => {
        const { host, observedOpts } = makeHost();
        const report = { status: 'completed', changedFiles: ['a.ts'], gitStatus: 'committed', validationResults: 'ok', errors: [], nextAction: 'merge' };
        emitGeneratingCompleted(host, {
            chatTitle: 'x', duration: 1, timestamp: 1000,
            finalSummary: `Done.\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
        });
        expect(observedOpts[0]?.envelope?.workerResult).toEqual(report);
    });

    it('omits envelope.workerResult when the final summary carries no worker-report-shaped JSON (never invents a result)', () => {
        const { host, observedOpts } = makeHost();
        emitGeneratingCompleted(host, { chatTitle: 'x', duration: 1, timestamp: 1000, finalSummary: 'all done, nothing structured to report' });
        expect(observedOpts[0]?.envelope?.workerResult).toBeUndefined();
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
        const { host, observed } = makeHost();
        emitGeneratingCompleted(host, { chatTitle: 'x', duration: 1, timestamp: 5000, evidenceLevel: 'insufficient' });
        const ev = observed[0] as Extract<TurnEvidence, { kind: 'turn_end' }>;
        expect(ev.strength === 'weak').toBe(host.lastEmittedCompletion?.weak);
    });

    it('is a no-op on the evidence path when turnEvidencePort is null (guarded, never throws)', () => {
        const { host, observed } = makeHost({ turnEvidencePort: null });
        expect(() => emitGeneratingCompleted(host, { chatTitle: 'x', duration: 1, timestamp: 6000 })).not.toThrow();
        expect(observed).toHaveLength(0);
    });

    it('a throwing sink does not break emitGeneratingCompleted (guarded, never throws)', () => {
        const port = createTurnEvidencePort({ observe: () => { throw new Error('ledger down'); } });
        const host: CompletionEmitHost = {
            instanceId: 'sess_1', settings: {}, busyEpoch: 0, lastCompletionSummary: null, lastEmittedCompletion: null,
            pushEvent: () => {}, updateSettings: () => {}, turnEvidencePort: port,
        };
        expect(() => emitGeneratingCompleted(host, { chatTitle: 'x', duration: 1, timestamp: 7000 })).not.toThrow();
    });
});
