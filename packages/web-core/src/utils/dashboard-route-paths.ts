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
  const instanceId = typeof args.entryInstanceId === 'string' ? args.entryInstanceId.trim() : ''
  const routeId = typeof args.entryRouteId === 'string' ? args.entryRouteId.trim() : ''

  const matchingConversation = args.conversations.find((conversation) => {
    if (routeId && conversation.routeId !== routeId) return false
    const tokens = [
      conversation.providerSessionId,
      conversation.sessionId,
      conversation.nativeSessionId,
      conversation.tabKey,
    ].map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean)
    return Boolean(
      (sessionId && tokens.includes(sessionId))
      || (instanceId && tokens.includes(instanceId))
      || (routeId && conversation.routeId === routeId),
    )
  })
  if (matchingConversation?.tabKey) return matchingConversation.tabKey

  if (routeId) {
    const preferredConversation = getPreferredConversationForIde(args.conversations, routeId)
      || args.conversations.find((conversation) => conversation.routeId === routeId)
    if (preferredConversation?.tabKey) return preferredConversation.tabKey
  }

  return sessionId || instanceId || routeId || null
}
