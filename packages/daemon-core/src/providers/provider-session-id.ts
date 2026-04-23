import type { ProviderModule } from './contracts.js'

/**
 * Normalize and validate a provider session ID using the declarative `sessionIdPattern`
 * from the provider's ProviderModule definition.
 */
export function normalizeProviderSessionId(
  provider: ProviderModule | undefined,
  providerSessionId: string | null | undefined,
): string {
  const normalizedId = typeof providerSessionId === 'string' ? providerSessionId.trim() : ''
  if (!normalizedId) return ''

  const lowered = normalizedId.toLowerCase()
  if (lowered === 'undefined' || lowered === 'null') return ''

  const sessionIdPattern = provider?.sessionIdPattern
  if (sessionIdPattern) {
    try {
      const re = new RegExp(sessionIdPattern, 'i')
      if (!re.test(normalizedId)) return ''
    } catch {
      // Invalid regex in provider.json — skip validation
    }
  }

  return normalizedId
}
