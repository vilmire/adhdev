import { themeDark, themeLight, type DockviewApi } from 'dockview'
import type { ActiveConversation } from './types'
import { getConversationTitle } from './conversation-presenters'

export function getDockviewTitle(conversation: ActiveConversation) {
    return getConversationTitle(conversation) || conversation.tabKey
}

export function getRemotePanelId(routeId: string) {
    return `remote:${routeId}`
}

export function isRemotePanelId(panelId: string) {
    return panelId.startsWith('remote:')
}

export function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export function focusOwnerWindow(ownerDoc: Document | null | undefined) {
    const ownerWindow = ownerDoc?.defaultView
    if (!ownerWindow) return
    const focusWithoutScrolling = (element: HTMLElement | null | undefined) => {
        if (!element) return
        try {
            element.focus({ preventScroll: true })
        } catch {
            try { element.focus() } catch { /* noop */ }
        }
    }
    try {
        ownerWindow.focus()
        focusWithoutScrolling(ownerDoc?.body)
        focusWithoutScrolling(ownerDoc?.documentElement)
        ownerWindow.requestAnimationFrame?.(() => {
            try {
                ownerWindow.focus()
                focusWithoutScrolling(ownerDoc?.body)
            } catch {
                // noop
            }
        })
    } catch {
        // noop
    }
}

export function applyDockviewThemeClass(target: HTMLElement, theme: 'light' | 'dark') {
    target.classList.remove(themeLight.className, themeDark.className)
    target.classList.add(theme === 'light' ? themeLight.className : themeDark.className)
}

export function getDistinctPopoutWindows(api: DockviewApi | null): Array<Window & typeof globalThis> {
    if (!api) return []
    return Array.from(
        new Set(
            api.groups
                .map(group => group.element?.ownerDocument?.defaultView)
                .filter((popup): popup is Window & typeof globalThis => !!popup && popup !== window),
        ),
    )
}

export type DockviewPaneDirection = 'left' | 'right' | 'above' | 'below'

/**
 * The group adjacent to the active one in `direction`, by on-screen geometry:
 * nearest primary-axis gap first, then cross-axis distance, preferring groups that
 * overlap the active group on the cross axis. Undefined when none lies that way.
 */
export function findAdjacentDockviewGroup(api: DockviewApi, direction: DockviewPaneDirection) {
    const activeGroup = api.activeGroup || api.activePanel?.group
    if (!activeGroup) return
    const groups = api.groups || []
    const activeEntry = groups.find(group => group.id === activeGroup.id)
    if (!activeEntry) return

    const activeRect = activeEntry.element.getBoundingClientRect()
    const activeCenterX = activeRect.left + activeRect.width / 2
    const activeCenterY = activeRect.top + activeRect.height / 2

    const getOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
    const getDistanceScore = (candidate: typeof activeEntry) => {
        const rect = candidate.element.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2

        let primaryGap = 0
        let crossAxisDistance = 0
        let overlap = 0
        let isValidDirection = false

        if (direction === 'left') {
            isValidDirection = centerX < activeCenterX
            primaryGap = Math.max(0, activeRect.left - rect.right)
            crossAxisDistance = Math.abs(centerY - activeCenterY)
            overlap = getOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom)
        } else if (direction === 'right') {
            isValidDirection = centerX > activeCenterX
            primaryGap = Math.max(0, rect.left - activeRect.right)
            crossAxisDistance = Math.abs(centerY - activeCenterY)
            overlap = getOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom)
        } else if (direction === 'above') {
            isValidDirection = centerY < activeCenterY
            primaryGap = Math.max(0, activeRect.top - rect.bottom)
            crossAxisDistance = Math.abs(centerX - activeCenterX)
            overlap = getOverlap(activeRect.left, activeRect.right, rect.left, rect.right)
        } else {
            isValidDirection = centerY > activeCenterY
            primaryGap = Math.max(0, rect.top - activeRect.bottom)
            crossAxisDistance = Math.abs(centerX - activeCenterX)
            overlap = getOverlap(activeRect.left, activeRect.right, rect.left, rect.right)
        }

        if (!isValidDirection) return Number.POSITIVE_INFINITY

        const overlapPenalty = overlap > 0 ? 0 : 120
        return (primaryGap * 3) + crossAxisDistance + overlapPenalty
    }

    let bestGroup: typeof activeEntry | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const group of groups) {
        if (group.id === activeEntry.id) continue
        const score = getDistanceScore(group)
        if (!Number.isFinite(score)) continue
        if (score >= bestScore) continue
        bestScore = score
        bestGroup = group
    }

    return bestGroup || undefined
}
