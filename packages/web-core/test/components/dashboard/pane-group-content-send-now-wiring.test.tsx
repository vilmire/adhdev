// @vitest-environment jsdom
//
// (PANE-GROUP-CONTENT-SEND-NOW-DRIFT) PaneGroupContent used to render two
// near-identical ChatPane call sites — one for the pty transport's chat
// sub-pane, one for every other transport — and commit 3cb9e4d0 wired
// pendingLocalMessage/sendFeedbackMessage into 6 of 7 call sites across the
// codebase but missed the pty ChatPane here. Because every command prop on
// ChatPane is optional, the omission compiled cleanly and only showed up as
// "send-now doesn't work when a CLI/PTY session is viewed in chat mode".
//
// The two call sites are now unified into one `renderChatPane(visible)`
// closure (see PaneGroupContent.tsx), so this test both guards against a
// prop reappearing on only one branch AND locks in the one real difference
// between the two branches: the pty branch's ChatPane is visible only when
// the chat sub-pane (not the terminal sub-pane) is showing, while the
// non-pty branch's ChatPane is visible whenever the parent pane is.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

const chatPaneSpy = vi.fn()
const cliTerminalPaneSpy = vi.fn()

vi.mock('../../../src/components/dashboard/ChatPane', () => ({
    default: (props: any) => {
        chatPaneSpy(props)
        return null
    },
}))

vi.mock('../../../src/components/dashboard/CliTerminalPane', () => ({
    default: (props: any) => {
        cliTerminalPaneSpy(props)
        return null
    },
}))

vi.mock('../../../src/hooks/useSessionModalSubscription', () => ({
    useSessionModalSubscription: () => ({}),
}))

const { default: PaneGroupContent } = await import('../../../src/components/dashboard/PaneGroupContent')

function fakeConversation(transport: 'pty' | 'acp' | undefined): ActiveConversation {
    return {
        routeId: 'route-1',
        transport,
        agentName: 'agent',
        agentType: 'claude',
        status: 'idle',
        title: 'Session',
        messages: [],
        workspaceName: 'ws',
        displayPrimary: 'p',
        displaySecondary: 's',
        streamSource: 'native',
        tabKey: 'tab-1',
    } as ActiveConversation
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    chatPaneSpy.mockClear()
    cliTerminalPaneSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

const HANDLE_SEND_NOW = vi.fn(async () => true)
const HANDLE_SEND = vi.fn(async () => true)

// The command surface arrives as ONE required `commands` object rather than N
// loose optional props. The assertions below are unchanged in intent — they
// still check what ChatPane actually receives — but the props are now built the
// way every real call site builds them.
function makeCommands() {
    return {
        handleModalButton: vi.fn(),
        handleRelaunch: vi.fn(),
        handleSendChat: HANDLE_SEND,
        handleSendNowQueued: HANDLE_SEND_NOW,
        isSendingChat: false,
        sendFeedbackMessage: null,
        lastSendQueued: false,
        pendingLocalMessage: null,
        handleFocusAgent: vi.fn(),
        isFocusingAgent: false,
    }
}

function renderPane(overrides: { transport: 'pty' | 'acp' | undefined; isCliTerminal: boolean; isVisible?: boolean }) {
    act(() => {
        root.render(
            React.createElement(PaneGroupContent, {
                activeConv: fakeConversation(overrides.transport),
                clearToken: 0,
                isCliTerminal: overrides.isCliTerminal,
                terminalRef: { current: null },
                commands: makeCommands(),
                actionLogs: [],
                isVisible: overrides.isVisible ?? true,
            } as any),
        )
    })
}

describe('PaneGroupContent — ChatPane call-site prop parity', () => {
    it('★ forwards handleSendNowQueued to the pty transport\'s chat sub-pane', () => {
        renderPane({ transport: 'pty', isCliTerminal: false })

        expect(chatPaneSpy).toHaveBeenCalledTimes(1)
        const props = chatPaneSpy.mock.calls[0][0]
        expect(props.handleSendNowQueued).toBe(HANDLE_SEND_NOW)
    })

    it('forwards handleSendNowQueued to the non-pty ChatPane (regression guard)', () => {
        renderPane({ transport: 'acp', isCliTerminal: false })

        expect(chatPaneSpy).toHaveBeenCalledTimes(1)
        const props = chatPaneSpy.mock.calls[0][0]
        expect(props.handleSendNowQueued).toBe(HANDLE_SEND_NOW)
    })

    it('preserves the one real difference: pty chat sub-pane visibility follows chatPaneVisible (off when terminal sub-pane is active)', () => {
        // isCliTerminal true => showChatPane=false => chatPaneVisible=false,
        // even though the parent pane itself (isVisible) is true.
        renderPane({ transport: 'pty', isCliTerminal: true, isVisible: true })

        const props = chatPaneSpy.mock.calls[0][0]
        expect(props.isVisible).toBe(false)
        expect(props.isInputActive).toBe(false)
    })

    it('preserves the one real difference: non-pty ChatPane visibility follows the parent pane directly', () => {
        renderPane({ transport: 'acp', isCliTerminal: false, isVisible: true })

        const props = chatPaneSpy.mock.calls[0][0]
        expect(props.isVisible).toBe(true)
        expect(props.isInputActive).toBe(true)
    })
})
