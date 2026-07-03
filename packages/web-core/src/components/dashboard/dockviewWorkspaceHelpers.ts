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
