export interface SavedHistorySummaryLike {
  title?: string | null
  providerSessionId: string
  workspace?: string | null
  currentModel?: string | null
  messageCount?: number | null
  lastMessageAt?: number | null
  preview?: string | null
}

export interface SavedHistorySummaryView {
  title: string
  providerSessionId: string
  metaLine: string
  updatedLabel: string
  preview: string
}

export function formatSavedHistorySummaryTime(timestamp?: number | null): string {
  if (!timestamp) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toLocaleString()
  }
}

export function buildSavedHistorySummaryView(session: SavedHistorySummaryLike): SavedHistorySummaryView {
  const metaItems = [session.workspace || 'Workspace unknown']
  if (session.currentModel) metaItems.push(session.currentModel)
  if ((session.messageCount || 0) > 0) metaItems.push(`${session.messageCount} msgs`)

  const formattedTime = formatSavedHistorySummaryTime(session.lastMessageAt)
  return {
    title: session.title || session.providerSessionId,
    providerSessionId: session.providerSessionId,
    metaLine: metaItems.join(' · '),
    updatedLabel: formattedTime ? `Updated ${formattedTime}` : '',
    preview: (session.preview || '').trim(),
  }
}
