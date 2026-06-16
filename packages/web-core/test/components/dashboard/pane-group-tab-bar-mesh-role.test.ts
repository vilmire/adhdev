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

describe('PaneGroupTabBar mesh role label', () => {
    it('renders compact mesh labels beside the tab status marker', () => {
        const html = renderTabBar(createConversation({
            settings: {
                meshNodeFor: 'mesh-1',
                meshCoordinatorFor: 'mesh-1',
            },
            coordinator: { meshId: 'mesh-1', role: 'coordinator' },
        }))

        expect(html).toContain('adhdev-dockview-tab-status')
        expect(html).toContain('adhdev-dockview-tab-mesh-role')
        expect(html).toContain('Mesh node · Coordinator')
        expect(html.indexOf('adhdev-dockview-tab-mesh-role')).toBeGreaterThan(html.indexOf('adhdev-dockview-tab-status'))
        expect(html.indexOf('adhdev-dockview-tab-mesh-role')).toBeLessThan(html.indexOf('adhdev-dockview-tab-copy'))
    })
})
