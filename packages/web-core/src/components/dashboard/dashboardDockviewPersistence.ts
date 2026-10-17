import type { SerializedDockview } from 'dockview'
import type { DashboardStoredDockviewLayout } from '../../utils/dashboardLayoutStorage'
import { isRemotePanelId } from './dockviewWorkspaceHelpers'

type GridNode = SerializedDockview['grid']['root']
type GroupState = NonNullable<SerializedDockview['floatingGroups']>[number]['data']

/** Serialize only live panels without disturbing unresolved panels' arrival
 * grace or split positions in the running dock. All group references must agree
 * with the filtered panel map so fromJSON can restore the saved layout. */
export function buildPersistableDashboardDockviewLayout(
  layout: SerializedDockview,
  activeTabId: string | null,
  visibleTabKeys: readonly string[],
): DashboardStoredDockviewLayout {
  const visible = new Set(visibleTabKeys)
  const panels = Object.fromEntries(Object.entries(layout.panels)
    .filter(([id]) => visible.has(id) || isRemotePanelId(id)))
  const allowed = new Set(Object.keys(panels))
  const groups = new Map<string, GroupState>()
  const filterGroup = (group: GroupState): GroupState | null => {
    const views = group.views.filter(id => allowed.has(id))
    if (!views.length) return null
    const filtered = { ...group, views, activeView: views.includes(group.activeView) ? group.activeView : views[0] }
    groups.set(group.id, filtered)
    return filtered
  }
  const filterNode = (node: GridNode): GridNode | null => {
    if (Array.isArray(node.data)) {
      const data = node.data.flatMap(child => {
        const filtered = filterNode(child)
        return filtered ? [filtered] : []
      })
      return data.length ? { ...node, data } : null
    }
    const data = filterGroup(node.data)
    return data ? { ...node, data } : null
  }
  const filterDetached = <T extends { data: GroupState }>(entries: T[] | undefined): T[] | undefined =>
    entries?.flatMap(entry => {
      const data = filterGroup(entry.data)
      return data ? [{ ...entry, data }] : []
    })

  const grid = { ...layout.grid, root: filterNode(layout.grid.root) ?? { type: 'branch' as const, data: [] } }
  // Dockview includes this location-based field at runtime. Filtering changes
  // grid indices, so a saved maximized path may point at a removed group.
  if (allowed.size !== Object.keys(layout.panels).length) {
    delete (grid as typeof grid & { maximizedNode?: unknown }).maximizedNode
  }
  const floatingGroups = filterDetached(layout.floatingGroups)
  const popoutGroups = filterDetached(layout.popoutGroups)?.map(group => ({
    ...group,
    gridReferenceGroup: groups.has(group.gridReferenceGroup) ? group.gridReferenceGroup : undefined,
  }))
  const activeGroup = groups.has(layout.activeGroup) ? layout.activeGroup : groups.keys().next().value
  return {
    activeTabId: activeTabId && allowed.has(activeTabId)
      ? activeTabId
      : groups.get(activeGroup)?.activeView ?? null,
    layout: {
      ...layout,
      panels,
      grid,
      activeGroup,
      floatingGroups,
      popoutGroups,
    },
  }
}
