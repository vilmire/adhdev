import { describe, expect, it } from 'vitest'
import { applyCliViewModeOverrides, getCliViewModeForSession } from '../../../src/components/dashboard/cliViewModeOverrides'
import type { DaemonData } from '../../../src/types'

function createEntry(overrides: Partial<DaemonData> = {}): DaemonData {
  return {
    id: 'machine-1:cli:cli-1',
    sessionId: 'cli-1',
    daemonId: 'machine-1',
    type: 'hermes-cli',
    agentType: 'hermes-cli',
    transport: 'pty',
    mode: 'chat',
    status: 'idle',
    cliName: 'Hermes Agent',
    workspace: '/repo',
    activeChat: { id: 'chat-1', title: 'Hermes Agent', status: 'idle', messages: [], activeModal: null },
    timestamp: 1,
    ...overrides,
  }
}

describe('cliViewModeOverrides', () => {
  it('applies optimistic mode overrides to top-level cli entries', () => {
    const entry = createEntry()
    const next = applyCliViewModeOverrides([entry], { 'cli-1': 'terminal' })
    expect(next[0]).toMatchObject({ sessionId: 'cli-1', mode: 'terminal' })
    expect(next[0]).not.toBe(entry)
  })

  it('applies optimistic mode overrides to child cli sessions', () => {
    const parent = createEntry({
      id: 'machine-1:ide:cursor-1',
      sessionId: 'cursor-1',
      transport: 'cdp-page',
      type: 'cursor',
      agentType: undefined,
      mode: 'chat',
      childSessions: [{
        id: 'cli-child',
        parentId: 'cursor-1',
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        kind: 'agent',
        transport: 'pty',
        status: 'idle',
        title: 'Hermes Agent',
        workspace: '/repo',
        activeChat: null,
        capabilities: [],
        mode: 'chat',
      } as any],
    })
    const next = applyCliViewModeOverrides([parent], { 'cli-child': 'terminal' })
    expect(next[0].childSessions?.[0]).toMatchObject({ id: 'cli-child', mode: 'terminal' })
  })

  it('reads the latest cli mode for a session from top-level and child entries', () => {
    const entries = applyCliViewModeOverrides([
      createEntry(),
      createEntry({
        id: 'machine-1:ide:cursor-1',
        sessionId: 'cursor-1',
        transport: 'cdp-page',
        type: 'cursor',
        agentType: undefined,
        childSessions: [{
          id: 'cli-child',
          parentId: 'cursor-1',
          providerType: 'hermes-cli',
          providerName: 'Hermes Agent',
          kind: 'agent',
          transport: 'pty',
          status: 'idle',
          title: 'Hermes Agent',
          workspace: '/repo',
          activeChat: null,
          capabilities: [],
          mode: 'chat',
        } as any],
      }),
    ], { 'cli-1': 'terminal', 'cli-child': 'terminal' })

    expect(getCliViewModeForSession(entries, 'cli-1')).toBe('terminal')
    expect(getCliViewModeForSession(entries, 'cli-child')).toBe('terminal')
    expect(getCliViewModeForSession(entries, 'missing')).toBeNull()
  })
})
