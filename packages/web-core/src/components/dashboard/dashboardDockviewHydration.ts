import type { DaemonData } from '../../types'

export interface StoredDockviewHydrationOptions {
  hasStoredLayout: boolean
  initialDataLoaded: boolean
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
