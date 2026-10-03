// D3: a stored split layout lost a pane when its session arrived after the
// first one — syncDockviewPanels pruned the not-yet-visible panel, collapsing
// the split, and the collapsed layout was persisted. retainIds keeps it.
import { describe, expect, it, vi } from 'vitest'
import { syncDockviewPanels } from '../../src/components/dashboard/dockviewWorkspaceLayout'

function fakeApi(ids: string[]) {
  const panels = ids.map(id => ({ id, title: id, update: vi.fn(), api: { setTitle: vi.fn() } }))
  return {
    get panels() { return panels },
    activePanel: panels[0],
    getPanel: (id: string) => panels.find(p => p.id === id),
    removePanel: vi.fn((panel: { id: string }) => { panels.splice(panels.findIndex(p => p.id === panel.id), 1) }),
    addPanel: vi.fn((opts: { id: string }) => { panels.push({ id: opts.id, title: opts.id, update: vi.fn(), api: { setTitle: vi.fn() } }) }),
  }
}

const conv = (tabKey: string) => ({ tabKey, title: tabKey, agentName: tabKey }) as any

describe('syncDockviewPanels retainIds', () => {
  it('keeps a stored panel whose conversation has not arrived yet', () => {
    const api = fakeApi(['a', 'b'])
    syncDockviewPanels(api as any, [conv('a')], new Set(['b']))
    expect(api.removePanel).not.toHaveBeenCalled()
    expect(api.panels.map(p => p.id)).toEqual(['a', 'b'])
  })

  it('prunes it without retainIds (grace over)', () => {
    const api = fakeApi(['a', 'b'])
    syncDockviewPanels(api as any, [conv('a')])
    expect(api.panels.map(p => p.id)).toEqual(['a'])
  })

  it('reuses the retained panel in place when the conversation arrives', () => {
    const api = fakeApi(['a', 'b'])
    syncDockviewPanels(api as any, [conv('a'), conv('b')], new Set(['b']))
    expect(api.addPanel).not.toHaveBeenCalled()
    expect(api.panels.map(p => p.id)).toEqual(['a', 'b'])
  })
})

import { pendingStoredPanelsAfterRestore, STORED_PANEL_ARRIVAL_GRACE_MS, takeRetainedStoredPanelIds } from '../../src/components/dashboard/dashboardDockviewHydration'

describe('stored panel arrival grace', () => {
  const isRemote = (id: string) => id.startsWith('remote:')
  it('tracks only conversation panels that are not visible yet', () => {
    const pending = pendingStoredPanelsAfterRestore(['a', 'b', 'remote:x'], ['a'], isRemote, 1000)
    expect([...pending!.ids]).toEqual(['b'])
    expect(pending!.deadline).toBe(1000 + STORED_PANEL_ARRIVAL_GRACE_MS)
    expect(pendingStoredPanelsAfterRestore(['a'], ['a'], isRemote)).toBeNull()
  })
  it('releases arrived panels, then everything at the deadline', () => {
    const ref = { current: pendingStoredPanelsAfterRestore(['a', 'b', 'c'], [], isRemote, 0) }
    expect([...takeRetainedStoredPanelIds(ref, ['a'], 10)!]).toEqual(['b', 'c'])
    expect(takeRetainedStoredPanelIds(ref, ['a'], STORED_PANEL_ARRIVAL_GRACE_MS)).toBeNull()
    expect(ref.current).toBeNull()
  })
  it('clears once every stored panel has arrived', () => {
    const ref = { current: pendingStoredPanelsAfterRestore(['a', 'b'], ['a'], isRemote, 0) }
    expect(takeRetainedStoredPanelIds(ref, ['a', 'b'], 1)).toBeNull()
    expect(ref.current).toBeNull()
  })
})
