import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReadChatCursor, ReadChatSyncResult, SessionChatTailUpdate } from '@adhdev/daemon-core'
import type { ActiveConversation, DashboardMessage } from './types'
import { useTransport } from '../../context/TransportContext'
import { subscriptionManager, type SubscriptionHandle, type SubscriptionManager } from '../../managers/SubscriptionManager'
import { getConversationDaemonRouteId } from './conversation-selectors'
import { dedupeOptimisticMessages } from './message-utils'

export interface SessionChatTailSnapshot {
  liveMessages: DashboardMessage[]
  cursor: Required<ReadChatCursor>
  historyMessages: DashboardMessage[]
  historyOffset: number
  hasMoreHistory: boolean
  historyError: string | null
}

export interface SessionChatTailControllerOptions {
  manager?: SubscriptionManager
  sendData?: (daemonId: string, data: any) => boolean
  daemonId: string
  sessionId: string
  historySessionId?: string
  subscriptionKey: string
  tailLimit?: number
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
const controllerRegistry = new Map<string, SessionChatTailController>()

function hashSignatureParts(parts: string[]): string {
  let hash = 0x811c9dc5
  for (const part of parts) {
    const text = String(part || '')
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function getControllerKey(daemonId: string, sessionId: string): string {
  return `${daemonId}::${sessionId}`
}

function buildEmptySnapshot(tailLimit = DEFAULT_TAIL_LIMIT): SessionChatTailSnapshot {
  return {
    liveMessages: [],
    cursor: buildReadChatCursor([], tailLimit),
    historyMessages: [],
    historyOffset: 0,
    hasMoreHistory: true,
    historyError: null,
  }
}

export function buildLastMessageSignature(message: DashboardMessage | null | undefined): string {
  if (!message) return ''
  let content = ''
  try {
    content = JSON.stringify(message.content ?? '')
  } catch {
    content = String(message.content ?? '')
  }
  return hashSignatureParts([
    String(message.id || ''),
    String(message.index ?? ''),
    String(message.role || ''),
    String(message.receivedAt ?? message.timestamp ?? ''),
    content,
  ])
}

export function buildReadChatCursor(messages: DashboardMessage[], tailLimit = DEFAULT_TAIL_LIMIT): Required<ReadChatCursor> {
  return {
    knownMessageCount: messages.length,
    lastMessageSignature: buildLastMessageSignature(messages[messages.length - 1]),
    tailLimit,
  }
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

export function applyReadChatSync(
  previousMessages: DashboardMessage[],
  result: Partial<ReadChatSyncResult>,
): DashboardMessage[] {
  const incomingMessages = Array.isArray(result.messages) ? result.messages as DashboardMessage[] : []
  switch (result.syncMode) {
    case 'noop':
      return previousMessages
    case 'append':
      return dedupeOptimisticMessages([...previousMessages, ...incomingMessages])
    case 'replace_tail': {
      const replaceFrom = Math.max(0, Math.min(Number(result.replaceFrom ?? previousMessages.length), previousMessages.length))
      return dedupeOptimisticMessages([
        ...previousMessages.slice(0, replaceFrom),
        ...incomingMessages,
      ])
    }
    case 'full': {
      const totalMessages = Math.max(Number(result.totalMessages || 0), incomingMessages.length)
      if (totalMessages > incomingMessages.length && previousMessages.length > incomingMessages.length) {
        const preserveCount = Math.max(0, totalMessages - incomingMessages.length)
        return dedupeOptimisticMessages([
          ...previousMessages.slice(0, preserveCount),
          ...incomingMessages,
        ])
      }
      return incomingMessages
    }
    default:
      return incomingMessages
  }
}

export class SessionChatTailController {
  private manager: SubscriptionManager
  private sendData?: (daemonId: string, data: any) => boolean
  private daemonId: string
  private sessionId: string
  private historySessionId?: string
  private subscriptionKey: string
  private snapshot: SessionChatTailSnapshot
  private transportSubscription: SubscriptionHandle | null = null
  private listeners = new Set<(snapshot: SessionChatTailSnapshot) => void>()
  private retainCount = 0
  private loadHistoryPromise: Promise<void> | null = null

  constructor(options: SessionChatTailControllerOptions) {
    this.manager = options.manager || subscriptionManager
    this.sendData = options.sendData
    this.daemonId = options.daemonId
    this.sessionId = options.sessionId
    this.historySessionId = options.historySessionId
    this.subscriptionKey = options.subscriptionKey
    this.snapshot = buildEmptySnapshot(Math.max(0, options.tailLimit ?? DEFAULT_TAIL_LIMIT))
  }

  updateOptions(options: Partial<SessionChatTailControllerOptions>): void {
    if (options.manager) this.manager = options.manager
    if (options.sendData) this.sendData = options.sendData
    if (options.historySessionId) this.historySessionId = options.historySessionId
  }

  getSnapshot(): SessionChatTailSnapshot {
    return this.snapshot
  }

  hydrateLiveMessages(messages: DashboardMessage[]): void {
    const incoming = Array.isArray(messages) ? messages : []
    if (incoming.length === 0) return
    const nextMessages = dedupeOptimisticMessages([...incoming, ...this.snapshot.liveMessages])
    if (nextMessages.length < incoming.length) return
    const nextCursor = buildReadChatCursor(nextMessages, this.snapshot.cursor.tailLimit)
    const unchanged = buildChatSnapshotSignature(this.snapshot.liveMessages)
      === buildChatSnapshotSignature(nextMessages)
      && this.snapshot.cursor.knownMessageCount === nextCursor.knownMessageCount
      && this.snapshot.cursor.lastMessageSignature === nextCursor.lastMessageSignature
    if (unchanged) return
    this.snapshot = {
      ...this.snapshot,
      liveMessages: nextMessages,
      cursor: nextCursor,
    }
  }

  subscribe(listener: (snapshot: SessionChatTailSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  retain(): void {
    this.retainCount += 1
    this.connect()
  }

  release(): void {
    this.retainCount = Math.max(0, this.retainCount - 1)
    if (this.retainCount === 0) {
      this.disconnect()
    }
  }

  async loadHistoryPage(loader: () => Promise<{ messages?: DashboardMessage[]; hasMore?: boolean }>): Promise<void> {
    if (this.loadHistoryPromise) return this.loadHistoryPromise
    this.snapshot = {
      ...this.snapshot,
      historyError: null,
    }
    this.emit()
    const run = (async () => {
      try {
        const result = await loader()
        const nextMessages = Array.isArray(result.messages) ? result.messages : []
        this.snapshot = {
          ...this.snapshot,
          historyMessages: [...nextMessages, ...this.snapshot.historyMessages],
          historyOffset: this.snapshot.historyOffset + nextMessages.length,
          hasMoreHistory: result.hasMore === true,
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

  private connect(): void {
    if (this.transportSubscription || !this.sendData || !this.daemonId || !this.sessionId) return
    this.transportSubscription = this.manager.subscribe(
      { sendData: this.sendData },
      this.daemonId,
      {
        type: 'subscribe',
        topic: 'session.chat_tail',
        key: this.subscriptionKey,
        params: {
          targetSessionId: this.sessionId,
          ...(this.historySessionId ? { historySessionId: this.historySessionId } : {}),
          knownMessageCount: this.snapshot.cursor.knownMessageCount,
          lastMessageSignature: this.snapshot.cursor.lastMessageSignature,
          ...(this.snapshot.cursor.tailLimit > 0 ? { tailLimit: this.snapshot.cursor.tailLimit } : {}),
        },
      },
      (update: SessionChatTailUpdate) => {
        this.handleUpdate(update)
      },
    )
  }

  private disconnect(): void {
    this.transportSubscription?.()
    this.transportSubscription = null
  }

  dispose(): void {
    this.disconnect()
    this.listeners.clear()
    this.retainCount = 0
    this.loadHistoryPromise = null
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.snapshot))
  }

  private handleUpdate(update: SessionChatTailUpdate): void {
    const nextMessages = applyReadChatSync(this.snapshot.liveMessages, update)
    const nextCursor: Required<ReadChatCursor> = {
      knownMessageCount: Math.max(
        nextMessages.length,
        Number(update.totalMessages || 0),
      ),
      lastMessageSignature: typeof update.lastMessageSignature === 'string'
        ? update.lastMessageSignature
        : buildLastMessageSignature(nextMessages[nextMessages.length - 1]),
      tailLimit: this.snapshot.cursor.tailLimit,
    }
    const unchanged = buildChatSnapshotSignature(this.snapshot.liveMessages)
      === buildChatSnapshotSignature(nextMessages)
      && this.snapshot.cursor.knownMessageCount === nextCursor.knownMessageCount
      && this.snapshot.cursor.lastMessageSignature === nextCursor.lastMessageSignature
    if (unchanged) return
    this.snapshot = {
      ...this.snapshot,
      liveMessages: nextMessages,
      cursor: nextCursor,
    }
    // Keep the subscription manager's stored request params up to date so that
    // resubscribeAll / resubscribeForDaemon on reconnect sends the current cursor
    // rather than the stale cursor from when the subscription was first opened.
    this.manager.updateParams('session.chat_tail', this.subscriptionKey, {
      knownMessageCount: nextCursor.knownMessageCount,
      lastMessageSignature: nextCursor.lastMessageSignature,
    })
    this.emit()
  }
}

export function getOrCreateSessionChatTailController(options: SessionChatTailControllerOptions): SessionChatTailController {
  const key = getControllerKey(options.daemonId, options.sessionId)
  const existing = controllerRegistry.get(key)
  if (existing) {
    existing.updateOptions(options)
    return existing
  }
  const controller = new SessionChatTailController(options)
  controllerRegistry.set(key, controller)
  return controller
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

export function buildWarmSessionChatTailDescriptorState(
  conversations: ActiveConversation[],
): { descriptors: WarmSessionChatTailDescriptor[]; signature: string } {
  const seen = new Set<string>()
  const descriptors: WarmSessionChatTailDescriptor[] = []
  for (const conversation of conversations) {
    const daemonId = getConversationDaemonRouteId(conversation)
    const sessionId = conversation.sessionId || ''
    if (!daemonId || !sessionId) continue
    const key = getControllerKey(daemonId, sessionId)
    if (seen.has(key)) continue
    seen.add(key)
    descriptors.push({
      daemonId,
      sessionId,
      historySessionId: conversation.providerSessionId || sessionId,
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
  const historySessionId = activeConv.providerSessionId || sessionId
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
    })
  }, [daemonId, enabled, historySessionId, sendData, sessionId, subscriptionKey, tailLimit])

  const [snapshot, setSnapshot] = useState<SessionChatTailSnapshot>(() => (
    controller?.getSnapshot() || buildEmptySnapshot(tailLimit)
  ))

  useEffect(() => {
    if (!controller) {
      setSnapshot(buildEmptySnapshot(tailLimit))
      return
    }
    controller.hydrateLiveMessages(activeConv.messages as DashboardMessage[])
    controller.retain()
    setSnapshot(controller.getSnapshot())
    const unsubscribe = controller.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot)
    })
    return () => {
      unsubscribe()
      controller.release()
    }
  }, [activeConv.messages, controller, tailLimit])

  const loadHistoryPage = useCallback(async () => {
    if (!controller || !daemonId || !sessionId) return
    await controller.loadHistoryPage(async () => {
      const agentType = activeConv.agentType
      const raw = await sendCommand(daemonId, 'chat_history', {
        agentType,
        offset: controller.getSnapshot().historyOffset,
        limit: 30,
        targetSessionId: sessionId,
        historySessionId,
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
  options?: { enabled?: boolean; tailLimit?: number },
): void {
  const { sendData } = useTransport()
  const enabled = options?.enabled !== false
  const tailLimit = Math.max(0, options?.tailLimit ?? DEFAULT_TAIL_LIMIT)
  const descriptorState = useMemo(
    () => buildWarmSessionChatTailDescriptorState(conversations),
    [conversations],
  )

  useEffect(() => {
    if (!enabled || !sendData || descriptorState.descriptors.length === 0) return
    const controllers = descriptorState.descriptors.map((descriptor) => (
      getOrCreateSessionChatTailController({
        ...descriptor,
        sendData,
        tailLimit,
      })
    ))
    controllers.forEach((controller) => controller.retain())
    return () => {
      controllers.forEach((controller) => controller.release())
    }
  }, [descriptorState.signature, enabled, sendData, tailLimit])
}
