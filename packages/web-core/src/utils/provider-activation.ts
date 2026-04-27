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
  // them on this machine. Once enabled, keep them visible so the user can attempt
  // launch and see the daemon/CLI error directly instead of having stale detection
  // state hide the provider from the launcher entirely.
  return provider.enabled === true
}
