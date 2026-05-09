import type { InputEnvelope, ProviderModule } from './contracts.js'

export type InputMediaType = 'text' | 'image' | 'audio' | 'video' | 'resource'

export type InputAttachmentStrategy =
  | 'native'
  | 'native_acp'
  | 'resource_link'
  | 'text_fallback'
  | 'paste'
  | 'upload'

export interface InputMediaStrategyDescriptor {
  mediaType: InputMediaType
  strategies: InputAttachmentStrategy[]
  native?: boolean
  degradation?: InputAttachmentStrategy[]
}

export interface MessageInputSupport {
  text: boolean
  multipart: boolean
  mediaTypes: InputMediaType[]
  strategies: InputMediaStrategyDescriptor[]
}

const VALID_INPUT_MEDIA_TYPES = new Set<InputMediaType>(['text', 'image', 'audio', 'video', 'resource'])
const VALID_INPUT_STRATEGIES = new Set<InputAttachmentStrategy>(['native', 'native_acp', 'resource_link', 'text_fallback', 'paste', 'upload'])

export const TEXT_ONLY_MESSAGE_INPUT_SUPPORT: MessageInputSupport = Object.freeze<MessageInputSupport>({
  text: true,
  multipart: false,
  mediaTypes: ['text'],
  strategies: [],
})

function getProviderLabel(provider?: Pick<ProviderModule, 'name' | 'type'> | null): string {
  return provider?.name || provider?.type || 'This provider'
}

function hasNonEmptyFallbackText(input: InputEnvelope): boolean {
  return typeof input.textFallback === 'string' && input.textFallback.trim().length > 0
}

function getRequestedInputMediaTypes(input: InputEnvelope): InputMediaType[] {
  const types = new Set<InputMediaType>()
  if (hasNonEmptyFallbackText(input) && !input.parts.some((part) => part.type === 'text')) {
    types.add('text')
  }
  for (const part of input.parts) {
    if (VALID_INPUT_MEDIA_TYPES.has(part.type as InputMediaType)) {
      types.add(part.type as InputMediaType)
    }
  }
  return Array.from(types)
}

function getEffectiveSemanticPartCount(input: InputEnvelope): number {
  let count = input.parts.length
  if (hasNonEmptyFallbackText(input) && !input.parts.some((part) => part.type === 'text')) {
    count += 1
  }
  return count
}

export function assertTextOnlyInput(provider: Pick<ProviderModule, 'name' | 'type'> | null | undefined, input: InputEnvelope): void {
  const unsupported = getRequestedInputMediaTypes(input).filter((type) => type !== 'text')
  if (unsupported.length === 0) return
  const label = getProviderLabel(provider)
  const suffix = unsupported.length === 1 ? '' : 's'
  throw new Error(`${label} only supports text input; unsupported input type${suffix}: ${unsupported.join(', ')}`)
}

export function getDeclaredProviderInputSupport(provider?: Pick<ProviderModule, 'capabilities'> | null): {
  multipart: boolean
  mediaTypes: Set<InputMediaType>
  strategies: InputMediaStrategyDescriptor[]
} {
  const rawMediaTypes = Array.isArray(provider?.capabilities?.input?.mediaTypes)
    ? provider?.capabilities?.input?.mediaTypes.filter((type): type is InputMediaType => VALID_INPUT_MEDIA_TYPES.has(type as InputMediaType))
    : []
  const strategies = normalizeInputStrategyDescriptors(provider?.capabilities?.input?.strategies)

  return {
    multipart: provider?.capabilities?.input?.multipart === true,
    mediaTypes: new Set<InputMediaType>(rawMediaTypes.length > 0 ? rawMediaTypes : ['text']),
    strategies,
  }
}

export function normalizeInputStrategyDescriptors(raw: unknown): InputMediaStrategyDescriptor[] {
  if (!Array.isArray(raw)) return []
  const result: InputMediaStrategyDescriptor[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const mediaType = record.mediaType
    if (typeof mediaType !== 'string' || !VALID_INPUT_MEDIA_TYPES.has(mediaType as InputMediaType)) continue
    const strategies = Array.isArray(record.strategies)
      ? record.strategies.filter((value): value is InputAttachmentStrategy => typeof value === 'string' && VALID_INPUT_STRATEGIES.has(value as InputAttachmentStrategy))
      : []
    const degradation = Array.isArray(record.degradation)
      ? record.degradation.filter((value): value is InputAttachmentStrategy => typeof value === 'string' && VALID_INPUT_STRATEGIES.has(value as InputAttachmentStrategy))
      : []
    if (strategies.length === 0 && degradation.length === 0) continue
    result.push({
      mediaType: mediaType as InputMediaType,
      strategies,
      ...(typeof record.native === 'boolean' ? { native: record.native } : {}),
      ...(degradation.length > 0 ? { degradation } : {}),
    })
  }
  return result
}

function promptCapabilityFlags(runtimeCapabilities?: Record<string, any> | null): { image: boolean; audio: boolean; embeddedContext: boolean } {
  const prompt = runtimeCapabilities?.promptCapabilities || {}
  return {
    image: prompt.image === true,
    audio: prompt.audio === true,
    embeddedContext: prompt.embeddedContext === true,
  }
}

function supportFromDeclared(provider?: Pick<ProviderModule, 'capabilities'> | null): MessageInputSupport {
  const declared = getDeclaredProviderInputSupport(provider)
  return {
    text: true,
    multipart: declared.multipart,
    mediaTypes: Array.from(declared.mediaTypes),
    strategies: declared.strategies,
  }
}

export function getEffectiveMessageInputSupport(
  provider?: Pick<ProviderModule, 'category' | 'capabilities'> | null,
  runtimeCapabilities?: Record<string, any> | null,
): MessageInputSupport {
  if (provider?.category !== 'acp') {
    const declared = supportFromDeclared(provider)
    return {
      ...declared,
      mediaTypes: [...declared.mediaTypes],
      strategies: declared.strategies.map((strategy) => ({
        ...strategy,
        strategies: [...strategy.strategies],
        ...(strategy.degradation ? { degradation: [...strategy.degradation] } : {}),
      })),
    }
  }

  const declared = supportFromDeclared(provider)
  const caps = promptCapabilityFlags(runtimeCapabilities)
  const mediaTypes = new Set<InputMediaType>(['text'])
  const strategies: InputMediaStrategyDescriptor[] = []

  if (declared.mediaTypes.includes('resource')) {
    mediaTypes.add('resource')
    strategies.push({ mediaType: 'resource', strategies: caps.embeddedContext ? ['native_acp', 'resource_link', 'text_fallback'] : ['resource_link', 'text_fallback'], native: caps.embeddedContext, degradation: ['resource_link', 'text_fallback'] })
  }
  if (declared.mediaTypes.includes('video')) {
    mediaTypes.add('video')
    strategies.push({ mediaType: 'video', strategies: ['resource_link', 'text_fallback'], native: false, degradation: ['resource_link', 'text_fallback'] })
  }
  if (declared.mediaTypes.includes('image')) {
    mediaTypes.add('image')
    strategies.push({ mediaType: 'image', strategies: caps.image ? ['native_acp', 'resource_link', 'text_fallback'] : ['resource_link', 'text_fallback'], native: caps.image, degradation: ['resource_link', 'text_fallback'] })
  }
  if (declared.mediaTypes.includes('audio')) {
    mediaTypes.add('audio')
    strategies.push({ mediaType: 'audio', strategies: caps.audio ? ['native_acp', 'resource_link', 'text_fallback'] : ['resource_link', 'text_fallback'], native: caps.audio, degradation: ['resource_link', 'text_fallback'] })
  }

  return {
    text: true,
    multipart: declared.multipart && mediaTypes.size > 1,
    mediaTypes: Array.from(mediaTypes),
    strategies,
  }
}

export function assertProviderSupportsDeclaredInput(provider: Pick<ProviderModule, 'name' | 'type' | 'capabilities'> | null | undefined, input: InputEnvelope): void {
  const label = getProviderLabel(provider)
  const support = getDeclaredProviderInputSupport(provider)
  const requestedTypes = getRequestedInputMediaTypes(input)
  const unsupported = requestedTypes.filter((type) => !support.mediaTypes.has(type))
  if (unsupported.length > 0) {
    const suffix = unsupported.length === 1 ? '' : 's'
    throw new Error(`${label} does not support input type${suffix}: ${unsupported.join(', ')}`)
  }

  if (getEffectiveSemanticPartCount(input) > 1 && !support.multipart) {
    throw new Error(`${label} does not support multipart input`)
  }
}
