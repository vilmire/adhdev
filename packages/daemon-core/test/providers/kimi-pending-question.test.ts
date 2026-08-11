/**
 * kimi-pending-question — wire.jsonl AskUserQuestion detector +
 * buildKimiInteractiveTuiAnswerSteps keystroke protocol.
 *
 * Record shapes are the LITERAL live kimi 0.34.0 wire.jsonl shapes (captured
 * from ~/.kimi-code/sessions/wd_adhdev_78117b8afba9/session_cc5d676d-…):
 * an AskUserQuestion tool.call loop event carries
 *   event.toolCallId / event.name / event.args.questions[]
 *   (question: { header, question, options: [{ label, description }] })
 * and its answer arrives as a tool.result loop event with the SAME top-level
 * event.toolCallId. A pending question = the LATEST such call with no
 * matching tool.result after it (and no later turn.prompt — the turn moved on).
 *
 * The keystroke protocol was reverse-engineered live against kimi 0.34.0:
 * single-select digit selects+auto-advances; multi-select digits toggle and
 * Tab advances; the review screen submits on Enter. The freeform ("Other")
 * path is mirrored from claude and marked UNVERIFIED in the builder.
 */

import { describe, expect, it } from 'vitest';
import {
    detectKimiPendingQuestion,
    detectKimiPendingQuestionFromRecords,
} from '../../src/providers/kimi-pending-question.js';
import { buildKimiInteractiveTuiAnswerSteps } from '../../src/providers/types/interactive-prompt.js';
import type { InteractivePrompt } from '../../src/providers/types/interactive-prompt.js';

// ── wire.jsonl record builders (literal live shapes) ─────────────────────────

function promptRow(text = 'set up the release') {
    return { type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 1785357360000 };
}

function askCallRow(callId: string, questions: unknown[], time = 1785357370000) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.call', uuid: `u-${callId}`, turnId: '1', step: 12,
            toolCallId: callId, name: 'AskUserQuestion',
            args: { questions },
        },
        time,
    };
}

function toolResultRow(callId: string, time = 1785357375000) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.result', parentUuid: `u-${callId}`, toolCallId: callId,
            result: { output: 'answers recorded' },
        },
        time,
    };
}

function bashCallRow(callId: string, time = 1785357371000) {
    return {
        type: 'context.append_loop_event',
        event: {
            type: 'tool.call', uuid: `u-${callId}`, turnId: '1', step: 13,
            toolCallId: callId, name: 'Bash',
            args: { command: 'touch /tmp/x' },
        },
        time,
    };
}

const COLORS_QUESTION = {
    header: 'Colors',
    question: 'Pick any colors?',
    options: [
        { label: 'Red', description: 'warm' },
        { label: 'Green', description: 'calm' },
        { label: 'Blue', description: 'cold' },
    ],
};

// ── detector ─────────────────────────────────────────────────────────────────

describe('detectKimiPendingQuestionFromRecords', () => {
    it('returns a prompt for an unanswered AskUserQuestion call, promptId = toolCallId', () => {
        const prompt = detectKimiPendingQuestionFromRecords([
            promptRow(),
            askCallRow('tool_abc123', [COLORS_QUESTION]),
        ]);
        expect(prompt).not.toBeNull();
        expect(prompt!.promptId).toBe('tool_abc123');
        expect(prompt!.origin).toBe('cli');
        expect(prompt!.providerType).toBe('kimi');
        expect(prompt!.createdAt).toBe(1785357370000);
        expect(prompt!.questions).toHaveLength(1);
        const q = prompt!.questions[0];
        expect(q.questionId).toBe('q1');
        expect(q.header).toBe('Colors');
        expect(q.question).toBe('Pick any colors?');
        expect(q.multiSelect).toBe(false);
        expect(q.options.map(o => o.label)).toEqual(['Red', 'Green', 'Blue']);
        expect(q.options[0].description).toBe('warm');
        // kimi always renders an "Other" row on screen → allowFreeform, but the
        // row is NEVER added to options (the dashboard supplies its own escape).
        expect(q.allowFreeform).toBe(true);
        expect(q.options.some(o => /other/i.test(o.label))).toBe(false);
    });

    it('returns null once the matching tool.result has landed', () => {
        expect(detectKimiPendingQuestionFromRecords([
            promptRow(),
            askCallRow('tool_abc123', [COLORS_QUESTION]),
            toolResultRow('tool_abc123'),
        ])).toBeNull();
    });

    it('ignores a tool.result for a DIFFERENT toolCallId', () => {
        const prompt = detectKimiPendingQuestionFromRecords([
            promptRow(),
            askCallRow('tool_abc123', [COLORS_QUESTION]),
            bashCallRow('tool_other'),
            toolResultRow('tool_other'),
        ]);
        expect(prompt?.promptId).toBe('tool_abc123');
    });

    it('returns null when a later turn.prompt supersedes the question (turn moved on)', () => {
        expect(detectKimiPendingQuestionFromRecords([
            promptRow('first'),
            askCallRow('tool_abc123', [COLORS_QUESTION]),
            promptRow('never mind, do something else'),
        ])).toBeNull();
    });

    it('latest-wins with multiple AskUserQuestion calls in the tail', () => {
        const prompt = detectKimiPendingQuestionFromRecords([
            promptRow(),
            askCallRow('tool_first', [COLORS_QUESTION], 1785357370000),
            toolResultRow('tool_first', 1785357371000),
            askCallRow('tool_second', [{
                header: 'Deploy',
                question: 'Ship it?',
                options: [{ label: 'Yes' }, { label: 'No' }],
            }], 1785357372000),
        ]);
        expect(prompt?.promptId).toBe('tool_second');
        expect(prompt?.questions[0].options.map(o => o.label)).toEqual(['Yes', 'No']);
    });

    it('normalizes multi_select (snake_case) and multiSelect (camelCase) question flags', () => {
        const snake = detectKimiPendingQuestionFromRecords([
            askCallRow('tool_ms1', [{ ...COLORS_QUESTION, multi_select: true }]),
        ]);
        expect(snake?.questions[0].multiSelect).toBe(true);
        const camel = detectKimiPendingQuestionFromRecords([
            askCallRow('tool_ms2', [{ ...COLORS_QUESTION, multiSelect: true }]),
        ]);
        expect(camel?.questions[0].multiSelect).toBe(true);
    });

    it('a pending non-question tool.call (e.g. Bash awaiting approval) is NOT an interactive prompt', () => {
        // Misroute guard: a kimi approval modal parks on a Bash tool.call with
        // no tool.result — the wire-side twin of the on-screen approval modal.
        // It must never surface as waiting_choice.
        expect(detectKimiPendingQuestionFromRecords([
            promptRow(),
            bashCallRow('tool_bash_pending'),
        ])).toBeNull();
    });

    it('returns null for empty / malformed input', () => {
        expect(detectKimiPendingQuestionFromRecords([])).toBeNull();
        expect(detectKimiPendingQuestionFromRecords([null, 42, 'x', { type: 'weird' }])).toBeNull();
    });

    it('returns null when the latest call has no usable questions', () => {
        expect(detectKimiPendingQuestionFromRecords([
            askCallRow('tool_empty', []),
        ])).toBeNull();
    });
});

describe('detectKimiPendingQuestion (provider gating)', () => {
    it('returns null for non-kimi agent types', () => {
        expect(detectKimiPendingQuestion(undefined, { agentType: 'claude-cli' })).toBeNull();
        expect(detectKimiPendingQuestion(undefined, { agentType: 'kimi' })).toBeNull(); // no cfg
    });
});

// ── answer steps ─────────────────────────────────────────────────────────────

function kimiPrompt(questions: Partial<InteractivePrompt['questions'][number]>[]): InteractivePrompt {
    return {
        promptId: 'tool_abc123',
        origin: 'cli',
        providerType: 'kimi',
        createdAt: 1,
        questions: questions.map((q, i) => ({
            questionId: `q${i + 1}`,
            question: q.question ?? `Q${i + 1}?`,
            multiSelect: q.multiSelect ?? false,
            options: q.options ?? [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
            ...(q.allowFreeform !== false ? { allowFreeform: true } : {}),
        })),
    };
}

describe('buildKimiInteractiveTuiAnswerSteps', () => {
    it('single-select: digit of the selected label, then Enter for the review screen', () => {
        const steps = buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{}]),
            { promptId: 'tool_abc123', answers: { q1: { selectedLabels: ['Green'] } } },
        );
        expect(steps).toEqual(['2', '\r']);
    });

    it('multi-question single-select: one digit per question (digits auto-advance), then review Enter', () => {
        const steps = buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{}, {}]),
            {
                promptId: 'tool_abc123',
                answers: {
                    q1: { selectedLabels: ['Blue'] },
                    q2: { selectedLabels: ['Red'] },
                },
            },
        );
        expect(steps).toEqual(['3', '1', '\r']);
    });

    it('multi-select: one digit per label (toggles), Tab advances, then review Enter', () => {
        const steps = buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{ multiSelect: true }]),
            { promptId: 'tool_abc123', answers: { q1: { selectedLabels: ['Red', 'Blue'] } } },
        );
        expect(steps).toEqual(['1', '3', '\t', '\r']);
    });

    it('defensive: >1 selected labels on a single-select-flagged question still takes the toggle path', () => {
        const steps = buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{ multiSelect: false }]),
            { promptId: 'tool_abc123', answers: { q1: { selectedLabels: ['Red', 'Green'] } } },
        );
        expect(steps).toEqual(['1', '2', '\t', '\r']);
    });

    it('freeform: digit of the trailing "Other" row (options.length + 1), chars, Enter, then review Enter', () => {
        const steps = buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{}]),
            { promptId: 'tool_abc123', answers: { q1: { selectedLabels: [], freeformText: 'Purple' } } },
        );
        // 3 options → "Other" is on-screen option 4.
        expect(steps).toEqual(['4', 'P', 'u', 'r', 'p', 'l', 'e', '\r', '\r']);
    });

    it('throws on an unknown selected label', () => {
        expect(() => buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{}]),
            { promptId: 'tool_abc123', answers: { q1: { selectedLabels: ['Yellow'] } } },
        )).toThrow(/Unknown option/);
    });

    it('throws on a missing answer and on a promptId mismatch', () => {
        expect(() => buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{}]),
            { promptId: 'tool_abc123', answers: {} },
        )).toThrow(/Missing answer/);
        expect(() => buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{}]),
            { promptId: 'tool_STALE', answers: { q1: { selectedLabels: ['Red'] } } },
        )).toThrow(/does not match active prompt/);
    });

    it('throws when a single-select answer carries no label and no freeform', () => {
        expect(() => buildKimiInteractiveTuiAnswerSteps(
            kimiPrompt([{}]),
            { promptId: 'tool_abc123', answers: { q1: { selectedLabels: [] } } },
        )).toThrow(/Expected one selected label/);
    });
});
