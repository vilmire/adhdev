import type { TFunction } from 'i18next'
import type { DaemonData } from '../types'
import { getProviderSummaryLine } from './daemon-utils'

export interface SavedHistorySummaryLike {
  title?: string | null
  providerSessionId: string
  workspace?: string | null
  summaryMetadata?: DaemonData['summaryMetadata'] | null
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

/** `t` is optional so the view stays usable (and testable) without i18n; English is the default. */
export function buildSavedHistorySummaryView(session: SavedHistorySummaryLike, t?: TFunction): SavedHistorySummaryView {
  const metaItems = [session.workspace || (t ? t('launch.workspaceUnknown') : 'Workspace unknown')]
  const summaryLine = getProviderSummaryLine(session.summaryMetadata)
  if (summaryLine) metaItems.push(summaryLine)
  if ((session.messageCount || 0) > 0) {
    metaItems.push(t ? t('launch.messageCountShort', { count: session.messageCount }) : `${session.messageCount} msgs`)
  }

  const formattedTime = formatSavedHistorySummaryTime(session.lastMessageAt)
  return {
    title: session.title || session.providerSessionId,
    providerSessionId: session.providerSessionId,
    metaLine: metaItems.join(' · '),
    updatedLabel: formattedTime ? (t ? t('launch.updatedAt', { time: formattedTime }) : `Updated ${formattedTime}`) : '',
    preview: (session.preview || '').trim(),
  }
}
