import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { describe, expect, it } from 'vitest'

import ConversationMetaChips from '../../../src/components/dashboard/ConversationMetaChips'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1:cli:claude-1',
        providerSessionId: 'claude-1',
        transport: 'pty',
        daemonId: 'machine-1',
        mode: 'chat',
        agentName: 'Claude',
        agentType: 'claude-cli',
        status: 'idle',
        title: 'Claude',
        messages: [],
        workspaceName: 'adhdev',
        workspacePath: '/repo/adhdev',
        displayPrimary: 'Claude',
        displaySecondary: 'CLI',
        streamSource: 'native',
        tabKey: 'cli:claude-1',
        machineName: 'Studio Mac',
        connectionState: 'connected',
        ...overrides,
    }
}

function renderChips(
    conversation: ActiveConversation,
    props: Partial<React.ComponentProps<typeof ConversationMetaChips>> = {},
) {
    return renderToStaticMarkup(
        React.createElement(
            StaticRouter,
            { location: '/' },
            React.createElement(ConversationMetaChips, { conversation, ...props }),
        ),
    )
}

describe('ConversationMetaChips', () => {
    it('does not render the mesh coordinator chip below the dashboard tab bar', () => {
        const html = renderChips(createConversation({
            settings: { meshCoordinatorFor: 'mesh-1' },
        }), { meshOnly: true })

        expect(html).toBe('')
        expect(html).not.toContain('Coordinator')
        expect(html).not.toContain('Mesh Coordinator')
    })

    it('still renders mesh node chips when the mesh-only row has node context', () => {
        const html = renderChips(createConversation({
            settings: { meshNodeFor: 'mesh-1' },
        }), { meshOnly: true })

        expect(html).toContain('Mesh Node')
        expect(html).not.toContain('Coordinator')
    })
})
