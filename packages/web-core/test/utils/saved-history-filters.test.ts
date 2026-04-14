import { describe, expect, it } from 'vitest'
import {
  filterSavedHistoryEntries,
  prepareSavedHistoryEntries,
  sortSavedHistoryEntries,
} from '../../src/utils/saved-history-filters'

describe('saved history filters', () => {
  it('filters entries by title/preview, workspace, and model substring, case-insensitively', () => {
    const entries = filterSavedHistoryEntries([
      { providerSessionId: 'session-1', title: 'Alpha task', preview: 'Reply with exactly OK.', workspace: '/repo/alpha', currentModel: 'gpt-5.4' },
      { providerSessionId: 'session-2', title: 'Beta notes', preview: 'Need sonnet follow-up.', workspace: '/repo/beta', currentModel: 'claude-sonnet-4' },
      { providerSessionId: 'session-3', title: 'Gamma scratch', preview: 'Preview text', workspace: '/other/gamma', currentModel: 'gpt-5.4-mini' },
    ] as any, {
      textQuery: 'reply with exactly',
      workspaceQuery: 'REPO',
      modelQuery: 'gpt-5.4',
    })

    expect(entries.map(entry => entry.providerSessionId)).toEqual(['session-1'])
  })

  it('matches title or preview when only textQuery is provided', () => {
    const entries = filterSavedHistoryEntries([
      { providerSessionId: 'session-1', title: 'Alpha task', preview: 'Reply with exactly OK.' },
      { providerSessionId: 'session-2', title: 'Beta notes', preview: 'Need sonnet follow-up.' },
    ] as any, {
      textQuery: 'sonnet',
    })

    expect(entries.map(entry => entry.providerSessionId)).toEqual(['session-2'])
  })

  it('returns all entries when filters are empty', () => {
    const entries = [
      { providerSessionId: 'session-1', workspace: '/repo/alpha', currentModel: 'gpt-5.4' },
      { providerSessionId: 'session-2', workspace: '/repo/beta', currentModel: 'claude-sonnet-4' },
    ] as any

    expect(filterSavedHistoryEntries(entries, {})).toEqual(entries)
  })

  it('can restrict web saved-history views to resumable entries only', () => {
    const entries = filterSavedHistoryEntries([
      { providerSessionId: 'session-1', title: 'Alpha task', canResume: true },
      { providerSessionId: 'session-2', title: 'Beta task', canResume: false },
    ] as any, {
      resumableOnly: true,
    })

    expect(entries.map(entry => entry.providerSessionId)).toEqual(['session-1'])
  })

  it('sorts entries by recent, oldest, or message count to match CLI continuity semantics', () => {
    const entries = [
      { providerSessionId: 'session-1', title: 'Alpha', lastMessageAt: 200, messageCount: 2 },
      { providerSessionId: 'session-2', title: 'Beta', lastMessageAt: 500, messageCount: 1 },
      { providerSessionId: 'session-3', title: 'Gamma', lastMessageAt: 300, messageCount: 7 },
    ] as any

    expect(sortSavedHistoryEntries(entries, 'recent').map(entry => entry.providerSessionId)).toEqual([
      'session-2',
      'session-3',
      'session-1',
    ])
    expect(sortSavedHistoryEntries(entries, 'oldest').map(entry => entry.providerSessionId)).toEqual([
      'session-1',
      'session-3',
      'session-2',
    ])
    expect(sortSavedHistoryEntries(entries, 'messages').map(entry => entry.providerSessionId)).toEqual([
      'session-3',
      'session-1',
      'session-2',
    ])
  })

  it('applies filtering before sorting for shared saved-history web views', () => {
    const entries = prepareSavedHistoryEntries([
      { providerSessionId: 'session-1', title: 'Alpha', preview: 'older note', workspace: '/repo/alpha', currentModel: 'gpt-5.4', lastMessageAt: 200, messageCount: 2 },
      { providerSessionId: 'session-2', title: 'Alpha follow-up', preview: 'newer note', workspace: '/repo/alpha', currentModel: 'gpt-5.4', lastMessageAt: 500, messageCount: 1 },
      { providerSessionId: 'session-3', title: 'Beta', preview: 'other', workspace: '/repo/beta', currentModel: 'claude', lastMessageAt: 300, messageCount: 7 },
    ] as any, {
      textQuery: 'alpha',
      workspaceQuery: '/repo/alpha',
      sortMode: 'oldest',
    })

    expect(entries.map(entry => entry.providerSessionId)).toEqual(['session-1', 'session-2'])
  })
})
