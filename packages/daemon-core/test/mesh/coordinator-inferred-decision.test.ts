import { describe, expect, it } from 'vitest';
import { extractOwnerQuestion, subscribeInferredOwnerDecisions, INFERRED_DECISION_CONTEXT } from '../../src/mesh/coordinator-inferred-decision.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';

// Live QA 2026-10-29 (claude-cli haiku coordinator). Bodies are reconstructed around the two
// quoted question lines; the real transcripts are not kept.
const MSG_DECISION_FOR_YOU = [
    'The refinery run finished with two failing gates and I need a direction.',
    '',
    'Decision for you',
    '1. Re-run the failing gates once more on the same branch',
    '2. Fix the lint failure first, then re-run everything',
    '3. Skip the flaky gate and merge now',
    '',
    'Which one should I use?',
].join('\n');

const MSG_CODEX_RUN = [
    'The Codex worker is still running and has used 40 minutes.',
    'Options:',
    '1. Let the Codex run finish',
    '2. Cancel it and relaunch with a smaller scope',
    '',
    'Should I let the Codex run finish, or cancel…?',
].join('\n');

describe('extractOwnerQuestion (strict)', () => {
    it('extracts "Decision for you 1./2./3. … Which one should I use?"', () => {
        const q = extractOwnerQuestion(MSG_DECISION_FOR_YOU)!;
        expect(q.question).toBe('Which one should I use?');
        expect(q.options.map(o => o.label)).toEqual([
            'Re-run the failing gates once more on the same branch',
            'Fix the lint failure first, then re-run everything',
            'Skip the flaky gate and merge now',
        ]);
    });

    it('extracts the Codex finish-or-cancel question when it carries numbered options', () => {
        const q = extractOwnerQuestion(MSG_CODEX_RUN)!;
        expect(q.question).toContain('Should I let the Codex run finish, or cancel');
        expect(q.options).toHaveLength(2);
    });

    it('negatives: a bare either/or question without a numbered list is NOT inferred', () => {
        expect(extractOwnerQuestion('Should I let the Codex run finish, or cancel…?')).toBeNull();
        expect(extractOwnerQuestion('All done.\n\nShould I let the Codex run finish, or cancel it?')).toBeNull();
    });

    it('negatives: a numbered status summary ending in a generic question is NOT inferred (no header cue)', () => {
        const summary = ['Merged these:', '1. fix A', '2. fix B', '3. fix C', '', 'Should I merge the rest?'].join('\n');
        expect(extractOwnerQuestion(summary)).toBeNull();
    });

    it('negatives: the message does not END with the question', () => {
        expect(extractOwnerQuestion(MSG_DECISION_FOR_YOU + '\n\nThanks.')).toBeNull();
    });

    it('negatives: wrong option counts, non-sequential numbers, no cue in the question', () => {
        expect(extractOwnerQuestion('Options:\n1. only one\n\nWhich one should I use?')).toBeNull();
        expect(extractOwnerQuestion('Options:\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n\nWhich one should I use?')).toBeNull();
        expect(extractOwnerQuestion('Options:\n1. a\n3. b\n\nWhich one should I use?')).toBeNull();
        expect(extractOwnerQuestion('Options:\n1. a\n2. b\n\nAnything else?')).toBeNull();
    });

    it('negatives: empty / non-string', () => {
        expect(extractOwnerQuestion('')).toBeNull();
        expect(extractOwnerQuestion(null)).toBeNull();
        expect(extractOwnerQuestion(undefined)).toBeNull();
    });
});

describe('subscribeInferredOwnerDecisions', () => {
    function harness(body: string | null, opts: { registered?: boolean; coordinator?: boolean } = {}) {
        const bus = createSessionLifecycleBus();
        const registered: Array<{ meshId: string; question: string }> = [];
        subscribeInferredOwnerDecisions({
            bus,
            coordinatorMeshOf: (sid) => (opts.coordinator === false ? null : sid === 'coord-1' ? 'mesh-1' : null),
            readFinalMessage: async () => body,
            decisionRegisteredSince: () => opts.registered === true,
            register: (meshId, q) => { registered.push({ meshId, question: q.question }); },
        });
        const turn = (phase: 'started' | 'committed', attemptId = 'plain:a1', sessionId = 'coord-1', outcome: any = 'completed') =>
            bus.emit({ kind: 'turn', phase, sessionId, attemptId, generation: 1, ...(phase === 'committed' ? { outcome, strength: 'strong' } : {}), at: Date.now() } as any);
        return { registered, turn };
    }
    const settle = () => new Promise(r => setTimeout(r, 10));

    it('registers a decision when a coordinator turn ends with a numbered-options question and no decision was written', async () => {
        const h = harness(MSG_DECISION_FOR_YOU);
        h.turn('started'); h.turn('committed'); await settle();
        expect(h.registered).toEqual([{ meshId: 'mesh-1', question: 'Which one should I use?' }]);
    });

    it('does nothing when the coordinator already registered a decision during the turn', async () => {
        const h = harness(MSG_DECISION_FOR_YOU, { registered: true });
        h.turn('started'); h.turn('committed'); await settle();
        expect(h.registered).toEqual([]);
    });

    it('ignores non-coordinator sessions, non-plain attempts and non-completed outcomes', async () => {
        const a = harness(MSG_DECISION_FOR_YOU, { coordinator: false });
        a.turn('committed'); await settle();
        expect(a.registered).toEqual([]);
        const b = harness(MSG_DECISION_FOR_YOU);
        b.turn('committed', 'task:xyz'); await settle();
        expect(b.registered).toEqual([]);
        const c = harness(MSG_DECISION_FOR_YOU);
        c.turn('committed', 'plain:a2', 'coord-1', 'failed'); await settle();
        expect(c.registered).toEqual([]);
    });

    it('does nothing for an ordinary final message', async () => {
        const h = harness('Merged. Nothing pending.');
        h.turn('started'); h.turn('committed'); await settle();
        expect(h.registered).toEqual([]);
    });

    it('marks inferred items with a stable context string', () => {
        expect(INFERRED_DECISION_CONTEXT).toMatch(/Inferred/);
    });
});
