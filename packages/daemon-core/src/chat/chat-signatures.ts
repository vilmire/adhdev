export interface ChatMessageSignatureInput {
  id?: string | number | null
  index?: number | null
  role?: string | null
  receivedAt?: string | number | null
  timestamp?: string | number | null
  content?: unknown
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
