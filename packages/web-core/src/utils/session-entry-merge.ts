import type { SessionEntry } from '@adhdev/daemon-core'
import { normalizeTextContent } from './text'

export type SessionEntryWithInboxMarkers = SessionEntry & {
  completionMarker?: string
  seenCompletionMarker?: string
}

export type ExistingSessionLike = Partial<SessionEntryWithInboxMarkers> & {
  parentSessionId?: string | null
  cliName?: string
  type?: string
  mode?: SessionEntry['mode']
  sessionCapabilities?: SessionEntry['capabilities']
  summaryMetadata?: any
  activeChat?: SessionEntry['activeChat']
  completionMarker?: string
  seenCompletionMarker?: string
}

type ActiveChatMessageList = NonNullable<NonNullable<SessionEntry['activeChat']>['messages']>

function hasExplicitProviderName(value: string | null | undefined, providerType: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value !== providerType
}

function getMessageTimestamp(message: { receivedAt?: number | string; timestamp?: number | string } | null | undefined): number {
  const value = Number(message?.receivedAt ?? message?.timestamp ?? 0)
  return Number.isFinite(value) ? value : 0
}

function isTruncatedPrefixRegression(
  incomingMessages: ActiveChatMessageList | null | undefined,
  existingMessages: ActiveChatMessageList | null | undefined,
): boolean {
  if (!Array.isArray(incomingMessages) || !Array.isArray(existingMessages)) return false
  if (incomingMessages.length === 0 || existingMessages.length === 0) return false
  if (incomingMessages.length > existingMessages.length) return false

  const incomingLast = incomingMessages[incomingMessages.length - 1]
  const existingLast = existingMessages[existingMessages.length - 1]
  if (!incomingLast || !existingLast) return false

  const incomingRole = String(incomingLast.role || '').toLowerCase()
  const existingRole = String(existingLast.role || '').toLowerCase()
  if (!incomingRole || incomingRole !== existingRole) return false

  if (incomingLast.id && existingLast.id && String(incomingLast.id) !== String(existingLast.id)) return false
  if (typeof incomingLast.index === 'number' && typeof existingLast.index === 'number' && incomingLast.index !== existingLast.index) return false

  const incomingText = normalizeTextContent(incomingLast.content)
  const existingText = normalizeTextContent(existingLast.content)
  if (!incomingText || !existingText) return false
  if (incomingText === existingText) return false
  if (incomingText.length >= existingText.length) return false
  if (!existingText.startsWith(incomingText)) return false

  const incomingTs = getMessageTimestamp(incomingLast)
  const existingTs = getMessageTimestamp(existingLast)
  if (incomingTs && existingTs && Math.abs(incomingTs - existingTs) > 15_000) return false

  return true
}

export function mergeActiveChatData(
  incoming: SessionEntry['activeChat'] | null | undefined,
  existing: SessionEntry['activeChat'] | null | undefined,
): SessionEntry['activeChat'] | null {
  if (!incoming) return existing ?? null
  if (!existing) return incoming ?? null

  const incomingMessages = Array.isArray(incoming.messages) ? incoming.messages : []
  const existingMessages = Array.isArray(existing.messages) ? existing.messages : []
  const mergedMessages = incomingMessages.length > 0
    ? (isTruncatedPrefixRegression(incomingMessages, existingMessages) ? existingMessages : incomingMessages)
    : existingMessages

  const mergedActiveModal = incoming.activeModal
    || (incoming.status === 'waiting_approval' ? existing.activeModal : null)

  return {
    ...existing,
    ...incoming,
    messages: mergedMessages,
    activeModal: mergedActiveModal,
    inputContent: incoming.inputContent ?? existing.inputContent,
  }
}

export function mergeSessionEntrySummary(
  session: SessionEntryWithInboxMarkers,
  existingEntry: ExistingSessionLike | undefined,
): SessionEntryWithInboxMarkers {
  const explicitProviderName = hasExplicitProviderName(session.providerName, session.providerType)
    ? session.providerName
    : undefined

  return {
    ...session,
    parentId: session.parentId ?? existingEntry?.parentSessionId ?? null,
    providerSessionId: session.providerSessionId ?? existingEntry?.providerSessionId,
    providerName: explicitProviderName
      ?? existingEntry?.providerName
      ?? existingEntry?.cliName
      ?? existingEntry?.type
      ?? session.providerName
      ?? session.providerType,
    title: session.title
      ?? existingEntry?.title
      ?? explicitProviderName
      ?? existingEntry?.providerName
      ?? session.providerName
      ?? session.providerType,
    workspace: session.workspace ?? existingEntry?.workspace ?? null,
    mode: session.mode ?? existingEntry?.mode,
    capabilities: session.capabilities ?? (existingEntry?.sessionCapabilities as SessionEntry['capabilities']) ?? existingEntry?.capabilities ?? [],
    cdpConnected: session.cdpConnected ?? existingEntry?.cdpConnected,
    activeChat: mergeActiveChatData(session.activeChat, existingEntry?.activeChat),
    controlValues: session.controlValues ?? existingEntry?.controlValues,
    providerControls: session.providerControls ?? existingEntry?.providerControls,
    summaryMetadata: session.summaryMetadata ?? existingEntry?.summaryMetadata,
    runtimeWriteOwner: session.runtimeWriteOwner ?? existingEntry?.runtimeWriteOwner,
    runtimeAttachedClients: session.runtimeAttachedClients ?? existingEntry?.runtimeAttachedClients,
    lastMessagePreview: session.lastMessagePreview ?? existingEntry?.lastMessagePreview,
    lastMessageRole: session.lastMessageRole ?? existingEntry?.lastMessageRole,
    lastMessageAt: session.lastMessageAt ?? existingEntry?.lastMessageAt,
    lastMessageHash: session.lastMessageHash ?? existingEntry?.lastMessageHash,
    unread: session.unread ?? existingEntry?.unread,
    lastSeenAt: session.lastSeenAt ?? existingEntry?.lastSeenAt,
    inboxBucket: session.inboxBucket ?? existingEntry?.inboxBucket,
    completionMarker: session.completionMarker ?? existingEntry?.completionMarker,
    seenCompletionMarker: session.seenCompletionMarker ?? existingEntry?.seenCompletionMarker,
    surfaceHidden: session.surfaceHidden ?? existingEntry?.surfaceHidden,
    resume: session.resume ?? existingEntry?.resume,
    runtimeKey: session.runtimeKey ?? existingEntry?.runtimeKey,
    runtimeDisplayName: session.runtimeDisplayName ?? existingEntry?.runtimeDisplayName,
    runtimeWorkspaceLabel: session.runtimeWorkspaceLabel ?? existingEntry?.runtimeWorkspaceLabel,
  }
}

export function mergeSessionEntryChildren(
  existingChildren: SessionEntryWithInboxMarkers[] | undefined,
  incomingChildren: SessionEntryWithInboxMarkers[] | undefined,
): SessionEntryWithInboxMarkers[] | undefined {
  if (!incomingChildren?.length) return existingChildren
  if (!existingChildren?.length) return incomingChildren

  const existingById = new Map(existingChildren.map((child) => [child.id, child]))
  return incomingChildren.map((child) => {
    const existing = existingById.get(child.id)
    if (!existing) return child
    return mergeSessionEntrySummary(child, existing)
  })
}
