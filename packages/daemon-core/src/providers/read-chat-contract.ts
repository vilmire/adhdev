import type { MessagePart, ModalInfo, ReadChatResult } from './contracts.js'
import { normalizeMessageParts } from './contracts.js'
import type { ChatBubbleState, ChatMessage } from '../types.js'

const VALID_STATUSES = ['idle', 'generating', 'waiting_approval', 'error', 'panel_hidden', 'starting', 'streaming', 'long_generating'] as const
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

  if (typeof message.kind === 'string') normalized.kind = message.kind as any
  if (typeof message.id === 'string') normalized.id = message.id
  if (typeof message.bubbleId === 'string') normalized.bubbleId = message.bubbleId
  if (typeof message.providerUnitKey === 'string') normalized.providerUnitKey = message.providerUnitKey
  if (message.bubbleState !== undefined) normalized.bubbleState = validateBubbleState(message.bubbleState, source, index)
  if (isFiniteNumber(message.index)) normalized.index = message.index
  if (isFiniteNumber(message.timestamp)) normalized.timestamp = message.timestamp
  if (isFiniteNumber(message.receivedAt)) normalized.receivedAt = message.receivedAt
  if (typeof (message as any)._turnKey === 'string') normalized._turnKey = (message as any)._turnKey
  if (Array.isArray(message.toolCalls)) normalized.toolCalls = message.toolCalls as any
  if (isPlainObject(message.meta)) normalized.meta = message.meta as any
  if (typeof message.senderName === 'string') normalized.senderName = message.senderName
  if (typeof (message as any)._type === 'string') normalized._type = (message as any)._type
  if (typeof (message as any)._sub === 'string') normalized._sub = (message as any)._sub
  if (typeof (message as any).visibility === 'string') normalized.visibility = (message as any).visibility
  if (typeof (message as any).transcriptVisibility === 'string') normalized.transcriptVisibility = (message as any).transcriptVisibility
  if (typeof (message as any).audience === 'string') normalized.audience = (message as any).audience
  if (typeof (message as any).source === 'string') normalized.source = (message as any).source
  if (typeof (message as any).userFacing === 'boolean') normalized.userFacing = (message as any).userFacing
  if (typeof (message as any).internal === 'boolean') normalized.internal = (message as any).internal
  if (typeof (message as any).isInternal === 'boolean') normalized.isInternal = (message as any).isInternal
  if (typeof (message as any).debug === 'boolean') normalized.debug = (message as any).debug

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
