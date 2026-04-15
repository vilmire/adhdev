import type { DaemonData } from '../types'
import { getProviderSummaryValues } from './daemon-utils'

export type SavedHistorySortMode = 'recent' | 'oldest' | 'messages'

export interface SavedHistoryFilterOptions {
  textQuery?: string
  workspaceQuery?: string
  modelQuery?: string
  resumableOnly?: boolean
  sortMode?: SavedHistorySortMode
}

interface SavedHistoryFilterableEntry {
  title?: string | null
  preview?: string | null
  workspace?: string | null
  summaryMetadata?: DaemonData['summaryMetadata'] | null
  canResume?: boolean | null
  lastMessageAt?: number | null
  messageCount?: number | null
}

export function filterSavedHistoryEntries<T extends SavedHistoryFilterableEntry>(
  entries: T[],
  options: SavedHistoryFilterOptions = {},
): T[] {
  const textQuery = String(options.textQuery || '').trim().toLowerCase()
  const workspaceQuery = String(options.workspaceQuery || '').trim().toLowerCase()
  const modelQuery = String(options.modelQuery || '').trim().toLowerCase()
  const resumableOnly = !!options.resumableOnly

  if (!textQuery && !workspaceQuery && !modelQuery && !resumableOnly) return entries

  return entries.filter((entry) => {
    if (resumableOnly && !entry.canResume) return false
    if (textQuery) {
      const haystack = [entry.title, entry.preview]
        .map(value => String(value || '').toLowerCase())
        .join('\n')
      if (!haystack.includes(textQuery)) return false
    }
    if (workspaceQuery) {
      const workspace = String(entry.workspace || '').toLowerCase()
      if (!workspace.includes(workspaceQuery)) return false
    }
    if (modelQuery) {
      const model = getProviderSummaryValues(entry.summaryMetadata)
        .map(value => value.toLowerCase())
        .join('\n')
      if (!model.includes(modelQuery)) return false
    }
    return true
  })
}

export function sortSavedHistoryEntries<T extends SavedHistoryFilterableEntry>(
  entries: T[],
  sortMode: SavedHistorySortMode = 'recent',
): T[] {
  const sorted = entries.slice()
  sorted.sort((left, right) => {
    if (sortMode === 'oldest') {
      return (Number(left.lastMessageAt) || 0) - (Number(right.lastMessageAt) || 0)
    }
    if (sortMode === 'messages') {
      const diff = (Number(right.messageCount) || 0) - (Number(left.messageCount) || 0)
      if (diff !== 0) return diff
    }
    return (Number(right.lastMessageAt) || 0) - (Number(left.lastMessageAt) || 0)
  })
  return sorted
}

export function prepareSavedHistoryEntries<T extends SavedHistoryFilterableEntry>(
  entries: T[],
  options: SavedHistoryFilterOptions = {},
): T[] {
  return sortSavedHistoryEntries(
    filterSavedHistoryEntries(entries, options),
    options.sortMode || 'recent',
  )
}
