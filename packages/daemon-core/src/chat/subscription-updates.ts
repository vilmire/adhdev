import type { SessionModalUpdate } from '../shared-types.js'
import { buildSessionModalDeliverySignature } from './chat-signatures.js'
import { normalizeManagedStatus } from '../status/normalize.js'

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

function normalizeModalButtons(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((button): button is string => typeof button === 'string')
    : []
}

function normalizeModalMessage(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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
