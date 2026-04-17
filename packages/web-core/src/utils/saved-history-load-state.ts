export interface SavedHistoryModalOpenRefreshState {
  hasLoadedInitialResults: boolean
  isLoading: boolean
}

export function shouldRefreshSavedHistoryOnModalOpen(state: SavedHistoryModalOpenRefreshState): boolean {
  return !state.hasLoadedInitialResults && !state.isLoading
}
