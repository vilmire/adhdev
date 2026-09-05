export const DEFAULT_VISIBLE_STANDARD_MESSAGES = 60
export const DEFAULT_VISIBLE_CLI_MESSAGES = 50

export function getDefaultVisibleLiveMessages(options: { isCliLike?: boolean } = {}): number {
    return options.isCliLike ? DEFAULT_VISIBLE_CLI_MESSAGES : DEFAULT_VISIBLE_STANDARD_MESSAGES
}

export function getDefaultChatTailHydrateLimit(options: { isCliLike?: boolean } = {}): number {
    return getDefaultVisibleLiveMessages(options)
}

/**
 * (CHAT-TAB-SWITCH-STALE-FALLBACK ②) Per-tab "how many live bubbles are
 * expanded" memory.
 *
 * `visibleLiveCount` is user-expanded state ("Load older" grows it), but it
 * lived in `useState` scoped to a ChatPane instance and was reset to the default
 * whenever `tabKey` changed. Switching away from a tab and back therefore
 * collapsed the window back to the default — the visible range shrinks, then
 * grows again as the user re-expands. That is the other half of the reported
 * "jumpy" feel, independent of the stale-fallback beat.
 *
 * Keyed by tabKey and module-scoped so it survives ChatPane unmount/remount
 * (dockview swaps panels rather than keeping every pane mounted). Bounded: one
 * small integer per tab the user has expanded, cleared alongside the tab.
 */
const visibleLiveCountByTabKey = new Map<string, number>()

export function getRememberedVisibleLiveCount(tabKey: string, fallback: number): number {
    if (!tabKey) return fallback
    const remembered = visibleLiveCountByTabKey.get(tabKey)
    // A remembered value only ever GROWS the window past the default. If the
    // default itself moved (CLI↔standard view-mode flip), take the larger so a
    // remembered count can never shrink the pane below what it would show fresh.
    return typeof remembered === 'number' && remembered > fallback ? remembered : fallback
}

export function rememberVisibleLiveCount(tabKey: string, count: number): void {
    if (!tabKey) return
    visibleLiveCountByTabKey.set(tabKey, count)
}

export function forgetVisibleLiveCount(tabKey: string): void {
    visibleLiveCountByTabKey.delete(tabKey)
}

export function resetVisibleLiveCountMemoryForTest(): void {
    visibleLiveCountByTabKey.clear()
}
