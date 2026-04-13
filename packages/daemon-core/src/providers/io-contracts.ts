import type { ContentAnnotations } from './contracts.js'

export type InputPart =
  | TextInputPart
  | ImageInputPart
  | AudioInputPart
  | VideoInputPart
  | ResourceInputPart

export interface TextInputPart {
  type: 'text'
  text: string
}

export interface ImageInputPart {
  type: 'image'
  mimeType: string
  uri?: string
  data?: string
  alt?: string
}

export interface AudioInputPart {
  type: 'audio'
  mimeType: string
  uri?: string
  data?: string
  transcript?: string
}

export interface VideoInputPart {
  type: 'video'
  mimeType: string
  uri?: string
  data?: string
  posterUri?: string
}

export interface ResourceInputPart {
  type: 'resource'
  uri: string
  mimeType?: string
  name?: string
  text?: string
  data?: string
}

export interface InputEnvelope {
  parts: InputPart[]
  textFallback: string
  metadata?: {
    source?: 'dashboard' | 'shortcut_api' | 'provider_script' | 'session_replay'
    clientTimestamp?: number
  }
}

export type MessagePart =
  | TextMessagePart
  | ImageMessagePart
  | AudioMessagePart
  | VideoMessagePart
  | ResourceLinkMessagePart
  | ResourceMessagePart

export interface TextMessagePart {
  type: 'text'
  text: string
  annotations?: ContentAnnotations
}

export interface ImageMessagePart {
  type: 'image'
  mimeType: string
  uri?: string
  data?: string
  annotations?: ContentAnnotations
}

export interface AudioMessagePart {
  type: 'audio'
  mimeType: string
  uri?: string
  data?: string
  transcript?: string
  annotations?: ContentAnnotations
}

export interface VideoMessagePart {
  type: 'video'
  mimeType: string
  uri?: string
  data?: string
  posterUri?: string
  annotations?: ContentAnnotations
}

export interface ResourceLinkMessagePart {
  type: 'resource_link'
  uri: string
  name: string
  mimeType?: string
  size?: number
}

export interface ResourceMessagePart {
  type: 'resource'
  resource: {
    uri: string
    mimeType?: string | null
    text?: string
    blob?: string
  }
}

export function normalizeInputEnvelope(input: unknown): InputEnvelope {
  const normalized = normalizeInputEnvelopePayload(input)
  const textFallback = normalized.textFallback ?? flattenInputParts(normalized.parts)
  return {
    parts: normalized.parts,
    textFallback,
    ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
  }
}

export function normalizeMessageParts(content: unknown): MessagePart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
      return [{ type: 'text', text: String((content as { text: string }).text) }]
    }
    return []
  }

  const parts: MessagePart[] = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push({ type: 'text', text: raw })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const part = normalizeMessagePartObject(raw)
    if (part) parts.push(part)
  }
  return parts
}

export function flattenMessageParts(parts: MessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'resource') return part.resource.text || ''
      return ''
    })
    .filter((value) => value.length > 0)
    .join('\n')
}

function normalizeInputEnvelopePayload(input: unknown): Omit<InputEnvelope, 'textFallback'> & { textFallback?: string } {
  if (typeof input === 'string') {
    return { parts: [{ type: 'text', text: input }], textFallback: input }
  }

  if (!input || typeof input !== 'object') {
    return { parts: [], textFallback: '' }
  }

  const record = input as Record<string, unknown>
  const nestedInput = record.input
  if (nestedInput && typeof nestedInput === 'object') {
    const nested = nestedInput as Record<string, unknown>
    return {
      parts: normalizeInputParts(nested.parts ?? nested.prompt),
      textFallback: typeof nested.textFallback === 'string' ? nested.textFallback : undefined,
      metadata: normalizeInputMetadata(nested.metadata),
    }
  }

  const directText = typeof record.text === 'string'
    ? record.text
    : (typeof record.message === 'string' ? record.message : undefined)
  if (directText !== undefined) {
    return { parts: [{ type: 'text', text: directText }], textFallback: directText }
  }

  const directParts = normalizeInputParts(record.parts ?? record.prompt)
  return {
    parts: directParts,
    textFallback: typeof record.textFallback === 'string' ? record.textFallback : undefined,
    metadata: normalizeInputMetadata(record.metadata),
  }
}

function normalizeInputMetadata(value: unknown): InputEnvelope['metadata'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const metadata: InputEnvelope['metadata'] = {}
  if (record.source === 'dashboard' || record.source === 'shortcut_api' || record.source === 'provider_script' || record.source === 'session_replay') {
    metadata.source = record.source
  }
  if (typeof record.clientTimestamp === 'number' && Number.isFinite(record.clientTimestamp)) {
    metadata.clientTimestamp = record.clientTimestamp
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function normalizeInputParts(value: unknown): InputPart[] {
  if (!Array.isArray(value)) return []
  const parts: InputPart[] = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      parts.push({ type: 'text', text: raw })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const part = normalizeInputPartObject(raw)
    if (part) parts.push(part)
  }
  return parts
}

function normalizeInputPartObject(raw: Record<string, unknown>): InputPart | null {
  const type = raw.type
  if (type === 'text' && typeof raw.text === 'string') {
    return { type, text: raw.text }
  }
  if (type === 'image' && typeof raw.mimeType === 'string') {
    return {
      type,
      mimeType: raw.mimeType,
      ...(typeof raw.uri === 'string' ? { uri: raw.uri } : {}),
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
      ...(typeof raw.alt === 'string' ? { alt: raw.alt } : {}),
    }
  }
  if (type === 'audio' && typeof raw.mimeType === 'string') {
    return {
      type,
      mimeType: raw.mimeType,
      ...(typeof raw.uri === 'string' ? { uri: raw.uri } : {}),
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
      ...(typeof raw.transcript === 'string' ? { transcript: raw.transcript } : {}),
    }
  }
  if (type === 'video' && typeof raw.mimeType === 'string') {
    return {
      type,
      mimeType: raw.mimeType,
      ...(typeof raw.uri === 'string' ? { uri: raw.uri } : {}),
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
      ...(typeof raw.posterUri === 'string' ? { posterUri: raw.posterUri } : {}),
    }
  }
  if (type === 'resource' && typeof raw.uri === 'string') {
    return {
      type,
      uri: raw.uri,
      ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}),
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
    }
  }
  if (type === 'resource_link' && typeof raw.uri === 'string') {
    return {
      type: 'resource',
      uri: raw.uri,
      ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}),
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    }
  }
  return null
}

function normalizeMessagePartObject(raw: Record<string, unknown>): MessagePart | null {
  const type = raw.type
  if (type === 'text' && typeof raw.text === 'string') {
    return { type, text: raw.text }
  }
  if (type === 'image' && typeof raw.mimeType === 'string') {
    return {
      type,
      mimeType: raw.mimeType,
      ...(typeof raw.uri === 'string' ? { uri: raw.uri } : {}),
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
    }
  }
  if (type === 'audio' && typeof raw.mimeType === 'string') {
    return {
      type,
      mimeType: raw.mimeType,
      ...(typeof raw.uri === 'string' ? { uri: raw.uri } : {}),
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
      ...(typeof raw.transcript === 'string' ? { transcript: raw.transcript } : {}),
    }
  }
  if (type === 'video' && typeof raw.mimeType === 'string') {
    return {
      type,
      mimeType: raw.mimeType,
      ...(typeof raw.uri === 'string' ? { uri: raw.uri } : {}),
      ...(typeof raw.data === 'string' ? { data: raw.data } : {}),
      ...(typeof raw.posterUri === 'string' ? { posterUri: raw.posterUri } : {}),
    }
  }
  if (type === 'resource_link' && typeof raw.uri === 'string' && typeof raw.name === 'string') {
    return {
      type,
      uri: raw.uri,
      name: raw.name,
      ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}),
      ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
    }
  }
  if (type === 'resource' && raw.resource && typeof raw.resource === 'object') {
    const resource = raw.resource as Record<string, unknown>
    if (typeof resource.uri !== 'string') return null
    return {
      type,
      resource: {
        uri: resource.uri,
        ...(typeof resource.mimeType === 'string' || resource.mimeType === null ? { mimeType: resource.mimeType as string | null } : {}),
        ...(typeof resource.text === 'string' ? { text: resource.text } : {}),
        ...(typeof resource.blob === 'string' ? { blob: resource.blob } : {}),
      },
    }
  }
  return null
}

function flattenInputParts(parts: InputPart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'audio') return part.transcript || ''
      if (part.type === 'resource') return part.text || ''
      return ''
    })
    .filter((value) => value.length > 0)
    .join('\n')
}
