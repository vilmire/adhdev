import type {
  ReadChatCursor,
  ReadChatSyncMode,
  ReadChatSyncResult,
  SessionChatTailUpdate,
  SessionModalUpdate,
} from '../shared-types.js'
import {
  buildChatTailDeliverySignature,
  buildSessionModalDeliverySignature,
} from './chat-signatures.js'
import { normalizeManagedStatus } from '../status/normalize.js'

export interface ChatTailSubscriptionCursor {
  knownMessageCount: number
  lastMessageSignature: string
  tailLimit: number
}

export type SessionChatTailCommandResult = Partial<Omit<ReadChatSyncResult, 'activeModal'>> & {
  success?: boolean
  activeModal?: unknown
}

export interface PrepareSessionChatTailUpdateInput {
  key: string
  sessionId: string
  historySessionId?: string
  seq: number
  timestamp: number
  interactionId?: string
  cursor: ChatTailSubscriptionCursor
  lastDeliveredSignature: string
  result: SessionChatTailCommandResult | null | undefined
}

export interface PreparedSessionChatTailUpdate {
  cursor: ChatTailSubscriptionCursor
  seq: number
  lastDeliveredSignature: string
  update: SessionChatTailUpdate | null
}

export interface PrepareSessionModalUpdateInput {
  key: string
  sessionId: string
  status: string
  title?: string
  activeModal?: unknown
  seq: number
  timestamp: number
  interactionId?: string
  lastDeliveredSignature: string
}

export interface PreparedSessionModalUpdate {
  seq: number
  lastDeliveredSignature: string
  update: SessionModalUpdate | null
}

function normalizeSyncMode(syncMode: string | undefined): ReadChatSyncMode {
  return syncMode === 'append'
    || syncMode === 'replace_tail'
    || syncMode === 'noop'
    || syncMode === 'full'
    ? syncMode
    : 'full'
}

function normalizeModalButtons(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((button): button is string => typeof button === 'string')
    : []
}

function normalizeModalMessage(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function normalizeChatTailActiveModal(activeModal: unknown): { message: string; buttons: string[] } | null {
  if (!activeModal || typeof activeModal !== 'object') return null
  const message = normalizeModalMessage((activeModal as { message?: unknown }).message)
  if (!message) return null
  const rawButtons = (activeModal as { buttons?: unknown }).buttons
  if (!Array.isArray(rawButtons)) return null
  return {
    message,
    buttons: normalizeModalButtons(rawButtons),
  }
}

export function normalizeSessionModalFields(activeModal: unknown): { modalMessage?: string; modalButtons: string[] } {
  if (!activeModal || typeof activeModal !== 'object') {
    return { modalButtons: [] }
  }

  return {
    modalMessage: normalizeModalMessage((activeModal as { message?: unknown }).message),
    modalButtons: normalizeModalButtons((activeModal as { buttons?: unknown }).buttons),
  }
}

function buildNextChatCursor(
  cursor: ChatTailSubscriptionCursor,
  result: SessionChatTailCommandResult,
): ChatTailSubscriptionCursor {
  return {
    knownMessageCount: Math.max(0, Number(result.totalMessages || cursor.knownMessageCount)),
    lastMessageSignature: typeof result.lastMessageSignature === 'string'
      ? result.lastMessageSignature
      : cursor.lastMessageSignature,
    tailLimit: cursor.tailLimit,
  }
}

export function prepareSessionChatTailUpdate(
  input: PrepareSessionChatTailUpdateInput,
): PreparedSessionChatTailUpdate {
  const result = input.result
  if (!result?.success || result.syncMode === 'noop') {
    return {
      cursor: result?.success ? buildNextChatCursor(input.cursor, result) : input.cursor,
      seq: input.seq,
      lastDeliveredSignature: input.lastDeliveredSignature,
      update: null,
    }
  }

  const syncMode = normalizeSyncMode(result.syncMode)
  const cursor = {
    knownMessageCount: Math.max(0, Number(result.totalMessages || 0)),
    lastMessageSignature: typeof result.lastMessageSignature === 'string' ? result.lastMessageSignature : '',
    tailLimit: input.cursor.tailLimit,
  }
  const title = typeof result.title === 'string' ? result.title : undefined
  const activeModal = normalizeChatTailActiveModal(result.activeModal)
  const status = typeof result.status === 'string' ? result.status : 'idle'
  const deliverySignature = buildChatTailDeliverySignature({
    sessionId: input.sessionId,
    ...(input.historySessionId ? { historySessionId: input.historySessionId } : {}),
    messages: Array.isArray(result.messages) ? result.messages : [],
    status,
    ...(title ? { title } : {}),
    ...(activeModal ? { activeModal } : {}),
    syncMode,
    replaceFrom: Number(result.replaceFrom || 0),
    totalMessages: Number(result.totalMessages || 0),
    lastMessageSignature: typeof result.lastMessageSignature === 'string' ? result.lastMessageSignature : '',
  })
  const seq = input.seq + 1

  if (deliverySignature === input.lastDeliveredSignature) {
    return {
      cursor,
      seq,
      lastDeliveredSignature: input.lastDeliveredSignature,
      update: null,
    }
  }

  return {
    cursor,
    seq,
    lastDeliveredSignature: deliverySignature,
    update: {
      topic: 'session.chat_tail',
      key: input.key,
      sessionId: input.sessionId,
      ...(input.historySessionId ? { historySessionId: input.historySessionId } : {}),
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      seq,
      timestamp: input.timestamp,
      messages: Array.isArray(result.messages) ? result.messages : [],
      status,
      ...(title ? { title } : {}),
      ...(activeModal ? { activeModal } : {}),
      syncMode,
      replaceFrom: Number(result.replaceFrom || 0),
      totalMessages: Number(result.totalMessages || 0),
      lastMessageSignature: typeof result.lastMessageSignature === 'string' ? result.lastMessageSignature : '',
    },
  }
}

export function prepareSessionModalUpdate(
  input: PrepareSessionModalUpdateInput,
): PreparedSessionModalUpdate {
  const { modalMessage, modalButtons } = normalizeSessionModalFields(input.activeModal)
  const status = normalizeManagedStatus(input.status, {
    activeModal: modalButtons.length > 0 ? { buttons: modalButtons } : null,
  })
  const deliverySignature = buildSessionModalDeliverySignature({
    sessionId: input.sessionId,
    status,
    ...(input.title ? { title: input.title } : {}),
    ...(modalMessage ? { modalMessage } : {}),
    ...(modalButtons.length > 0 ? { modalButtons } : {}),
  })

  if (deliverySignature === input.lastDeliveredSignature) {
    return {
      seq: input.seq,
      lastDeliveredSignature: input.lastDeliveredSignature,
      update: null,
    }
  }

  const seq = input.seq + 1
  return {
    seq,
    lastDeliveredSignature: deliverySignature,
    update: {
      topic: 'session.modal',
      key: input.key,
      sessionId: input.sessionId,
      status,
      ...(input.title ? { title: input.title } : {}),
      ...(modalMessage ? { modalMessage } : {}),
      ...(modalButtons.length > 0 ? { modalButtons } : {}),
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      seq,
      timestamp: input.timestamp,
    },
  }
}
