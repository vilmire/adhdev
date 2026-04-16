import { describe, expect, it } from 'vitest'
import { shouldAwaitStoredDockviewHydration } from '../../../src/components/dashboard/dashboardDockviewHydration'

describe('shouldAwaitStoredDockviewHydration', () => {
  it('keeps waiting when a stored layout exists and initial data has not loaded yet', () => {
    expect(shouldAwaitStoredDockviewHydration({
      hasStoredLayout: true,
      initialDataLoaded: false,
      visibleConversationCount: 0,
      ides: [],
    })).toBe(true)
  })

  it('keeps waiting during cloud bootstrap when only minimal daemon discovery entries exist', () => {
    expect(shouldAwaitStoredDockviewHydration({
      hasStoredLayout: true,
      initialDataLoaded: true,
      visibleConversationCount: 0,
      ides: [
        {
          id: 'daemon-1',
          type: 'adhdev-daemon',
          status: 'online',
          p2p: { available: true, state: 'connecting', peers: 0 },
        },
      ],
    })).toBe(true)
  })

  it('stops waiting once an authoritative machine snapshot has arrived even if there are no visible conversations yet', () => {
    expect(shouldAwaitStoredDockviewHydration({
      hasStoredLayout: true,
      initialDataLoaded: true,
      visibleConversationCount: 0,
      ides: [
        {
          id: 'daemon-1',
          type: 'adhdev-daemon',
          status: 'online',
          machine: {
            hostname: 'box',
            platform: 'darwin',
            arch: 'arm64',
            cpus: 8,
            totalMem: 16,
            uptime: 1,
          },
        },
      ],
    })).toBe(false)
  })

  it('stops waiting once visible conversations exist', () => {
    expect(shouldAwaitStoredDockviewHydration({
      hasStoredLayout: true,
      initialDataLoaded: true,
      visibleConversationCount: 1,
      ides: [
        {
          id: 'daemon-1:cli:session-1',
          daemonId: 'daemon-1',
          sessionId: 'session-1',
          type: 'claude-code',
          agentType: 'claude-code',
          transport: 'pty',
          sessionKind: 'agent',
          status: 'running',
          workspace: '/tmp',
        },
      ],
    })).toBe(false)
  })

  it('does not wait when there is no stored layout to protect', () => {
    expect(shouldAwaitStoredDockviewHydration({
      hasStoredLayout: false,
      initialDataLoaded: true,
      visibleConversationCount: 0,
      ides: [],
    })).toBe(false)
  })
})
