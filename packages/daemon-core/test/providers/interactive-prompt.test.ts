import { describe, expect, it } from 'vitest';
import {
  buildClaudeInteractiveTuiAnswerSteps,
  buildClaudeInteractiveToolResult,
  detectClaudeAskUserQuestionPromptFromJson,
  detectClaudeAskUserQuestionPromptFromTuiPages,
  interactivePromptFromClaudeAskUserQuestion,
  normalizeInteractivePrompt,
  normalizeInteractivePromptResponse,
} from '../../src/providers/types/interactive-prompt.js';

describe('interactive prompt schema', () => {
  it('normalizes and serializes prompt payloads', () => {
    const prompt = normalizeInteractivePrompt({
      promptId: 'prompt-1',
      origin: 'cli',
      providerType: 'claude-cli',
      createdAt: 123,
      questions: [{
        questionId: 'color',
        header: 'Color',
        question: 'Which colors?',
        multiSelect: true,
        allowFreeform: true,
        options: [
          { label: 'Blue', description: 'Calm', preview: '#0000ff' },
          'Green',
        ],
      }],
    });

    expect(JSON.parse(JSON.stringify(prompt))).toEqual({
      promptId: 'prompt-1',
      origin: 'cli',
      providerType: 'claude-cli',
      createdAt: 123,
      questions: [{
        questionId: 'color',
        header: 'Color',
        question: 'Which colors?',
        multiSelect: true,
        allowFreeform: true,
        options: [
          { label: 'Blue', description: 'Calm', preview: '#0000ff' },
          { label: 'Green' },
        ],
      }],
    });
  });

  it('normalizes responses and builds claude tool_result stdin payloads', () => {
    const response = normalizeInteractivePromptResponse({
      promptId: 'prompt-1',
      answers: {
        color: { selectedLabels: ['Blue'], freeformText: 'teal' },
      },
    });

    expect(buildClaudeInteractiveToolResult(response)).toBe(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'prompt-1',
          content: JSON.stringify({
            answers: {
              color: { selectedLabels: ['Blue'], freeformText: 'teal' },
            },
          }),
          is_error: false,
        }],
      },
    }));
  });
});

describe('claude AskUserQuestion conversion', () => {
  it('converts tool input to InteractivePrompt', () => {
    const prompt = interactivePromptFromClaudeAskUserQuestion({
      questions: [{
        id: 'q-color',
        header: 'Color',
        question: 'Pick a color',
        multiSelect: false,
        options: [
          { label: 'Blue', description: 'Default' },
          { label: 'Red', preview: 'danger' },
        ],
        allowFreeform: true,
      }],
    }, {
      promptId: 'toolu_123',
      providerType: 'claude-cli',
      createdAt: 456,
    });

    expect(prompt).toEqual({
      promptId: 'toolu_123',
      origin: 'cli',
      providerType: 'claude-cli',
      createdAt: 456,
      questions: [{
        questionId: 'q-color',
        header: 'Color',
        question: 'Pick a color',
        multiSelect: false,
        options: [
          { label: 'Blue', description: 'Default' },
          { label: 'Red', preview: 'danger' },
        ],
        allowFreeform: true,
      }],
    });
  });

  it('detects AskUserQuestion tool_use blocks from claude JSON events', () => {
    const prompt = detectClaudeAskUserQuestionPromptFromJson({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_question',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              questionId: 'fruit',
              question: 'Pick fruit',
              multiSelect: true,
              options: [{ label: 'Apple' }, { label: 'Pear' }],
            }],
          },
        }],
      },
    });

    expect(prompt?.promptId).toBe('toolu_question');
    expect(prompt?.questions[0].multiSelect).toBe(true);
    expect(prompt?.questions[0].options.map(option => option.label)).toEqual(['Apple', 'Pear']);
  });

  it('captures live Claude TUI question pages and builds answer key steps', () => {
    const firstPage = `
←  ☐ Favorite color  ☐ Font style  ✔ Submit  →

어떤 색을 가장 좋아하시나요?

❯ 1. 빨강
     Red
  2. 파랑
     Blue
  3. 녹색
     Green
  4. 노랑
     Yellow
  5. Type something.
────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
    const secondPage = `
←  ☐ Favorite color  ☐ Font style  ✔ Submit  →

코딩할 때 어떤 폰트 스타일을 선호하시나요?

❯ 1. monospace
     Fixed-width font
  2. sans-serif
     Proportional sans-serif font
  3. serif
     Proportional serif font
  4. Type something.
────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: firstPage },
      { screenText: secondPage },
    ], { promptId: 'tui-prompt', createdAt: 789 });

    expect(prompt).toEqual({
      promptId: 'tui-prompt',
      origin: 'cli',
      providerType: 'claude-cli',
      createdAt: 789,
      questions: [
        {
          questionId: 'q1',
          header: 'Favorite color',
          question: '어떤 색을 가장 좋아하시나요?',
          multiSelect: false,
          options: [
            { label: '빨강', description: 'Red' },
            { label: '파랑', description: 'Blue' },
            { label: '녹색', description: 'Green' },
            { label: '노랑', description: 'Yellow' },
          ],
          allowFreeform: true,
        },
        {
          questionId: 'q2',
          header: 'Font style',
          question: '코딩할 때 어떤 폰트 스타일을 선호하시나요?',
          multiSelect: false,
          options: [
            { label: 'monospace', description: 'Fixed-width font' },
            { label: 'sans-serif', description: 'Proportional sans-serif font' },
            { label: 'serif', description: 'Proportional serif font' },
          ],
          allowFreeform: true,
        },
      ],
    });
    // q1=빨강(idx 0) → '1', q2=monospace(idx 0) → '1'
    expect(buildClaudeInteractiveTuiAnswerSteps(prompt!, {
      promptId: 'tui-prompt',
      answers: {
        q1: { selectedLabels: ['빨강'] },
        q2: { selectedLabels: ['monospace'] },
      },
    })).toEqual(['1', '1', '\r']);
  });

  it('sends freeform text by selecting Type-something option then typing', () => {
    const screen = [
      '☐ RPS R1 1라운드 — 가위바위보! 무엇을 내시겠어요?',
      '❯ 1. 가위',
      '  2. 바위',
      '  3. 보',
      '  4. Type something.',
      '────────────────────────────────────────────────',
      '  5. Chat about thisEnter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([{ screenText: screen }], {
      promptId: 'freeform-test', createdAt: 0,
    });
    // freeform: select option 4 ("Type something."), type text, Enter, final confirm Enter
    expect(buildClaudeInteractiveTuiAnswerSteps(prompt!, {
      promptId: 'freeform-test',
      answers: { q1: { selectedLabels: [], freeformText: 'hi' } },
    })).toEqual(['4', 'h', 'i', '\r', '\r']);
  });

  it('uses numeric key (1-based) to select each option — no arrow keys needed', () => {
    const screen = [
      '☐ RPS R1 1라운드 — 가위바위보! 무엇을 내시겠어요?',
      '❯ 1. 가위',
      '  2. 바위',
      '  3. 보',
      '  4. Type something.',
      '────────────────────────────────────────────────',
      '  5. Chat about thisEnter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: screen },
    ], { promptId: 'rps-choices', createdAt: 1234 });

    expect(prompt?.questions[0].options.map(option => option.label)).toEqual([
      '가위',
      '바위',
      '보',
      'Type something.',
    ]);

    // 가위=idx 0 → '1', 바위=idx 1 → '2', 보=idx 2 → '3'
    expect(buildClaudeInteractiveTuiAnswerSteps(prompt!, {
      promptId: 'rps-choices',
      answers: { q1: { selectedLabels: ['가위'] } },
    })).toEqual(['1', '\r']);

    expect(buildClaudeInteractiveTuiAnswerSteps(prompt!, {
      promptId: 'rps-choices',
      answers: { q1: { selectedLabels: ['바위'] } },
    })).toEqual(['2', '\r']);

    expect(buildClaudeInteractiveTuiAnswerSteps(prompt!, {
      promptId: 'rps-choices',
      answers: { q1: { selectedLabels: ['보'] } },
    })).toEqual(['3', '\r']);
  });

  it('emits one numeric key per question in multi-question prompts — no cursor drift', () => {
    const makePrompt = (opts: { q1Opts: string[]; q2Opts: string[] }) => ({
      promptId: 'multi-q',
      origin: 'cli' as const,
      providerType: 'claude-cli',
      createdAt: 0,
      questions: [
        {
          questionId: 'q1',
          question: 'Round 1',
          header: 'R1',
          multiSelect: false,
          options: opts.q1Opts.map(l => ({ label: l })),
          allowFreeform: false,
        },
        {
          questionId: 'q2',
          question: 'Round 2',
          header: 'R2',
          multiSelect: false,
          options: opts.q2Opts.map(l => ({ label: l })),
          allowFreeform: false,
        },
      ],
    });

    // Rock(0)→'1', Rock(0)→'1', confirm→'\r'
    expect(buildClaudeInteractiveTuiAnswerSteps(
      makePrompt({ q1Opts: ['Rock','Paper','Scissors'], q2Opts: ['Rock','Paper','Scissors'] }),
      { promptId: 'multi-q', answers: { q1: { selectedLabels: ['Rock'] }, q2: { selectedLabels: ['Rock'] } } },
    )).toEqual(['1', '1', '\r']);

    // Paper(1)→'2', Rock(0)→'1', confirm→'\r'
    expect(buildClaudeInteractiveTuiAnswerSteps(
      makePrompt({ q1Opts: ['Rock','Paper','Scissors'], q2Opts: ['Rock','Paper','Scissors'] }),
      { promptId: 'multi-q', answers: { q1: { selectedLabels: ['Paper'] }, q2: { selectedLabels: ['Rock'] } } },
    )).toEqual(['2', '1', '\r']);

    // Scissors(2)→'3', Paper(1)→'2', confirm→'\r'
    expect(buildClaudeInteractiveTuiAnswerSteps(
      makePrompt({ q1Opts: ['Rock','Paper','Scissors'], q2Opts: ['Rock','Paper','Scissors'] }),
      { promptId: 'multi-q', answers: { q1: { selectedLabels: ['Scissors'] }, q2: { selectedLabels: ['Paper'] } } },
    )).toEqual(['3', '2', '\r']);

    // Rock(0)→'1', Scissors(2)→'3', confirm→'\r'
    expect(buildClaudeInteractiveTuiAnswerSteps(
      makePrompt({ q1Opts: ['Rock','Paper','Scissors'], q2Opts: ['Rock','Paper','Scissors'] }),
      { promptId: 'multi-q', answers: { q1: { selectedLabels: ['Rock'] }, q2: { selectedLabels: ['Scissors'] } } },
    )).toEqual(['1', '3', '\r']);
  });

  it('builds multi-select answer steps by jumping to each option and pressing Space to toggle', () => {
    const prompt = {
      promptId: 'multi-select',
      origin: 'cli' as const,
      providerType: 'claude-cli',
      createdAt: 0,
      questions: [
        {
          questionId: 'q1',
          question: 'Pick all the languages you use',
          header: 'Languages',
          multiSelect: true,
          options: [
            { label: 'TypeScript' },
            { label: 'Python' },
            { label: 'Rust' },
            { label: 'Go' },
          ],
          allowFreeform: false,
        },
      ],
    };

    // Check TypeScript(idx0)→'1'+Space, Rust(idx2)→'3'+Space, then Enter to
    // leave the question, then Enter to submit the confirm screen.
    expect(buildClaudeInteractiveTuiAnswerSteps(prompt, {
      promptId: 'multi-select',
      answers: { q1: { selectedLabels: ['TypeScript', 'Rust'] } },
    })).toEqual(['1', ' ', '3', ' ', '\r', '\r']);

    // Order of selected labels is preserved as emitted; a single checked box
    // still gets its toggle + advance, distinguishing it from single-select.
    expect(buildClaudeInteractiveTuiAnswerSteps(prompt, {
      promptId: 'multi-select',
      answers: { q1: { selectedLabels: ['Go'] } },
    })).toEqual(['4', ' ', '\r', '\r']);
  });

  it('handles a multi-select question mixed with a single-select question', () => {
    const prompt = {
      promptId: 'mixed',
      origin: 'cli' as const,
      providerType: 'claude-cli',
      createdAt: 0,
      questions: [
        {
          questionId: 'q1',
          question: 'Pick features',
          header: 'Features',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          allowFreeform: false,
        },
        {
          questionId: 'q2',
          question: 'Pick one tier',
          header: 'Tier',
          multiSelect: false,
          options: [{ label: 'Free' }, { label: 'Pro' }],
          allowFreeform: false,
        },
      ],
    };

    // q1 multi: A(0)→'1'+Space, C(2)→'3'+Space, Enter advance.
    // q2 single: Pro(1)→'2' (auto-advances). Final Enter submits.
    expect(buildClaudeInteractiveTuiAnswerSteps(prompt, {
      promptId: 'mixed',
      answers: {
        q1: { selectedLabels: ['A', 'C'] },
        q2: { selectedLabels: ['Pro'] },
      },
    })).toEqual(['1', ' ', '3', ' ', '\r', '2', '\r']);
  });

  it('throws when a multi-select question has no selected labels', () => {
    const prompt = {
      promptId: 'empty-multi',
      origin: 'cli' as const,
      providerType: 'claude-cli',
      createdAt: 0,
      questions: [
        {
          questionId: 'q1',
          question: 'Pick any',
          header: 'Any',
          multiSelect: true,
          options: [{ label: 'X' }, { label: 'Y' }],
          allowFreeform: false,
        },
      ],
    };
    expect(() => buildClaudeInteractiveTuiAnswerSteps(prompt, {
      promptId: 'empty-multi',
      answers: { q1: { selectedLabels: [] } },
    })).toThrow(/at least one selected label/);
  });

  it('captures the headerless picker variant where ☐ marker prefixes the question line', () => {
    // claude-cli >=2.1 ships a compact variant where the section header and
    // the question share one line (e.g. "☐ RPS R1 1라운드 — 가위바위보!").
    // The pre-fix parser unconditionally skipped every ☐/☒ line walking up
    // from the options, returned null, and the dashboard never showed the
    // picker UI. Pin the new behaviour: strip the marker, keep the text.
    const screen = [
      '☐ RPS R1 1라운드 — 가위바위보! 무엇을 내시겠어요?',
      '❯ 1. 가위 ✌     보를 이기고 바위에 집니다',
      '  2. 바위 ✊     가위를 이기고 보에 집니다',
      '  3. 보 ✋     바위를 이기고 가위에 집니다',
      '  4. Type something.',
      '────────────────────────────────────────────────',
      '  5. Chat about thisEnter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: screen },
    ], { promptId: 'rps-tui-prompt', createdAt: 1234 });

    expect(prompt?.questions).toHaveLength(1);
    expect(prompt?.questions[0]).toMatchObject({
      questionId: 'q1',
      question: 'RPS R1 1라운드 — 가위바위보! 무엇을 내시겠어요?',
      multiSelect: false,
      options: [
        { label: '가위 ✌     보를 이기고 바위에 집니다' },
        { label: '바위 ✊     가위를 이기고 보에 집니다' },
        { label: '보 ✋     바위를 이기고 가위에 집니다' },
        { label: 'Type something.' },
      ],
      allowFreeform: true,
    });
  });

  it('captures Claude v2.1 single-question numbered-choice screens without submit headers', () => {
    const screen = [
      '▗ ▗   ▖ ▖  Claude Code v2.1.153',
      '           Opus 4.7 (1M context) with high effort · Claude Max',
      '  ▘▘ ▝▝    ~/Work/adhdev',
      '',
      '❯ ## Task: 가위바위보',
      '',
      '⏺ 안녕하세요! 가위바위보 한 판 해요.',
      '────────────────────────────────────────────────────────────────',
      ' ☐ 가위바위보 ',
      '',
      '무엇을 내시겠어요?',
      '',
      '❯ 1. ✊ 바위',
      '     주먹',
      '  2. ✌️  가위',
      '     검지와 중지',
      '  3. ✋  보',
      '     손바닥',
      '  4. Type something.',
      '────────────────────────────────────────────────────────────────',
      '  5. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: screen },
    ], { promptId: 'single-tui-prompt', createdAt: 1234 });

    expect(prompt?.questions).toHaveLength(1);
    expect(prompt?.questions[0]).toEqual({
      questionId: 'q1',
      header: '가위바위보',
      question: '무엇을 내시겠어요?',
      multiSelect: false,
      options: [
        { label: '✊ 바위', description: '주먹' },
        { label: '✌️  가위', description: '검지와 중지' },
        { label: '✋  보', description: '손바닥' },
        { label: 'Type something.' },
      ],
      allowFreeform: true,
    });
  });

  it('detects multi-select from checkbox option markers even when the footer hint drifts (regression)', () => {
    // Regression: the dashboard rendered single-select (radio) for a
    // multi-select AskUserQuestion because multiSelect was derived solely from
    // the footer text /Space to select|toggle selections/. When claude-cli
    // changed that footer wording, the parse fell back to multiSelect:false and
    // the user could no longer check multiple boxes in the dashboard — even
    // though the picker visibly drew checkboxes. Pin that the per-option
    // checkbox markers ([ ] / ☐) are now an authoritative multi-select signal.
    // The footer keeps "Enter to select" (the prompt-presence gate) but the
    // old multi-select hint "Space to select" is gone — only the per-option
    // checkbox markers remain to signal multi-select.
    const screen = [
      '←  ☐ Languages  ✔ Submit  →',
      '',
      'Pick all the languages you use',
      '',
      '❯ [ ] 1. TypeScript',
      '  [x] 2. Python',
      '  [ ] 3. Rust',
      '────────────────────────────────────────────────',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: screen },
    ], { promptId: 'multi-drift', createdAt: 1234 });

    expect(prompt?.questions).toHaveLength(1);
    expect(prompt?.questions[0].multiSelect).toBe(true);
    expect(prompt?.questions[0].options.map(o => o.label)).toEqual([
      'TypeScript', 'Python', 'Rust',
    ]);
  });

  it('detects multi-select from ☐ glyph option markers (regression)', () => {
    const screen = [
      '←  ☐ Features  ✔ Submit  →',
      '',
      'Pick features',
      '',
      '❯ ☐ 1. Alpha',
      '  ☒ 2. Beta',
      '  ☐ 3. Gamma',
      '────────────────────────────────────────────────',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: screen },
    ], { promptId: 'multi-glyph', createdAt: 1234 });

    expect(prompt?.questions[0]?.multiSelect).toBe(true);
  });

  it('detects multi-select when the checkbox sits AFTER the number (claude-cli >=2.1 layout, regression)', () => {
    // Live-captured from claude-cli v2.1.170: the multi-select picker draws the
    // checkbox glyph after the "N." marker ("❯ 1. [ ] Label"), not before it.
    // detectClaudeTuiMultiSelect originally only matched the glyph-before-number
    // form, so EVERY multi-select question (single or multi) was frozen as
    // single-select and the dashboard rendered radio buttons.
    const screen = [
      '←  ☐ 아침  ☐ 점심  ☐ 저녁  ✔ Submit  →',
      '',
      '아침 반찬?',
      '',
      '❯ 1. [ ] 계란말이',
      '  부드러운 계란말이',
      '  2. [ ] 김구이',
      '  바삭한 김구이',
      '  3. [ ] 콩자반',
      '  달콤한 콩자반',
      '────────────────────────────────────────────────',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    ].join('\n');

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: screen },
    ], { promptId: 'after-number', createdAt: 1234 });

    expect(prompt?.questions[0]?.multiSelect).toBe(true);
    expect(prompt?.questions[0]?.options.map(o => o.label)).toEqual([
      '계란말이', '김구이', '콩자반',
    ]);
  });

  it('keeps single-select numbered screens as multiSelect:false (no false positive)', () => {
    // No per-option checkbox markers and no multi-select footer hint. The ☐ on
    // the `✔ Submit` nav line is per-question answered state, NOT multi-select,
    // and must not trigger a false positive.
    const screen = [
      '←  ☐ Move  ✔ Submit  →',
      '',
      '무엇을 내시겠어요?',
      '',
      '❯ 1. 바위',
      '  2. 가위',
      '  3. 보',
      '────────────────────────────────────────────────',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');

    const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([
      { screenText: screen },
    ], { promptId: 'single-no-fp', createdAt: 1234 });

    expect(prompt?.questions[0]?.multiSelect).toBe(false);
  });
});
