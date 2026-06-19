import type { MessagePart, ModalInfo, ReadChatResult } from './contracts.js'
import { normalizeMessageParts } from './contracts.js'
import type { ChatBubbleState, ChatMessage } from '../types.js'
import {
  CHAT_CONTRACT_VERSION_V1,
  CHAT_CONTRACT_VERSION_V2,
  assertReadChatResultV2Payload,
  isSupportedChatContractVersion,
  type ChatContractVersion,
  type ReadChatResultV2,
} from './transcript-v2.js'

const VALID_STATUSES = ['idle', 'generating', 'waiting_approval', 'error', 'panel_hidden', 'starting', 'streaming', 'no_progress', 'long_generating'] as const
const VALID_ROLES = ['user', 'assistant', 'system', 'human'] as const
const VALID_BUBBLE_STATES = ['draft', 'streaming', 'final', 'removed'] as const
const VALID_TURN_STATUSES = ['open', 'waiting_approval', 'complete', 'error'] as const

type ValidStatus = typeof VALID_STATUSES[number]
type ValidRole = typeof VALID_ROLES[number]
type ValidTurnStatus = typeof VALID_TURN_STATUSES[number]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateStatus(status: unknown, source: string): ValidStatus {
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as ValidStatus)) {
    throw new Error(`${source}: status must be one of ${VALID_STATUSES.join(', ')}`)
  }
  return status as ValidStatus
}

function validateRole(role: unknown, source: string, index: number): ValidRole {
  if (typeof role !== 'string' || !VALID_ROLES.includes(role as ValidRole)) {
    throw new Error(`${source}: messages[${index}].role must be one of ${VALID_ROLES.join(', ')}`)
  }
  return role as ValidRole
}

function validateBubbleState(state: unknown, source: string, index: number): ChatBubbleState {
  if (typeof state !== 'string' || !VALID_BUBBLE_STATES.includes(state as ChatBubbleState)) {
    throw new Error(`${source}: messages[${index}].bubbleState must be one of ${VALID_BUBBLE_STATES.join(', ')}`)
  }
  return state as ChatBubbleState
}

function validateTurnStatus(turnStatus: unknown, source: string): ValidTurnStatus {
  if (typeof turnStatus !== 'string' || !VALID_TURN_STATUSES.includes(turnStatus as ValidTurnStatus)) {
    throw new Error(`${source}: turnStatus must be one of ${VALID_TURN_STATUSES.join(', ')}`)
  }
  return turnStatus as ValidTurnStatus
}

function validateMessageContent(content: unknown, source: string, index: number): string | MessagePart[] {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return normalizeMessageParts(content as any)
  throw new Error(`${source}: messages[${index}].content must be a string or structured content array`)
}

function validateMessage(message: unknown, source: string, index: number): ChatMessage {
  if (!isPlainObject(message)) {
    throw new Error(`${source}: messages[${index}] must be an object`)
  }

  const normalized: ChatMessage = {
    role: validateRole(message.role, source, index),
    content: validateMessageContent(message.content, source, index),
  }

  if (typeof message.kind === 'string') normalized.kind = message.kind as ChatMessage['kind']
  if (typeof message.id === 'string') normalized.id = message.id
  if (typeof message.bubbleId === 'string') normalized.bubbleId = message.bubbleId
  if (typeof message.providerUnitKey === 'string') normalized.providerUnitKey = message.providerUnitKey
  if (message.bubbleState !== undefined) normalized.bubbleState = validateBubbleState(message.bubbleState, source, index)
  if (isFiniteNumber(message.index)) normalized.index = message.index
  if (isFiniteNumber(message.timestamp)) normalized.timestamp = message.timestamp
  if (isFiniteNumber(message.receivedAt)) normalized.receivedAt = message.receivedAt
  // (A2.3) sequence is the monotonic ordering key consumed by ChatSourceMachine.
  // v1 producers omit it; the daemon derives it in normalizeNativeHistoryMessages.
  if (isFiniteNumber(message.sequence)) normalized.sequence = message.sequence
  if (typeof message._turnKey === 'string') normalized._turnKey = message._turnKey
  if (Array.isArray(message.toolCalls)) normalized.toolCalls = message.toolCalls as ChatMessage['toolCalls']
  if (isPlainObject(message.meta)) normalized.meta = message.meta as ChatMessage['meta']
  if (typeof message.senderName === 'string') normalized.senderName = message.senderName
  if (typeof message._type === 'string') normalized._type = message._type
  if (typeof message._sub === 'string') normalized._sub = message._sub
  if (typeof message.visibility === 'string') normalized.visibility = message.visibility
  if (typeof message.transcriptVisibility === 'string') normalized.transcriptVisibility = message.transcriptVisibility
  if (typeof message.audience === 'string') normalized.audience = message.audience
  if (typeof message.source === 'string') normalized.source = message.source
  if (typeof message.userFacing === 'boolean') normalized.userFacing = message.userFacing
  if (typeof message.internal === 'boolean') normalized.internal = message.internal
  if (typeof message.isInternal === 'boolean') normalized.isInternal = message.isInternal
  if (typeof message.debug === 'boolean') normalized.debug = message.debug

  return normalized
}

function validateModal(activeModal: unknown, status: ValidStatus, source: string): ModalInfo | null | undefined {
  if (activeModal == null) {
    if (status === 'waiting_approval') {
      throw new Error(`${source}: waiting_approval status requires activeModal with buttons`)
    }
    return activeModal === null ? null : undefined
  }
  if (!isPlainObject(activeModal)) {
    throw new Error(`${source}: activeModal must be an object when provided`)
  }
  if (typeof activeModal.message !== 'string') {
    throw new Error(`${source}: activeModal.message must be a string`)
  }
  if (!Array.isArray(activeModal.buttons) || activeModal.buttons.some((button) => typeof button !== 'string' || !button.trim())) {
    throw new Error(`${source}: activeModal.buttons must be a non-empty string array`)
  }
  const normalized: ModalInfo = {
    message: activeModal.message,
    buttons: activeModal.buttons.map((button) => button.trim()),
  }
  if (isFiniteNumber(activeModal.width)) normalized.width = activeModal.width
  if (isFiniteNumber(activeModal.height)) normalized.height = activeModal.height
  return normalized
}

function validateControlValues(controlValues: unknown, source: string): Record<string, string | number | boolean> | undefined {
  if (controlValues === undefined) return undefined
  if (!isPlainObject(controlValues)) {
    throw new Error(`${source}: controlValues must be an object when provided`)
  }
  const normalized: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(controlValues)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`${source}: controlValues.${key} must be string, number, or boolean`)
    }
    normalized[key] = value
  }
  return normalized
}

/**
 * Read the producer-declared contract version from a raw read_chat payload.
 * Returns v1 when absent or unrecognised, so legacy producers keep working
 * through A1. A2 will tighten this to throw when an unsupported version is
 * declared.
 */
export function readPayloadContractVersion(raw: unknown): ChatContractVersion {
  if (!isPlainObject(raw)) return CHAT_CONTRACT_VERSION_V1
  const declared = (raw as Record<string, unknown>).contractVersion
  if (isSupportedChatContractVersion(declared)) return declared
  return CHAT_CONTRACT_VERSION_V1
}

/**
 * Validate a v2 payload. Thin wrapper around assertReadChatResultV2Payload
 * that prefixes the contract violation with the caller's source label.
 */
export function validateReadChatResultV2Payload(raw: unknown, source = 'read_chat'): ReadChatResultV2 {
  try {
    return assertReadChatResultV2Payload(raw)
  } catch (err) {
    if (err instanceof Error) {
      err.message = `${source}: ${err.message}`
    }
    throw err
  }
}

/**
 * Versioned entry point. Routes on the producer-declared contractVersion:
 *   - v2 → strict v2 validation (transcript-v2.ts invariants)
 *   - v1 (or absent) → legacy permissive validation
 *
 * Callers that have not yet been audited to handle v2 outputs should use
 * validateReadChatResultPayload directly; that path stays bound to v1 shape
 * during the A1 transition.
 */
export function validateReadChatResultPayloadVersioned(
  raw: unknown,
  source = 'read_chat',
): { version: typeof CHAT_CONTRACT_VERSION_V1; payload: ReadChatResult & Record<string, unknown> }
  | { version: typeof CHAT_CONTRACT_VERSION_V2; payload: ReadChatResultV2 } {
  const version = readPayloadContractVersion(raw)
  if (version === CHAT_CONTRACT_VERSION_V2) {
    return { version, payload: validateReadChatResultV2Payload(raw, source) }
  }
  return { version: CHAT_CONTRACT_VERSION_V1, payload: validateReadChatResultPayload(raw, source) }
}

export function validateReadChatResultPayload(raw: unknown, source = 'read_chat'): ReadChatResult & Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new Error(`${source}: payload must be an object`)
  }

  const status = validateStatus(raw.status, source)
  if (!Array.isArray(raw.messages)) {
    throw new Error(`${source}: messages must be an array`)
  }
  const messages = raw.messages.map((message, index) => validateMessage(message, source, index))
  const activeModal = validateModal(raw.activeModal, status, source)
  const controlValues = validateControlValues(raw.controlValues, source)

  const normalized: ReadChatResult & Record<string, unknown> = {
    status: status as any,
    messages,
  }

  if (activeModal !== undefined) normalized.activeModal = activeModal
  if (typeof raw.id === 'string') normalized.id = raw.id
  if (typeof raw.title === 'string') normalized.title = raw.title
  if (typeof raw.currentTurnId === 'string') normalized.currentTurnId = raw.currentTurnId
  if (raw.turnStatus !== undefined) normalized.turnStatus = validateTurnStatus(raw.turnStatus, source)
  if (typeof raw.agentType === 'string') normalized.agentType = raw.agentType
  if (typeof raw.agentName === 'string') normalized.agentName = raw.agentName
  if (typeof raw.extensionId === 'string') normalized.extensionId = raw.extensionId
  if (typeof raw.inputContent === 'string') normalized.inputContent = raw.inputContent
  if (typeof raw.isVisible === 'boolean') normalized.isVisible = raw.isVisible
  if (typeof raw.isWelcomeScreen === 'boolean') normalized.isWelcomeScreen = raw.isWelcomeScreen
  if (controlValues) normalized.controlValues = controlValues
  if (raw.summaryMetadata !== undefined) normalized.summaryMetadata = raw.summaryMetadata as any
  if (Array.isArray(raw.effects)) normalized.effects = raw.effects as any
  if (typeof raw.providerSessionId === 'string') normalized.providerSessionId = raw.providerSessionId
  if (raw.transcriptAuthority === 'provider' || raw.transcriptAuthority === 'daemon') normalized.transcriptAuthority = raw.transcriptAuthority
  if (raw.coverage === 'full' || raw.coverage === 'tail' || raw.coverage === 'current-turn') normalized.coverage = raw.coverage

  return normalized
}
