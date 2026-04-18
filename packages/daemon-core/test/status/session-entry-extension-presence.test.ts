import { describe, expect, it } from 'vitest'
import { buildSessionEntries } from '../../src/status/builders.js'

describe('buildSessionEntries extension presence gating', () => {
  it('omits idle extension sessions that have no discovered stream or chat state', () => {
    const sessions = buildSessionEntries([
      {
        category: 'ide',
        type: 'cursor',
        name: 'Cursor',
        instanceId: 'ide-parent',
        status: 'idle',
        workspace: '/repo',
        activeChat: null,
        extensions: [
          {
            category: 'extension',
            type: 'codex',
            name: 'Codex',
            instanceId: 'ext-stale',
            status: 'idle',
            activeChat: null,
            agentStreams: [],
            controlValues: {},
            lastUpdated: 1,
            settings: {},
            pendingEvents: [],
          },
          {
            category: 'extension',
            type: 'claude-code-vscode',
            name: 'Claude Code (VS Code)',
            instanceId: 'ext-live',
            status: 'idle',
            activeChat: null,
            agentStreams: [{ status: 'idle' }],
            controlValues: {},
            lastUpdated: 1,
            settings: {},
            pendingEvents: [],
          },
        ],
        lastUpdated: 1,
        settings: {},
        pendingEvents: [],
      } as any,
    ], new Map(), { profile: 'full' })

    expect(sessions.find((session) => session.id === 'ext-stale')).toBeUndefined()
    expect(sessions.find((session) => session.id === 'ext-live')?.providerType).toBe('claude-code-vscode')
  })
})
