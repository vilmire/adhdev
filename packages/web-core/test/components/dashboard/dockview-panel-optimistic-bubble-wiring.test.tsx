// @vitest-environment jsdom
//
// (DESKTOP-DOCKVIEW-OPTIMISTIC-BUBBLE) Regression for a render-site prop drop:
// `DashboardDockviewPanel` (the dockview `'conversation'` panel component)
// built `cmds` from `useDashboardConversationCommands` — which already returns
// `pendingLocalMessage`/`sendFeedbackMessage` — but forwarded only 9 of the
// hook's fields to `PaneGroupContent`, silently omitting both. The optimistic
// bubble logic itself (`withPendingLocalMessage`, covered by
// `test/hooks/queued-send-and-optimistic-bubble.test.ts`) was correct and
// wired end-to-end in `PaneGroup.tsx` (split-view/mobile-adjacent path) and
// `DashboardRemoteDialog.tsx` — only the desktop Dockview workspace's render
// site dropped it, so no hook/pure-function test could ever catch this: the
// hook always produced the right value, it just never reached the component
// that needed it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDockviewPanelProps } from 'dockview'
import type { DashboardDockviewPanelParams } from '../../../src/components/dashboard/dockviewWorkspaceLayout'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { PendingLocalMessage } from '../../../src/components/dashboard/conversation-message-snapshot'

const SENTINEL_PENDING: PendingLocalMessage = { content: 'deploy the thing', sentAt: 1_000 }
const SENTINEL_FEEDBACK = 'send-feedback-sentinel'

const paneGroupContentSpy = vi.fn()

vi.mock('../../../src/components/dashboard/PaneGroupContent', () => ({
    default: (props: any) => {
        paneGroupContentSpy(props)
        return null
    },
}))

// One stable object, mirroring the real hook — which memoizes its return so
// that `PaneGroupContent`'s memo comparator can compare it by reference.
const hookResult = {
    handleModalButton: vi.fn(),
    handleRelaunch: vi.fn(),
    handleSendChat: vi.fn(async () => true),
    handleSendNowQueued: vi.fn(async () => true),
    isSendingChat: false,
    sendFeedbackMessage: SENTINEL_FEEDBACK,
    lastSendQueued: false,
    pendingLocalMessage: SENTINEL_PENDING,
    handleFocusAgent: vi.fn(),
    isFocusingAgent: false,
}

vi.mock('../../../src/hooks/useDashboardConversationCommands', () => ({
    useDashboardConversationCommands: () => hookResult,
}))

// Imported AFTER the mocks above so the module graph picks them up.
const { DashboardDockviewPanel } = await import('../../../src/components/dashboard/DashboardDockviewWorkspace')
const { DashboardDockviewContext } = await import('../../../src/components/dashboard/dockviewWorkspaceContext')

function fakeApi(): IDockviewPanelProps<DashboardDockviewPanelParams>['api'] {
    return {
        isActive: true,
        isVisible: true,
        onDidActiveChange: () => ({ dispose: () => {} }),
        onDidActiveGroupChange: () => ({ dispose: () => {} }),
        onDidVisibilityChange: () => ({ dispose: () => {} }),
    } as unknown as IDockviewPanelProps<DashboardDockviewPanelParams>['api']
}

function fakeConversation(): ActiveConversation {
    return {
        routeId: 'route-1',
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
    paneGroupContentSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

function renderPanel() {
    const conversation = fakeConversation()
    const contextValue = {
        actionLogs: [],
        clearedTabs: {},
        conversationsByTabKey: new Map([[conversation.tabKey, conversation]]),
        hasDetachedConversationPanels: false,
        ides: [],
        isStandalone: false,
        hasRegisteredMachines: true,
        initialDataLoaded: true,
        liveSessionInboxState: new Map(),
        sendDaemonCommand: vi.fn(async () => ({})),
        setActionLogs: vi.fn(),
        toggleHiddenTab: vi.fn(),
        tabShortcuts: {},
        openTabContextMenu: vi.fn(),
        popoutTab: vi.fn(),
        moveTabBackToMain: vi.fn(),
        isTabInPopout: () => false,
        floatTab: vi.fn(),
        isTabFloating: () => false,
    }

    act(() => {
        root.render(
            React.createElement(
                DashboardDockviewContext.Provider,
                { value: contextValue as any },
                React.createElement(DashboardDockviewPanel, {
                    params: { kind: 'conversation', tabKey: conversation.tabKey },
                    api: fakeApi(),
                } as any),
            ),
        )
    })
}

describe('desktop Dockview panel — optimistic bubble prop wiring', () => {
    // The command surface now reaches PaneGroupContent as ONE required
    // `commands` object rather than N loose optional props, so the assertion
    // reads through that bundle. The intent is unchanged and is still the whole
    // point of this file: the values the hook produces must actually arrive at
    // the render site. What changed is that omitting them is now a compile
    // error (`commands` is required) instead of a silent runtime drop — this
    // test guards the wiring, the type guards the omission.
    it('★ forwards pendingLocalMessage and sendFeedbackMessage from the hook to PaneGroupContent', () => {
        renderPanel()

        expect(paneGroupContentSpy).toHaveBeenCalledTimes(1)
        const props = paneGroupContentSpy.mock.calls[0][0]
        expect(props.commands.pendingLocalMessage).toBe(SENTINEL_PENDING)
        expect(props.commands.sendFeedbackMessage).toBe(SENTINEL_FEEDBACK)
    })

    it('forwards the hook object itself, so a newly added command field cannot be dropped in transit', () => {
        renderPanel()

        // The structural half of the same guarantee: the panel passes the hook's
        // return through as one value, so a field added to the hook reaches this
        // render site without a per-field edit here.
        const props = paneGroupContentSpy.mock.calls[0][0]
        expect(props.commands).toBe(hookResult)
    })
})
