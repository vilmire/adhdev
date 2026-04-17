export interface ChatMessageSignatureInput {
  id?: string | number | null
  index?: number | null
  role?: string | null
  receivedAt?: string | number | null
  timestamp?: string | number | null
  content?: unknown
}

export interface ChatTailDeliverySignatureInput {
  sessionId: string
  historySessionId?: string
  messages: unknown[]
  status: string
  title?: string
  activeModal?: { message: string; buttons: string[] } | null
  syncMode: string
  replaceFrom: number
  totalMessages: number
  lastMessageSignature: string
}

export interface SessionModalDeliverySignatureInput {
  sessionId: string
  status: string
  title?: string
  modalMessage?: string
  modalButtons?: string[]
}

export function hashSignatureParts(parts: string[]): string {
  let hash = 0x811c9dc5
  for (const part of parts) {
    const text = String(part || '')
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function stringifySignatureContent(content: unknown): string {
  try {
    return JSON.stringify(content ?? '')
  } catch {
    return String(content ?? '')
  }
}

function stringifySignatureMessages(messages: unknown[]): string {
  try {
    return JSON.stringify(messages)
  } catch {
    return String(messages.length)
  }
}

export function buildChatMessageSignature(message: ChatMessageSignatureInput | null | undefined): string {
  if (!message) return ''
  return hashSignatureParts([
    String(message.id || ''),
    String(message.index ?? ''),
    String(message.role || ''),
    String(message.receivedAt ?? message.timestamp ?? ''),
    stringifySignatureContent(message.content),
  ])
}

export function buildChatTailDeliverySignature(payload: ChatTailDeliverySignatureInput): string {
  return hashSignatureParts([
    payload.sessionId,
    payload.historySessionId || '',
    payload.status,
    payload.title || '',
    payload.syncMode,
    String(payload.replaceFrom),
    String(payload.totalMessages),
    payload.lastMessageSignature,
    payload.activeModal ? `${payload.activeModal.message}|${payload.activeModal.buttons.join('\u001f')}` : '',
    stringifySignatureMessages(payload.messages),
  ])
}

export function buildSessionModalDeliverySignature(payload: SessionModalDeliverySignatureInput): string {
  return hashSignatureParts([
    payload.sessionId,
    payload.status,
    payload.title || '',
    payload.modalMessage || '',
    Array.isArray(payload.modalButtons) ? payload.modalButtons.join('\u001f') : '',
  ])
}
