import { parseJsonRecord } from '@adhdev/mesh-shared'

export interface ProviderPrioritySnapshot {
  type?: string
  id?: string
  name?: string
  displayName?: string
  icon?: string
  category?: string
  installed?: boolean
  detectedPath?: string | null
  enabled?: boolean
  machineStatus?: 'disabled' | 'enabled_unchecked' | 'not_detected' | 'detected' | string
  lastDetection?: { ok?: boolean; message?: string; path?: string | null; command?: string }
  /** Advisory model list this provider supports (from the provider manifest). */
  modelOptions?: string[]
  /** Advisory thinking-level list this provider supports. */
  thinkingLevelOptions?: string[]
}

export interface AvailableCliProviderOption {
  type: string
  label: string
  icon?: string
  statusLabel: string
  detectedPath?: string | null
  /** Advisory model list for this provider (drives the slot editor's model dropdown). */
  modelOptions?: string[]
  /** Advisory thinking-level list for this provider. */
  thinkingLevelOptions?: string[]
}

function providerType(provider: ProviderPrioritySnapshot): string {
  return String(provider.type || provider.id || '').trim()
}

export function isAvailableCliProvider(provider: ProviderPrioritySnapshot): boolean {
  if (provider.category !== 'cli') return false
  if (!providerType(provider)) return false
  if (provider.enabled === false) return false

  // Newer daemon payloads expose machineStatus from the detector. Treat that as
  // authoritative and fail closed unless it says the CLI is detected.
  if (provider.machineStatus) return provider.machineStatus === 'detected'

  // Older daemon payloads only exposed installed/detectedPath/lastDetection.
  // These still come from runtime/provider inventory, not a hardcoded catalog.
  return provider.lastDetection?.ok === true || provider.installed === true || !!provider.detectedPath
}

export function normalizeAvailableCliProviders(providers: ProviderPrioritySnapshot[] | undefined | null): AvailableCliProviderOption[] {
  const seen = new Set<string>()
  const options: AvailableCliProviderOption[] = []
  for (const provider of providers || []) {
    if (!isAvailableCliProvider(provider)) continue
    const type = providerType(provider)
    if (!type || seen.has(type)) continue
    seen.add(type)
    const label = String(provider.displayName || provider.name || type)
    const detectedPath = provider.detectedPath || provider.lastDetection?.path || null
    options.push({
      type,
      label,
      icon: provider.icon,
      statusLabel: detectedPath ? `Detected at ${detectedPath}` : 'Detected on this machine',
      detectedPath,
      ...(Array.isArray(provider.modelOptions) && provider.modelOptions.length ? { modelOptions: provider.modelOptions } : {}),
      ...(Array.isArray(provider.thinkingLevelOptions) && provider.thinkingLevelOptions.length ? { thinkingLevelOptions: provider.thinkingLevelOptions } : {}),
    })
  }
  return options
}

export function normalizeProviderPriority(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    const type = typeof item === 'string' ? item.trim() : ''
    if (!type || seen.has(type)) continue
    seen.add(type)
    result.push(type)
  }
  return result
}

export function normalizeProviderPriorityForInventory(value: unknown, options: AvailableCliProviderOption[]): string[] {
  const availableTypes = new Set(options.map(option => option.type))
  return normalizeProviderPriority(value).filter(type => availableTypes.has(type))
}

export function defaultProviderPriorityFromInventory(options: AvailableCliProviderOption[]): string[] {
  return options.map(option => option.type)
}

export function addProviderPriorityItem(priority: string[], type: string): string[] {
  const normalized = normalizeProviderPriority(priority)
  const cleanType = type.trim()
  if (!cleanType || normalized.includes(cleanType)) return normalized
  return [...normalized, cleanType]
}

export function removeProviderPriorityItem(priority: string[], type: string): string[] {
  return normalizeProviderPriority(priority).filter(item => item !== type)
}

export function moveProviderPriorityItem(priority: string[], type: string, direction: 'up' | 'down' | 'top' | 'bottom'): string[] {
  const normalized = normalizeProviderPriority(priority)
  const index = normalized.indexOf(type)
  if (index < 0) return normalized
  const next = normalized.filter(item => item !== type)
  if (direction === 'top') return [type, ...next]
  if (direction === 'bottom') return [...next, type]
  const targetIndex = direction === 'up' ? Math.max(0, index - 1) : Math.min(next.length, index + 1)
  next.splice(targetIndex, 0, type)
  return next
}

const CANONICAL_REPO_MESH_PROVIDER_TYPES = new Set([
  'hermes-cli',
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'antigravity-cli',
])

export const DEFAULT_REPO_MESH_PROVIDER_PRIORITY = 'hermes-cli, claude-cli, codex-cli, gemini-cli, antigravity-cli'

function normalizeProviderPriorityToken(type: string): string | undefined {
  const trimmed = type.trim()
  if (!trimmed) return undefined
  const lower = trimmed.toLowerCase()
  return CANONICAL_REPO_MESH_PROVIDER_TYPES.has(lower) ? lower : trimmed
}

export function parseProviderPriorityInput(input: string): string[] {
  const seen = new Set<string>()
  return input
    .split(/[\s,]+/)
    .map(normalizeProviderPriorityToken)
    .filter((type): type is string => !!type)
    .filter(type => {
      if (seen.has(type)) return false
      seen.add(type)
      return true
    })
}

export function readRepoMeshNodePolicy(node: unknown): Record<string, unknown> {
  const record = node && typeof node === 'object' ? node as Record<string, unknown> : {}
  return parseJsonRecord(record.node_policy ?? record.policy_json ?? record.policy)
}

export function readRepoMeshNodeProviderPriority(node: unknown): string[] {
  const record = node && typeof node === 'object' ? node as Record<string, unknown> : {}
  const policy = readRepoMeshNodePolicy(node)
  const raw = record.providerPriority ?? record.provider_priority ?? policy.providerPriority
  if (!Array.isArray(raw)) return []
  return normalizeProviderPriority(raw)
}

export function formatRepoMeshNodeProviderPriority(node: unknown): string {
  return readRepoMeshNodeProviderPriority(node).join(' → ')
}

export function describeRepoMeshNodeProviderPriority(node: unknown): {
  configured: boolean
  label: string
  launchReady: boolean
  launchBlockedMessage?: string
} {
  const providerPriority = readRepoMeshNodeProviderPriority(node)
  if (!providerPriority.length) {
    return {
      configured: false,
      label: 'not configured',
      launchReady: false,
      launchBlockedMessage: 'launch not ready unless an explicit provider is selected',
    }
  }
  return {
    configured: true,
    label: providerPriority.join(' → '),
    launchReady: true,
  }
}
