import { getConversationHistorySessionId } from '../components/dashboard/conversation-identity'
import { getPreferredConversationForIde } from '../components/dashboard/conversation-sort'
import type { ActiveConversation } from '../components/dashboard/types'

export function getDashboardActiveTabHref(targetKey: string): string {
  return `/dashboard?activeTab=${encodeURIComponent(targetKey)}`
}

export function getDashboardActiveTabKeyForConversation(
  conversation: Pick<ActiveConversation, 'providerSessionId' | 'sessionId' | 'tabKey' | 'routeId'>,
): string | null {
  return getConversationHistorySessionId(conversation)
    || conversation.tabKey
    || conversation.routeId
    || null
}

export function resolveDashboardSessionTargetFromEntry(args: {
  entrySessionId?: string | null
  entryInstanceId?: string | null
  entryRouteId?: string | null
  conversations: ActiveConversation[]
}): string | null {
  const sessionId = typeof args.entrySessionId === 'string' ? args.entrySessionId.trim() : ''
  if (sessionId) return sessionId

  const instanceId = typeof args.entryInstanceId === 'string' ? args.entryInstanceId.trim() : ''
  if (instanceId) return instanceId

  const routeId = typeof args.entryRouteId === 'string' ? args.entryRouteId.trim() : ''
  if (!routeId) return null

  const preferredConversation = getPreferredConversationForIde(args.conversations, routeId)
    || args.conversations.find((conversation) => conversation.routeId === routeId)
  if (!preferredConversation) return null

  return getDashboardActiveTabKeyForConversation(preferredConversation)
}
