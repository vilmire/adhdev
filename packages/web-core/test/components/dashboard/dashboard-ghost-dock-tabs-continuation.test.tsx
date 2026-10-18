// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockviewApi, SerializedDockview } from 'dockview'
import DashboardDockviewWorkspace from '../../../src/components/dashboard/DashboardDockviewWorkspace'
import { buildConversations } from '../../../src/components/dashboard/buildConversations'
import { statusPayloadToEntries } from '../../../src/utils/status-transform'
import { reconcileIdes } from '../../../src/context/ides-reconcile'
import { buildPersistableDashboardDockviewLayout } from '../../../src/components/dashboard/dashboardDockviewPersistence'
import { readDashboardDockviewStoredLayout, writeDashboardDockviewStoredLayout } from '../../../src/utils/dashboardLayoutStorage'

const dock = vi.hoisted(() => ({ api: null as DockviewApi | null }))

// Keep the real dock engine and serialization; omit transcript rendering and
// transport so these regressions exercise workspace hydration and persistence.
vi.mock('dockview', async importOriginal => {
  const actual = await importOriginal<typeof import('dockview')>()
  return {
    ...actual,
    DockviewReact: (props: React.ComponentProps<typeof actual.DockviewReact>) => (
      <actual.DockviewReact
        {...props}
        components={{ conversation: () => null, remote: () => null }}
        defaultTabComponent={() => null}
        watermarkComponent={() => null}
        onReady={event => { dock.api = event.api; props.onReady?.(event) }}
      />
    ),
  }
})
vi.mock('../../../src/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }))
vi.mock('../../../src/context/TransportContext', () => ({
  useTransport: () => ({ sendCommand: vi.fn().mockResolvedValue({}) }),
}))

const PROFILE = 'desktop-narrow'
const machine = { hostname: 'probe', platform: 'darwin', arch: 'arm64', cpus: 8, totalMem: 16, uptime: 1 }
const cli = (id: string) => ({
  id, kind: 'agent' as const, transport: 'pty' as const, providerType: 'claude-cli',
  status: 'idle' as const, workspace: '/probe/adhdev',
})
function metadata(daemonId: string, sessions?: ReturnType<typeof cli>[]) {
  return statusPayloadToEntries({ machine, timestamp: Date.now(), ...(sessions === undefined ? {} : { sessions }) }, { daemonId })
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  dock.api = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(ides: ReturnType<typeof metadata>) {
  const visibleConversations = buildConversations(ides.filter(entry => entry.type !== 'adhdev-daemon'), ides)
  await act(async () => root.render(
    <DashboardDockviewWorkspace
      visibleConversations={visibleConversations}
      ides={ides}
      layoutProfile={PROFILE}
      initialDataLoaded
      hasRegisteredMachines
      isStandalone={false}
      clearedTabs={{}}
      actionLogs={{}}
      sendDaemonCommand={vi.fn()}
      setActionLogs={vi.fn()}
      toggleHiddenTab={vi.fn()}
      onActiveTabChange={vi.fn()}
      liveSessionInboxState={new Map()}
    />,
  ))
}

describe('ghost dock review regressions through the workspace', () => {
  it('immediately saves an empty authoritative list after a previously visible session', async () => {
    const initial = metadata('a', [cli('old')])
    await render(initial)
    // Dockview's onReady runs after the first parent layout effect. Settle a
    // visible render before the empty metadata update reaches that effect.
    await render(initial)
    expect(dock.api!.getPanel('a:cli:old')).toBeDefined()
    writeDashboardDockviewStoredLayout(PROFILE, { activeTabId: 'a:cli:old', layout: dock.api!.toJSON() })

    await render(metadata('a', []))

    expect(dock.api!.panels.map(panel => panel.id)).not.toContain('a:cli:old')
    const saved = readDashboardDockviewStoredLayout(PROFILE)!
    expect(saved.layout.panels).toEqual({})
    expect(saved.activeTabId).toBeNull()
  })

  it('preserves live panels when reconnect metadata omits the sessions field', async () => {
    const initial = metadata('a', [cli('live')])
    await render(initial)
    const sparse = metadata('a')
    expect(sparse[0]._sessionListAuthoritative).toBe(false)
    const reconciled = reconcileIdes(sparse, initial, { authoritativeDaemonIds: ['a'] })
    await render(reconciled)
    expect(dock.api!.getPanel('a:cli:live')).toBeDefined()

    // Even a transient zero-conversation view without an explicit list keeps
    // the reconnect deferral; omission is not an authoritative empty list.
    await render(sparse)
    expect(dock.api!.getPanel('a:cli:live')).toBeDefined()
  })

  it('saves A\'s prune without saving B\'s unresolved title or removing B\'s live split', async () => {
    await render([...metadata('a', [cli('ghost')]), ...metadata('b', [cli('waiting')])])
    act(() => {
      const b = dock.api!.getPanel('b:cli:waiting')!
      b.api.moveTo({ position: 'right' })
      b.api.setTitle('Unresolved stored title')
    })
    writeDashboardDockviewStoredLayout(PROFILE, { activeTabId: 'b:cli:waiting', layout: dock.api!.toJSON() })
    await act(async () => root.unmount())
    root = createRoot(container)
    await render([...metadata('a', [cli('live')]), ...metadata('b')])

    expect(dock.api!.getPanel('a:cli:ghost')).toBeUndefined()
    const waiting = dock.api!.getPanel('b:cli:waiting')!
    expect(waiting).toBeDefined()
    const waitingGroup = waiting.group.id
    const saved = readDashboardDockviewStoredLayout(PROFILE)!
    expect(Object.keys(saved.layout.panels)).toEqual(['a:cli:live'])
    expect(JSON.stringify(saved)).not.toContain('Unresolved stored title')
    expect(JSON.stringify(saved)).not.toContain('b:cli:waiting')
    expect(saved.activeTabId).toBe('a:cli:live')

    await render([...metadata('a', [cli('live')]), ...metadata('b', [cli('waiting')])])
    expect(dock.api!.getPanel('b:cli:waiting')!.group.id).toBe(waitingGroup)

    // The persisted copy must also be a valid Dockview restore, not merely a
    // panel map with dangling group views removed from it.
    await act(async () => dock.api!.fromJSON(saved.layout))
    expect(dock.api!.panels.map(panel => panel.id)).toEqual(['a:cli:live'])
  })

  it('prunes only the reported daemon during an empty reconnect view', async () => {
    const initial = [...metadata('a', [cli('old')]), ...metadata('b', [cli('live')])]
    await render(initial)
    await render(initial)
    await render([...metadata('a', []), ...metadata('b')])

    expect(dock.api!.panels.map(panel => panel.id)).toEqual(['b:cli:live'])
    const saved = readDashboardDockviewStoredLayout(PROFILE)!
    expect(saved.layout.panels).toEqual({})
    expect(saved.activeTabId).toBeNull()
  })

  it('filters nested, floating and popout references without mutating the running layout', async () => {
    await render(metadata('a', [cli('live')]))
    const base = dock.api!.toJSON()
    const group = (id: string, views: string[]) => ({ id, views, activeView: views[0] })
    const ghost = 'b:cli:waiting'
    const live = 'a:cli:live'
    const remote = 'remote:machine'
    const position = { left: 10, top: 20, width: 300, height: 200 }
    const layout: SerializedDockview = {
      ...base,
      panels: { ...base.panels, [ghost]: { id: ghost, contentComponent: 'conversation', title: 'Ghost' },
        [remote]: { id: remote, contentComponent: 'remote' } },
      grid: { ...base.grid, root: { type: 'branch', data: [
        { type: 'leaf', data: group('empty', [ghost]) },
        { type: 'branch', size: 500, data: [{ type: 'leaf', size: 200, data: group('live', [ghost, live]) }] },
      ] } },
      activeGroup: 'empty',
      floatingGroups: [
        { data: group('empty-float', [ghost]), position },
        { data: group('remote', [ghost, remote]), position },
      ],
      popoutGroups: [
        { data: group('empty-popout', [ghost]), position },
      ],
    }
    Object.assign(layout.grid, { maximizedNode: { location: [0] } })
    const before = JSON.stringify(layout)
    const saved = buildPersistableDashboardDockviewLayout(layout, ghost, [live])

    expect(JSON.stringify(layout)).toBe(before)
    expect(JSON.stringify(saved)).not.toContain(ghost)
    expect(saved.activeTabId).toBe(live)
    expect(saved.layout.activeGroup).toBe('live')
    expect(saved.layout.grid).not.toHaveProperty('maximizedNode')
    expect(saved.layout.floatingGroups).toEqual([{ data: group('remote', [remote]), position }])
    expect(saved.layout.popoutGroups).toEqual([])
    await act(async () => dock.api!.fromJSON(saved.layout))
    expect(dock.api!.panels.map(panel => panel.id).sort()).toEqual([live, remote].sort())
  })
})
