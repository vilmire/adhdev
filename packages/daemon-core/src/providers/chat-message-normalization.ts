import type { ChatMessage } from '../types.js';
import { flattenContent } from './contracts.js';

export const DEFAULT_FINAL_SUMMARY_MAX_CHARS = 4_000;

export function extractFinalSummaryFromMessages(
  messages: ChatMessage[] | null | undefined,
  maxChars: number = DEFAULT_FINAL_SUMMARY_MAX_CHARS,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  // Find last user-facing assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const classification = classifyChatMessageVisibility(msg);
    if (classification.isUserFacing && (msg.role === 'assistant' || msg.role === 'model')) {
      const text = flattenContent(msg.content).trim();
      if (text) return text.slice(0, maxChars);
    }
  }

  // Completion summaries must describe the assistant/model result. If no
  // user-facing assistant/model message exists yet (for example, only the
  // dispatched user prompt is visible), return empty instead of echoing the
  // prompt as a misleading finalSummary.
  return '';
}

export const BUILTIN_CHAT_MESSAGE_KINDS = ['standard', 'thought', 'tool', 'terminal', 'system'] as const;

export type BuiltinChatMessageKind = typeof BUILTIN_CHAT_MESSAGE_KINDS[number];
export type ChatMessageKind = BuiltinChatMessageKind | (string & {});

export const CHAT_MESSAGE_VISIBILITIES = ['user', 'debug', 'internal', 'hidden'] as const;
export const CHAT_MESSAGE_TRANSCRIPT_VISIBILITIES = ['visible', 'chat', 'user', 'debug', 'internal', 'hidden'] as const;
export const CHAT_MESSAGE_AUDIENCES = ['chat', 'debug', 'trace', 'internal'] as const;
export const CHAT_MESSAGE_SOURCES = [
  'assistant_text',
  'tool_call',
  'terminal_command',
  'runtime_activity',
  'runtime_status',
  'provider_chrome',
  'control',
] as const;
export const CHAT_MESSAGE_ACTIVITY_SOURCES = ['tool_call', 'terminal_command', 'runtime_activity'] as const;
export const CHAT_MESSAGE_INTERNAL_SOURCES = ['runtime_status', 'provider_chrome', 'control'] as const;

export type ChatMessageVisibility = typeof CHAT_MESSAGE_VISIBILITIES[number] | (string & {});
export type ChatMessageTranscriptVisibility = typeof CHAT_MESSAGE_TRANSCRIPT_VISIBILITIES[number] | (string & {});
export type ChatMessageAudience = typeof CHAT_MESSAGE_AUDIENCES[number] | (string & {});
export type ChatMessageSource = typeof CHAT_MESSAGE_SOURCES[number] | (string & {});
export type ChatMessageTranscriptSurface = 'chat' | 'activity' | 'internal';

export interface ChatMessageVisibilityClassification {
  surface: ChatMessageTranscriptSurface;
  isUserFacing: boolean;
  isActivityFacing: boolean;
  isInternal: boolean;
  explicitUserFacing: boolean;
  explicitHidden: boolean;
  role: string;
  kind: ChatMessageKind;
  visibility: string;
  transcriptVisibility: string;
  audience: string;
  source: string;
}


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

function readMessageMeta(message: ChatMessage): Record<string, unknown> | null {
  const meta = message?.meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : null;
}

function readStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function readRecordField(message: ChatMessage, meta: Record<string, unknown> | null, key: string): unknown {
  const record = message as ChatMessage & Record<string, unknown>;
  return record[key] ?? meta?.[key];
}

function readVisibilityField(message: ChatMessage, meta: Record<string, unknown> | null): string {
  return readStringField(readRecordField(message, meta, 'visibility'));
}

function readTranscriptVisibilityField(message: ChatMessage, meta: Record<string, unknown> | null): string {
  const record = message as ChatMessage & Record<string, unknown>;
  return readStringField(record.transcriptVisibility ?? meta?.transcriptVisibility ?? record.visibility ?? meta?.visibility);
}

const EXPLICIT_HIDDEN_VISIBILITIES = new Set(['hidden', 'debug', 'internal']);
const EXPLICIT_VISIBLE_VISIBILITIES = new Set(['visible', 'user', 'chat']);
const HIDDEN_AUDIENCES = new Set(['debug', 'trace', 'internal']);
const ACTIVITY_SOURCE_SET = new Set<string>(CHAT_MESSAGE_ACTIVITY_SOURCES);
const INTERNAL_SOURCE_SET = new Set<string>(CHAT_MESSAGE_INTERNAL_SOURCES);

function hasBooleanMarker(message: ChatMessage, meta: Record<string, unknown> | null, keys: string[]): boolean {
  const record = message as ChatMessage & Record<string, unknown>;
  return keys.some((key) => record[key] === true || meta?.[key] === true);
}

function isActivityKind(kind: ChatMessageKind): boolean {
  return kind === 'thought' || kind === 'tool' || kind === 'terminal';
}

function isOrdinaryVisibleTurn(message: ChatMessage, role: string, kind: ChatMessageKind): boolean {
  if (role === 'user' || role === 'human') return kind === 'standard' || kind === '';
  if (role === 'assistant') return kind === 'standard' || kind === '';
  return false;
}

/**
 * Shared transcript visibility protocol for all ADHDev provider chat messages.
 *
 * Producers can stamp visibility/audience/source/userFacing/internal/debug either
 * at the top level or under `meta`. Consumers should use this classifier instead
 * of matching command text, icons, provider names, or terminal UI fragments.
 */
export function classifyChatMessageVisibility(message: ChatMessage | null | undefined): ChatMessageVisibilityClassification {
  if (!message) {
    return {
      surface: 'internal',
      isUserFacing: false,
      isActivityFacing: false,
      isInternal: true,
      explicitUserFacing: false,
      explicitHidden: true,
      role: '',
      kind: 'standard',
      visibility: '',
      transcriptVisibility: '',
      audience: '',
      source: '',
    };
  }

  const meta = readMessageMeta(message);
  const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
  const kind = resolveChatMessageKind(message);
  const visibility = readVisibilityField(message, meta);
  const transcriptVisibility = readTranscriptVisibilityField(message, meta);
  const audience = readStringField(readRecordField(message, meta, 'audience'));
  const source = readStringField(readRecordField(message, meta, 'source'));
  const explicitHidden = EXPLICIT_HIDDEN_VISIBILITIES.has(visibility)
    || EXPLICIT_HIDDEN_VISIBILITIES.has(transcriptVisibility)
    || HIDDEN_AUDIENCES.has(audience)
    || hasBooleanMarker(message, meta, ['hidden', 'internal', 'isInternal', 'debug', 'statusOnly', 'controlOnly']);
  const explicitUserFacing = EXPLICIT_VISIBLE_VISIBILITIES.has(visibility)
    || EXPLICIT_VISIBLE_VISIBILITIES.has(transcriptVisibility)
    || audience === 'chat'
    || hasBooleanMarker(message, meta, ['userFacing']);

  if (explicitHidden) {
    const activityLike = isActivityKind(kind) || ACTIVITY_SOURCE_SET.has(source);
    return {
      surface: activityLike ? 'activity' : 'internal',
      isUserFacing: false,
      isActivityFacing: activityLike,
      isInternal: !activityLike,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  if (explicitUserFacing) {
    return {
      surface: 'chat',
      isUserFacing: true,
      isActivityFacing: false,
      isInternal: false,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  if (INTERNAL_SOURCE_SET.has(source) || role === 'system' || kind === 'system') {
    return {
      surface: 'internal',
      isUserFacing: false,
      isActivityFacing: false,
      isInternal: true,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  if (ACTIVITY_SOURCE_SET.has(source) || isActivityKind(kind)) {
    return {
      surface: 'activity',
      isUserFacing: false,
      isActivityFacing: true,
      isInternal: false,
      explicitUserFacing,
      explicitHidden,
      role,
      kind,
      visibility,
      transcriptVisibility,
      audience,
      source,
    };
  }

  const isUserFacing = isOrdinaryVisibleTurn(message, role, kind);
  return {
    surface: isUserFacing ? 'chat' : 'internal',
    isUserFacing,
    isActivityFacing: false,
    isInternal: !isUserFacing,
    explicitUserFacing,
    explicitHidden,
    role,
    kind,
    visibility,
    transcriptVisibility,
    audience,
    source,
  };
}

export function isUserFacingChatMessage(message: ChatMessage | null | undefined): boolean {
  return classifyChatMessageVisibility(message).isUserFacing;
}

export function isActivityChatMessage(message: ChatMessage | null | undefined): boolean {
  return classifyChatMessageVisibility(message).isActivityFacing;
}

export function isInternalChatMessage(message: ChatMessage | null | undefined): boolean {
  return classifyChatMessageVisibility(message).isInternal;
}

export function filterUserFacingChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => isUserFacingChatMessage(message));
}

export function filterActivityChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => isActivityChatMessage(message));
}

export function filterInternalChatMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => isInternalChatMessage(message));
}

export function filterChatMessagesByVisibility<T extends ChatMessage>(
  messages: T[] | null | undefined,
  surface: ChatMessageTranscriptSurface,
): T[] {
  return (Array.isArray(messages) ? messages : []).filter((message) => classifyChatMessageVisibility(message).surface === surface);
}
