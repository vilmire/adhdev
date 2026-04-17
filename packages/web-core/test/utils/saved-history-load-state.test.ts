import { describe, expect, it } from 'vitest'
import { shouldRefreshSavedHistoryOnModalOpen } from '../../src/utils/saved-history-load-state'

describe('saved-history load state', () => {
  it('refreshes when the current provider scope has not finished an initial load yet', () => {
    expect(shouldRefreshSavedHistoryOnModalOpen({
      hasLoadedInitialResults: false,
      isLoading: false,
    })).toBe(true)
  })

  it('does not refresh when a load is already in flight', () => {
    expect(shouldRefreshSavedHistoryOnModalOpen({
      hasLoadedInitialResults: false,
      isLoading: true,
    })).toBe(false)
  })

  it('does not refresh when the current provider scope already loaded, even if the result set is empty', () => {
    expect(shouldRefreshSavedHistoryOnModalOpen({
      hasLoadedInitialResults: true,
      isLoading: false,
    })).toBe(false)
  })
})
