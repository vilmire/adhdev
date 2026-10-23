/**
 * ASKUSERQUESTION-NOT-APPROVAL / REMOTE-ANSWER-PICKER-PARSE: pins the exact
 * classification runStatusTransitionTick's isQuestionPicker computes.
 *
 * interactivePrompt=null is the state a parse failure leaves behind (the
 * daemon-side TUI/spec parser could not turn the captured screen into a
 * structured InteractivePrompt — see fsm-evaluator-claude-checkbox-picker.test
 * and interactive-prompt.test's footer-drift-fallback coverage for the parser
 * side of this same bug). This test pins the CONSEQUENCE one layer up: with no
 * captured prompt, a picker-kind modal must still fall back to waiting_approval
 * (there is nothing else it CAN classify as), and — the fix's target state —
 * once a prompt IS captured, the identical picker-kind modal classifies as
 * waiting_choice instead.
 */

import { describe, expect, it } from 'vitest';
import { runStatusTransitionTick } from '../../../src/providers/completion/status-transition.js';
import { projectServerStatusEvent } from '../../../src/status/status-event.js';
import type { InteractivePrompt } from '../../../src/providers/types/interactive-prompt.js';

import { makeHost, SAMPLE_PROMPT } from './status-transition-picker-host-fixture.js';

describe('runStatusTransitionTick — question-picker vs approval classification', () => {
    it('interactivePrompt=null + rawStatus=waiting_approval + activeModalKind=picker → stays waiting_approval (parse-failure fallback, the bug)', () => {
        const { host, pushed } = makeHost({
            rawStatus: 'waiting_approval',
            activeInteractivePrompt: null,
            activeModalKind: 'picker',
        });

        runStatusTransitionTick(host);

        expect(host.lastStatus).toBe('waiting_approval');
        expect(pushed.some((e: any) => e.event === 'agent:waiting_approval')).toBe(true);
        expect(pushed.some((e: any) => e.event === 'agent:waiting_choice')).toBe(false);
    });

    it('interactivePrompt=<captured> + rawStatus=waiting_approval + activeModalKind=picker → reclassifies to waiting_choice (the fix)', () => {
        const { host, pushed } = makeHost({
            rawStatus: 'waiting_approval',
            activeInteractivePrompt: SAMPLE_PROMPT,
            activeModalKind: 'picker',
        });

        runStatusTransitionTick(host);

        expect(host.lastStatus).toBe('waiting_choice');
        expect(pushed.some((e: any) => e.event === 'agent:waiting_approval')).toBe(false);
        expect(pushed.some((e: any) => e.event === 'agent:waiting_choice')).toBe(true);
    });

    it('interactivePrompt=<captured> but activeModalKind=approval (genuine consent) → approval still wins (mutual exclusion holds)', () => {
        const { host, pushed } = makeHost({
            rawStatus: 'waiting_approval',
            activeInteractivePrompt: SAMPLE_PROMPT,
            activeModalKind: 'approval',
        });

        runStatusTransitionTick(host);

        expect(host.lastStatus).toBe('waiting_approval');
        expect(pushed.some((e: any) => e.event === 'agent:waiting_approval')).toBe(true);
    });

    // CLAUDE.md "Push notification exception": the waiting_choice event is what the
    // server push reads. Drive the real event path and pin what leaves the daemon.
    it('waiting_choice push projection: first question + its option labels only; NOT bounded daemon-side (reported, policy unchanged)', () => {
        const long = 'Q'.repeat(400);
        const prompt: InteractivePrompt = {
            ...SAMPLE_PROMPT,
            questions: [
                { questionId: 'a', header: 'Scope', question: long, multiSelect: false, options: Array.from({ length: 12 }, (_, i) => ({ label: `opt-${i}` })) },
                { questionId: 'b', question: 'SECOND-QUESTION-TEXT', multiSelect: false, options: [{ label: 'SECOND-OPTION' }] },
            ],
        };
        const { host, pushed } = makeHost({ rawStatus: 'waiting_approval', activeInteractivePrompt: prompt, activeModalKind: 'picker' });
        runStatusTransitionTick(host);
        const ev = pushed.find((e: any) => e.event === 'agent:waiting_choice') as Record<string, unknown>;
        expect(ev.modalMessage).toBe(`Scope: ${long}`);
        expect((ev.modalButtons as string[]).length).toBe(12);
        const wire = projectServerStatusEvent(ev) as Record<string, unknown>;
        expect(wire.modalMessage).toBe(`Scope: ${long}`); // untruncated here; the 80-char cut is server-side
        expect(wire.modalButtons).toEqual(ev.modalButtons);
        expect(JSON.stringify(wire)).not.toMatch(/SECOND-/);
        expect(wire).not.toHaveProperty('interactivePrompt');
    });
});
