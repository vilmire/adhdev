import type { InputEnvelope, ProviderModule } from './contracts.js'

type InputMediaType = 'text' | 'image' | 'audio' | 'video' | 'resource'

const VALID_INPUT_MEDIA_TYPES = new Set<InputMediaType>(['text', 'image', 'audio', 'video', 'resource'])

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
} {
  const rawMediaTypes = Array.isArray(provider?.capabilities?.input?.mediaTypes)
    ? provider?.capabilities?.input?.mediaTypes.filter((type): type is InputMediaType => VALID_INPUT_MEDIA_TYPES.has(type as InputMediaType))
    : []

  return {
    multipart: provider?.capabilities?.input?.multipart === true,
    mediaTypes: new Set<InputMediaType>(rawMediaTypes.length > 0 ? rawMediaTypes : ['text']),
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
