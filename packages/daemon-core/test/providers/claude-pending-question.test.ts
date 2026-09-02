/**
 * claude-pending-question — native JSONL AskUserQuestion pending detector.
 *
 * Record shapes below are the LITERAL live Claude Code transcript shapes,
 * captured from ~/.claude/projects/-Users-vilmire-Work-adhdev/
 * f0ef0fb3-928c-4337-a2ad-5466b45f9bd6.jsonl (plain TUI session, no
 * --ax-screen-reader):
 *
 *   assistant line → message.content[] holds
 *     { type:'tool_use', id:'toolu_…', name:'AskUserQuestion',
 *       input:{ questions:[{ question, header, multiSelect,
 *               options:[{ label, description, preview }] }] } }
 *   user line      → message.content[] holds
 *     { type:'tool_result', tool_use_id:'toolu_…', content:'Your questions
 *       have been answered: …' }
 *
 * The wrap-fidelity test uses the real Korean label/description pair from that
 * capture, because it is exactly the case the screen scrape cannot solve: on
 * screen the long label wraps to a continuation line indented identically to a
 * description row.
 *
 * The detector logic is imported from src — this file defines NO copy of it.
 */

import { describe, expect, it } from 'vitest';
import {
    detectClaudePendingQuestion,
    detectClaudePendingQuestionFromRecords,
} from '../../src/providers/claude-pending-question.js';
import { detectClaudeAskUserQuestionPromptFromTuiPages } from '../../src/providers/types/interactive-prompt.js';

// ── transcript record builders (literal live shapes) ─────────────────────────

function askUseRow(toolUseId: string, questions: unknown[], timestamp = '2026-09-01T05:30:46.507Z') {
    return {
        type: 'assistant',
        uuid: `uuid-${toolUseId}`,
        timestamp,
        sessionId: 'f0ef0fb3-928c-4337-a2ad-5466b45f9bd6',
        cwd: '/Users/vilmire/Work/adhdev',
        message: {
            id: `msg_${toolUseId}`,
            role: 'assistant',
            content: [
                { type: 'text', text: '결정이 필요합니다.' },
                {
                    type: 'tool_use',
                    id: toolUseId,
                    name: 'AskUserQuestion',
                    input: { questions },
                },
            ],
        },
    };
}

function toolResultRow(toolUseId: string, timestamp = '2026-09-01T05:31:22.794Z') {
    return {
        type: 'user',
        uuid: `uuid-res-${toolUseId}`,
        timestamp,
        sessionId: 'f0ef0fb3-928c-4337-a2ad-5466b45f9bd6',
        message: {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: 'Your questions have been answered: "…"="…"',
            }],
        },
    };
}

function userTextRow(text = '다음 단계로 가자') {
    return {
        type: 'user',
        timestamp: '2026-09-01T05:40:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text }] },
    };
}

/** The live capture's question — long label + description + emoji. */
function liveQuestion() {
    return {
        question: 'Codex worker 가 사용자의 다른 MCP 서버를 봐도 됩니까? (①안 채택 여부가 여기서 갈립니다)',
        header: 'MCP 격리 범위',
        multiSelect: false,
        options: [
            {
                label: '⚠️ 렌더링은 OK, 모달이 안 닫힘',
                description: 'provider contract 에 worker config_override 추가. 좁은 변경.',
                preview: '①안 — config_override\n\n변경: provider.v1.json',
            },
            {
                label: '❌ 렌더링이 아직 깨짐',
                description: '질문문이 잘리거나 라벨이 쪼개짐',
            },
        ],
    };
}

describe('detectClaudePendingQuestionFromRecords', () => {
    it('reports the pending question when no tool_result has landed', () => {
        const prompt = detectClaudePendingQuestionFromRecords([
            userTextRow('MCP 격리 조사해줘'),
            askUseRow('toolu_01A3X9xd6hFnQ64bsFeYfwwf', [liveQuestion()]),
        ]);
        expect(prompt).not.toBeNull();
        expect(prompt!.promptId).toBe('toolu_01A3X9xd6hFnQ64bsFeYfwwf');
        expect(prompt!.providerType).toBe('claude-cli');
        expect(prompt!.questions).toHaveLength(1);
        expect(prompt!.questions[0].header).toBe('MCP 격리 범위');
    });

    it('preserves long labels, emoji, and per-option descriptions verbatim', () => {
        // This is the whole point of the JSONL source: on screen, the first
        // option's label wraps onto a continuation line indented exactly like
        // the second option's description, making the two indistinguishable.
        const prompt = detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_wrapcase', [liveQuestion()]),
        ]);
        const options = prompt!.questions[0].options;

        // Label intact on ONE piece — not split at the TUI wrap point.
        expect(options[0].label).toBe('⚠️ 렌더링은 OK, 모달이 안 닫힘');
        expect(options[0].label).not.toContain('\n');
        // Emoji survived (the scrape path damages/drops these glyphs).
        expect(options[0].label.startsWith('⚠️')).toBe(true);
        expect(options[1].label.startsWith('❌')).toBe(true);
        // Each description belongs to ITS OWN option — the failure mode being
        // fixed is option 1's wrapped label being read as option 2's text.
        expect(options[0].description).toContain('config_override');
        expect(options[1].description).toBe('질문문이 잘리거나 라벨이 쪼개짐');
        // Question text is not truncated.
        expect(prompt!.questions[0].question).toContain('①안 채택 여부가 여기서 갈립니다');
    });

    it('clears once the matching tool_result lands', () => {
        expect(detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_resolved', [liveQuestion()]),
            toolResultRow('toolu_resolved'),
        ])).toBeNull();
    });

    it('stays pending when a tool_result carries a DIFFERENT tool_use_id', () => {
        const prompt = detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_mine', [liveQuestion()]),
            toolResultRow('toolu_someone_else'),
        ]);
        expect(prompt?.promptId).toBe('toolu_mine');
    });

    it('latest-wins: an earlier resolved call does not mask a later pending one', () => {
        const prompt = detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_first', [liveQuestion()]),
            toolResultRow('toolu_first'),
            askUseRow('toolu_second', [liveQuestion()]),
        ]);
        expect(prompt?.promptId).toBe('toolu_second');
    });

    it('latest-wins: a resolved LATER call clears even if an earlier one is unresolved', () => {
        expect(detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_stale', [liveQuestion()]),
            askUseRow('toolu_latest', [liveQuestion()]),
            toolResultRow('toolu_latest'),
        ])).toBeNull();
    });

    it('carries the transcript timestamp as createdAt so it does not drift per poll', () => {
        const prompt = detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_ts', [liveQuestion()], '2026-09-01T05:30:46.507Z'),
        ]);
        expect(prompt!.createdAt).toBe(Date.parse('2026-09-01T05:30:46.507Z'));
    });

    it('carries multiSelect through from the tool input', () => {
        const prompt = detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_multi', [{ ...liveQuestion(), multiSelect: true }]),
        ]);
        expect(prompt!.questions[0].multiSelect).toBe(true);
    });

    it('handles multi-question calls', () => {
        const prompt = detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_mq', [
                liveQuestion(),
                { ...liveQuestion(), question: '두 번째 질문', header: '두번째' },
            ]),
        ]);
        expect(prompt!.questions).toHaveLength(2);
        expect(prompt!.questions[1].question).toBe('두 번째 질문');
    });

    it('ignores non-AskUserQuestion tool calls', () => {
        const bashUse = {
            type: 'assistant',
            timestamp: '2026-09-01T05:00:00.000Z',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }],
            },
        };
        expect(detectClaudePendingQuestionFromRecords([bashUse])).toBeNull();
    });

    it('returns null on empty / malformed records rather than throwing', () => {
        expect(detectClaudePendingQuestionFromRecords([])).toBeNull();
        expect(detectClaudePendingQuestionFromRecords([null, 42, 'x', { type: 'weird' }])).toBeNull();
        expect(detectClaudePendingQuestionFromRecords([
            askUseRow('toolu_empty', []),
        ])).toBeNull();
    });

    it('skips a call with no toolu_ id — it could never be shown to clear', () => {
        // Without claude's own tool_use id there is nothing for a tool_result
        // to pair against, so the prompt would be held forever. Let the screen
        // scrape own that picker instead.
        const noId = {
            type: 'assistant',
            timestamp: '2026-09-01T05:00:00.000Z',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [liveQuestion()] } }],
            },
        };
        expect(detectClaudePendingQuestionFromRecords([noId])).toBeNull();
    });
});

describe('native JSONL vs screen scrape on a WRAPPED label (the defect)', () => {
    // The exact case that motivated this module. On an 80-col terminal a long
    // label wraps onto a continuation line indented to the SAME column a
    // description uses, so the two are indistinguishable on screen.
    const LONG_LABEL = '⚠️ 렌더링은 OK 인데 모달이 닫히지 않는 문제가 아직 남아있는 상태입니다 그리고 추가 설명이 더 이어집니다';
    const DESC_1 = '버튼 클릭 이벤트 핸들러가 정상적으로 바인딩되지 않았을 가능성이 있습니다.';
    const LABEL_2 = '❌ 렌더링이 아직 깨져서 라벨이 두 줄로 쪼개져 표시되는 상태입니다';
    const DESC_2 = 'CSS flexbox 레이아웃 설정이 컨테이너 너비를 초과하고 있습니다.';

    /** The picker as claude paints it — LONG_LABEL wrapped across two rows. */
    const wrappedScreen = [
        '현재 화면 상태를 확인해주세요. 어떤 상태인가요?',
        '',
        ' ❯ 1. ⚠️ 렌더링은 OK 인데 모달이 닫히지 않는 문제가 아직 남아있는 상태입니다',
        '      그리고 추가 설명이 더 이어집니다',
        `      ${DESC_1}`,
        `   2. ${LABEL_2}`,
        `      ${DESC_2}`,
        '',
        ' Enter to select · Esc to cancel',
    ].join('\n');

    /** The same call as claude records it in its own transcript. */
    const nativeRecord = askUseRow('toolu_wrapped', [{
        question: '현재 화면 상태를 확인해주세요. 어떤 상태인가요?',
        header: '화면 상태',
        multiSelect: false,
        options: [
            { label: LONG_LABEL, description: DESC_1 },
            { label: LABEL_2, description: DESC_2 },
        ],
    }]);

    it('scrape LOSES the wrapped label — its tail leaks into the description', () => {
        // Documents the defect this module routes around. If a future parser
        // ever solves this on-screen, this expectation flips and that is a
        // signal to re-evaluate, not a regression to paper over.
        const prompt = detectClaudeAskUserQuestionPromptFromTuiPages(
            [{ screenText: wrappedScreen }],
            { promptId: 'control', providerType: 'claude-cli' },
        );
        const options = prompt!.questions[0].options;
        expect(options[0].label).not.toBe(LONG_LABEL);
        // The wrapped remainder is glued onto the FRONT of the description.
        expect(options[0].description).toContain('그리고 추가 설명이 더 이어집니다');
        expect(options[0].description).toContain(DESC_1);
    });

    it('native JSONL recovers label AND description intact for the same picker', () => {
        const options = detectClaudePendingQuestionFromRecords([nativeRecord])!
            .questions[0].options;
        expect(options[0].label).toBe(LONG_LABEL);
        expect(options[0].description).toBe(DESC_1);
        expect(options[1].label).toBe(LABEL_2);
        expect(options[1].description).toBe(DESC_2);
    });
});

describe('detectClaudePendingQuestion (provider / config gating)', () => {
    const jsonlCfg = { source: { kind: 'jsonl' as const, path: '/nonexistent/does-not-exist.jsonl' } };

    it('returns null for every non-claude provider', () => {
        expect(detectClaudePendingQuestion(jsonlCfg as never, { agentType: 'kimi' })).toBeNull();
        expect(detectClaudePendingQuestion(jsonlCfg as never, { agentType: 'codex-cli' })).toBeNull();
        expect(detectClaudePendingQuestion(jsonlCfg as never, { agentType: '' })).toBeNull();
    });

    it('returns null without a jsonl native_history source', () => {
        expect(detectClaudePendingQuestion(undefined, { agentType: 'claude-cli' })).toBeNull();
        expect(detectClaudePendingQuestion(
            { source: { kind: 'sqlite' } } as never,
            { agentType: 'claude-cli' },
        )).toBeNull();
    });

    it('fails open (null, no throw) when the transcript cannot be read', () => {
        expect(detectClaudePendingQuestion(jsonlCfg as never, { agentType: 'claude-cli' })).toBeNull();
    });
});

/**
 * TRANSPORT EQUIVALENCE — the real guard against the two paths drifting apart.
 *
 * This suite exists because a live E2E comparison reported that the scrape
 * "emits a Type something. row and the JSONL path does not". Measuring the
 * scrape settled it the other way: the canonical parser strips that row from
 * `options` and re-encodes it as the per-question boolean `allowFreeform`
 * (parseClaudeInteractiveTuiQuestion). So the freeform escape is carried by a
 * FLAG on both transports, and equivalence must be asserted on the flag — not
 * on a synthesized option row, which would have shifted the keystroke
 * protocol's digits and shown the dashboard a row the TUI never offers.
 */
describe('freeform escape: native JSONL matches the screen scrape', () => {
    const Q = 'Pick one.';
    /**
     * A picker as claude paints it, INCLUDING the freeform escape row, with the
     * `✔ Submit` nav line that routes it to the CANONICAL headered parser.
     */
    const screenWithEscape = [
        '←  ☐ Choice  ✔ Submit  →',
        Q,
        '',
        ' ❯ 1. Alpha',
        '      First option.',
        '   2. Beta',
        '      Second option.',
        '   3. Type something.',
        '',
        ' Enter to select · Esc to cancel',
    ].join('\n');

    const nativeRecord = askUseRow('toolu_freeform', [{
        question: Q,
        header: 'Choice',
        multiSelect: false,
        options: [
            { label: 'Alpha', description: 'First option.' },
            { label: 'Beta', description: 'Second option.' },
        ],
    }]);

    const scraped = () => detectClaudeAskUserQuestionPromptFromTuiPages(
        [{ screenText: screenWithEscape }],
        { promptId: 'control', providerType: 'claude-cli' },
    )!.questions[0];
    const native = () => detectClaudePendingQuestionFromRecords([nativeRecord])!.questions[0];

    it('scrape keeps the escape OUT of options and reports it as allowFreeform', () => {
        // Pins the measured contract this synthesis is matched against. If the
        // scrape ever starts emitting the row as an option, this flips and the
        // native side must be re-derived — not silently left behind.
        const s = scraped();
        expect(s.allowFreeform).toBe(true);
        expect(s.options.map(o => o.label)).toEqual(['Alpha', 'Beta']);
    });

    it('both transports agree on the option list AND on allowFreeform', () => {
        const s = scraped();
        const n = native();
        expect(n.options.map(o => o.label)).toEqual(s.options.map(o => o.label));
        expect(n.allowFreeform).toBe(s.allowFreeform);
        // No phantom row on either side.
        expect(n.options.some(o => /^Type something\.?$/i.test(o.label))).toBe(false);
    });

    it('multi-select pickers carry the escape too (scrape sets it unconditionally)', () => {
        // The scrape's flag does not depend on multiSelect, so the native side
        // must not condition on it either.
        const multiScreen = [
            '←  ☐ Choice  ✔ Submit  →',
            Q,
            '',
            ' ❯ 1. ☐ Alpha',
            '   2. ☐ Beta',
            '   3. Type something.',
            '',
            ' Enter to select · Esc to cancel',
        ].join('\n');
        const s = detectClaudeAskUserQuestionPromptFromTuiPages(
            [{ screenText: multiScreen }],
            { promptId: 'control', providerType: 'claude-cli' },
        )!.questions[0];
        const n = detectClaudePendingQuestionFromRecords([askUseRow('toolu_multi', [{
            question: Q,
            multiSelect: true,
            options: [{ label: 'Alpha' }, { label: 'Beta' }],
        }])])!.questions[0];
        expect(s.allowFreeform).toBe(true);
        expect(n.allowFreeform).toBe(s.allowFreeform);
    });

    it('every question of a multi-question native prompt gets the escape', () => {
        const n = detectClaudePendingQuestionFromRecords([askUseRow('toolu_multiq', [
            { question: 'First?', options: [{ label: 'A' }] },
            { question: 'Second?', options: [{ label: 'B' }] },
        ])])!;
        expect(n.questions).toHaveLength(2);
        expect(n.questions.every(q => q.allowFreeform === true)).toBe(true);
    });
});

/**
 * PARITY on the escape row, across all three parsers (2026-09-02).
 *
 * This block used to pin a MEASURED DIVERGENCE: the headered parser stripped
 * the "Type something." row from `options` while the headerless one left it in,
 * so the same picker produced two different option lists and the keystroke
 * builder picked a different digit per shape.
 *
 * Both scrape parsers now strip it, matching the native JSONL path. The row is
 * an escape hatch, not an option: `allowFreeform` is the only thing it should
 * set, and the builder re-derives its on-screen number as options.length + 1
 * (measured live, claude v2.1.220 — see interactive-prompt.ts).
 */
describe('scrape parity on the escape row (headered and headerless agree)', () => {
    const rows = (nav: boolean) => [
        ...(nav ? ['←  ☐ Choice  ✔ Submit  →'] : []),
        'Pick one.',
        '',
        ' ❯ 1. Alpha',
        '   2. Type something.',
        '',
        ' Enter to select · Esc to cancel',
    ].join('\n');

    const parse = (nav: boolean) => detectClaudeAskUserQuestionPromptFromTuiPages(
        [{ screenText: rows(nav) }],
        { promptId: 'control', providerType: 'claude-cli' },
    )!.questions[0];

    it('both shapes strip the row and set allowFreeform', () => {
        expect(parse(true).options.map(o => o.label)).toEqual(['Alpha']);
        expect(parse(false).options.map(o => o.label)).toEqual(['Alpha']);
        expect(parse(true).allowFreeform).toBe(true);
        expect(parse(false).allowFreeform).toBe(true);
    });
});
