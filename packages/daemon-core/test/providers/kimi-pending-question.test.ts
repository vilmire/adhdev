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
    buildKimiSelectorAnswerSteps,
    detectKimiIdleSelectorPrompt,
    detectKimiPendingQuestion,
    detectKimiPendingQuestionFromRecords,
    KIMI_TUI_SELECTOR_PROMPT_PREFIX,
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

// ── built-in idle/cache-expired selector (screen-based) ──────────────────────

// Literal live capture (kimi 0.34, Spec Debug screen section, 2026-08-12):
// the selector box kimi draws when a message arrives after a long idle and
// the prompt cache has expired. NOT an AskUserQuestion tool call — the wire
// never carries it.
function idleSelectorScreen(opts: { idleLine?: string; cursor?: number } = {}): string {
    const rows = [
        'Compact and continue    one-time compact cost · cheapest way to keep th...',
        'Start a new session     zero context cost · best for a new task',
        'Continue as-is          full history kept · highest cost per turn',
        "Don't ask me again",
    ];
    const cursor = opts.cursor ?? 0;
    return [
        '  prior assistant output line',
        ' ──────────────────────────────────────────────────────────────────────────────',
        `  ${opts.idleLine ?? 'This session has been idle for 32m and is ~392k tokens.'}`,
        '  ↑↓ navigate · Enter select · Esc cancel',
        '',
        '  Cache expired — the next message re-sends the entire history at full price.',
        ...rows.map((row, i) => (i === cursor ? `   ❯ ${row}` : `     ${row}`)),
        '',
        ' ──────────────────────────────────────────────────────────────────────────────',
        ' yolo  K3 thinking: high  ~/Work/adhdev  main [±]',
        '                                                        context: 39% (392k/1M)',
    ].join('\n');
}

describe('detectKimiIdleSelectorPrompt', () => {
    it('parses the live idle selector into a single-question prompt with 4 options', () => {
        const prompt = detectKimiIdleSelectorPrompt(idleSelectorScreen());
        expect(prompt).not.toBeNull();
        expect(prompt!.promptId.startsWith(KIMI_TUI_SELECTOR_PROMPT_PREFIX)).toBe(true);
        expect(prompt!.providerType).toBe('kimi');
        expect(prompt!.questions).toHaveLength(1);
        const q = prompt!.questions[0];
        expect(q.question).toBe('Cache expired — the next message re-sends the entire history at full price.');
        expect(q.header).toBe('This session has been idle for 32m and is ~392k tokens.');
        expect(q.multiSelect).toBe(false);
        expect(q.options.map((o) => o.label)).toEqual([
            'Compact and continue',
            'Start a new session',
            'Continue as-is',
            "Don't ask me again",
        ]);
        expect(q.options[0].description).toBe('one-time compact cost · cheapest way to keep th...');
        expect(q.options[3].description).toBeUndefined();
    });

    it('promptId is stable while only the volatile idle-minutes title changes', () => {
        const a = detectKimiIdleSelectorPrompt(idleSelectorScreen());
        const b = detectKimiIdleSelectorPrompt(idleSelectorScreen({
            idleLine: 'This session has been idle for 47m and is ~392k tokens.',
        }));
        expect(a!.promptId).toBe(b!.promptId);
    });

    it('returns null without the title, without the hint, or without a ❯ cursor row', () => {
        const screen = idleSelectorScreen();
        const noTitle = screen.split('\n').filter((l) => !l.includes('This session has been idle')).join('\n');
        expect(detectKimiIdleSelectorPrompt(noTitle)).toBeNull();
        const noHint = screen.split('\n').filter((l) => !l.includes('Enter select')).join('\n');
        expect(detectKimiIdleSelectorPrompt(noHint)).toBeNull();
        const noCursor = screen.replace('   ❯ Compact', '     Compact');
        expect(detectKimiIdleSelectorPrompt(noCursor)).toBeNull();
    });

    it('returns null on an empty screen and on the settled composer', () => {
        expect(detectKimiIdleSelectorPrompt('')).toBeNull();
        expect(detectKimiIdleSelectorPrompt(' yolo  K3 thinking: high  ~/Work/adhdev  main [±]')).toBeNull();
    });
});

describe('buildKimiSelectorAnswerSteps', () => {
    function selectorPrompt() {
        const prompt = detectKimiIdleSelectorPrompt(idleSelectorScreen());
        if (!prompt) throw new Error('fixture did not parse');
        return prompt;
    }

    it('cursor already on the target: a bare Enter', () => {
        const prompt = selectorPrompt();
        const steps = buildKimiSelectorAnswerSteps(
            prompt,
            { promptId: prompt.promptId, answers: { q1: { selectedLabels: ['Compact and continue'] } } },
            idleSelectorScreen(),
        );
        expect(steps).toEqual(['\r']);
    });

    it('navigates DOWN from the live cursor row, then Enter', () => {
        const prompt = selectorPrompt();
        const steps = buildKimiSelectorAnswerSteps(
            prompt,
            { promptId: prompt.promptId, answers: { q1: { selectedLabels: ['Continue as-is'] } } },
            idleSelectorScreen(),
        );
        expect(steps).toEqual(['\x1b[B', '\x1b[B', '\r']);
    });

    it('navigates UP when the live cursor sits below the target', () => {
        const prompt = selectorPrompt();
        const steps = buildKimiSelectorAnswerSteps(
            prompt,
            { promptId: prompt.promptId, answers: { q1: { selectedLabels: ['Compact and continue'] } } },
            idleSelectorScreen({ cursor: 2 }),
        );
        expect(steps).toEqual(['\x1b[A', '\x1b[A', '\r']);
    });

    it('throws on freeform, on multiple labels, and on an unknown label', () => {
        const prompt = selectorPrompt();
        expect(() => buildKimiSelectorAnswerSteps(
            prompt,
            { promptId: prompt.promptId, answers: { q1: { selectedLabels: [], freeformText: 'x' } } },
            idleSelectorScreen(),
        )).toThrow(/no freeform/);
        expect(() => buildKimiSelectorAnswerSteps(
            prompt,
            { promptId: prompt.promptId, answers: { q1: { selectedLabels: ['Compact and continue', 'Continue as-is'] } } },
            idleSelectorScreen(),
        )).toThrow(/Expected one selected label/);
        expect(() => buildKimiSelectorAnswerSteps(
            prompt,
            { promptId: prompt.promptId, answers: { q1: { selectedLabels: ['Bogus'] } } },
            idleSelectorScreen(),
        )).toThrow(/Unknown option/);
    });
});
