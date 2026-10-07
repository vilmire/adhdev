import type { DockviewApi } from 'dockview'
import type { ActiveConversation } from './types'
import { getPreferredConversationForIde } from './conversation-sort'
import { getRemotePanelTitle } from './conversation-presenters'
import { getDockviewTitle, getRemotePanelId, isRemotePanelId } from './dockviewWorkspaceHelpers'
import type { DashboardStoredHiddenTabLocation } from '../../utils/dashboardLayoutStorage'
import { takeAssistantTabsToPin, type AssistantTabPinState } from './assistant-session'

export interface DashboardDockviewPanelParams {
    kind: 'conversation'
    tabKey: string
}

export interface DashboardDockviewRemotePanelParams {
    kind: 'remote'
    routeId: string
}

/**
 * Move each fresh assistant panel to the first tab of its group, once
 * (`takeAssistantTabsToPin`) — when it is identified, which in the cloud can be
 * after the panel was added at the end of the group. Keeps the panel's active
 * state; never empties a group (a lone panel is already first).
 */
export function pinAssistantPanels(api: DockviewApi, visibleConversations: ActiveConversation[], pins?: AssistantTabPinState | null) {
    if (!pins) return
    for (const tabKey of takeAssistantTabsToPin(visibleConversations, pins)) {
        const panel = api.getPanel(tabKey)
        if (!panel || panel.group.panels.indexOf(panel) <= 0) continue
        const wasActive = panel.group.activePanel?.id === panel.id
        panel.api.moveTo({ group: panel.group, position: 'center', index: 0, skipSetActive: true })
        if (wasActive) panel.api.setActive()
    }
}

export function buildInitialDockviewLayout(
    api: DockviewApi,
    visibleConversations: ActiveConversation[],
    requestedActiveTabKey?: string | null,
    assistantPins?: AssistantTabPinState | null,
): string | null {
    const groups = [visibleConversations]
    let previousGroupAnchorId: string | undefined

    for (const group of groups) {
        let groupAnchorId: string | undefined
        for (const conversation of group) {
            const panel = api.addPanel<DashboardDockviewPanelParams>({
                id: conversation.tabKey,
                component: 'conversation',
                title: getDockviewTitle(conversation),
                params: { kind: 'conversation', tabKey: conversation.tabKey },
                ...(groupAnchorId
                    ? { position: { referencePanel: groupAnchorId, direction: 'within' as const }, inactive: true }
                    : previousGroupAnchorId
                        ? { position: { referencePanel: previousGroupAnchorId, direction: 'right' as const }, inactive: true }
                        : {}),
            })
            if (!groupAnchorId) groupAnchorId = panel.id
            assistantPins?.fresh.add(panel.id)
        }
        previousGroupAnchorId = groupAnchorId ?? previousGroupAnchorId
    }
    pinAssistantPanels(api, visibleConversations, assistantPins)

    const preferredActiveTabKey = requestedActiveTabKey
        ?? visibleConversations[0]?.tabKey
        ?? null
    return preferredActiveTabKey
}

/**
 * `retainIds`: panels restored from the stored layout whose conversation has not
 * arrived yet. Removing them collapses the split they sit in — and the collapsed
 * layout is then persisted — so a session that shows up a moment later lands as
 * a tab instead of back in its pane.
 */
export function syncDockviewPanels(
    api: DockviewApi,
    visibleConversations: ActiveConversation[],
    retainIds?: ReadonlySet<string> | null,
    assistantPins?: AssistantTabPinState | null,
) {
    const visibleKeys = new Set(visibleConversations.map(conversation => conversation.tabKey))
    const tabKeyCounts = new Map<string, number>()
    for (const conversation of visibleConversations) {
        tabKeyCounts.set(conversation.tabKey, (tabKeyCounts.get(conversation.tabKey) || 0) + 1)
    }

    for (const panel of [...api.panels]) {
        if (isRemotePanelId(panel.id)) continue
        if (!visibleKeys.has(panel.id) && !retainIds?.has(panel.id)) api.removePanel(panel)
    }

    for (const conversation of visibleConversations) {
        const existing = api.getPanel(conversation.tabKey)
        if (existing) {
            if ((tabKeyCounts.get(conversation.tabKey) || 0) > 1) {
                console.warn('[dashboard-conversations] Dockview panel already exists for duplicate tabKey', {
                    tabKey: conversation.tabKey,
                    daemonId: conversation.daemonId,
                    sessionId: conversation.sessionId,
                    providerSessionId: conversation.providerSessionId,
                    panelId: existing.id,
                })
            }
            existing.update({ params: { tabKey: conversation.tabKey } })
            if (existing.title !== getDockviewTitle(conversation)) {
                existing.api.setTitle(getDockviewTitle(conversation))
            }
            continue
        }

        api.addPanel<DashboardDockviewPanelParams>({
            id: conversation.tabKey,
            component: 'conversation',
            title: getDockviewTitle(conversation),
            params: { kind: 'conversation', tabKey: conversation.tabKey },
            ...(api.activePanel
                ? { position: { referencePanel: api.activePanel.id, direction: 'within' as const }, inactive: true }
                : api.panels[0]
                    ? { position: { referencePanel: api.panels[0].id, direction: 'within' as const }, inactive: true }
                    : {}),
        })
        assistantPins?.fresh.add(conversation.tabKey)
    }
    pinAssistantPanels(api, visibleConversations, assistantPins)
}

export function syncRemotePanels(
    api: DockviewApi,
    visibleConversations: ActiveConversation[],
    requestedRemoteIdeId?: string | null,
) {
    const desiredPanelId = requestedRemoteIdeId ? getRemotePanelId(requestedRemoteIdeId) : null

    for (const panel of [...api.panels]) {
        if (!isRemotePanelId(panel.id)) continue
        if (!desiredPanelId || panel.id !== desiredPanelId) {
            api.removePanel(panel)
        }
    }

    if (!requestedRemoteIdeId || !desiredPanelId) return

    const preferredConversation = getPreferredConversationForIde(visibleConversations, requestedRemoteIdeId)
    if (!preferredConversation && api.totalPanels === 0) return

    const existing = api.getPanel(desiredPanelId)
    const nextTitle = getRemotePanelTitle(preferredConversation)

    if (existing) {
        if (existing.title !== nextTitle) {
            existing.api.setTitle(nextTitle)
        }
        return
    }

    const referencePanelId = preferredConversation?.tabKey
        ?? api.activePanel?.id
        ?? api.panels.find(panel => !isRemotePanelId(panel.id))?.id

    api.addPanel<DashboardDockviewRemotePanelParams>({
        id: desiredPanelId,
        component: 'remote',
        title: nextTitle,
        params: { kind: 'remote', routeId: requestedRemoteIdeId },
        ...(referencePanelId
            ? { position: { referencePanel: referencePanelId, direction: 'right' as const }, inactive: true }
            : {}),
    })
}

/**
 * Where a tab currently lives in the serialized layout — a floating group (with its
 * position) or a popout — so hiding it can later restore it there. Grid otherwise.
 */
export function readHiddenTabLocationFromLayout(api: DockviewApi, tabKey: string): DashboardStoredHiddenTabLocation {

    const serialized = api.toJSON() as {
        floatingGroups?: Array<{
            data?: { views?: string[] }
            position?: {
                left?: number
                right?: number
                top?: number
                bottom?: number
                width: number
                height: number
            }
        }>
        popoutGroups?: Array<{
            data?: { views?: string[] }
            position?: { left: number, top: number, width: number, height: number }
            url?: string
        }>
    }

    for (const group of serialized.floatingGroups || []) {
        if (group.data?.views?.includes(tabKey) && group.position) {
            return { kind: 'floating', position: group.position }
        }
    }

    for (const group of serialized.popoutGroups || []) {
        if (group.data?.views?.includes(tabKey)) {
            return {
                kind: 'popout',
                position: group.position,
                popoutUrl: group.url,
            }
        }
    }

    return { kind: 'grid' }
}
