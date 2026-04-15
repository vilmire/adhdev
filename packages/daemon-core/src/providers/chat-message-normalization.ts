import type { ChatMessage } from '../types.js';

export const BUILTIN_CHAT_MESSAGE_KINDS = ['standard', 'thought', 'tool', 'terminal', 'system'] as const;

export type BuiltinChatMessageKind = typeof BUILTIN_CHAT_MESSAGE_KINDS[number];
export type ChatMessageKind = BuiltinChatMessageKind | (string & {});

const KNOWN_CHAT_MESSAGE_KINDS = new Set<string>(BUILTIN_CHAT_MESSAGE_KINDS);

export function isBuiltinChatMessageKind(kind: unknown): kind is BuiltinChatMessageKind {
  return typeof kind === 'string' && KNOWN_CHAT_MESSAGE_KINDS.has(kind.trim().toLowerCase());
}

export function normalizeChatMessageKind(kind: unknown, role: unknown): ChatMessageKind {
  const normalizedKind = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  if (normalizedKind && KNOWN_CHAT_MESSAGE_KINDS.has(normalizedKind)) return normalizedKind as BuiltinChatMessageKind;

  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return normalizedRole === 'system' ? 'system' : 'standard';
}

export function buildChatMessage<T extends Omit<ChatMessage, 'kind'> & { kind?: ChatMessageKind }>(message: T): T & { kind: ChatMessageKind } {
  return {
    ...message,
    kind: normalizeChatMessageKind(message?.kind, message?.role),
  };
}

export function buildSystemChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'system'; kind?: ChatMessageKind }>(message: T): (T & { role: 'system'; kind: ChatMessageKind }) {
  return buildChatMessage({
    ...message,
    role: 'system',
    kind: message?.kind || 'system',
  } as T & { role: 'system'; kind?: ChatMessageKind }) as T & { role: 'system'; kind: ChatMessageKind };
}

export function buildRuntimeSystemChatMessage<T extends Omit<ChatMessage, 'role' | 'kind' | 'senderName'> & { role?: 'system'; kind?: ChatMessageKind; senderName?: string }>(message: T): (T & { role: 'system'; kind: ChatMessageKind; senderName: string }) {
  return buildSystemChatMessage({
    ...message,
    senderName: typeof message?.senderName === 'string' && message.senderName.trim()
      ? message.senderName
      : 'System',
  } as T & { role?: 'system'; kind?: ChatMessageKind; senderName?: string }) as T & { role: 'system'; kind: ChatMessageKind; senderName: string };
}

export function buildAssistantChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildChatMessage({
    ...message,
    role: 'assistant',
    kind: message?.kind || 'standard',
  } as T & { role: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
}

export function buildUserChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'user'; kind?: ChatMessageKind }>(message: T): (T & { role: 'user'; kind: ChatMessageKind }) {
  return buildChatMessage({
    ...message,
    role: 'user',
    kind: message?.kind || 'standard',
  } as T & { role: 'user'; kind?: ChatMessageKind }) as T & { role: 'user'; kind: ChatMessageKind };
}

export function normalizeChatMessage<T extends ChatMessage>(message: T): T {
  return buildChatMessage(message) as T;
}

export function normalizeChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).map((message) => normalizeChatMessage(message));
}
