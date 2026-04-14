export interface ProviderSourceConfigPayload {
  sourceMode: 'normal' | 'no-upstream'
  disableUpstream: boolean
  explicitProviderDir: string | null
  userDir: string
  upstreamDir: string
  providerRoots: string[]
}

interface ProviderSourceConfigResponse {
  result?: unknown
  sourceConfig?: unknown
}

function isPayload(value: unknown): value is ProviderSourceConfigPayload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (candidate.sourceMode === 'normal' || candidate.sourceMode === 'no-upstream')
    && typeof candidate.disableUpstream === 'boolean'
    && (candidate.explicitProviderDir === null || typeof candidate.explicitProviderDir === 'string')
    && typeof candidate.userDir === 'string'
    && typeof candidate.upstreamDir === 'string'
    && Array.isArray(candidate.providerRoots)
}

export function extractProviderSourceConfigPayload(response: unknown): ProviderSourceConfigPayload | null {
  if (!response || typeof response !== 'object') return null
  if (isPayload(response)) return response
  const commandResponse = response as ProviderSourceConfigResponse
  const resultPayload = commandResponse.result
  if (isPayload(resultPayload)) return resultPayload
  if (isPayload(commandResponse.sourceConfig)) return commandResponse.sourceConfig
  return null
}

export function normalizeProviderDirInput(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
