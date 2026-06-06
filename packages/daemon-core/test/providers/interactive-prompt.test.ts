import { describe, expect, it } from 'vitest';
import {
  buildClaudeInteractiveToolResult,
  detectClaudeAskUserQuestionPromptFromJson,
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
});
