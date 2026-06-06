import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildChatMessageSignature } from '@adhdev/daemon-core/chat/chat-signatures'
import type { SessionChatTailUpdate, SubscribeRequest } from '@adhdev/daemon-core'
import type { ActiveConversation, DashboardMessage } from './types'
import { useTransport } from '../../context/TransportContext'
import { subscriptionManager, type SubscriptionHandle, type SubscriptionManager } from '../../managers/SubscriptionManager'
import { getConversationHistorySessionId } from './conversation-identity'
import { getConversationDaemonRouteId } from './conversation-selectors'


export interface SessionChatTailCursor {
  tailLimit: number
}

export interface SessionChatTailSnapshot {
  liveMessages: DashboardMessage[]
  hasLiveSnapshot: boolean
  cursor: SessionChatTailCursor
  historyMessages: DashboardMessage[]
  historyOffset: number
  hasMoreHistory: boolean
  historyError: string | null
  /**
   * (A3) Latest ChatSourceMachine decision delivered from the daemon.
   * Carries selected ('native-history' | 'pty-parser'), fallbackReason,
   * coverage, identityStatus, staleness, lockState. Consumed by the
   * source debug badge and SourceTimeline. Undefined for v1 daemons /
   * pre-A2 subscriptions.
   */
  messageSource?: Record<string, unknown>
}

export interface SessionChatHistoryPageRequest {
  offset: number
  excludeRecentCount: number
}

export interface SessionChatTailControllerOptions {
  manager?: SubscriptionManager
  sendData?: (daemonId: string, data: any) => boolean
  daemonId: string
  sessionId: string
  historySessionId?: string
  subscriptionKey: string
  tailLimit?: number
  fallbackRecentCount?: number
}

export interface SessionChatTailControllerHandle extends SessionChatTailSnapshot {
  loadHistoryPage: () => Promise<void>
}

export interface WarmSessionChatTailDescriptor {
  daemonId: string
  sessionId: string
  historySessionId: string
  subscriptionKey: string
}

const DEFAULT_TAIL_LIMIT = 60
const CHAT_TAIL_SUBSCRIBE_RETRY_MS = 1_000
const DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS = 120_000
const WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES = new Set([
  'generating',
  'waiting_approval',
  'starting',
  'streaming',
  'working',
])
const controllerRegistry = new Map<string, SessionChatTailController>()

function getControllerKey(daemonId: string, sessionId: string, historySessionId?: string): string {
  return `${daemonId}::${sessionId}::${historySessionId || sessionId}`
}

function buildEmptySnapshot(tailLimit = DEFAULT_TAIL_LIMIT): SessionChatTailSnapshot {
  return {
    liveMessages: [],
    hasLiveSnapshot: false,
    cursor: buildReadChatCursor([], tailLimit),
    historyMessages: [],
    historyOffset: 0,
    hasMoreHistory: true,
    historyError: null,
  }
}

export function buildLastMessageSignature(message: DashboardMessage | null | undefined): string {
  return buildChatMessageSignature(message)
}

export function buildReadChatCursor(_messages: DashboardMessage[], tailLimit = DEFAULT_TAIL_LIMIT): SessionChatTailCursor {
  return { tailLimit }
}

function buildChatSnapshotSignature(messages: DashboardMessage[], status?: string): string {
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage) return `empty:${status || ''}`

  let content = ''
  try {
    content = JSON.stringify(lastMessage.content ?? '')
  } catch {
    content = String(lastMessage.content ?? '')
  }

  return [
    status || '',
    messages.length,
    String(lastMessage.id || ''),
    String(lastMessage.index ?? ''),
    String(lastMessage.receivedAt ?? lastMessage.timestamp ?? ''),
    content,
  ].join('|')
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    return content.map(flattenMessageContent).join('\n')
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>
    return flattenMessageContent(record.text ?? record.content ?? record.value ?? '')
  }
  return String(content)
}

function isNonSubstantiveChatMessage(message: DashboardMessage): boolean {
  const text = flattenMessageContent((message as { content?: unknown }).content)
  const withoutChrome = text.replace(/[─━═│┃┄┅┈┉┌┐└┘├┤┬┴┼╭╮╰╯╴╶╷╵\s]+/g, '')
  return withoutChrome.length === 0
}

function isTransientNonSubstantiveTail(messages: DashboardMessage[]): boolean {
  return messages.length === 0 || messages.every(isNonSubstantiveChatMessage)
}

function isBusyChatTailStatus(status: unknown): boolean {
  const value = typeof status === 'string' ? status.toLowerCase() : ''
  return value === 'generating' || value === 'long_generating' || value === 'streaming' || value === 'working' || value === 'starting'
}

function getExistingVisibleMessageCount(snapshot: SessionChatTailSnapshot, fallbackRecentCount: number): number {
  return Math.max(
    Math.max(0, fallbackRecentCount),
    Array.isArray(snapshot.liveMessages) ? snapshot.liveMessages.length : 0,
  )
}

function shouldDeferBusyTailUpdate(
  snapshot: SessionChatTailSnapshot,
  fallbackRecentCount: number,
  nextMessages: DashboardMessage[],
  status: unknown,
  messageSource: Record<string, unknown> | undefined,
): boolean {
  if (!isBusyChatTailStatus(status)) return false
  const existingCount = getExistingVisibleMessageCount(snapshot, fallbackRecentCount)
  if (existingCount <= 0) return false

  if (isTransientNonSubstantiveTail(nextMessages)) return true

  // (A3) When the daemon ships a ChatSourceMachine decision, trust it.
  // The machine already knows whether the incoming tail is the locked
  // native transcript (don't defer) or a PTY substitute (defer until
  // native catches up). v1 had to infer this from message count, which
  // misfired whenever PTY ran ahead of native legitimately.
  if (messageSource && typeof messageSource === 'object') {
    const selected = (messageSource as { selected?: unknown }).selected
    const fallbackReason = (messageSource as { fallbackReason?: unknown }).fallbackReason
    // Native-history is authoritative — never defer.
    if (selected === 'native-history') return false
    // Provider declined native ('provider_native_transcript_not_supported',
    // 'native_history_not_checked', or any non-'native_history_' code) —
    // PTY is the only source we have, so accept it instead of insisting on
    // the larger stale snapshot.
    if (typeof fallbackReason === 'string'
        && fallbackReason !== ''
        && !fallbackReason.startsWith('native_history_')) {
      return false
    }
    // Otherwise (genuine native_history_* fallback during busy) fall through
    // to the count heuristic — native is expected but transiently behind.
  }

  // Legacy heuristic for v1 daemons or v1-only producers that do not emit a
  // ChatSourceMachine decision. Doomed once the v1 vocabulary is removed.
  return nextMessages.length < existingCount
}

function readChatTailUpdateMessages(update: SessionChatTailUpdate): DashboardMessage[] {
  if (Array.isArray(update.messages)) return update.messages as DashboardMessage[]
  const tailMessages = (update as SessionChatTailUpdate & { messagesTail?: unknown }).messagesTail
  return Array.isArray(tailMessages) ? tailMessages as DashboardMessage[] : []
}

function readUpdateStringField(update: SessionChatTailUpdate, field: 'sessionId' | 'historySessionId'): string {
  const value = (update as SessionChatTailUpdate & Record<typeof field, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

export class SessionChatTailController {
  private manager: SubscriptionManager
  private sendData?: (daemonId: string, data: any) => boolean
  private daemonId: string
  private sessionId: string
  private historySessionId?: string
  private subscriptionKey: string
  private fallbackRecentCount: number
  private snapshot: SessionChatTailSnapshot
  private transportSubscription: SubscriptionHandle | null = null
  private listeners = new Set<(snapshot: SessionChatTailSnapshot) => void>()
  private retainCount = 0
  private loadHistoryPromise: Promise<void> | null = null
  private pendingDisconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: SessionChatTailControllerOptions) {
    this.manager = options.manager || subscriptionManager
    this.sendData = options.sendData
    this.daemonId = options.daemonId
    this.sessionId = options.sessionId
    this.historySessionId = options.historySessionId
    this.subscriptionKey = options.subscriptionKey
    this.fallbackRecentCount = Math.max(0, options.fallbackRecentCount ?? 0)
    this.snapshot = buildEmptySnapshot(Math.max(0, options.tailLimit ?? DEFAULT_TAIL_LIMIT))
  }

  updateOptions(options: Partial<SessionChatTailControllerOptions>): void {
    if (options.manager) this.manager = options.manager
    if (options.sendData) this.sendData = options.sendData
    if (options.historySessionId) this.historySessionId = options.historySessionId
    if (options.fallbackRecentCount !== undefined) {
      this.fallbackRecentCount = Math.max(0, options.fallbackRecentCount)
    }
    if (options.tailLimit !== undefined) {
      const nextTailLimit = Math.max(0, options.tailLimit)
      if (nextTailLimit !== this.snapshot.cursor.tailLimit) {
        this.snapshot = {
          ...this.snapshot,
          cursor: { tailLimit: nextTailLimit },
        }
        if (this.transportSubscription) {
          this.disconnect()
          this.connect()
        }
      }
    }
  }

  getSnapshot(): SessionChatTailSnapshot {
    return this.snapshot
  }

  clearLiveSnapshot(): void {
    this.snapshot = {
      ...buildEmptySnapshot(this.snapshot.cursor.tailLimit),
      hasLiveSnapshot: true,
    }
    this.emit()
  }

  subscribe(listener: (snapshot: SessionChatTailSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  retain(): void {
    if (this.pendingDisconnectTimer) {
      clearTimeout(this.pendingDisconnectTimer)
      this.pendingDisconnectTimer = null
    }
    this.retainCount += 1
    this.connect()
  }

  release(): void {
    this.retainCount = Math.max(0, this.retainCount - 1)
    if (this.retainCount !== 0 || this.pendingDisconnectTimer) {
      return
    }
    this.pendingDisconnectTimer = setTimeout(() => {
      this.pendingDisconnectTimer = null
      if (this.retainCount === 0) {
        this.disconnect()
      }
    }, 0)
  }

  async loadHistoryPage(loader: (request: SessionChatHistoryPageRequest) => Promise<{ messages?: DashboardMessage[]; hasMore?: boolean }>): Promise<void> {
    if (this.loadHistoryPromise) return this.loadHistoryPromise
    this.snapshot = {
      ...this.snapshot,
      historyError: null,
    }
    this.emit()
    const run = (async () => {
      try {
        const hadLiveSnapshot = this.snapshot.hasLiveSnapshot
        const excludeRecentCount = hadLiveSnapshot
          ? this.snapshot.liveMessages.length
          : Math.max(this.snapshot.liveMessages.length, this.fallbackRecentCount)
        const result = await loader({
          offset: this.snapshot.historyOffset,
          excludeRecentCount,
        })
        const nextMessages = Array.isArray(result.messages) ? result.messages : []
        const shouldKeepHistoryOpen = !hadLiveSnapshot
          && nextMessages.length === 0
          && result.hasMore !== true
          && this.fallbackRecentCount > 0
        this.snapshot = {
          ...this.snapshot,
          historyMessages: [...nextMessages, ...this.snapshot.historyMessages],
          historyOffset: this.snapshot.historyOffset + nextMessages.length,
          hasMoreHistory: shouldKeepHistoryOpen ? true : result.hasMore === true,
          historyError: null,
        }
      } catch (error) {
        this.snapshot = {
          ...this.snapshot,
          historyError: error instanceof Error ? error.message : 'Failed to load history',
        }
      }
      this.emit()
    })().finally(() => {
      this.loadHistoryPromise = null
    })
    this.loadHistoryPromise = run
    return run
  }

  private buildSubscribeRequest(): SubscribeRequest {
    return {
      type: 'subscribe',
      topic: 'session.chat_tail',
      key: this.subscriptionKey,
      params: {
        targetSessionId: this.sessionId,
        ...(this.historySessionId ? { historySessionId: this.historySessionId } : {}),
        ...(this.snapshot.cursor.tailLimit > 0 ? { tailLimit: this.snapshot.cursor.tailLimit } : {}),
      },
    }
  }

  private connect(): void {
    if (this.transportSubscription || !this.sendData || !this.daemonId || !this.sessionId) return
    this.transportSubscription = this.manager.subscribe(
      { sendData: this.sendData },
      this.daemonId,
      this.buildSubscribeRequest(),
      (update: SessionChatTailUpdate) => {
        this.handleUpdate(update)
      },
      { retryIntervalMs: CHAT_TAIL_SUBSCRIBE_RETRY_MS },
    )
  }

  private disconnect(): void {
    this.transportSubscription?.()
    this.transportSubscription = null
  }

  dispose(): void {
    if (this.pendingDisconnectTimer) {
      clearTimeout(this.pendingDisconnectTimer)
      this.pendingDisconnectTimer = null
    }
    this.disconnect()
    this.listeners.clear()
    this.retainCount = 0
    this.loadHistoryPromise = null
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.snapshot))
  }

  private handleUpdate(update: SessionChatTailUpdate): void {
    if (update.error) return
    const updateSessionId = readUpdateStringField(update, 'sessionId')
    if (updateSessionId && updateSessionId !== this.sessionId) return

    const updateHistorySessionId = readUpdateStringField(update, 'historySessionId')
    if (updateHistorySessionId && this.historySessionId && updateHistorySessionId !== this.historySessionId) return

    const nextMessages = readChatTailUpdateMessages(update)
    const incomingMessageSource = (update as SessionChatTailUpdate & { messageSource?: Record<string, unknown> }).messageSource
    if (shouldDeferBusyTailUpdate(this.snapshot, this.fallbackRecentCount, nextMessages, update.status, incomingMessageSource)) {
      return
    }
    const nextCursor: SessionChatTailCursor = { tailLimit: this.snapshot.cursor.tailLimit }
    const unchanged = buildChatSnapshotSignature(this.snapshot.liveMessages)
      === buildChatSnapshotSignature(nextMessages)
      && this.snapshot.cursor.tailLimit === nextCursor.tailLimit
    if (unchanged) return
    this.snapshot = {
      ...this.snapshot,
      liveMessages: nextMessages,
      hasLiveSnapshot: true,
      cursor: nextCursor,
      // (A3) Track latest source decision for the debug badge / SourceTimeline.
      // Read-only consumption; daemon is source of truth.
      messageSource: incomingMessageSource,
    }
    this.emit()
  }
}

export function getOrCreateSessionChatTailController(options: SessionChatTailControllerOptions): SessionChatTailController {
  const key = getControllerKey(options.daemonId, options.sessionId, options.historySessionId)
  const existing = controllerRegistry.get(key)
  if (existing) {
    existing.updateOptions(options)
    return existing
  }
  const controller = new SessionChatTailController(options)
  controllerRegistry.set(key, controller)
  return controller
}

export function clearSessionChatTailControllerSnapshot(
  daemonId: string | undefined,
  sessionId: string | undefined,
  historySessionId?: string,
): void {
  if (!daemonId || !sessionId) return
  const prefix = `${daemonId}::${sessionId}::`
  const exactKey = getControllerKey(daemonId, sessionId, historySessionId)
  for (const [key, controller] of controllerRegistry.entries()) {
    if (key === exactKey || key.startsWith(prefix)) {
      controller.clearLiveSnapshot()
    }
  }
}

export function resetSessionChatTailControllersForTest(): void {
  for (const controller of controllerRegistry.values()) {
    controller.dispose()
  }
  controllerRegistry.clear()
}

function buildControllerHandle(
  snapshot: SessionChatTailSnapshot,
  loadHistoryPage: SessionChatTailControllerHandle['loadHistoryPage'],
): SessionChatTailControllerHandle {
  return {
    ...snapshot,
    loadHistoryPage,
  }
}

function compareWarmSessionChatTailDescriptors(
  left: WarmSessionChatTailDescriptor,
  right: WarmSessionChatTailDescriptor,
): number {
  return left.subscriptionKey.localeCompare(right.subscriptionKey)
    || left.daemonId.localeCompare(right.daemonId)
    || left.sessionId.localeCompare(right.sessionId)
    || left.historySessionId.localeCompare(right.historySessionId)
}

function shouldWarmSessionChatTailConversation(
  conversation: ActiveConversation,
  options: { now?: number; recentActivityMs?: number } = {},
): boolean {
  const status = String(conversation.status || '').trim().toLowerCase()
  if (WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES.has(status)) return true
  if ((conversation.modalMessage || '').trim()) return true
  if (Array.isArray(conversation.modalButtons) && conversation.modalButtons.length > 0) return true

  const now = options.now ?? Date.now()
  const recentActivityMs = Math.max(0, Number(options.recentActivityMs ?? DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS))
  const lastActivityAt = Math.max(
    Number(conversation.lastUpdated || 0),
    Number(conversation.lastMessageAt || 0),
  )
  if (lastActivityAt > 0) {
    return (now - lastActivityAt) <= recentActivityMs
  }

  return Array.isArray(conversation.messages) && conversation.messages.length > 0
}

export function getWarmSessionChatTailDescriptorRefreshMs(recentActivityMs = DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS): number {
  return Math.max(1_000, Math.min(30_000, Math.max(0, Number(recentActivityMs || 0))))
}

export function buildWarmSessionChatTailDescriptorState(
  conversations: ActiveConversation[],
  options: { now?: number; recentActivityMs?: number } = {},
): { descriptors: WarmSessionChatTailDescriptor[]; signature: string } {
  const seen = new Set<string>()
  const descriptors: WarmSessionChatTailDescriptor[] = []
  for (const conversation of conversations) {
    if (!shouldWarmSessionChatTailConversation(conversation, options)) continue
    const daemonId = getConversationDaemonRouteId(conversation)
    const sessionId = conversation.sessionId || ''
    if (!daemonId || !sessionId) continue
    const historySessionId = getConversationHistorySessionId(conversation)
    const key = getControllerKey(daemonId, sessionId, historySessionId || sessionId)
    if (seen.has(key)) continue
    seen.add(key)
    descriptors.push({
      daemonId,
      sessionId,
      historySessionId: historySessionId || sessionId,
      subscriptionKey: `daemon:${daemonId}:session:${sessionId}`,
    })
  }
  descriptors.sort(compareWarmSessionChatTailDescriptors)
  return {
    descriptors,
    signature: descriptors
      .map((descriptor) => `${descriptor.subscriptionKey}|${descriptor.historySessionId}`)
      .join('||'),
  }
}

export function useSessionChatTailController(
  activeConv: ActiveConversation,
  options?: { enabled?: boolean; tailLimit?: number },
): SessionChatTailControllerHandle {
  const { sendData, sendCommand } = useTransport()
  const enabled = options?.enabled !== false
  const daemonId = getConversationDaemonRouteId(activeConv)
  const sessionId = activeConv.sessionId || ''
  const historySessionId = getConversationHistorySessionId(activeConv) || sessionId
  const subscriptionKey = `daemon:${daemonId}:session:${sessionId}`
  const tailLimit = Math.max(0, options?.tailLimit ?? DEFAULT_TAIL_LIMIT)

  const controller = useMemo(() => {
    if (!enabled || !daemonId || !sessionId) return null
    return getOrCreateSessionChatTailController({
      daemonId,
      sessionId,
      historySessionId,
      subscriptionKey,
      sendData,
      tailLimit,
      fallbackRecentCount: activeConv.messages.length,
    })
  }, [activeConv.messages.length, daemonId, enabled, historySessionId, sendData, sessionId, subscriptionKey, tailLimit])

  const [snapshot, setSnapshot] = useState<SessionChatTailSnapshot>(() => (
    controller?.getSnapshot() || buildEmptySnapshot(tailLimit)
  ))

  useEffect(() => {
    if (!controller) {
      setSnapshot(buildEmptySnapshot(tailLimit))
      return
    }
    controller.retain()
    setSnapshot(controller.getSnapshot())
    const unsubscribe = controller.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot)
    })
    return () => {
      unsubscribe()
      controller.release()
    }
  }, [controller, tailLimit])

  const loadHistoryPage = useCallback(async () => {
    if (!controller || !daemonId || !sessionId) return
    await controller.loadHistoryPage(async ({ offset, excludeRecentCount }) => {
      const agentType = activeConv.agentType
      const raw = await sendCommand(daemonId, 'chat_history', {
        agentType,
        offset,
        limit: 30,
        targetSessionId: sessionId,
        historySessionId,
        excludeRecentCount,
      })
      const result = raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)
        ? (raw as { result?: { messages?: DashboardMessage[]; hasMore?: boolean } }).result || {}
        : (raw as { messages?: DashboardMessage[]; hasMore?: boolean } | undefined) || {}
      return {
        messages: Array.isArray(result.messages) ? result.messages : [],
        hasMore: result.hasMore === true,
      }
    })
  }, [activeConv.agentType, controller, daemonId, historySessionId, sendCommand, sessionId])

  return useMemo(
    () => buildControllerHandle(snapshot, loadHistoryPage),
    [loadHistoryPage, snapshot],
  )
}

export function useWarmSessionChatTailControllers(
  conversations: ActiveConversation[],
  options?: { enabled?: boolean; tailLimit?: number; recentActivityMs?: number },
): void {
  const { sendData } = useTransport()
  const enabled = options?.enabled !== false
  const tailLimit = Math.max(0, options?.tailLimit ?? DEFAULT_TAIL_LIMIT)
  const recentActivityMs = Math.max(0, Number(options?.recentActivityMs ?? DEFAULT_WARM_SESSION_CHAT_TAIL_RECENT_ACTIVITY_MS))
  const refreshMs = getWarmSessionChatTailDescriptorRefreshMs(recentActivityMs)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!enabled || conversations.length === 0) return
    const timer = setInterval(() => {
      setRefreshTick((prev) => prev + 1)
    }, refreshMs)
    return () => {
      clearInterval(timer)
    }
  }, [conversations.length, enabled, refreshMs])

  const descriptorState = useMemo(
    () => buildWarmSessionChatTailDescriptorState(conversations, { recentActivityMs }),
    [conversations, recentActivityMs, refreshTick],
  )

  useEffect(() => {
    if (!enabled || !sendData || descriptorState.descriptors.length === 0) return
    const controllers = descriptorState.descriptors.map((descriptor) => getOrCreateSessionChatTailController({
      ...descriptor,
      sendData,
      tailLimit,
    }))
    controllers.forEach((controller) => {
      controller.retain()
    })
    return () => {
      controllers.forEach((controller) => controller.release())
    }
  }, [descriptorState.signature, enabled, sendData, tailLimit])
}
