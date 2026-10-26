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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, vi } from 'vitest';
import { readTailJsonlLinesAsync } from '../../src/providers/spec/background-task-detector.js';
import { KimiPendingQuestionReader } from '../../src/providers/kimi-pending-question.js';
import { __resetTranscriptClaimRegistry, claimTranscript, releaseTranscriptOwner, transcriptClaimOwner, transcriptClaimOwnerToken } from '../../src/providers/native-history/transcript-claim-registry.js';
import { recordSentPrompt, __resetSentPromptRegistry } from '../../src/providers/native-history/sent-prompt-registry.js';
const questionStores: string[] = [];
const questionReaders: KimiPendingQuestionReader[] = [];
afterEach(() => {
    for (const reader of questionReaders.splice(0)) reader.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __resetTranscriptClaimRegistry();
    __resetSentPromptRegistry();
    for (const root of questionStores.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function questionStore(tag = 'q', existingRoot?: string, bucket = 'bucket', uuid = 'a0000000-0000-4000-8000-000000000001') {
    const root = existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-reader-'));
    if (!existingRoot) questionStores.push(root);
    const session = path.join(root, 'sessions', bucket, `session_${uuid}`);
    const dir = path.join(session, 'agents', 'main');
    fs.mkdirSync(dir, { recursive: true });
    const wire = path.join(dir, 'wire.jsonl');
    const sidecar = path.join(session, 'state.json');
    fs.writeFileSync(sidecar, JSON.stringify({ workDir: root }));
    fs.writeFileSync(wire, JSON.stringify(askCallRow(tag, [COLORS_QUESTION])) + '\n');
    const cfg: any = { source: { kind: 'jsonl', path: '${KIMI_TEST_STORE}/sessions/*/session_*/agents/main', file_pattern: 'wire.jsonl', session_id_from: 'dir_uuid', workspace_from_sidecar: { rel_path: '../../state.json', workspace_path: '$.workDir' } } };
    const input = { agentType: 'kimi', workspace: root, instanceId: `owner-${tag}`, sessionStartedAtMs: 0, envOverrides: { KIMI_TEST_STORE: root } };
    return { root, wire, sidecar, cfg, input, uuid };
}
function questionReader(notify = vi.fn()) {
    const reader = new KimiPendingQuestionReader(notify);
    questionReaders.push(reader);
    return reader;
}

describe('per-incarnation asynchronous Kimi reader', () => {
    it('keeps loading distinct from ready-null, reuses unchanged question projection, and observes append', async () => {
        const f = questionStore();
        const reader = questionReader();
        expect(reader.read(f.cfg, f.input)).toMatchObject({ state: 'loading', prompt: null });
        await reader.whenSettled();
        const ready = reader.read(f.cfg, f.input);
        expect(ready).toMatchObject({ state: 'ready', prompt: { promptId: 'q' } });
        await reader.whenSettled(true);
        expect(reader.read(f.cfg, f.input).prompt).toBe(ready.prompt);
        fs.appendFileSync(f.wire, JSON.stringify(toolResultRow('q')) + '\n');
        await reader.whenSettled(true);
        expect(reader.read(f.cfg, f.input)).toMatchObject({ state: 'ready', prompt: null });
    });

    it('does not share an owner-confirmed source with another owner or incarnation/spawn floor', async () => {
        const f = questionStore();
        const first = questionReader();
        first.read(f.cfg, f.input);
        await first.whenSettled();
        const second = questionReader();
        const other = { ...f.input, instanceId: 'other-owner' };
        second.read(f.cfg, other);
        await second.whenSettled();
        expect(second.read(f.cfg, other)).toMatchObject({ state: 'unavailable', prompt: null, resolution: { outcome: { attribution: 'already_claimed' } } });
        const future = { ...f.input, sessionStartedAtMs: Date.now() + 60_000 };
        expect(first.read(f.cfg, future).prompt).toBeNull();
        await first.whenSettled();
        expect(first.read(f.cfg, future).state).toBe('unavailable');
    });

    it('invalidates provider/workspace/env/config/pin identities, including effective process fallback', async () => {
        const a = questionStore('A');
        const b = questionStore('B');
        const reader = questionReader();
        reader.read(a.cfg, a.input);
        await reader.whenSettled();
        expect(reader.read(a.cfg, { ...a.input, agentType: 'claude-cli' }).prompt).toBeNull();
        reader.read(b.cfg, { ...b.input, providerSessionId: b.uuid });
        await reader.whenSettled();
        expect(reader.read(b.cfg, { ...b.input, providerSessionId: b.uuid }).prompt?.promptId).toBe('B');
        expect(reader.read(b.cfg, { ...b.input, workspace: a.root, providerSessionId: undefined }).prompt).toBeNull();
        await reader.whenSettled();
        expect(reader.read(b.cfg, { ...b.input, workspace: a.root }).state).toBe('unavailable');
        vi.stubEnv('KIMI_TEST_STORE', a.root);
        const fallback = { ...a.input, envOverrides: {} };
        reader.read(a.cfg, fallback);
        await reader.whenSettled();
        expect(reader.read(a.cfg, fallback).prompt?.promptId).toBe('A');
        vi.stubEnv('KIMI_TEST_STORE', b.root);
        expect(reader.read(a.cfg, fallback).prompt).toBeNull();
        await reader.whenSettled();
        expect(reader.read(a.cfg, fallback).state).toBe('unavailable');
        const missingCfg = { source: { ...a.cfg.source, path: `${a.root}/absent/*` } };
        expect(reader.read(missingCfg, a.input).prompt).toBeNull();
    });

    it('finds a deeply-created source from a negative cache without relying on root mtime', async () => {
        const f = questionStore();
        fs.rmSync(path.dirname(path.dirname(path.dirname(f.wire))), { recursive: true });
        const reader = questionReader();
        reader.read(f.cfg, f.input);
        await reader.whenSettled();
        expect(reader.read(f.cfg, f.input).state).toBe('unavailable');
        const rootRevision = fs.statSync(path.join(f.root, 'sessions')).mtimeMs;
        questionStore('created', f.root);
        expect(fs.statSync(path.join(f.root, 'sessions')).mtimeMs).toBe(rootRevision);
        await reader.whenSettled(true);
        expect(reader.read(f.cfg, f.input).prompt?.promptId).toBe('created');
    });

    it('invalidates sidecar changes and replacement/truncation/same-size rewrites', async () => {
        const f = questionStore();
        const reader = questionReader();
        reader.read(f.cfg, f.input);
        await reader.whenSettled();
        fs.writeFileSync(f.wire + '.new', JSON.stringify(askCallRow('new-inode', [COLORS_QUESTION])) + '\n');
        fs.renameSync(f.wire + '.new', f.wire);
        await reader.whenSettled(true);
        expect(reader.read(f.cfg, f.input).prompt?.promptId).toBe('new-inode');
        fs.writeFileSync(f.wire, JSON.stringify(askCallRow('same-size', [COLORS_QUESTION])) + '\n');
        await reader.whenSettled(true);
        expect(reader.read(f.cfg, f.input).prompt?.promptId).toBe('same-size');
        fs.writeFileSync(f.wire, '');
        await reader.whenSettled(true);
        expect(reader.read(f.cfg, f.input).prompt).toBeNull();
        fs.writeFileSync(f.sidecar, JSON.stringify({ workDir: path.join(f.root, 'other-workspace') }));
        await reader.whenSettled(true);
        expect(reader.read(f.cfg, f.input).state).toBe('unavailable');
    });

    it('rejects late discovery before claim and notification after disposal', async () => {
        const f = questionStore();
        const notify = vi.fn();
        const reader = questionReader(notify);
        let release!: () => void;
        let entered!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const blocked = new Promise<void>(resolve => { entered = resolve; });
        const original = fs.promises.readdir;
        vi.spyOn(fs.promises, 'readdir').mockImplementationOnce(async (...args: any[]) => {
            entered(); await barrier; return (original as any)(...args);
        });
        reader.read(f.cfg, f.input);
        await blocked;
        reader.dispose();
        release();
        await reader.whenSettled();
        expect(transcriptClaimOwner(fs.realpathSync(f.wire))).toBeUndefined();
        expect(notify).not.toHaveBeenCalled();
        expect(reader.read(f.cfg, f.input)).toMatchObject({ state: 'unavailable', prompt: null });
    });

    it('rejects an old identity completion when env/config changes during async discovery', async () => {
        const a = questionStore('old');
        const b = questionStore('current');
        const reader = questionReader();
        let release!: () => void;
        let entered!: () => void;
        const barrier = new Promise<void>(r => { release = r; });
        const blocked = new Promise<void>(r => { entered = r; });
        const original = fs.promises.readdir;
        vi.spyOn(fs.promises, 'readdir').mockImplementationOnce(async (...args: any[]) => { entered(); await barrier; return (original as any)(...args); });
        reader.read(a.cfg, a.input);
        await blocked;
        reader.read(b.cfg, b.input);
        release();
        await reader.whenSettled();
        expect(transcriptClaimOwner(fs.realpathSync(a.wire))).toBeUndefined();
        expect(transcriptClaimOwner(fs.realpathSync(b.wire))).toBe(transcriptClaimOwnerToken(b.input.instanceId));
        expect(reader.read(b.cfg, b.input).prompt?.promptId).toBe('current');
    });
});

describe('concrete Kimi source compatibility', () => {
    it('keeps a concrete file source without manufacturing a claim or sidecar outcome', async () => {
        const f = questionStore('direct');
        const cfg: any = { source: { kind: 'jsonl', path: f.wire } };
        const reader = questionReader();
        reader.read(cfg, f.input);
        await reader.whenSettled();
        expect(reader.read(cfg, f.input)).toMatchObject({ state: 'ready', prompt: { promptId: 'direct' } });
        expect(reader.read(cfg, f.input).resolution?.outcome).toBeUndefined();
        expect(transcriptClaimOwner(fs.realpathSync(f.wire))).toBeUndefined();
    });
});


describe('negative-cache policy invalidation and late tail jobs', () => {
    it('rechecks changed claim ownership from cached candidates without a directory walk', async () => {
        const f = questionStore();
        claimTranscript(fs.realpathSync(f.wire), 'foreign-owner');
        const reader = questionReader();
        reader.read(f.cfg, f.input);
        await reader.whenSettled();
        expect(reader.read(f.cfg, f.input).state).toBe('unavailable');
        const readdir = vi.spyOn(fs.promises, 'readdir');
        releaseTranscriptOwner('foreign-owner');
        reader.read(f.cfg, f.input);
        await reader.whenSettled();
        expect(reader.read(f.cfg, f.input).prompt?.promptId).toBe('q');
        expect(readdir).not.toHaveBeenCalled();
    });

    it('refreshes newly sent prompt evidence without repeating filesystem discovery', async () => {
        const f = questionStore();
        fs.appendFileSync(f.wire, JSON.stringify(promptRow('specific owned prompt')) + '\n');
        recordSentPrompt(f.input.instanceId, 'different unmatched input');
        const reader = questionReader();
        reader.read(f.cfg, f.input);
        await reader.whenSettled();
        expect(reader.read(f.cfg, f.input).state).toBe('unavailable');
        const readdir = vi.spyOn(fs.promises, 'readdir');
        recordSentPrompt(f.input.instanceId, 'specific owned prompt');
        reader.read(f.cfg, f.input);
        await reader.whenSettled();
        expect(reader.read(f.cfg, f.input)).toMatchObject({ state: 'ready', prompt: null }); // later turn superseded the picker
        expect(reader.read(f.cfg, f.input).resolution?.outcome?.attribution).toBe('claimed');
        expect(readdir).not.toHaveBeenCalled();
    });

    it('cannot publish, cache or reclaim after teardown while a tail read is deferred', async () => {
        const f = questionStore('late-tail');
        const notify = vi.fn();
        const reader = questionReader(notify);
        let release!: () => void;
        let entered!: () => void;
        const barrier = new Promise<void>(r => { release = r; });
        const blocked = new Promise<void>(r => { entered = r; });
        const original = fs.promises.open;
        vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: any[]) => {
            const fd = await (original as any)(...args);
            const read = fd.read.bind(fd);
            fd.read = async (...readArgs: any[]) => { entered(); await barrier; return read(...readArgs); };
            return fd;
        });
        reader.read(f.cfg, f.input);
        await blocked;
        reader.dispose();
        releaseTranscriptOwner(transcriptClaimOwnerToken(f.input.instanceId));
        release();
        await reader.whenSettled();
        expect(transcriptClaimOwner(fs.realpathSync(f.wire))).toBeUndefined();
        expect(notify).not.toHaveBeenCalled();
        expect(reader.read(f.cfg, f.input)).toMatchObject({ state: 'unavailable', prompt: null });
        let actualReads = 0;
        vi.mocked(fs.promises.open).mockImplementation(async (...args: any[]) => {
            const fd = await (original as any)(...args);
            const read = fd.read.bind(fd);
            fd.read = async (...readArgs: any[]) => { actualReads++; return read(...readArgs); };
            return fd;
        });
        expect((await readTailJsonlLinesAsync(f.wire, 512 * 1024))?.records.length).toBe(1);
        expect(actualReads).toBe(1); // disposed job never installed the shared tail cache
    });
});

describe('owner-free background snapshots using the sealed Kimi reader', () => {
    function backgroundReader(notify = vi.fn(), currentInput?: () => any) {
        const reader = new KimiPendingQuestionReader(notify, undefined, undefined, currentInput, true);
        questionReaders.push(reader);
        return reader;
    }
    function rows() {
        return [
            { type: 'turn.prompt', input: [{ type: 'text', text: 'start' }] },
            { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'background', name: 'Bash', args: { run_in_background: true } } },
        ].map(r => JSON.stringify(r)).join('\n') + '\n';
    }
    it.each(['dispose', 'identity', 'config', 'append', 'rotate'] as const)('rejects late background publication across %s during tail I/O', async action => {
        const f = questionStore(`bg-${action}`);
        fs.writeFileSync(f.wire, rows());
        let input: any = { ...f.input, instanceId: undefined };
        const published: Array<boolean | undefined> = [];
        let reader!: KimiPendingQuestionReader;
        const notify = vi.fn(() => published.push((reader as any).snapshot.background?.active));
        reader = backgroundReader(notify, () => input);
        const original = fs.promises.open;
        let release!: () => void; let entered!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const reached = new Promise<void>(resolve => { entered = resolve; });
        vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: any[]) => {
            const fd = await (original as any)(...args); const read = fd.read.bind(fd);
            fd.read = async (...readArgs: any[]) => { entered(); await barrier; return read(...readArgs); };
            return fd;
        });
        expect(reader.read(f.cfg, input).state).toBe('loading');
        await reached;
        if (action === 'dispose') reader.dispose();
        if (action === 'identity') { input = { ...input, providerSessionId: 'b0000000-0000-4000-8000-000000000002' }; reader.read(f.cfg, input); }
        if (action === 'config') reader.read({ source: { ...f.cfg.source, path: `${f.root}/missing/*` } }, input);
        const clear = JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'new turn' }] }) + '\n';
        if (action === 'append') fs.appendFileSync(f.wire, clear);
        if (action === 'rotate') { fs.writeFileSync(f.wire + '.new', clear); fs.renameSync(f.wire + '.new', f.wire); }
        notify.mockClear(); release();
        await reader.whenSettled();
        if (action === 'dispose') {
            expect(reader.read(f.cfg, input)).toMatchObject({ state: 'unavailable' });
            expect(notify).not.toHaveBeenCalled();
        } else if (action === 'identity' || action === 'config') {
            expect((reader as any).snapshot).toMatchObject({ state: 'unavailable' });
            expect((reader as any).snapshot.background).toBeUndefined();
        } else {
            await reader.whenSettled(true);
            expect((reader as any).snapshot).toMatchObject({ state: 'ready', background: { active: false } });
            // No old active snapshot was published while the seal was changing.
            expect(published).not.toContain(true);
        }
        expect(transcriptClaimOwner(fs.realpathSync(f.wire))).toBeUndefined();
    });
});
