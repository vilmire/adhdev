import { describe, expect, it } from 'vitest'
import {
  getSavedProviderSessions,
  upsertSavedProviderSession,
} from '../../src/config/saved-sessions.js'
import type { DaemonState } from '../../src/config/state-store.js'

function createState(): DaemonState {
  return {
    recentActivity: [],
    savedProviderSessions: [],
    sessionReads: {},
    sessionReadMarkers: {},
  }
}

describe('saved-sessions', () => {
  it('writes summary metadata without duplicating currentModel in new saved sessions', () => {
    const next = upsertSavedProviderSession(createState(), {
      kind: 'cli',
      providerType: 'codex',
      providerName: 'Codex',
      providerSessionId: 'sess-1',
      workspace: '/repo',
      summaryMetadata: {
        items: [{ id: 'model', value: 'gpt-5.4', shortValue: 'gpt-5.4', order: 10 }],
      },
      title: 'Session one',
      lastUsedAt: 123,
    })

    expect(next.savedProviderSessions).toHaveLength(1)
    expect(next.savedProviderSessions[0]?.summaryMetadata).toEqual({
      items: [{ id: 'model', value: 'gpt-5.4', shortValue: 'gpt-5.4', order: 10 }],
    })
    expect(next.savedProviderSessions[0]).not.toHaveProperty('currentModel')
  })

  it('does not upgrade legacy currentModel when reading old saved sessions after compat removal', () => {
    const state = createState()
    state.savedProviderSessions = [
      {
        id: 'saved:sess-1',
        kind: 'cli',
        providerType: 'codex',
        providerName: 'Codex',
        providerSessionId: 'sess-1',
        workspace: '/repo',
        currentModel: 'gpt-5.4',
        title: 'Legacy session',
        createdAt: 10,
        lastUsedAt: 20,
      } as any,
    ]

    const result = getSavedProviderSessions(state, { providerType: 'codex', kind: 'cli' })
    expect(result[0]?.summaryMetadata).toBeUndefined()
  })
})
