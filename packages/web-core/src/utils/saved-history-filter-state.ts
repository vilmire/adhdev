import type { SavedHistorySortMode } from './saved-history-filters'

export interface SavedHistoryFilterState {
  textQuery: string
  workspaceQuery: string
  modelQuery: string
  resumableOnly: boolean
  sortMode: SavedHistorySortMode
}

export function createSavedHistoryFilterState(
  overrides: Partial<SavedHistoryFilterState> = {},
): SavedHistoryFilterState {
  return {
    textQuery: overrides.textQuery || '',
    workspaceQuery: overrides.workspaceQuery || '',
    modelQuery: overrides.modelQuery || '',
    resumableOnly: !!overrides.resumableOnly,
    sortMode: overrides.sortMode || 'recent',
  }
}

export function shouldResetSavedHistoryFilterState(
  previousScope: string | null | undefined,
  nextScope: string | null | undefined,
): boolean {
  return String(previousScope || '') !== String(nextScope || '')
}
