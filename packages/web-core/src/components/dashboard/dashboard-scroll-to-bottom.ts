export type DashboardScrollToBottomIntent =
  | 'notification-open'
  | 'toast-open'
  | 'conversation-open'
  | 'requested-tab'
  | 'dockview-shortcut'
  | 'dockview-focus'
  | 'dockview-move'
  | 'dockview-split'
  | 'stored-layout-restore'
  | 'passive-tab-sync'

export interface DashboardScrollToBottomRequest {
  tabKey: string
  nonce: number
}

export function shouldRequestDashboardScrollToBottom(intent: DashboardScrollToBottomIntent): boolean {
  switch (intent) {
    case 'notification-open':
    case 'toast-open':
    case 'conversation-open':
    case 'requested-tab':
    case 'dockview-shortcut':
    case 'dockview-focus':
    case 'dockview-move':
    case 'dockview-split':
      return true
    case 'stored-layout-restore':
    case 'passive-tab-sync':
      return false
    default:
      return false
  }
}

export function buildDashboardScrollToBottomRequest(
  tabKey: string | null | undefined,
  intent: DashboardScrollToBottomIntent,
  nonce: number = Date.now(),
): DashboardScrollToBottomRequest | null {
  if (!tabKey || !shouldRequestDashboardScrollToBottom(intent)) return null
  return {
    tabKey,
    nonce,
  }
}
