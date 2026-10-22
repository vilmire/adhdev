// Ghost dock tabs after the 2026-10-17 reboot: Chrome localStorage key
// adhdev_dashboardDockview_v1:desktop-narrow (000300.ldb) restored seven
// pre-reboot :cli: panels. The first authoritative daemon.metadata list had
// one assistant (fa86b5c0) and two coordinators (fe3587e9, afa78c9f).
import { describe, expect, it, vi } from 'vitest'
import type { DaemonData } from '../../../src/types'
import { buildConversations } from '../../../src/components/dashboard/buildConversations'
import {
  applyAuthoritativeStoredDockPrune,
  pendingStoredPanelsAfterRestore,
  releaseStoredDockGrace,
  type PendingStoredPanels,
} from '../../../src/components/dashboard/dashboardDockviewHydration'
import { ASSISTANT_DISPLAY_LABEL } from '../../../src/components/dashboard/assistant-session'

const DAEMON = 'daemon_mach_4462a75330c548be9c2e74dd9f7f6ffb'

/** Seven panel session ids from 000300.ldb, with the titles the dock restored. */
const STORED_GHOSTS: Array<{ sessionId: string; title: string }> = [
  { sessionId: '0c7ea42c-ed61-490c-a0e5-2c0402d74eab', title: 'Assistant' },
  { sessionId: '7ddc85c1-7de0-433e-a27a-12e8111a08d2', title: 'BATRP' },
  { sessionId: '15e83685-e53c-42a6-b966-d4e89ca49c81', title: 'adhdev' },
  { sessionId: '0997c202-02cc-496e-9463-76cc42f3548a', title: 'adhdev' },
  { sessionId: '5ba2ff3c-c1f2-4c09-92d7-988b793b09bc', title: 'fix-assistant-four-defects-rc15' },
  { sessionId: '41a4abd6-09a0-4698-83e8-3ee0825171cb', title: 'adhdev' },
  { sessionId: '81c26269-2f32-457a-8bf8-6080bfbf9de4', title: 'adhdev' },
]

const LIVE_ASSISTANT = 'fa86b5c0-c00a-4bdb-80aa-2ed1929e5510'
const LIVE_ADHDEV = 'fe3587e9-8d8a-4bf5-9c00-4889ea5d77c9'
const LIVE_BATRP = 'afa78c9f-657e-4209-9e55-ec48076805be'

function panelId(sessionId: string) {
  return `${DAEMON}:cli:${sessionId}`
}

function cliEntry(sessionId: string, workspace: string, extra: Partial<DaemonData> = {}): DaemonData {
  return {
    id: panelId(sessionId),
    daemonId: DAEMON,
    sessionId,
    type: 'claude-cli',
    agentType: 'claude-cli',
    transport: 'pty',
    sessionKind: 'agent',
    status: 'idle',
    workspace,
    ...extra,
  }
}

function authoritativeDaemon(): DaemonData {
  return {
    id: DAEMON,
    type: 'adhdev-daemon',
    status: 'online',
    _sessionListAuthoritative: true,
    machine: {
      hostname: 'user-DevMac-4',
      platform: 'darwin',
      arch: 'arm64',
      cpus: 8,
      totalMem: 16,
      uptime: 1,
    },
  }
}

interface FakePanel {
  id: string
  title: string
  update: ReturnType<typeof vi.fn>
  api: { setTitle: (title: string) => void; moveTo: ReturnType<typeof vi.fn>; setActive: ReturnType<typeof vi.fn> }
  group: { panels: FakePanel[]; activePanel: FakePanel | null }
}

function fakeApi(stored: Array<{ id: string; title: string }>) {
  const panels: FakePanel[] = []
  const group = { panels, activePanel: null as FakePanel | null }
  const make = (id: string, title: string): FakePanel => {
    const panel = {
      id,
      title,
      update: vi.fn(),
      api: {
        setTitle: (next: string) => { panel.title = next },
        moveTo: vi.fn(),
        setActive: vi.fn(),
      },
      group,
    }
    return panel
  }
  for (const entry of stored) panels.push(make(entry.id, entry.title))
  group.activePanel = panels[0] ?? null
  return {
    get panels() { return panels },
    get activePanel() { return panels[0] },
    getPanel: (id: string) => panels.find(panel => panel.id === id),
    removePanel: (panel: { id: string }) => {
      const index = panels.findIndex(entry => entry.id === panel.id)
      if (index >= 0) panels.splice(index, 1)
    },
    addPanel: (opts: { id: string; title?: string }) => {
      const panel = make(opts.id, opts.title || opts.id)
      panels.push(panel)
      return panel
    },
    toJSON: () => ({
      panels: Object.fromEntries(panels.map(panel => [panel.id, { id: panel.id, title: panel.title }])),
    }),
  }
}

/** Panels left by handleReady → fromJSON, before the session list arrives. */
function restoredFromJSON(stored: Array<{ sessionId: string; title: string }>) {
  return fakeApi(stored.map(entry => ({ id: panelId(entry.sessionId), title: entry.title })))
}

function pendingFor(api: { panels: Array<{ id: string }> }, visibleTabKeys: string[]): { current: PendingStoredPanels | null } {
  return {
    current: pendingStoredPanelsAfterRestore(
      api.panels.map(panel => panel.id),
      visibleTabKeys,
      id => id.startsWith('remote:'),
      1_000,
    ),
  }
}

describe('authoritative dock prune of stored ghost tabs', () => {
  it('drops the seven 000300 panels on the first authoritative snapshot and persists that layout', () => {
    const sessions = [
      cliEntry(LIVE_ASSISTANT, '/Users/dev/.adhdev-preview/assistant', { assistant: true }),
      cliEntry(LIVE_ADHDEV, '/Users/dev/Work/adhdev', { coordinator: { meshId: 'mesh_271444af', role: 'coordinator' } }),
      cliEntry(LIVE_BATRP, '/Users/dev/Work/BATRP', { coordinator: { meshId: 'mesh_dbe0718d', role: 'coordinator' } }),
    ]
    const ides = [authoritativeDaemon(), ...sessions]
    const conversations = buildConversations(sessions, ides)
    const api = restoredFromJSON(STORED_GHOSTS)
    const pendingRef = pendingFor(api, conversations.map(conversation => conversation.tabKey))
    let written: unknown = null

    // Still inside the 20s grace. The prune must not wait for it.
    applyAuthoritativeStoredDockPrune(
      api as any,
      conversations,
      pendingRef,
      ides,
      null,
      1_000,
      layout => { written = layout },
    )

    const ids = api.panels.map(panel => panel.id)
    for (const ghost of STORED_GHOSTS) {
      expect(ids, ghost.sessionId).not.toContain(panelId(ghost.sessionId))
    }
    expect(ids).toEqual([
      panelId(LIVE_ASSISTANT),
      panelId(LIVE_ADHDEV),
      panelId(LIVE_BATRP),
    ])
    const assistantPanels = api.panels.filter(panel => {
      const conversation = conversations.find(entry => entry.tabKey === panel.id)
      return panel.title === ASSISTANT_DISPLAY_LABEL || conversation?.displayPrimary === ASSISTANT_DISPLAY_LABEL
    })
    expect(assistantPanels).toHaveLength(1)
    expect(assistantPanels[0].id).toBe(panelId(LIVE_ASSISTANT))
    expect(written).not.toBeNull()
    const serialized = JSON.stringify(written)
    for (const ghost of STORED_GHOSTS) {
      expect(serialized).not.toContain(ghost.sessionId)
    }
    expect(serialized).toContain(LIVE_ASSISTANT)
    expect(serialized).toContain(LIVE_ADHDEV)
    expect(serialized).toContain(LIVE_BATRP)
  })

  it('grace-timeout early return leaves no stored ghosts when the retain ref is already null', () => {
    const sessions = [
      cliEntry(LIVE_ASSISTANT, '/Users/dev/.adhdev-preview/assistant', { assistant: true }),
    ]
    const conversations = buildConversations(sessions, [authoritativeDaemon(), ...sessions])
    const api = restoredFromJSON(STORED_GHOSTS)
    const pendingRef: { current: PendingStoredPanels | null } = { current: null }

    const removed = releaseStoredDockGrace(api as any, pendingRef, conversations, null)

    expect(removed).toBe(true)
    const ids = api.panels.map(panel => panel.id)
    for (const ghost of STORED_GHOSTS) {
      expect(ids).not.toContain(panelId(ghost.sessionId))
    }
    expect(ids).toEqual([panelId(LIVE_ASSISTANT)])
  })

  it('keeps two live sessions that share a workspace basename', () => {
    const sameBasename = '15e83685-e53c-42a6-b966-d4e89ca49c81'
    const otherLive = 'fe3587e9-8d8a-4bf5-9c00-4889ea5d77c9'
    const storedGhost = '0997c202-02cc-496e-9463-76cc42f3548a'
    const sessions = [
      cliEntry(sameBasename, '/Users/dev/Work/adhdev'),
      cliEntry(otherLive, '/Users/dev/Work/adhdev'),
    ]
    const ides = [authoritativeDaemon(), ...sessions]
    const conversations = buildConversations(sessions, ides)
    expect(conversations.map(conversation => conversation.displayPrimary)).toEqual(['adhdev', 'adhdev'])
    const api = restoredFromJSON([
      { sessionId: storedGhost, title: 'adhdev' },
      { sessionId: sameBasename, title: 'adhdev' },
    ])
    const pendingRef = pendingFor(api, conversations.map(conversation => conversation.tabKey))
    let written: unknown = null

    applyAuthoritativeStoredDockPrune(
      api as any,
      conversations,
      pendingRef,
      ides,
      null,
      1_000,
      layout => { written = layout },
    )

    expect(api.panels.map(panel => panel.id).sort()).toEqual([
      panelId(sameBasename),
      panelId(otherLive),
    ].sort())
    expect(JSON.stringify(written)).not.toContain(storedGhost)
    expect(conversations.filter(conversation => conversation.displayPrimary === 'adhdev')).toHaveLength(2)
  })
})
