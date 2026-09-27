import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import PaneGroupTabBar from '../../../src/components/dashboard/PaneGroupTabBar'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1:cli:codex-1',
        sessionId: 'codex-1',
        transport: 'pty',
        daemonId: 'machine-1',
        mode: 'chat',
        agentName: 'Codex',
        agentType: 'codex-cli',
        status: 'idle',
        title: 'Codex',
        messages: [],
        workspaceName: 'adhdev',
        workspacePath: '/repo/adhdev',
        displayPrimary: 'Codex',
        displaySecondary: 'Codex CLI',
        streamSource: 'native',
        tabKey: 'tab-1',
        machineName: 'Studio Mac',
        connectionState: 'connected',
        ...overrides,
    }
}

function renderTabBar(conversation: ActiveConversation) {
    return renderToStaticMarkup(
        React.createElement(PaneGroupTabBar, {
            conversations: [conversation],
            activeTabId: conversation.tabKey,
            groupIndex: 0,
            numGroups: 1,
            unreadTabKeys: new Set(),
            draggingTabRef: { current: null },
            onFocus: () => {},
            onSelectTab: () => {},
            onConversationActivated: () => {},
            onPreviewReorder: () => {},
            onReorderTab: () => {},
            onCommitPreviewOrder: () => {},
            onClearPreviewOrder: () => {},
            onDragStateReset: () => {},
            onDragTabKeyChange: () => {},
            isGroupActive: true,
            allowTabShortcuts: false,
        }),
    )
}

describe('PaneGroupTabBar mesh role marker', () => {
    it('marks a coordinator tab with the mesh icon before the title, and carries the role in its tooltip', () => {
        const html = renderTabBar(createConversation({
            settings: {
                meshNodeFor: 'mesh-1',
                meshCoordinatorFor: 'mesh-1',
            },
            coordinator: { meshId: 'mesh-1', role: 'coordinator' },
        }))

        expect(html).toContain('mesh-role-icon is-coordinator')
        expect(html).toContain('aria-label="Coordinator for mesh-1"')
        expect(html).toContain('title="Coordinator for mesh-1"')
        // status dot → icon → title/subtitle copy
        expect(html.indexOf('mesh-role-icon')).toBeGreaterThan(html.indexOf('adhdev-dockview-tab-status'))
        expect(html.indexOf('mesh-role-icon')).toBeLessThan(html.indexOf('adhdev-dockview-tab-copy'))
        // No visible "Coordinator · <mesh>" subtitle text — the icon alone carries the role.
        expect(html).not.toContain('Coordinator ·')
        expect(html).not.toContain('>Coordinator<')
        // The retired corner badge / plain-text role label / chip are gone.
        expect(html).not.toContain('adhdev-dockview-tab-mesh-badge')
        expect(html).not.toContain('adhdev-dockview-tab-mesh-role')
        expect(html).not.toContain('mesh-role-label')
        expect(html).not.toContain('mesh-role-chip')
    })

    it('renders no mesh icon for a worker tab — the icon is coordinator-only', () => {
        const html = renderTabBar(createConversation({ settings: { meshNodeFor: 'mesh-1' } }))

        expect(html).not.toContain('mesh-role-icon')
        expect(html).not.toContain('is-worker')
        expect(html).not.toContain('is-coordinator')
    })

    it('renders no mesh marker for non-mesh chats', () => {
        const html = renderTabBar(createConversation())

        expect(html).not.toContain('mesh-role-icon')
        expect(html).not.toContain('mesh-role-label')
    })
})
