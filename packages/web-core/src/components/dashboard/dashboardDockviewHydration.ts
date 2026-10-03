import type { DaemonData } from '../../types'

export interface StoredDockviewHydrationOptions {
  hasStoredLayout: boolean
  initialDataLoaded: boolean
  visibleConversationCount: number
  ides: DaemonData[]
}

export interface DockviewPanelPruneDeferralOptions {
  previousVisibleConversationCount: number
  visibleConversationCount: number
  ides: DaemonData[]
}

export function hasAuthoritativeDockviewHydrationData(ides: DaemonData[]) {
  return ides.some((entry) => entry.type !== 'adhdev-daemon')
    || ides.some((entry) => entry.type === 'adhdev-daemon' && !!entry.machine)
}

export function shouldAwaitStoredDockviewHydration({
  hasStoredLayout,
  initialDataLoaded,
  visibleConversationCount,
  ides,
}: StoredDockviewHydrationOptions) {
  if (!hasStoredLayout) return false
  if (visibleConversationCount > 0) return false
  if (!initialDataLoaded) return true
  return !hasAuthoritativeDockviewHydrationData(ides)
}

export function shouldDeferDockviewPanelPrune({
  previousVisibleConversationCount,
  visibleConversationCount,
  ides,
}: DockviewPanelPruneDeferralOptions) {
  if (visibleConversationCount > 0) return false
  if (previousVisibleConversationCount <= 0) return false
  return hasAuthoritativeDockviewHydrationData(ides)
}

// How long a stored-layout panel waits for its conversation (a second daemon or
// a restored session can land seconds after the first) before it is pruned.
export const STORED_PANEL_ARRIVAL_GRACE_MS = 20_000

/** Stored-layout panels whose conversation hadn't arrived at hydration. */
export interface PendingStoredPanels { ids: Set<string>; deadline: number }

export function pendingStoredPanelsAfterRestore(
  restoredPanelIds: string[],
  visibleTabKeys: string[],
  isRemotePanelId: (id: string) => boolean,
  now = Date.now(),
): PendingStoredPanels | null {
  const visible = new Set(visibleTabKeys)
  const missing = restoredPanelIds.filter(id => !isRemotePanelId(id) && !visible.has(id))
  return missing.length > 0 ? { ids: new Set(missing), deadline: now + STORED_PANEL_ARRIVAL_GRACE_MS } : null
}

/**
 * Panels to keep in place this sync (syncDockviewPanels retainIds). Arrived
 * conversations leave the set; once it is empty or the grace is over the ref is
 * cleared and pruning resumes.
 */
export function takeRetainedStoredPanelIds(
  ref: { current: PendingStoredPanels | null },
  visibleTabKeys: string[],
  now = Date.now(),
): Set<string> | null {
  const pending = ref.current
  if (!pending) return null
  for (const key of visibleTabKeys) pending.ids.delete(key)
  if (pending.ids.size === 0 || now >= pending.deadline) {
    ref.current = null
    return null
  }
  return pending.ids
}
