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
    expect(buildClaudeInteractiveTuiAnswerSteps(prompt!, {
      promptId: 'tui-prompt',
      answers: {
        q1: { selectedLabels: ['빨강'] },
        q2: { selectedLabels: ['monospace'] },
      },
    })).toEqual(['\r', '\r', '\r']);
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
});
