import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard group/layout boundary cleanup', () => {
  it('does not keep raw group layout setters threaded through page-effects and pane workspace props once hook actions own the updates', () => {
    const pageEffects = readSource('hooks/useDashboardPageEffects.ts')
    const mainView = readSource('components/dashboard/DashboardMainView.tsx')
    const paneWorkspace = readSource('components/dashboard/DashboardPaneWorkspace.tsx')

    expect(pageEffects).not.toContain('setGroupActiveTabIds:')
    expect(pageEffects).not.toContain('setFocusedGroup:')

    expect(mainView).not.toContain('setFocusedGroup:')
    expect(mainView).not.toContain('setGroupActiveTabIds:')
    expect(mainView).not.toContain('setGroupTabOrders:')
    expect(mainView).not.toContain('setFocusedGroup={')
    expect(mainView).not.toContain('setGroupActiveTabIds={')
    expect(mainView).not.toContain('setGroupTabOrders={')

    expect(paneWorkspace).not.toContain('setFocusedGroup:')
    expect(paneWorkspace).not.toContain('setGroupActiveTabIds:')
    expect(paneWorkspace).not.toContain('setGroupTabOrders:')
    expect(paneWorkspace).not.toContain('setFocusedGroup(')
    expect(paneWorkspace).not.toContain('setGroupActiveTabIds(')
    expect(paneWorkspace).not.toContain('setGroupTabOrders(')
  })

  it('reuses the root layout profile instead of recomputing it inside dockview workspace', () => {
    const groupState = readSource('hooks/useDashboardGroupState.ts')
    const dockviewWorkspace = readSource('components/dashboard/DashboardDockviewWorkspace.tsx')

    expect(groupState).toContain('layoutProfile')
    expect(dockviewWorkspace).not.toContain('getDashboardLayoutProfile(')
  })
})
