// @vitest-environment jsdom
//
// UI simplification (2026-09-27): the pane toolbar keeps Stop visible and moves
// every other per-conversation action (history, remote, mute, session info,
// git, mesh graph) into one "…" overflow. This pins that the overflow offers
// exactly the actions that apply, that each item still reaches its handler
// (nothing lost by hiding it), and that the menu behaves like a menu.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ConversationActionsMenu from '../../../src/components/dashboard/ConversationActionsMenu'
import DashboardHeader from '../../../src/components/dashboard/DashboardHeader'
import { BaseDaemonProvider } from '../../../src/context/BaseDaemonContext'
import { TransportProvider } from '../../../src/context/TransportContext'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function conversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1',
        daemonId: 'machine-1',
        sessionId: 'session-1',
        transport: 'pty',
        mode: 'chat',
        agentName: 'Claude',
        agentType: 'claude-cli',
        status: 'idle',
        title: 'Refactor',
        messages: [],
        workspaceName: 'repo',
        workspacePath: '/work/repo',
        displayPrimary: 'Refactor',
        displaySecondary: 'machine-1',
        streamSource: 'native',
        tabKey: 'tab-1',
        git: { branch: 'main', dirty: false, ahead: 0, behind: 0 } as ActiveConversation['git'],
        coordinator: { meshId: 'mesh-1', role: 'coordinator' } as ActiveConversation['coordinator'],
        ...overrides,
    }
}

describe('ConversationActionsMenu — the pane toolbar "…" overflow', () => {
    let container: HTMLDivElement
    let root: Root
    const sendCommand = vi.fn(async () => ({ success: true }))

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        sendCommand.mockClear()
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    function render(node: React.ReactNode) {
        act(() => root.render(
            <TransportProvider value={{ sendCommand }}>
                <BaseDaemonProvider>{node}</BaseDaemonProvider>
            </TransportProvider>,
        ))
    }

    const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="conversation-actions-menu"]')!
    const menuItems = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    const itemKeys = () => menuItems().map(item => item.dataset.menuItem)

    it('is closed until clicked, then lists only the actions that apply to a CLI coordinator', () => {
        render(
            <ConversationActionsMenu
                conversation={conversation()}
                onOpenHistory={() => {}}
                onOpenRemote={() => {}}
                onOpenGit={() => {}}
                onOpenMeshGraph={() => {}}
            />,
        )
        expect(trigger().getAttribute('aria-expanded')).toBe('false')
        expect(menuItems()).toHaveLength(0)

        act(() => trigger().click())
        expect(trigger().getAttribute('aria-expanded')).toBe('true')
        // No "remote" for a CLI (terminal) conversation — only IDE chats have a screen.
        expect(itemKeys()).toEqual(['history', 'mesh', 'git', 'mute', 'info'])
        expect(menuItems().map(item => item.textContent)).toEqual([
            'Chat History', 'Mesh graph', 'Open git status', 'Mute this chat', 'Session info',
        ])
    })

    it('offers Remote control for an IDE chat and omits mesh/git when they do not apply', () => {
        render(
            <ConversationActionsMenu
                conversation={conversation({ transport: 'cdp-page', agentType: 'cursor', coordinator: undefined, git: undefined })}
                onOpenHistory={() => {}}
                onOpenRemote={() => {}}
                onOpenGit={() => {}}
                onOpenMeshGraph={() => {}}
            />,
        )
        act(() => trigger().click())
        expect(itemKeys()).toEqual(['history', 'remote', 'mute', 'info'])
    })

    it('every item still reaches its action, and choosing one closes the menu', () => {
        const onOpenHistory = vi.fn()
        const onOpenMeshGraph = vi.fn()
        const onOpenGit = vi.fn()
        const conv = conversation()
        render(
            <ConversationActionsMenu conversation={conv} onOpenHistory={onOpenHistory} onOpenGit={onOpenGit} onOpenMeshGraph={onOpenMeshGraph} />,
        )
        const choose = (key: string) => {
            act(() => trigger().click())
            const item = menuItems().find(entry => entry.dataset.menuItem === key)!
            act(() => item.click())
            expect(menuItems()).toHaveLength(0)
        }
        choose('history')
        expect(onOpenHistory).toHaveBeenCalledWith(conv)
        choose('mesh')
        expect(onOpenMeshGraph).toHaveBeenCalledWith(conv)
        choose('git')
        expect(onOpenGit).toHaveBeenCalledWith('machine-1', '/work/repo')
        choose('mute')
        expect(sendCommand).toHaveBeenCalledWith('machine-1', 'set_conversation_prefs', { sessionId: 'session-1', muted: true })
        choose('info')
        expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Session info')
    })

    it('Escape closes the menu and returns focus to the "…" button', () => {
        render(<ConversationActionsMenu conversation={conversation()} onOpenHistory={() => {}} />)
        act(() => trigger().click())
        expect(menuItems().length).toBeGreaterThan(0)
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
        expect(menuItems()).toHaveLength(0)
        expect(document.activeElement).toBe(trigger())
    })

    it('the dashboard header toolbar is Stop + "…" (history/mesh are not separate header buttons)', () => {
        const conv = conversation()
        render(
            <DashboardHeader
                activeConv={conv}
                wsStatus="connected"
                isConnected
                conversations={[conv]}
                onOpenHistory={() => {}}
                onStopCli={() => {}}
                onOpenMeshGraph={() => {}}
                inboxOpen={false}
                onInboxOpenChange={() => {}}
                hiddenOpen={false}
                onHiddenOpenChange={() => {}}
                notifications={[]}
                notificationUnreadCount={0}
                onOpenNotification={() => {}}
                onMarkNotificationRead={() => {}}
                onMarkNotificationUnread={() => {}}
                onDeleteNotification={() => {}}
            />,
        )
        const toolbar = container.querySelector('[data-testid="dashboard-pane-toolbar"]')!
        const buttons = Array.from(toolbar.querySelectorAll('button'))
        const labels = buttons.map(button => button.getAttribute('aria-label') || button.getAttribute('title') || '')
        expect(labels).toContain('Stop CLI process')
        expect(labels).toContain('More actions')
        expect(labels).not.toContain('Chat History')
        expect(toolbar.textContent).not.toContain('Refactor')
    })
})
