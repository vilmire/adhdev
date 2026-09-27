import React from 'react'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
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
    // Owner decision (2026-09-27): a coordinator is recognisable at a glance on
    // every surface, so the mesh role chip ("Coordinator · <mesh>" /
    // "Worker · <mesh>") renders in the mesh-only row too.
    it('renders the coordinator role chip in the mesh-only row', () => {
        const html = renderChips(createConversation({
            settings: { meshCoordinatorFor: 'mesh-1' },
        }), { meshOnly: true })

        expect(html).toContain('mesh-role-chip is-coordinator')
        expect(html).toContain('Coordinator · mesh-1')
        expect(html).not.toContain('Studio Mac')
    })

    it('renders the worker role chip (not a coordinator chip) for a mesh node', () => {
        const html = renderChips(createConversation({
            settings: { meshNodeFor: 'mesh-1' },
        }), { meshOnly: true })

        expect(html).toContain('mesh-role-chip is-worker')
        expect(html).toContain('Worker · mesh-1')
        expect(html).not.toContain('Coordinator')
    })

    it('does not render the old chat pane meta row from pane content', () => {
        const source = readFileSync(path.resolve(process.cwd(), 'src/components/dashboard/PaneGroupContent.tsx'), 'utf8')

        expect(source).not.toContain('chat-pane-meta-row')
        expect(source).not.toContain('<ConversationMetaChips')
    })
})
