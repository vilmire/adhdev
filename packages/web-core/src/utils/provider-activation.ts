import type { ProviderCategory } from '@adhdev/daemon-core'

// Wiring-unification A4: daemon-core's dist/index.d.ts (what web-core resolves
// types from) predates the LaunchableProviderCategory export, so it is derived
// locally from the already-exported ProviderCategory rather than imported
// directly. Once daemon-core is rebuilt and re-exports it, this can switch to
// a plain `import type { LaunchableProviderCategory } from '@adhdev/daemon-core'`.
export type LaunchableProviderCategory = Exclude<ProviderCategory, 'extension'>

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
