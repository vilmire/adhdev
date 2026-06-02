/**
 * Chat Transcript Contract v2
 *
 * First-class message identity, monotonic sequence, strict enums. Designed to
 * replace the v1 contract (contracts.ts ReadChatResult + types.ts ChatMessage)
 * during the A2 big-bang. This module defines the contract; it does not yet
 * change runtime behaviour. v1 keeps working until A2 flips the switch.
 *
 * Invariants v2 enforces (and v1 does not):
 *   1. Every ChatMessageV2 has providerUnitKey, bubbleId, sequence — none optional.
 *   2. sequence is a monotonic integer per (sessionId, source) tuple. Producers
 *      never reuse it; consumers MAY assume strict ordering.
 *   3. providerUnitKey is stable across re-reads: the same logical message
 *      always yields the same key even if its index shifts or content is
 *      edited mid-stream. Producers derive it from provider-owned identifiers
 *      (turn id, native message id), not from content hashes or array index.
 *   4. timestamp is producer-asserted wall-clock; orderingTimestamp is monotonic
 *      and used for snapshot diffs. 1ms fallback increments are forbidden — if
 *      a producer cannot supply a stable monotonic value, the daemon assigns
 *      sequence at ingest and orderingTimestamp = ingestedAt.
 *   5. visibility / source / role / kind are strict unions. No `(string & {})`
 *      escape hatches.
 *   6. Coverage is exactly one of full/tail/current-turn. Mixing it with
 *      partialReason or unavailableReason is a contract violation.
 *   7. workspace / sessionId are explicit on every ReadChatResultV2; the daemon
 *      no longer infers them from message bodies.
 */

import type { MessagePart, ToolCallInfo } from './contracts.js';

// ─── Contract version ────────────────────────────────────────────────────

export const CHAT_CONTRACT_VERSION_V1 = '1.0' as const;
export const CHAT_CONTRACT_VERSION_V2 = '2.0' as const;

export type ChatContractVersion =
  | typeof CHAT_CONTRACT_VERSION_V1
  | typeof CHAT_CONTRACT_VERSION_V2;

export const SUPPORTED_CHAT_CONTRACT_VERSIONS: readonly ChatContractVersion[] = [
  CHAT_CONTRACT_VERSION_V1,
  CHAT_CONTRACT_VERSION_V2,
] as const;

// ─── Strict role / kind / visibility / source enums ─────────────────────

export const CHAT_ROLES_V2 = ['user', 'assistant', 'system'] as const;
export type ChatRoleV2 = typeof CHAT_ROLES_V2[number];

export const CHAT_MESSAGE_KINDS_V2 = [
  'standard',
  'thought',
  'tool',
  'terminal',
  'system',
] as const;
export type ChatMessageKindV2 = typeof CHAT_MESSAGE_KINDS_V2[number];

export const CHAT_VISIBILITIES_V2 = ['user', 'debug', 'internal', 'hidden'] as const;
export type ChatVisibilityV2 = typeof CHAT_VISIBILITIES_V2[number];

export const CHAT_AUDIENCES_V2 = ['chat', 'debug', 'trace', 'internal'] as const;
export type ChatAudienceV2 = typeof CHAT_AUDIENCES_V2[number];

export const CHAT_SOURCES_V2 = [
  'assistant_text',
  'tool_call',
  'terminal_command',
  'runtime_activity',
  'runtime_status',
  'provider_chrome',
  'control',
] as const;
export type ChatSourceV2 = typeof CHAT_SOURCES_V2[number];

export const CHAT_BUBBLE_STATES_V2 = ['draft', 'streaming', 'final', 'removed'] as const;
export type ChatBubbleStateV2 = typeof CHAT_BUBBLE_STATES_V2[number];

// ─── Message identity ────────────────────────────────────────────────────

/**
 * Stable identity of a single chat message. All fields are required in v2.
 *
 * - providerUnitKey: provider-owned canonical id. Must be derivable from
 *   provider primitives (native message id, turn id, bubble id), NOT from
 *   array index or content hash. Stable across re-reads of the same logical
 *   message even if neighbours change.
 * - bubbleId: dashboard-owned bubble identity. May equal providerUnitKey when
 *   the provider already exposes a bubble-grained id; otherwise daemon
 *   derives it deterministically from providerUnitKey (e.g. `bubble:${key}`).
 * - sequence: monotonic integer per (sessionId, source). Strictly increasing
 *   over the lifetime of the session. Used for snapshot diffs and dedup.
 * - turnKey: stable identifier for the conversation turn this message belongs
 *   to. Required so consumers can group messages without re-deriving turns.
 */
export interface MessageIdentityV2 {
  providerUnitKey: string;
  bubbleId: string;
  sequence: number;
  turnKey: string;
}

// ─── Timing ──────────────────────────────────────────────────────────────

/**
 * Producer-asserted wall-clock time (ms since epoch). Forward jumps are
 * permitted; consumers MUST NOT rely on this for ordering.
 */
export type ChatTimestampMs = number;

/**
 * Monotonic ordering value (ms since epoch, but assigned by the daemon at
 * ingest to guarantee monotonicity even if the producer's wall clock skews).
 * Used by snapshot diffs in place of timestamp.
 */
export type ChatOrderingTimestampMs = number;

// ─── Message ─────────────────────────────────────────────────────────────

export interface ChatMessageV2 extends MessageIdentityV2 {
  role: ChatRoleV2;
  kind: ChatMessageKindV2;
  content: string | MessagePart[];
  bubbleState: ChatBubbleStateV2;
  timestamp: ChatTimestampMs;
  orderingTimestamp: ChatOrderingTimestampMs;
  visibility: ChatVisibilityV2;
  audience: ChatAudienceV2;
  source: ChatSourceV2;
  /** Sender display name (for shared sessions). Empty string when unused. */
  senderName: string;
  /** Tool calls associated with this message. Empty array when none. */
  toolCalls: ToolCallInfo[];
  /** Producer-defined metadata. Daemon never inspects this except for passthrough. */
  meta: Readonly<Record<string, unknown>>;
}

// ─── Workspace / session context ─────────────────────────────────────────

export interface WorkspaceContextV2 {
  /** Absolute realpath of the workspace the session is reading from. */
  workspacePath: string;
  /** Workspace the session was intended to operate on (may differ during cross-workspace ops). */
  intendedWorkspacePath: string;
}

export interface SessionContextV2 {
  /** Provider-owned session id (e.g. claude.jsonl uuid, codex session_meta.id). */
  providerSessionId: string;
  /** Optional daemon-side history alias used to disambiguate within a workspace. */
  historySessionId?: string;
}

// ─── Coverage (honest signal) ────────────────────────────────────────────

/**
 * v1 allowed `coverage='full'` to coexist with `partialReason`/`unavailableReason`,
 * which is a contract lie. v2 makes the three states mutually exclusive.
 */
export type CoverageHintV2 =
  | { kind: 'full' }
  | { kind: 'tail'; tailMessageCount: number }
  | { kind: 'current-turn'; turnKey: string }
  | { kind: 'partial'; partialReason: string }
  | { kind: 'unavailable'; unavailableReason: string };

// ─── Canonical history declaration (provider.json) ───────────────────────

export type CanonicalHistoryModeV2 = 'native-source' | 'disabled' | 'materialized-mirror';

export interface CanonicalHistoryDeclarationV2 {
  contractVersion: ChatContractVersion;
  format: string;
  mode: CanonicalHistoryModeV2;
  watchPath?: string;
  scripts: {
    readSession: string;
    listSessions: string;
  };
}

// ─── ReadChat result ─────────────────────────────────────────────────────

export type ReadChatStatusV2 =
  | 'idle'
  | 'generating'
  | 'waiting_approval'
  | 'error'
  | 'panel_hidden'
  | 'streaming';

export type ReadChatTurnStatusV2 = 'open' | 'waiting_approval' | 'complete' | 'error';

export interface ReadChatResultV2 {
  contractVersion: typeof CHAT_CONTRACT_VERSION_V2;
  workspace: WorkspaceContextV2;
  session: SessionContextV2;
  coverage: CoverageHintV2;
  status: ReadChatStatusV2;
  messages: ChatMessageV2[];
  currentTurnId: string;
  turnStatus: ReadChatTurnStatusV2;
  transcriptAuthority: 'provider' | 'daemon';
}

// ─── Validation primitives ───────────────────────────────────────────────

export class ChatContractViolationError extends Error {
  readonly violationPath: string;
  readonly contractVersion: ChatContractVersion;
  constructor(
    contractVersion: ChatContractVersion,
    violationPath: string,
    detail: string,
  ) {
    super(`chat contract ${contractVersion} violation at ${violationPath}: ${detail}`);
    this.name = 'ChatContractViolationError';
    this.violationPath = violationPath;
    this.contractVersion = contractVersion;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertSequenceMonotonic(
  messages: ReadonlyArray<{ sequence: number }>,
  pathPrefix: string,
): void {
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1]!.sequence;
    const cur = messages[i]!.sequence;
    if (!(cur > prev)) {
      throw new ChatContractViolationError(
        CHAT_CONTRACT_VERSION_V2,
        `${pathPrefix}[${i}].sequence`,
        `sequence must be strictly increasing (prev=${prev}, current=${cur})`,
      );
    }
  }
}

function assertOrderingTimestampMonotonic(
  messages: ReadonlyArray<{ orderingTimestamp: number }>,
  pathPrefix: string,
): void {
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1]!.orderingTimestamp;
    const cur = messages[i]!.orderingTimestamp;
    if (cur < prev) {
      throw new ChatContractViolationError(
        CHAT_CONTRACT_VERSION_V2,
        `${pathPrefix}[${i}].orderingTimestamp`,
        `orderingTimestamp must be monotonic non-decreasing (prev=${prev}, current=${cur})`,
      );
    }
  }
}

function assertIdentity(message: Record<string, unknown>, index: number): MessageIdentityV2 {
  const providerUnitKey = message['providerUnitKey'];
  const bubbleId = message['bubbleId'];
  const sequence = message['sequence'];
  const turnKey = message['turnKey'];
  if (typeof providerUnitKey !== 'string' || !providerUnitKey.length) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      `messages[${index}].providerUnitKey`,
      'must be a non-empty string',
    );
  }
  if (typeof bubbleId !== 'string' || !bubbleId.length) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      `messages[${index}].bubbleId`,
      'must be a non-empty string',
    );
  }
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      `messages[${index}].sequence`,
      'must be a non-negative integer',
    );
  }
  if (typeof turnKey !== 'string' || !turnKey.length) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      `messages[${index}].turnKey`,
      'must be a non-empty string',
    );
  }
  return { providerUnitKey, bubbleId, sequence, turnKey };
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      path,
      `must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

function assertContent(value: unknown, path: string): string | MessagePart[] {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value as MessagePart[];
  throw new ChatContractViolationError(
    CHAT_CONTRACT_VERSION_V2,
    path,
    'must be a string or MessagePart[]',
  );
}

function assertCoverage(value: unknown, path: string): CoverageHintV2 {
  if (!isPlainObject(value)) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      path,
      'must be a CoverageHintV2 object',
    );
  }
  const kind = value['kind'];
  switch (kind) {
    case 'full':
      return { kind: 'full' };
    case 'tail': {
      const n = value['tailMessageCount'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        throw new ChatContractViolationError(
          CHAT_CONTRACT_VERSION_V2,
          `${path}.tailMessageCount`,
          'must be a non-negative integer for tail coverage',
        );
      }
      return { kind: 'tail', tailMessageCount: n };
    }
    case 'current-turn': {
      const turnKey = value['turnKey'];
      if (typeof turnKey !== 'string' || !turnKey.length) {
        throw new ChatContractViolationError(
          CHAT_CONTRACT_VERSION_V2,
          `${path}.turnKey`,
          'current-turn coverage requires a non-empty turnKey',
        );
      }
      return { kind: 'current-turn', turnKey };
    }
    case 'partial': {
      const reason = value['partialReason'];
      if (typeof reason !== 'string' || !reason.length) {
        throw new ChatContractViolationError(
          CHAT_CONTRACT_VERSION_V2,
          `${path}.partialReason`,
          'partial coverage requires a non-empty partialReason',
        );
      }
      return { kind: 'partial', partialReason: reason };
    }
    case 'unavailable': {
      const reason = value['unavailableReason'];
      if (typeof reason !== 'string' || !reason.length) {
        throw new ChatContractViolationError(
          CHAT_CONTRACT_VERSION_V2,
          `${path}.unavailableReason`,
          'unavailable coverage requires a non-empty unavailableReason',
        );
      }
      return { kind: 'unavailable', unavailableReason: reason };
    }
    default:
      throw new ChatContractViolationError(
        CHAT_CONTRACT_VERSION_V2,
        `${path}.kind`,
        `must be one of full | tail | current-turn | partial | unavailable (got ${JSON.stringify(kind)})`,
      );
  }
}

function assertMessageV2(raw: unknown, index: number): ChatMessageV2 {
  if (!isPlainObject(raw)) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      `messages[${index}]`,
      'must be an object',
    );
  }
  const identity = assertIdentity(raw, index);
  const role = assertEnum(raw['role'], CHAT_ROLES_V2, `messages[${index}].role`);
  const kind = assertEnum(raw['kind'], CHAT_MESSAGE_KINDS_V2, `messages[${index}].kind`);
  const content = assertContent(raw['content'], `messages[${index}].content`);
  const bubbleState = assertEnum(
    raw['bubbleState'],
    CHAT_BUBBLE_STATES_V2,
    `messages[${index}].bubbleState`,
  );
  const timestamp = raw['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      `messages[${index}].timestamp`,
      'must be a finite number (ms since epoch)',
    );
  }
  const orderingTimestamp = raw['orderingTimestamp'];
  if (typeof orderingTimestamp !== 'number' || !Number.isFinite(orderingTimestamp)) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      `messages[${index}].orderingTimestamp`,
      'must be a finite number (ms since epoch)',
    );
  }
  const visibility = assertEnum(raw['visibility'], CHAT_VISIBILITIES_V2, `messages[${index}].visibility`);
  const audience = assertEnum(raw['audience'], CHAT_AUDIENCES_V2, `messages[${index}].audience`);
  const source = assertEnum(raw['source'], CHAT_SOURCES_V2, `messages[${index}].source`);
  const senderName = typeof raw['senderName'] === 'string' ? (raw['senderName'] as string) : '';
  const toolCalls = Array.isArray(raw['toolCalls']) ? (raw['toolCalls'] as ToolCallInfo[]) : [];
  const meta = isPlainObject(raw['meta']) ? (raw['meta'] as Record<string, unknown>) : {};

  return {
    ...identity,
    role,
    kind,
    content,
    bubbleState,
    timestamp,
    orderingTimestamp,
    visibility,
    audience,
    source,
    senderName,
    toolCalls,
    meta,
  };
}

/**
 * Validate a v2 read_chat payload. Throws ChatContractViolationError on the
 * first violation. v2 invariants beyond per-field checks:
 *   - messages[*].sequence strictly increasing
 *   - messages[*].orderingTimestamp monotonic non-decreasing
 *   - coverage union is well-formed
 */
export function assertReadChatResultV2Payload(raw: unknown): ReadChatResultV2 {
  if (!isPlainObject(raw)) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      '$',
      'must be an object',
    );
  }
  if (raw['contractVersion'] !== CHAT_CONTRACT_VERSION_V2) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      'contractVersion',
      `expected ${CHAT_CONTRACT_VERSION_V2}, got ${JSON.stringify(raw['contractVersion'])}`,
    );
  }
  const workspace = raw['workspace'];
  if (!isPlainObject(workspace) || typeof workspace['workspacePath'] !== 'string'
      || typeof workspace['intendedWorkspacePath'] !== 'string') {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      'workspace',
      'must have workspacePath and intendedWorkspacePath strings',
    );
  }
  const session = raw['session'];
  if (!isPlainObject(session) || typeof session['providerSessionId'] !== 'string') {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      'session',
      'must have providerSessionId string',
    );
  }
  const coverage = assertCoverage(raw['coverage'], 'coverage');
  const status = assertEnum(
    raw['status'],
    ['idle', 'generating', 'waiting_approval', 'error', 'panel_hidden', 'streaming'] as const,
    'status',
  );
  const turnStatus = assertEnum(
    raw['turnStatus'],
    ['open', 'waiting_approval', 'complete', 'error'] as const,
    'turnStatus',
  );
  const transcriptAuthority = assertEnum(
    raw['transcriptAuthority'],
    ['provider', 'daemon'] as const,
    'transcriptAuthority',
  );
  const currentTurnId = raw['currentTurnId'];
  if (typeof currentTurnId !== 'string') {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      'currentTurnId',
      'must be a string',
    );
  }
  if (!Array.isArray(raw['messages'])) {
    throw new ChatContractViolationError(
      CHAT_CONTRACT_VERSION_V2,
      'messages',
      'must be an array',
    );
  }
  const messages = raw['messages'].map((m, i) => assertMessageV2(m, i));
  assertSequenceMonotonic(messages, 'messages');
  assertOrderingTimestampMonotonic(messages, 'messages');

  const historySessionId = typeof session['historySessionId'] === 'string'
    ? (session['historySessionId'] as string)
    : undefined;

  return {
    contractVersion: CHAT_CONTRACT_VERSION_V2,
    workspace: {
      workspacePath: workspace['workspacePath'] as string,
      intendedWorkspacePath: workspace['intendedWorkspacePath'] as string,
    },
    session: historySessionId !== undefined
      ? { providerSessionId: session['providerSessionId'] as string, historySessionId }
      : { providerSessionId: session['providerSessionId'] as string },
    coverage,
    status,
    messages,
    currentTurnId,
    turnStatus,
    transcriptAuthority,
  };
}

// ─── Contract version negotiation ────────────────────────────────────────

export function isSupportedChatContractVersion(value: unknown): value is ChatContractVersion {
  return typeof value === 'string'
    && (SUPPORTED_CHAT_CONTRACT_VERSIONS as readonly string[]).includes(value);
}

/**
 * Read a provider's declared chat contract version from its parsed
 * provider.json `canonicalHistory.contractVersion` field.
 *
 * - Absent or unrecognized → treated as v1 (legacy behaviour preserved during
 *   the A1 transition). A2 will tighten this to reject unsupported versions
 *   at provider load time.
 * - Present and supported → returned as-is.
 *
 * The returned version drives which validator (assertReadChatResultV2Payload
 * vs the legacy validateReadChatResultPayload) processes the provider's
 * read_chat output.
 */
export function readDeclaredChatContractVersion(
  canonicalHistory: unknown,
): ChatContractVersion {
  if (!isPlainObject(canonicalHistory)) return CHAT_CONTRACT_VERSION_V1;
  const declared = canonicalHistory['contractVersion'];
  if (isSupportedChatContractVersion(declared)) return declared;
  return CHAT_CONTRACT_VERSION_V1;
}
