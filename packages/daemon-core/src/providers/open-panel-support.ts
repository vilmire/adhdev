import type { ProviderModule } from './contracts.js'
import type { SessionCapability } from '../shared-types.js'

export const IDE_PROVIDER_SESSION_CAPABILITIES_BASE: SessionCapability[] = [
  'read_chat',
  'send_message',
  'new_session',
  'list_sessions',
  'switch_session',
  'resolve_action',
  'change_model',
  'set_mode',
  'set_thought_level',
]

export const EXTENSION_PROVIDER_SESSION_CAPABILITIES_BASE: SessionCapability[] = [
  'read_chat',
  'send_message',
  'new_session',
  'list_sessions',
  'switch_session',
  'resolve_action',
  'change_model',
  'set_mode',
]

export function providerHasOpenPanelSupport(provider: Pick<ProviderModule, 'category' | 'scripts'>): boolean {
  if (typeof provider.scripts?.openPanel === 'function') return true
  if (provider.category === 'ide' && typeof provider.scripts?.webviewOpenPanel === 'function') return true
  return false
}

export function getProviderSessionCapabilities(
  provider: Pick<ProviderModule, 'category' | 'scripts'>,
  baseCapabilities: SessionCapability[],
): SessionCapability[] {
  return providerHasOpenPanelSupport(provider)
    ? [...baseCapabilities, 'open_panel']
    : [...baseCapabilities]
}
