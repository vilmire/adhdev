/**
 * Dockview popout windows (tabs torn off into a separate browser window): carrying
 * the dashboard theme into the popout document, keeping it in sync as the theme
 * changes, and the ADHDev header chrome (title, meta line, Dashboard / Dock buttons)
 * rendered into every open popout. Pure DOM work over the Dockview API — the
 * workspace component only decides when to call it.
 */
import type { DockviewApi } from 'dockview'
import type { ActiveConversation } from './types'
import { getPreferredConversationForIde } from './conversation-sort'
import { getConversationTabMetaText, getConversationTitle, getRemotePanelTitle } from './conversation-presenters'
import { applyDockviewThemeClass, escapeHtml, isRemotePanelId } from './dockviewWorkspaceHelpers'
import type { DashboardDockviewRemotePanelParams } from './dockviewWorkspaceLayout'

type DockviewTheme = Parameters<typeof applyDockviewThemeClass>[1]

/** Copy the parent document's stylesheets, root CSS variables and theme onto a freshly opened popout. */
export function injectDockviewThemeIntoPopout(popoutWindow: Window, theme: DockviewTheme): void {
    const parentDoc = document
    const popoutDoc = popoutWindow.document

    for (const link of parentDoc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
        const clone = popoutDoc.createElement('link')
        clone.rel = 'stylesheet'
        clone.href = link.href
        if (link.crossOrigin) clone.crossOrigin = link.crossOrigin
        popoutDoc.head.appendChild(clone)
    }

    for (const style of parentDoc.querySelectorAll<HTMLStyleElement>('style')) {
        const clone = popoutDoc.createElement('style')
        clone.textContent = style.textContent
        popoutDoc.head.appendChild(clone)
    }

    const cssVars: string[] = []
    for (const sheet of parentDoc.styleSheets) {
        try {
            for (const rule of sheet.cssRules) {
                if (rule instanceof CSSStyleRule && (rule.selectorText === ':root' || rule.selectorText === 'html')) {
                    cssVars.push(rule.cssText)
                }
            }
        } catch { /* cross-origin sheet, skip */ }
    }
    if (cssVars.length > 0) {
        const varStyle = popoutDoc.createElement('style')
        varStyle.textContent = cssVars.join('\n')
        popoutDoc.head.appendChild(varStyle)
    }

    const htmlTheme = parentDoc.documentElement.getAttribute('data-theme')
    if (htmlTheme) popoutDoc.documentElement.setAttribute('data-theme', htmlTheme)
    popoutDoc.documentElement.style.colorScheme = htmlTheme === 'light' ? 'light' : 'dark'
    popoutDoc.body.className = parentDoc.body.className

    const inlineRootStyle = parentDoc.documentElement.getAttribute('style')
    if (inlineRootStyle) popoutDoc.documentElement.setAttribute('style', inlineRootStyle)

    const mount = popoutDoc.getElementById('dv-popout-window')
    if (mount instanceof HTMLElement) {
        mount.classList.add('adhdev-dockview')
        applyDockviewThemeClass(mount, theme)
    }
}

/** Re-apply the current theme to every open popout document. */
export function syncDockviewThemeToPopouts(api: DockviewApi, theme: DockviewTheme): void {
    for (const group of api.groups) {
        try {
            const ownerDoc = group.element?.ownerDocument
            if (!ownerDoc || ownerDoc === document) continue
            const mount = ownerDoc.getElementById('dv-popout-window')
            if (mount instanceof HTMLElement) {
                mount.classList.add('adhdev-dockview')
                applyDockviewThemeClass(mount, theme)
            }
            const htmlTheme = document.documentElement.getAttribute('data-theme')
            if (htmlTheme) ownerDoc.documentElement.setAttribute('data-theme', htmlTheme)
            ownerDoc.documentElement.style.colorScheme = htmlTheme === 'light' ? 'light' : 'dark'
            ownerDoc.body.className = document.body.className
            const inlineRootStyle = document.documentElement.getAttribute('style')
            if (inlineRootStyle) ownerDoc.documentElement.setAttribute('style', inlineRootStyle)
            else ownerDoc.documentElement.removeAttribute('style')
        } catch {
            // ignore detached popout docs
        }
    }
}

/**
 * (Re)render the ADHDev header into every open popout: its active panel's title and
 * meta line, plus Dashboard (focus the main window) and Dock (move the panel back).
 */
export function renderDockviewPopoutChrome(
    api: DockviewApi,
    conversationsByTabKey: ReadonlyMap<string, ActiveConversation>,
    moveTabBackToMain: (tabKey: string) => void,
): void {

    for (const group of api.groups) {
        const ownerDoc = group.element?.ownerDocument
        if (!ownerDoc || ownerDoc === document) continue

        const mount = ownerDoc.getElementById('dv-popout-window')
        if (!(mount instanceof HTMLElement)) continue

        let activePanelId: string | null = null
        let title = ownerDoc.title || 'ADHDev'
        let meta = 'Popout workspace'

        const activePanel = group.activePanel
        if (activePanel) {
            activePanelId = activePanel.id
            if (isRemotePanelId(activePanel.id)) {
                const routeId = (activePanel.params as DashboardDockviewRemotePanelParams | undefined)?.routeId || activePanel.id.slice('remote:'.length)
                const conversation = getPreferredConversationForIde([...conversationsByTabKey.values()], routeId)
                title = getRemotePanelTitle(conversation)
                meta = conversation?.machineName ? `Remote view · ${conversation.machineName}` : 'Remote view'
            } else {
                const conversation = conversationsByTabKey.get(activePanel.id)
                title = conversation ? getConversationTitle(conversation) : (activePanel.title || activePanel.id)
                meta = conversation ? getConversationTabMetaText(conversation) : 'Dockview panel'
            }
        }

        ownerDoc.title = `${title} — ADHDev`

        const existingHeaders = Array.from(ownerDoc.querySelectorAll<HTMLElement>('#adhdev-popout-header'))
        for (const existingHeader of existingHeaders) existingHeader.remove()
        const header = ownerDoc.createElement('div')
        header.id = 'adhdev-popout-header'
        ownerDoc.body.appendChild(header)

        header.setAttribute('style', [
            'position:absolute',
            'top:0',
            'left:0',
            'right:0',
            'height:52px',
            'display:flex',
            'align-items:center',
            'justify-content:space-between',
            'gap:12px',
            'padding:0 14px',
            'box-sizing:border-box',
            'background:var(--surface-secondary)',
            'border-bottom:1px solid var(--border-subtle)',
            'z-index:5',
            'backdrop-filter:blur(14px)',
        ].join(';'))

        header.innerHTML = `
            <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
                <div style="font-size:10px;line-height:1;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;">ADHDev</div>
                <div style="min-width:0;font-size:13px;font-weight:700;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(title)}</div>
                <div style="min-width:0;font-size:10px;line-height:1.1;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(meta)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
                <button type="button" data-adhdev-popout-focus style="height:30px;padding:0 10px;border-radius:9px;background:var(--bg-glass);color:var(--text-secondary);font-size:11px;font-weight:600;">Dashboard</button>
                <button type="button" data-adhdev-popout-dock style="height:30px;padding:0 10px;border-radius:9px;background:var(--surface-primary);color:var(--text-primary);font-size:11px;font-weight:700;">Dock</button>
            </div>
        `

        mount.style.top = '52px'
        mount.style.height = 'calc(100% - 52px)'

        const focusBtn = header.querySelector<HTMLButtonElement>('[data-adhdev-popout-focus]')
        if (focusBtn) {
            focusBtn.onclick = () => {
                window.focus()
            }
        }

        const dockBtn = header.querySelector<HTMLButtonElement>('[data-adhdev-popout-dock]')
        if (dockBtn) {
            dockBtn.disabled = !activePanelId
            dockBtn.style.opacity = activePanelId ? '1' : '0.5'
            dockBtn.style.cursor = activePanelId ? 'pointer' : 'default'
            dockBtn.onclick = () => {
                if (activePanelId) moveTabBackToMain(activePanelId)
                ownerDoc.defaultView?.focus()
            }
        }
    }
}
