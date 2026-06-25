import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CHAT_MESSAGE_KINDS,
  buildAssistantChatMessage,
  buildChatMessage,
  buildRuntimeSystemChatMessage,
  buildSystemChatMessage,
  buildTerminalChatMessage,
  buildThoughtChatMessage,
  buildToolChatMessage,
  buildUserChatMessage,
  DEFAULT_FINAL_SUMMARY_MAX_CHARS,
  extractFinalSummaryFromMessages,
  filterUserFacingChatMessages,
  isBuiltinChatMessageKind,
  isUserFacingChatMessage,
  normalizeChatMessage,
  normalizeChatMessageKind,
  normalizeChatMessages,
} from '../../src/providers/chat-message-normalization';

describe('chat message normalization', () => {
  it('exports the built-in kind list and builtin-kind guard', () => {
    expect(BUILTIN_CHAT_MESSAGE_KINDS).toEqual(['standard', 'thought', 'tool', 'terminal', 'system']);
    expect(isBuiltinChatMessageKind('tool')).toBe(true);
    expect(isBuiltinChatMessageKind('custom_kind')).toBe(false);
  });

  it('defaults non-system messages to standard kind', () => {
    expect(normalizeChatMessage({ role: 'assistant', content: 'hello' } as any).kind).toBe('standard');
    expect(normalizeChatMessage({ role: 'user', content: 'hello' } as any).kind).toBe('standard');
  });

  it('defaults system-role messages to system kind', () => {
    expect(normalizeChatMessage({ role: 'system', content: 'notice' } as any).kind).toBe('system');
  });

  it('preserves known explicit kinds and normalizes casing', () => {
    expect(normalizeChatMessageKind('tool', 'assistant')).toBe('tool');
    expect(normalizeChatMessageKind('TERMINAL', 'assistant')).toBe('terminal');
    expect(normalizeChatMessageKind('text', 'assistant')).toBe('standard');
    expect(normalizeChatMessageKind('command', 'assistant')).toBe('terminal');
    expect(normalizeChatMessage({ role: 'assistant', content: 'thinking', kind: 'thought' } as any).kind).toBe('thought');
  });

  it('infers richer kinds from readChat producer hints when explicit kind is missing', () => {
    expect(normalizeChatMessage({ role: 'assistant', content: 'npm test', _sub: 'command' } as any).kind).toBe('terminal');
    expect(normalizeChatMessage({ role: 'assistant', content: 'Search files', _sub: 'tool' } as any).kind).toBe('tool');
    expect(normalizeChatMessage({ role: 'assistant', content: 'planning', meta: { label: 'Thinking' } } as any).kind).toBe('thought');
    expect(normalizeChatMessage({
      role: 'assistant',
      content: 'Ran tool',
      toolCalls: [{ toolCallId: 'tc-1', title: 'Run npm test', kind: 'execute' }],
    } as any).kind).toBe('terminal');
  });

  it('falls back from unknown kinds based on role', () => {
    expect(normalizeChatMessage({ role: 'assistant', content: 'hello', kind: 'weird' } as any).kind).toBe('standard');
    expect(normalizeChatMessage({ role: 'system', content: 'notice', kind: 'weird' } as any).kind).toBe('system');
  });

  it('provides builders for common runtime message roles', () => {
    const built = buildChatMessage({ role: 'assistant', content: 'hello' } as any);
    expect(built.kind).toBe('standard');

    const systemMessage = buildSystemChatMessage({ content: 'notice' } as any);
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.kind).toBe('system');

    const runtimeSystemMessage = buildRuntimeSystemChatMessage({ content: 'notice', receivedAt: 123 } as any);
    expect(runtimeSystemMessage.role).toBe('system');
    expect(runtimeSystemMessage.kind).toBe('system');
    expect(runtimeSystemMessage.senderName).toBe('System');
    expect(runtimeSystemMessage.receivedAt).toBe(123);

    const assistantMessage = buildAssistantChatMessage({ content: 'reply' } as any);
    expect(assistantMessage.role).toBe('assistant');
    expect(assistantMessage.kind).toBe('standard');

    const thoughtMessage = buildThoughtChatMessage({ content: 'analyzing…' } as any);
    expect(thoughtMessage.role).toBe('assistant');
    expect(thoughtMessage.kind).toBe('thought');

    const toolMessage = buildToolChatMessage({ content: 'Searching files' } as any);
    expect(toolMessage.role).toBe('assistant');
    expect(toolMessage.kind).toBe('tool');

    const terminalMessage = buildTerminalChatMessage({ content: 'npm test\nPASS', meta: { label: 'Ran command' } } as any);
    expect(terminalMessage.role).toBe('assistant');
    expect(terminalMessage.kind).toBe('terminal');
    expect(terminalMessage.meta).toMatchObject({ label: 'Ran command' });

    const userMessage = buildUserChatMessage({ content: 'prompt' } as any);
    expect(userMessage.role).toBe('user');
    expect(userMessage.kind).toBe('standard');
  });

  it('normalizes message arrays consistently', () => {
    const normalized = normalizeChatMessages([
      { role: 'assistant', content: 'reply' },
      { role: 'system', content: 'notice' },
      { role: 'assistant', content: 'command', kind: 'tool' },
    ] as any);

    expect(normalized.map((message) => message.kind)).toEqual(['standard', 'system', 'tool']);
  });

  it('filters user-facing transcript messages without discarding debug rows from normalization', () => {
    const messages = normalizeChatMessages([
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'answer' },
      { role: 'assistant', content: '⚡ mcp_adhdev_mesh_mesh_git_status (0.0s)', kind: 'tool' },
      { role: 'assistant', content: '$ git status --short', kind: 'terminal' },
      { role: 'assistant', content: 'intentional tool summary', kind: 'tool', meta: { transcriptVisibility: 'visible' } },
      { role: 'assistant', content: 'internal standard status', meta: { internal: true } },
      { role: 'system', content: 'runtime notice' },
    ] as any);

    expect(messages.map((message) => message.kind)).toEqual([
      'standard',
      'standard',
      'tool',
      'terminal',
      'tool',
      'standard',
      'system',
    ]);
    expect(messages.map((message) => isUserFacingChatMessage(message))).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(filterUserFacingChatMessages(messages).map((message) => message.content)).toEqual([
      'prompt',
      'answer',
      'intentional tool summary',
    ]);
  });

  it('extractFinalSummaryFromMessages returns empty string for null/undefined/empty', () => {
    expect(extractFinalSummaryFromMessages(null)).toBe('');
    expect(extractFinalSummaryFromMessages(undefined)).toBe('');
    expect(extractFinalSummaryFromMessages([])).toBe('');
  });

  it('extractFinalSummaryFromMessages extracts last user-facing assistant message', () => {
    const messages = [
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'first answer' },
      { role: 'assistant', content: 'final answer', meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages)).toBe('final answer');
  });

  it('extractFinalSummaryFromMessages returns empty instead of echoing a user prompt when no assistant result exists', () => {
    const messages = [
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'answer', meta: { hidden: true } },
      { role: 'user', content: 'follow-up', meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages)).toBe('');
  });

  it('extractFinalSummaryFromMessages keeps ordinary completion summaries under the default cap', () => {
    const text = 'a'.repeat(8_000);
    const messages = [
      { role: 'assistant', content: text, meta: { userFacing: true } },
    ] as any;
    expect(DEFAULT_FINAL_SUMMARY_MAX_CHARS).toBe(16_000);
    expect(extractFinalSummaryFromMessages(messages)).toBe(text);
  });

  it('extractFinalSummaryFromMessages truncates oversized summaries at the default cap', () => {
    const text = 'a'.repeat(20_000);
    const messages = [
      { role: 'assistant', content: text, meta: { userFacing: true } },
    ] as any;
    const summary = extractFinalSummaryFromMessages(messages);
    expect(summary).toHaveLength(16_000);
    expect(summary).toBe('a'.repeat(16_000));
  });

  it('extractFinalSummaryFromMessages truncates to maxChars when an explicit limit is provided', () => {
    const messages = [
      { role: 'assistant', content: 'a'.repeat(1000), meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages, 100)).toBe('a'.repeat(100));
  });

  it('extractFinalSummaryFromMessages prefers assistant over user', () => {
    const messages = [
      { role: 'user', content: 'user message', meta: { userFacing: true } },
      { role: 'assistant', content: 'assistant message', meta: { userFacing: true } },
    ] as any;
    expect(extractFinalSummaryFromMessages(messages)).toBe('assistant message');
  });
});
