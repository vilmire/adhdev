import type { RecentSessionBucket } from '@adhdev/daemon-core'
import type { ActiveConversation } from '../components/dashboard/types'
import { getConversationInboxSurfaceState } from '../components/dashboard/DashboardMobileChatShared'
import {
  getConversationNotificationLabel,
  getConversationNotificationPreview,
} from '../components/dashboard/conversation-selectors'
import {
  buildConversationLookupKeys,
  buildConversationTargetKey,
  conversationMatchesTarget,
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

export interface DashboardNotificationSessionState {
  unreadCount: number
  latestNotificationAt: number
  latestRecordId?: string
}

export interface DashboardNotificationOverlayRecord {
  id: string
  readAt?: number
  deletedAt?: number
  forceUnread?: boolean
}

const LS_KEY = 'adhdev_dashboard_notifications_v2'
const LEGACY_LS_KEY = 'adhdev_dashboard_notifications_v1'
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

export function buildDashboardNotificationCandidates(
  conversations: ActiveConversation[],
  stateBySessionId: Map<string, DashboardNotificationLiveState>,
  notificationStateBySessionId?: Map<string, DashboardNotificationSessionState>,
  overlayById?: Map<string, DashboardNotificationOverlayRecord>,
): DashboardNotificationRecord[] {
  const now = Date.now()
  const candidates: DashboardNotificationRecord[] = []

  for (const conversation of conversations) {
    const liveState = conversation.sessionId ? stateBySessionId.get(conversation.sessionId) : undefined
    if (liveState?.surfaceHidden) continue

    const taskCompleteDedupKey = buildDashboardNotificationDedupKey({
      type: 'task_complete',
      sessionId: conversation.sessionId,
      providerSessionId: conversation.providerSessionId,
      tabKey: conversation.tabKey,
      lastMessageHash: conversation.lastMessageHash,
      lastMessageAt: conversation.lastMessageAt,
      lastUpdated: liveState?.lastUpdated || conversation.lastUpdated,
    })
    const hasForceUnreadOverlay = !!overlayById?.get(taskCompleteDedupKey)?.forceUnread
    const surfaceState = getConversationInboxSurfaceState(conversation, stateBySessionId, {
      notificationStateBySessionId,
    })
    const type: DashboardNotificationType | null = surfaceState.inboxBucket === 'needs_attention'
      ? 'needs_attention'
      : (surfaceState.inboxBucket === 'task_complete' && surfaceState.unread)
          || (liveState?.inboxBucket === 'task_complete' && hasForceUnreadOverlay)
        ? 'task_complete'
        : null
    if (!type) continue

    const eventAt = toTimestamp(conversation.lastMessageAt || liveState?.lastUpdated || conversation.lastUpdated, now)
    const dedupKey = type === 'task_complete'
      ? taskCompleteDedupKey
      : buildDashboardNotificationDedupKey({
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

  return candidates.sort((left, right) => right.updatedAt - left.updatedAt)
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

export function buildDashboardNotificationOverlays(
  records: DashboardNotificationRecord[],
): DashboardNotificationOverlayRecord[] {
  return records
    .filter(record => typeof record.readAt === 'number' || typeof record.deletedAt === 'number')
    .map(record => ({
      id: record.id,
      ...(typeof record.readAt === 'number' ? { readAt: record.readAt } : {}),
      ...(typeof record.deletedAt === 'number' ? { deletedAt: record.deletedAt } : {}),
    }))
}

export function buildDashboardNotificationOverlayById(
  overlays: DashboardNotificationOverlayRecord[],
): Map<string, DashboardNotificationOverlayRecord> {
  return new Map(overlays.map(overlay => [overlay.id, overlay]))
}

export function applyDashboardNotificationOverlays(
  incoming: DashboardNotificationRecord[],
  overlays: DashboardNotificationOverlayRecord[],
  maxItems = MAX_DASHBOARD_NOTIFICATIONS,
): DashboardNotificationRecord[] {
  const overlayById = new Map<string, DashboardNotificationOverlayRecord>()
  for (const overlay of overlays) {
    overlayById.set(overlay.id, overlay)
  }

  const merged = incoming.map((candidate) => {
    const normalized = normalizeNotificationRecord(candidate)
    const overlay = overlayById.get(normalized.id)
    return {
      ...normalized,
      ...(typeof overlay?.readAt === 'number' ? { readAt: overlay.readAt } : {}),
      ...(typeof overlay?.deletedAt === 'number' ? { deletedAt: overlay.deletedAt } : {}),
    }
  })

  return buildLatestNotificationMap(merged, maxItems)
}

export function reduceDashboardNotificationOverlays(
  overlays: DashboardNotificationOverlayRecord[],
  incoming: DashboardNotificationRecord[],
  maxItems = MAX_DASHBOARD_NOTIFICATIONS,
): DashboardNotificationOverlayRecord[] {
  const retainedIds = new Set(applyDashboardNotificationOverlays(incoming, [], maxItems).map(record => record.id))
  return overlays
    .filter(overlay => retainedIds.has(overlay.id))
    .slice(0, Math.max(0, maxItems))
}

export function reduceDashboardNotifications(
  previous: DashboardNotificationRecord[],
  incoming: DashboardNotificationRecord[],
  maxItems = MAX_DASHBOARD_NOTIFICATIONS,
): DashboardNotificationRecord[] {
  const previousById = new Map(previous.map(record => [record.id, normalizeNotificationRecord(record)]))
  return applyDashboardNotificationOverlays(incoming, buildDashboardNotificationOverlays(previous), maxItems)
    .map((record) => {
      const previousRecord = previousById.get(record.id)
      return previousRecord
        ? { ...record, createdAt: previousRecord.createdAt }
        : record
    })
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

export function markDashboardNotificationOverlayRead(
  overlays: DashboardNotificationOverlayRecord[],
  id: string,
  readAt = Date.now(),
): DashboardNotificationOverlayRecord[] {
  const next = overlays.filter(record => record.id !== id)
  next.push({ id, readAt })
  return next
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

export function markDashboardNotificationOverlayUnread(
  overlays: DashboardNotificationOverlayRecord[],
  id: string,
): DashboardNotificationOverlayRecord[] {
  const next = overlays.filter(record => record.id !== id)
  next.push({ id, forceUnread: true })
  return next
}

export function markDashboardNotificationTargetRead(
  records: DashboardNotificationRecord[],
  target: { sessionId?: string; providerSessionId?: string; tabKey?: string; routeId?: string },
  readAt = Date.now(),
): DashboardNotificationRecord[] {
  return records.map(record => {
    if (!conversationMatchesTarget(record, target)) return record
    return { ...record, readAt, updatedAt: Math.max(record.updatedAt, readAt) }
  })
}

export function markDashboardNotificationTargetOverlayRead(
  overlays: DashboardNotificationOverlayRecord[],
  records: DashboardNotificationRecord[],
  target: { sessionId?: string; providerSessionId?: string; tabKey?: string; routeId?: string },
  readAt = Date.now(),
): DashboardNotificationOverlayRecord[] {
  const next = overlays.filter((overlay) => {
    const record = records.find(candidate => candidate.id === overlay.id)
    return !record || !conversationMatchesTarget(record, target)
  })
  for (const record of records) {
    if (!conversationMatchesTarget(record, target)) continue
    next.push({ id: record.id, readAt })
  }
  return next
}

export function deleteDashboardNotification(
  records: DashboardNotificationRecord[],
  id: string,
): DashboardNotificationRecord[] {
  return records.filter(record => record.id !== id)
}

export function deleteDashboardNotificationOverlay(
  overlays: DashboardNotificationOverlayRecord[],
  id: string,
): DashboardNotificationOverlayRecord[] {
  const next = overlays.filter(record => record.id !== id)
  next.push({ id, deletedAt: Date.now() })
  return next
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
    const keys = buildConversationLookupKeys(record)
    if (keys.length === 0) continue
    const unreadIncrement = record.readAt ? 0 : 1
    for (const key of keys) {
      const previous = state.get(key)
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
  }

  return state
}

export function readDashboardNotificationOverlays(): DashboardNotificationOverlayRecord[] {
  if (typeof window === 'undefined') return []
  const normalizeOverlay = (value: unknown): DashboardNotificationOverlayRecord | null => {
    if (!value || typeof value !== 'object') return null
    const overlay = value as DashboardNotificationOverlayRecord
    if (typeof overlay.id !== 'string' || overlay.id.length === 0) return null
    const readAt = typeof overlay.readAt === 'number' && Number.isFinite(overlay.readAt) ? overlay.readAt : undefined
    const deletedAt = typeof overlay.deletedAt === 'number' && Number.isFinite(overlay.deletedAt) ? overlay.deletedAt : undefined
    const forceUnread = overlay.forceUnread === true
    if (typeof readAt !== 'number' && typeof deletedAt !== 'number' && !forceUnread) return null
    return {
      id: overlay.id,
      ...(typeof readAt === 'number' ? { readAt } : {}),
      ...(typeof deletedAt === 'number' ? { deletedAt } : {}),
      ...(forceUnread ? { forceUnread: true } : {}),
    }
  }

  try {
    const raw = window.localStorage.getItem(LS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeOverlay).filter((overlay): overlay is DashboardNotificationOverlayRecord => !!overlay)
    }
  } catch {
    // fall through to legacy migration path
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_LS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? buildDashboardNotificationOverlays(
          parsed
            .map((record) => normalizeNotificationRecord(record as DashboardNotificationRecord))
            .filter(record => !record.deletedAt),
        )
      : []
  } catch {
    return []
  }
}

export function writeDashboardNotificationOverlays(records: DashboardNotificationOverlayRecord[]) {
  if (typeof window === 'undefined') return
  try {
    const next = records
      .filter(record => typeof record.readAt === 'number' || typeof record.deletedAt === 'number' || record.forceUnread === true)
      .slice(0, MAX_DASHBOARD_NOTIFICATIONS)
    if (next.length === 0) {
      window.localStorage.removeItem(LS_KEY)
      window.localStorage.removeItem(LEGACY_LS_KEY)
      return
    }
    window.localStorage.setItem(LS_KEY, JSON.stringify(next))
    window.localStorage.removeItem(LEGACY_LS_KEY)
  } catch {
    // noop
  }
}
