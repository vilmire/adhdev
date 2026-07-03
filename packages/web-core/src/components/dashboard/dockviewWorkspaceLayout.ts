import type { DockviewApi } from 'dockview'
import type { ActiveConversation } from './types'
import { getPreferredConversationForIde } from './conversation-sort'
import { getRemotePanelTitle } from './conversation-presenters'
import { getDockviewTitle, getRemotePanelId, isRemotePanelId } from './dockviewWorkspaceHelpers'

export interface DashboardDockviewPanelParams {
    kind: 'conversation'
    tabKey: string
}

export interface DashboardDockviewRemotePanelParams {
    kind: 'remote'
    routeId: string
}

export function buildInitialDockviewLayout(
    api: DockviewApi,
    visibleConversations: ActiveConversation[],
    requestedActiveTabKey?: string | null,
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
        }
        previousGroupAnchorId = groupAnchorId ?? previousGroupAnchorId
    }

    const preferredActiveTabKey = requestedActiveTabKey
        ?? visibleConversations[0]?.tabKey
        ?? null
    return preferredActiveTabKey
}

export function syncDockviewPanels(api: DockviewApi, visibleConversations: ActiveConversation[]) {
    const visibleKeys = new Set(visibleConversations.map(conversation => conversation.tabKey))
    const tabKeyCounts = new Map<string, number>()
    for (const conversation of visibleConversations) {
        tabKeyCounts.set(conversation.tabKey, (tabKeyCounts.get(conversation.tabKey) || 0) + 1)
    }

    for (const panel of [...api.panels]) {
        if (isRemotePanelId(panel.id)) continue
        if (!visibleKeys.has(panel.id)) api.removePanel(panel)
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
    }
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
