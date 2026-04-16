import type { ActiveConversation } from './types'

export function hasSessionCapability(conversation: Pick<ActiveConversation, 'sessionCapabilities'>, capability: string) {
  return Array.isArray(conversation.sessionCapabilities)
    && conversation.sessionCapabilities.includes(capability)
}

export function shouldShowOpenPanelAction(conversation: Pick<ActiveConversation, 'status' | 'sessionCapabilities'>) {
  if (!hasSessionCapability(conversation as Pick<ActiveConversation, 'sessionCapabilities'>, 'open_panel')) {
    return false
  }
  return conversation.status === 'panel_hidden' || conversation.status === 'not_monitored'
}
