import type { SessionEntry } from '@adhdev/daemon-core'

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

function hasExplicitProviderName(value: string | null | undefined, providerType: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value !== providerType
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
    ? incomingMessages
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
  options?: { preserveMissing?: boolean },
): SessionEntryWithInboxMarkers[] | undefined {
  if (!incomingChildren?.length) {
    if (options?.preserveMissing === false && Array.isArray(incomingChildren)) {
      return incomingChildren
    }
    return existingChildren
  }
  if (!existingChildren?.length) return incomingChildren

  const mergedChildren = incomingChildren.map((child) => {
    const existing = existingChildren.find((entry) => entry.id === child.id)
    if (!existing) return child
    return mergeSessionEntrySummary(child, existing)
  })

  if (options?.preserveMissing !== false) {
    const incomingIds = new Set(incomingChildren.map((child) => child.id))
    for (const existing of existingChildren) {
      if (!incomingIds.has(existing.id)) {
        mergedChildren.push(existing)
      }
    }
  }

  return mergedChildren
}
