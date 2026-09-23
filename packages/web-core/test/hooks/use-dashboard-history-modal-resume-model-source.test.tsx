// @vitest-environment jsdom
//
// Phase E launch provenance: when a saved-history session is resumed and its
// summary metadata carries a model, useDashboardHistoryModalState must stamp
// `modelSource: 'remembered'` alongside `initialModel` on the launchCli call —
// the same shape buildDashboardProviderLaunchPayload uses in
// useDashboardCommandActions.ts for a dialog-picked model ('user'). Without
// this, a resumed session's model would be indistinguishable from a fresh
// user choice downstream (launch provenance UI, telemetry).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDashboardHistoryModalState } from '../../src/hooks/useDashboardHistoryModalState'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { SavedSessionHistoryEntry } from '../../src/components/dashboard/HistoryModal'
import type { DaemonData } from '../../src/types'

let launchCliCalls: Array<{ machineId: string; payload: Record<string, unknown> }> = []

vi.mock('../../src/context/LaunchCliContext', () => ({
  useLaunchCli: () => ({
    launchCli: async (machineId: string, payload: Record<string, unknown>) => {
      launchCliCalls.push({ machineId, payload })
      return { result: { sessionId: 'sess_resumed' } }
    },
  }),
}))

const activeConv: ActiveConversation = {
  routeId: 'daemon-1',
  daemonId: 'daemon-1',
  agentName: 'claude-cli',
  agentType: 'claude-cli',
  status: 'idle',
  transport: 'pty',
} as ActiveConversation

const ides: DaemonData[] = []

let hook: ReturnType<typeof useDashboardHistoryModalState>
function Probe() {
  hook = useDashboardHistoryModalState({
    activeConv,
    remoteDialogConv: null,
    remoteDialogActiveConv: null,
    ides,
    sendDaemonCommand: async () => ({}),
    updateRouteChats: () => {},
    setToasts: () => {},
    setClearedTabs: () => {},
    setSearchParams: () => {},
  })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  launchCliCalls = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render() {
  act(() => root.render(<Probe />))
}

function savedSession(overrides: Partial<SavedSessionHistoryEntry> = {}): SavedSessionHistoryEntry {
  return {
    id: 'saved_1',
    providerSessionId: 'prov_sess_1',
    providerType: 'claude-cli',
    providerName: 'Claude Code',
    kind: 'cli',
    title: 'Resumed session',
    workspace: '/repo',
    messageCount: 3,
    firstMessageAt: 1,
    lastMessageAt: 2,
    canResume: true,
    ...overrides,
  }
}

describe('useDashboardHistoryModalState — handleResumeSavedHistorySession model provenance', () => {
  it('stamps modelSource "remembered" when the saved session carries a model in summaryMetadata', async () => {
    render()
    const session = savedSession({
      summaryMetadata: {
        items: [{ id: 'model', value: 'claude-opus-4', shortValue: 'opus-4' }],
      } as any,
    })

    await act(async () => {
      await hook.handleResumeSavedHistorySession(session)
    })

    expect(launchCliCalls).toHaveLength(1)
    expect(launchCliCalls[0].payload.initialModel).toBe('opus-4')
    expect(launchCliCalls[0].payload.modelSource).toBe('remembered')
  })

  it('omits modelSource entirely when there is no model to report (matches buildDashboardProviderLaunchPayload guard)', async () => {
    render()
    const session = savedSession({ summaryMetadata: undefined })

    await act(async () => {
      await hook.handleResumeSavedHistorySession(session)
    })

    expect(launchCliCalls).toHaveLength(1)
    expect(launchCliCalls[0].payload.initialModel).toBeUndefined()
    expect('modelSource' in launchCliCalls[0].payload).toBe(false)
  })
})
