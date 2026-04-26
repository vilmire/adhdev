export type LaunchableProviderCategory = 'ide' | 'cli' | 'acp'

export interface ProviderActivationSnapshot {
  category?: string
  enabled?: boolean
  machineStatus?: 'disabled' | 'enabled_unchecked' | 'not_detected' | 'detected' | string
  installed?: boolean
}

export function isLaunchableMachineProvider(
  provider: ProviderActivationSnapshot,
  category: LaunchableProviderCategory,
): boolean {
  if (provider.category !== category) return false
  if (category === 'ide') return true

  // CLI/ACP providers are passive catalog entries until the user explicitly enables
  // them on this machine and daemon detection proves the configured executable.
  if (provider.enabled !== true) return false
  if (provider.machineStatus !== 'detected') return false

  return provider.installed !== false
}
