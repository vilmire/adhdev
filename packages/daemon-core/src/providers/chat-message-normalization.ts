import type { ChatMessage } from '../types.js';

export const BUILTIN_CHAT_MESSAGE_KINDS = ['standard', 'thought', 'tool', 'terminal', 'system'] as const;

export type BuiltinChatMessageKind = typeof BUILTIN_CHAT_MESSAGE_KINDS[number];
export type ChatMessageKind = BuiltinChatMessageKind | (string & {});

const KNOWN_CHAT_MESSAGE_KINDS = new Set<string>(BUILTIN_CHAT_MESSAGE_KINDS);
const CHAT_MESSAGE_KIND_ALIASES: Record<string, BuiltinChatMessageKind> = {
  text: 'standard',
  message: 'standard',
  assistant: 'standard',
  thinking: 'thought',
  think: 'thought',
  reasoning: 'thought',
  reason: 'thought',
  toolcall: 'tool',
  tool_call: 'tool',
  tooluse: 'tool',
  tool_use: 'tool',
  action: 'tool',
  command: 'terminal',
  cmd: 'terminal',
  shell: 'terminal',
  console: 'terminal',
};

function canonicalizeKindHint(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function resolveBuiltinOrAliasKind(kind: unknown): BuiltinChatMessageKind | null {
  if (typeof kind !== 'string') return null;
  const normalizedKind = canonicalizeKindHint(kind);
  if (!normalizedKind) return null;
  if (KNOWN_CHAT_MESSAGE_KINDS.has(normalizedKind)) return normalizedKind as BuiltinChatMessageKind;
  return CHAT_MESSAGE_KIND_ALIASES[normalizedKind] || null;
}

function inferHintKind(value: unknown): BuiltinChatMessageKind | null {
  const direct = resolveBuiltinOrAliasKind(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  const normalized = canonicalizeKindHint(value);
  if (!normalized) return null;
  if (/thought|thinking|reasoning/.test(normalized)) return 'thought';
  if (/tool/.test(normalized)) return 'tool';
  if (/terminal|command|shell|console/.test(normalized)) return 'terminal';
  return null;
}

function inferKindFromToolCalls(message: ChatMessage): BuiltinChatMessageKind | null {
  const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  if (toolCalls.length === 0) return null;
  if (toolCalls.some((toolCall) => toolCall?.kind === 'think')) return 'thought';
  if (toolCalls.some((toolCall) => toolCall?.kind === 'execute')) return 'terminal';
  if (toolCalls.some((toolCall) => Array.isArray(toolCall?.content) && toolCall.content.some((entry) => entry?.type === 'terminal'))) {
    return 'terminal';
  }
  return 'tool';
}

function inferMissingChatMessageKind(message: ChatMessage): BuiltinChatMessageKind | null {
  const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
  if (role === 'system') return 'system';

  const meta = message?.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : undefined;
  const hintCandidates: unknown[] = [
    message?._sub,
    message?._type,
    meta?.label,
    typeof message?.senderName === 'string' ? message.senderName : undefined,
  ];

  for (const candidate of hintCandidates) {
    const inferred = inferHintKind(candidate);
    if (inferred) return inferred;
  }

  const inferredFromToolCalls = inferKindFromToolCalls(message);
  if (inferredFromToolCalls) return inferredFromToolCalls;
  return null;
}

export function isBuiltinChatMessageKind(kind: unknown): kind is BuiltinChatMessageKind {
  return resolveBuiltinOrAliasKind(kind) !== null;
}

export function normalizeChatMessageKind(kind: unknown, role: unknown): ChatMessageKind {
  const resolvedKind = resolveBuiltinOrAliasKind(kind);
  if (resolvedKind) return resolvedKind;

  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return normalizedRole === 'system' ? 'system' : 'standard';
}

export function resolveChatMessageKind<T extends ChatMessage>(message: T): ChatMessageKind {
  const explicitKind = resolveBuiltinOrAliasKind(message?.kind);
  if (explicitKind) return explicitKind;

  const inferredKind = inferMissingChatMessageKind(message);
  if (inferredKind) return inferredKind;
  return normalizeChatMessageKind(message?.kind, message?.role);
}

export function buildChatMessage<T extends Omit<ChatMessage, 'kind'> & { kind?: ChatMessageKind }>(message: T): T & { kind: ChatMessageKind } {
  return {
    ...message,
    kind: resolveChatMessageKind(message as unknown as ChatMessage),
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

export function buildThoughtChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildAssistantChatMessage({
    ...message,
    kind: message?.kind || 'thought',
  } as T & { role?: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
}

export function buildToolChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildAssistantChatMessage({
    ...message,
    kind: message?.kind || 'tool',
  } as T & { role?: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
}

export function buildTerminalChatMessage<T extends Omit<ChatMessage, 'role' | 'kind'> & { role?: 'assistant'; kind?: ChatMessageKind }>(message: T): (T & { role: 'assistant'; kind: ChatMessageKind }) {
  return buildAssistantChatMessage({
    ...message,
    kind: message?.kind || 'terminal',
  } as T & { role?: 'assistant'; kind?: ChatMessageKind }) as T & { role: 'assistant'; kind: ChatMessageKind };
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
