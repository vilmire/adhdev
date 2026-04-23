import type { RecentSessionBucket } from '@adhdev/daemon-core'
import type { ActiveConversation } from '../components/dashboard/types'
import { getConversationInboxSurfaceState } from '../components/dashboard/DashboardMobileChatShared'
import {
  getConversationNotificationLabel,
  getConversationNotificationPreview,
} from '../components/dashboard/conversation-selectors'
import {
  buildConversationTargetKey,
  getConversationTargetValue,
} from '../components/dashboard/conversation-identity'

export type DashboardNotificationType = 'task_complete' | 'needs_attention' | 'error' | 'disconnect'

export interface DashboardNotificationRecord {
  id: string
  dedupKey: string
  type: DashboardNotificationType
  sessionId?: string
  providerSessionId?: string
  tabKey?: string
  routeId: string
  machineId?: string
  title: string
  preview: string
  createdAt: number
  updatedAt: number
  readAt?: number
  deletedAt?: number
  lastEventAt: number
}

export interface DashboardNotificationLiveState {
  unread?: boolean
  lastUpdated?: number
  inboxBucket?: RecentSessionBucket
  surfaceHidden?: boolean
}

export const MAX_DASHBOARD_NOTIFICATIONS = 80

function toTimestamp(value: number | undefined, fallback = Date.now()) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeNotificationRecord(record: DashboardNotificationRecord): DashboardNotificationRecord {
  return {
    ...record,
    createdAt: toTimestamp(record.createdAt),
    updatedAt: toTimestamp(record.updatedAt, record.createdAt),
    lastEventAt: toTimestamp(record.lastEventAt, record.updatedAt || record.createdAt),
  }
}

function getDashboardNotificationTargetKey(record: Pick<DashboardNotificationRecord, 'providerSessionId' | 'sessionId' | 'tabKey' | 'routeId' | 'id'>): string {
  const targetKey = buildConversationTargetKey(record)
  return targetKey === 'unknown:' ? record.id : targetKey
}

export function buildDashboardNotificationDedupKey(args: {
  type: DashboardNotificationType
  sessionId?: string
  providerSessionId?: string
  tabKey?: string
  lastMessageHash?: string
  lastMessageAt?: number
  lastUpdated?: number
}) {
  return [
    args.type,
    getConversationTargetValue(args) || '',
    args.lastMessageHash || '',
    String(args.lastMessageAt || args.lastUpdated || 0),
  ].join('|')
}

function buildLatestNotificationMap(
  records: DashboardNotificationRecord[],
  maxItems = MAX_DASHBOARD_NOTIFICATIONS,
): DashboardNotificationRecord[] {
  const latestByTarget = new Map<string, DashboardNotificationRecord>()
  for (const record of records) {
    if (record.deletedAt) continue
    const targetKey = getDashboardNotificationTargetKey(record)
    const existing = latestByTarget.get(targetKey)
    if (!existing) {
      latestByTarget.set(targetKey, record)
      continue
    }

    if (
      record.updatedAt > existing.updatedAt
      || (record.updatedAt === existing.updatedAt && record.createdAt > existing.createdAt)
    ) {
      latestByTarget.set(targetKey, record)
    }
  }

  return Array.from(latestByTarget.values())
    .sort((left, right) => {
      const updatedDiff = right.updatedAt - left.updatedAt
      if (updatedDiff !== 0) return updatedDiff
      return right.createdAt - left.createdAt
    })
    .slice(0, Math.max(0, maxItems))
}

export function buildDashboardNotificationCandidates(
  conversations: ActiveConversation[],
  stateBySessionId: Map<string, DashboardNotificationLiveState>,
): DashboardNotificationRecord[] {
  const now = Date.now()
  const candidates: DashboardNotificationRecord[] = []

  for (const conversation of conversations) {
    const liveState = conversation.sessionId ? stateBySessionId.get(conversation.sessionId) : undefined
    if (liveState?.surfaceHidden) continue

    const surfaceState = getConversationInboxSurfaceState(conversation, stateBySessionId)
    const type: DashboardNotificationType | null = surfaceState.inboxBucket === 'needs_attention'
      ? 'needs_attention'
      : (surfaceState.inboxBucket === 'task_complete' && surfaceState.unread)
        ? 'task_complete'
        : null
    if (!type) continue

    const eventAt = toTimestamp(conversation.lastMessageAt || liveState?.lastUpdated || conversation.lastUpdated, now)
    const dedupKey = buildDashboardNotificationDedupKey({
      type,
      sessionId: conversation.sessionId,
      providerSessionId: conversation.providerSessionId,
      tabKey: conversation.tabKey,
      lastMessageHash: conversation.lastMessageHash,
      lastMessageAt: conversation.lastMessageAt,
      lastUpdated: liveState?.lastUpdated || conversation.lastUpdated,
    })

    candidates.push(normalizeNotificationRecord({
      id: dedupKey,
      dedupKey,
      type,
      routeId: conversation.routeId,
      machineId: conversation.daemonId || conversation.routeId,
      sessionId: conversation.sessionId,
      providerSessionId: conversation.providerSessionId,
      tabKey: conversation.tabKey,
      title: getConversationNotificationLabel(conversation),
      preview: getConversationNotificationPreview(conversation),
      createdAt: eventAt,
      updatedAt: eventAt,
      lastEventAt: eventAt,
    }))
  }

  return buildLatestNotificationMap(candidates)
}

export function getDashboardNotificationUnreadCount(records: DashboardNotificationRecord[]): number {
  return records.filter(record => !record.readAt && !record.deletedAt).length
}
