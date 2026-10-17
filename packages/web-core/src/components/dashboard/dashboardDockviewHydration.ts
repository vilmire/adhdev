import type { DockviewApi } from 'dockview'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import type { AssistantTabPinState } from './assistant-session'
import { syncDockviewPanels } from './dockviewWorkspaceLayout'

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

const CLI_PANEL_MARKER = ':cli:'

/** `daemonId:cli:sessionId` → parts. Remote and IDE panels return null. */
export function cliPanelIdentity(panelId: string): { daemonId: string; sessionId: string } | null {
  const index = panelId.indexOf(CLI_PANEL_MARKER)
  if (index <= 0) return null
  const sessionId = panelId.slice(index + CLI_PANEL_MARKER.length)
  if (!sessionId) return null
  return { daemonId: panelId.slice(0, index), sessionId }
}

/**
 * Daemons whose metadata carried an explicit sessions array
 * (`_sessionListAuthoritative`), mapped to the live :cli: session ids in that
 * list. An empty set means the daemon reported no CLI sessions.
 */
export function authoritativeCliSessionsByDaemon(ides: readonly DaemonData[]): Map<string, Set<string>> {
  const live = new Map<string, Set<string>>()
  for (const entry of ides) {
    if (entry.type === 'adhdev-daemon' && entry._sessionListAuthoritative && entry.id) {
      live.set(entry.id, new Set())
    }
  }
  for (const entry of ides) {
    if (!entry.daemonId || entry.type === 'adhdev-daemon' || !live.has(entry.daemonId)) continue
    const parsed = cliPanelIdentity(entry.id)
    if (!parsed || parsed.daemonId !== entry.daemonId) continue
    live.get(entry.daemonId)!.add(entry.sessionId || parsed.sessionId)
  }
  return live
}

/**
 * Stored :cli: panels that must not survive this sync. Once a daemon's session
 * list is authoritative, a panel whose session is absent — or that has no
 * visible conversation (surfaceHidden belongs to spawnedSessionVisibility) —
 * is not held for the arrival grace.
 */
export function storedCliPanelsToDrop(
  panelIds: readonly string[],
  visibleTabKeys: readonly string[],
  ides: readonly DaemonData[],
): Set<string> {
  const liveByDaemon = authoritativeCliSessionsByDaemon(ides)
  const visible = new Set(visibleTabKeys)
  const drop = new Set<string>()
  for (const panelId of panelIds) {
    if (visible.has(panelId)) continue
    const parsed = cliPanelIdentity(panelId)
    if (!parsed) continue
    const sessions = liveByDaemon.get(parsed.daemonId)
    if (!sessions) continue
    // Absent from this daemon's session list: stale restore. Present but not
    // visible: spawnedSessionVisibility hid it, so it is not a dock tab.
    if (!sessions.has(parsed.sessionId) || !visible.has(panelId)) drop.add(panelId)
  }
  return drop
}

/** True when the dock still holds a panel with no live conversation. Those
 * placeholders must not be written back to localStorage. */
export function dockLayoutContainsUnresolvedStoredPanel(
  panelIds: readonly string[],
  visibleTabKeys: readonly string[],
  isRemotePanelId: (id: string) => boolean,
): boolean {
  const visible = new Set(visibleTabKeys)
  return panelIds.some(id => !isRemotePanelId(id) && !visible.has(id))
}

/**
 * Sync dock panels for the current conversation list. On the first authoritative
 * session list for a daemon, stored :cli: panels that are not live are removed
 * immediately and the pruned layout is persisted in this same call.
 * Reconnect deferral retains unrelated panels. Returns whether a ghost was removed.
 */
export function applyAuthoritativeStoredDockPrune(
  api: DockviewApi,
  visibleConversations: ActiveConversation[],
  pendingRef: { current: PendingStoredPanels | null },
  ides: DaemonData[],
  assistantPins?: AssistantTabPinState | null,
  now = Date.now(),
  persist?: (layout: unknown) => void,
  deferNonAuthoritativePrune = false,
): boolean {
  const visibleTabKeys = visibleConversations.map(conversation => conversation.tabKey)
  const drop = storedCliPanelsToDrop(api.panels.map(panel => panel.id), visibleTabKeys, ides)
  if (pendingRef.current) {
    for (const id of drop) pendingRef.current.ids.delete(id)
  }
  let retain = takeRetainedStoredPanelIds(pendingRef, visibleTabKeys, now)
  if (retain) {
    for (const id of drop) retain.delete(id)
    if (retain.size === 0) retain = null
  }
  // A transient empty conversation view can defer ordinary pruning, but an
  // explicit authoritative list still removes this daemon's absent panels.
  // Retain other daemons' panels even when they are no longer in the grace ref.
  if (deferNonAuthoritativePrune) {
    retain = new Set(api.panels.map(panel => panel.id).filter(id => !drop.has(id)))
  }
  const before = new Set(api.panels.map(panel => panel.id))
  syncDockviewPanels(api, visibleConversations, retain, assistantPins)
  const removedGhost = [...drop].some(id => before.has(id) && !api.getPanel(id))
  if (removedGhost) persist?.(api.toJSON())
  return removedGhost
}

/**
 * Grace-timeout backstop. The retain ref may already be null (the deadline
 * cleared it, or no later layout effect ran). Still prune stored panels that
 * have no live conversation, and report whether any panel was removed so the
 * caller can persist that layout.
 */
export function releaseStoredDockGrace(
  api: DockviewApi | null,
  pendingRef: { current: PendingStoredPanels | null },
  visibleConversations: ActiveConversation[],
  assistantPins?: AssistantTabPinState | null,
): boolean {
  if (!api) return false
  pendingRef.current = null
  const before = api.panels.map(panel => panel.id)
  syncDockviewPanels(api, visibleConversations, null, assistantPins)
  const after = new Set(api.panels.map(panel => panel.id))
  return before.some(id => !after.has(id))
}
