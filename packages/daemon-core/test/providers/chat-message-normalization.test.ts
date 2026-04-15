import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CHAT_MESSAGE_KINDS,
  buildAssistantChatMessage,
  buildChatMessage,
  buildRuntimeSystemChatMessage,
  buildSystemChatMessage,
  buildUserChatMessage,
  isBuiltinChatMessageKind,
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
    expect(normalizeChatMessage({ role: 'assistant', content: 'thinking', kind: 'thought' } as any).kind).toBe('thought');
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
});
