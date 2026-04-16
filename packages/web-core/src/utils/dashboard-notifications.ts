import type { RecentSessionBucket } from '@adhdev/daemon-core'
import type { ActiveConversation } from '../components/dashboard/types'

export type DashboardNotificationType = 'task_complete' | 'needs_attention' | 'error' | 'disconnect'

export interface DashboardNotificationRecord {
  id: string
  dedupKey: string
  type: DashboardNotificationType
  sessionId?: string
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

export interface DashboardNotificationSessionState {
  unreadCount: number
  latestNotificationAt: number
  latestRecordId?: string
}

const LS_KEY = 'adhdev_dashboard_notifications_v1'
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

export function buildDashboardNotificationDedupKey(args: {
  type: DashboardNotificationType
  sessionId?: string
  tabKey?: string
  lastMessageHash?: string
  lastMessageAt?: number
  lastUpdated?: number
}) {
  return [
    args.type,
    args.sessionId || args.tabKey || '',
    args.lastMessageHash || '',
    String(args.lastMessageAt || args.lastUpdated || 0),
  ].join('|')
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

    const inboxBucket = liveState?.inboxBucket || 'idle'
    const type: DashboardNotificationType | null = inboxBucket === 'needs_attention'
      ? 'needs_attention'
      : inboxBucket === 'task_complete' && liveState?.unread
        ? 'task_complete'
        : null
    if (!type) continue

    const eventAt = toTimestamp(conversation.lastMessageAt || liveState?.lastUpdated || conversation.lastUpdated, now)
    const dedupKey = buildDashboardNotificationDedupKey({
      type,
      sessionId: conversation.sessionId,
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
      tabKey: conversation.tabKey,
      title: conversation.title || conversation.displayPrimary || conversation.agentName || conversation.tabKey,
      preview: conversation.lastMessagePreview || conversation.displaySecondary || '',
      createdAt: eventAt,
      updatedAt: eventAt,
      lastEventAt: eventAt,
    }))
  }

  return candidates.sort((left, right) => right.updatedAt - left.updatedAt)
}

export function reduceDashboardNotifications(
  previous: DashboardNotificationRecord[],
  incoming: DashboardNotificationRecord[],
  maxItems = MAX_DASHBOARD_NOTIFICATIONS,
): DashboardNotificationRecord[] {
  const nextById = new Map<string, DashboardNotificationRecord>()

  for (const record of previous) {
    if (record.deletedAt) continue
    nextById.set(record.id, normalizeNotificationRecord(record))
  }

  for (const candidate of incoming) {
    const normalized = normalizeNotificationRecord(candidate)
    const existing = nextById.get(normalized.id)
    if (!existing) {
      nextById.set(normalized.id, normalized)
      continue
    }
    nextById.set(normalized.id, {
      ...existing,
      ...normalized,
      createdAt: existing.createdAt,
      readAt: existing.readAt,
      deletedAt: existing.deletedAt,
    })
  }

  return Array.from(nextById.values())
    .filter(record => !record.deletedAt)
    .sort((left, right) => {
      const updatedDiff = right.updatedAt - left.updatedAt
      if (updatedDiff !== 0) return updatedDiff
      return right.createdAt - left.createdAt
    })
    .slice(0, Math.max(0, maxItems))
}

export function markDashboardNotificationRead(
  records: DashboardNotificationRecord[],
  id: string,
  readAt = Date.now(),
): DashboardNotificationRecord[] {
  return records.map(record => record.id === id
    ? { ...record, readAt, updatedAt: Math.max(record.updatedAt, readAt) }
    : record)
}

export function markDashboardNotificationUnread(
  records: DashboardNotificationRecord[],
  id: string,
): DashboardNotificationRecord[] {
  return records.map(record => {
    if (record.id !== id) return record
    const next = { ...record }
    delete next.readAt
    return next
  })
}

export function markDashboardNotificationTargetRead(
  records: DashboardNotificationRecord[],
  target: { sessionId?: string; tabKey?: string },
  readAt = Date.now(),
): DashboardNotificationRecord[] {
  return records.map(record => {
    const matchesSession = !!target.sessionId && record.sessionId === target.sessionId
    const matchesTab = !!target.tabKey && record.tabKey === target.tabKey
    if (!matchesSession && !matchesTab) return record
    return { ...record, readAt, updatedAt: Math.max(record.updatedAt, readAt) }
  })
}

export function deleteDashboardNotification(
  records: DashboardNotificationRecord[],
  id: string,
): DashboardNotificationRecord[] {
  return records.filter(record => record.id !== id)
}

export function getDashboardNotificationUnreadCount(records: DashboardNotificationRecord[]): number {
  return records.filter(record => !record.readAt && !record.deletedAt).length
}

export function buildDashboardNotificationStateBySessionId(
  records: DashboardNotificationRecord[],
): Map<string, DashboardNotificationSessionState> {
  const state = new Map<string, DashboardNotificationSessionState>()

  for (const record of records) {
    if (record.deletedAt) continue
    const key = record.sessionId || record.tabKey
    if (!key) continue
    const previous = state.get(key)
    const unreadIncrement = record.readAt ? 0 : 1
    if (!previous) {
      state.set(key, {
        unreadCount: unreadIncrement,
        latestNotificationAt: record.updatedAt,
        latestRecordId: record.id,
      })
      continue
    }
    state.set(key, {
      unreadCount: previous.unreadCount + unreadIncrement,
      latestNotificationAt: Math.max(previous.latestNotificationAt, record.updatedAt),
      latestRecordId: previous.latestNotificationAt >= record.updatedAt ? previous.latestRecordId : record.id,
    })
  }

  return state
}

export function readDashboardNotifications(): DashboardNotificationRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.map((record) => normalizeNotificationRecord(record as DashboardNotificationRecord)).filter(record => !record.deletedAt)
      : []
  } catch {
    return []
  }
}

export function writeDashboardNotifications(records: DashboardNotificationRecord[]) {
  if (typeof window === 'undefined') return
  try {
    const next = records
      .filter(record => !record.deletedAt)
      .slice(0, MAX_DASHBOARD_NOTIFICATIONS)
    if (next.length === 0) {
      window.localStorage.removeItem(LS_KEY)
      return
    }
    window.localStorage.setItem(LS_KEY, JSON.stringify(next))
  } catch {
    // noop
  }
}
