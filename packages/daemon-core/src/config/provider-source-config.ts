import type { ProviderSourceMode } from './config.js'

export interface ProviderSourceConfigSnapshot {
  sourceMode: ProviderSourceMode
  disableUpstream: boolean
  explicitProviderDir: string | null
  userDir: string
  upstreamDir: string
  providerRoots: string[]
}

export interface ProviderSourceConfigUpdate {
  providerSourceMode?: ProviderSourceMode
  providerDir?: string | undefined
}

function normalizeProviderDir(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function parseProviderSourceConfigUpdate(input: {
  providerSourceMode?: unknown
  providerDir?: unknown
}): { ok: true; updates: ProviderSourceConfigUpdate } | { ok: false; error: string } {
  const updates: ProviderSourceConfigUpdate = {}

  if (Object.prototype.hasOwnProperty.call(input, 'providerSourceMode')) {
    const { providerSourceMode } = input
    if (providerSourceMode !== 'normal' && providerSourceMode !== 'no-upstream') {
      return { ok: false, error: "providerSourceMode must be 'normal' or 'no-upstream'" }
    }
    updates.providerSourceMode = providerSourceMode
  }

  if (Object.prototype.hasOwnProperty.call(input, 'providerDir')) {
    updates.providerDir = normalizeProviderDir(input.providerDir)
  }

  return { ok: true, updates }
}
