const HERMES_SESSION_ID_RE = /^\d{8}_\d{6}_[a-z0-9]+$/i

export function normalizeProviderSessionId(providerType: string | undefined, providerSessionId: string | null | undefined): string {
  const normalizedProviderType = typeof providerType === 'string' ? providerType.trim() : ''
  const normalizedId = typeof providerSessionId === 'string' ? providerSessionId.trim() : ''
  if (!normalizedId) return ''

  const lowered = normalizedId.toLowerCase()
  if (lowered === 'undefined' || lowered === 'null') return ''

  if (normalizedProviderType === 'hermes-cli' && !HERMES_SESSION_ID_RE.test(normalizedId)) {
    return ''
  }

  return normalizedId
}

export function isLegacyVolatileSessionReadKey(key: string | null | undefined): boolean {
  const normalizedKey = typeof key === 'string' ? key.trim() : ''
  if (!normalizedKey) return false
  return normalizedKey.startsWith('provider:codex:vscode-webview://')
}
