import { describe, expect, it } from 'vitest'
import { createSavedHistoryFilterState, shouldResetSavedHistoryFilterState } from '../../src/utils/saved-history-filter-state'

describe('saved history filter state', () => {
  it('creates an empty filter state by default', () => {
    expect(createSavedHistoryFilterState()).toEqual({
      textQuery: '',
      workspaceQuery: '',
      modelQuery: '',
      resumableOnly: false,
      sortMode: 'recent',
    })
  })

  it('allows saved-history state to preserve sort mode alongside filters', () => {
    expect(createSavedHistoryFilterState({
      textQuery: 'alpha',
      resumableOnly: true,
      sortMode: 'messages',
    })).toEqual({
      textQuery: 'alpha',
      workspaceQuery: '',
      modelQuery: '',
      resumableOnly: true,
      sortMode: 'messages',
    })
  })

  it('preserves filter state when reopening the same saved-history scope', () => {
    expect(shouldResetSavedHistoryFilterState('machine-1:claude', 'machine-1:claude')).toBe(false)
  })

  it('resets filter state when the saved-history scope changes', () => {
    expect(shouldResetSavedHistoryFilterState('machine-1:claude', 'machine-1:hermes')).toBe(true)
    expect(shouldResetSavedHistoryFilterState('machine-1:claude', null)).toBe(true)
  })
})
