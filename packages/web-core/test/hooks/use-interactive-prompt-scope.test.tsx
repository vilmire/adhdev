// @vitest-environment jsdom
//
// Behavioural coverage for interactive-prompt scope, including the ACTUAL
// mobile chat composition: DashboardMobileChatRoom + PaneGroupContent's
// ApprovalBanner + the room-owned InteractivePromptModal mounted together.
//
// WHY THE COMPOSITION TEST MATTERS: hook-only scope tests were green while the
// mobile screen was live-broken. Its banner used the mobile-local selection,
// but the only modal lived in DashboardOverlays and used the desktop Dockview
// selection. A useful regression must click the real banner CTA and observe the
// real modal opening for that same mobile session; isolated hook probes cannot
// prove the two surfaces are wired together.
//
// Two live defects are locked down here:
//   1. an unscoped gate rendered the FIRST prompt-bearing session in `ides`
//      order (a status-report merge artifact), so with `wsA` selected the
//      modal showed `e2e-ws`'s question after a refresh;
//   2. hidden (`surfaceHidden`) mesh workers must stay suppressed — adding a
//      scope must not re-open that leak, which is why `sessionId` and
//      `includeHidden` are separate axes on the selector contract.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useInteractivePrompt } from '../../src/hooks/useInteractivePrompt'
import DashboardMobileChatRoom from '../../src/components/dashboard/DashboardMobileChatRoom'
import type { DaemonData } from '../../src/types'
import type { ActiveConversation } from '../../src/components/dashboard/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The hook pulls entries from BaseDaemonContext and a sender from
// TransportContext; neither is under test here, so both are stubbed.
const ides: DaemonData[] = []

vi.mock('../../src/context/BaseDaemonContext', () => ({
    useBaseDaemons: () => ({ ides, isP2PActive: false, p2pStates: {} }),
}))

vi.mock('../../src/context/TransportContext', () => ({
    useTransport: () => ({ sendCommand: async () => ({}) }),
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}))

// Keep the mobile composition real through PaneGroupContent, ApprovalBanner,
// useInteractivePrompt and InteractivePromptModal. Only the heavyweight pane
// bodies and their live modal subscription are irrelevant to this regression.
vi.mock('../../src/components/dashboard/ChatPane', () => ({ default: () => null }))
vi.mock('../../src/components/dashboard/CliTerminalPane', () => ({ default: () => null }))
vi.mock('../../src/hooks/useSessionModalSubscription', () => ({
    useSessionModalSubscription: () => ({}),
}))

function promptFor(promptId: string) {
    return {
        promptId,
        origin: 'cli' as const,
        providerType: 'claude-cli',
        createdAt: 1,
        questions: [{
            questionId: 'q1',
            question: `Question from ${promptId}`,
            multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }],
        }],
    }
}

function sessionEntry(sessionId: string, opts: { surfaceHidden?: boolean } = {}): DaemonData {
    return {
        id: `daemon-1:cli:${sessionId}`,
        daemonId: 'daemon-1',
        sessionId,
        type: 'claude-cli',
        status: 'waiting_choice',
        activeInteractivePrompt: promptFor(`prompt-${sessionId}`),
        ...(opts.surfaceHidden ? { surfaceHidden: true } : {}),
    } as DaemonData
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    ides.length = 0
})

/** Render the hook exactly as a gate does and report what it would surface. */
function resolveVia(sessionId: string | null): { sessionId?: string; promptId?: string } | null {
    let seen: { sessionId?: string; promptId?: string } | null = null
    function Probe() {
        const { promptSession } = useInteractivePrompt(sessionId)
        seen = promptSession
            ? { sessionId: promptSession.sessionId, promptId: promptSession.prompt.promptId }
            : null
        return null
    }
    act(() => root.render(<Probe />))
    return seen
}

describe('interactive prompt gate scoping', () => {
    it('does not surface another session\'s prompt when the selected session has none', () => {
        // Live repro: `e2e-ws` holds a question, the user has `wsA` selected.
        // `e2e-ws` is first in ides order, so an unscoped scan returned it.
        ides.push(sessionEntry('e2e-ws'), { id: 'daemon-1:cli:wsA', daemonId: 'daemon-1', sessionId: 'wsA', type: 'claude-cli', status: 'idle' } as DaemonData)

        expect(resolveVia('wsA')).toBeNull()
    })

    it('surfaces the selected session\'s own prompt', () => {
        ides.push(sessionEntry('e2e-ws'), sessionEntry('wsA'))

        expect(resolveVia('wsA')).toMatchObject({ sessionId: 'wsA', promptId: 'prompt-wsA' })
    })

    it('keeps a hidden mesh worker suppressed even when it is the scoped session', () => {
        // Regression guard: `includeHidden` must stay defaulted off. A hidden
        // worker has no tab and no pane, so its full-screen modal would be
        // unanswerable and would cover the owner's dashboard.
        ides.push(sessionEntry('hidden-worker', { surfaceHidden: true }))

        expect(resolveVia('hidden-worker')).toBeNull()
    })

    it('keeps a hidden worker suppressed on an unscoped lookup too', () => {
        ides.push(sessionEntry('hidden-worker', { surfaceHidden: true }))

        expect(resolveVia(null)).toBeNull()
    })
})

function mobileConversation(sessionId: string): ActiveConversation {
    return {
        routeId: `daemon-1:cli:${sessionId}`,
        daemonId: 'daemon-1',
        sessionId,
        transport: 'acp',
        agentName: 'Claude',
        agentType: 'claude-cli',
        status: 'waiting_choice',
        title: `Session ${sessionId}`,
        messages: [],
        workspaceName: 'workspace',
        displayPrimary: 'Claude',
        displaySecondary: 'workspace',
        streamSource: 'agent-stream',
        tabKey: `tab-${sessionId}`,
        modalMessage: `Question from prompt-${sessionId}`,
        modalButtons: ['Yes', 'No'],
    }
}

function mobileCommands() {
    return {
        handleModalButton: vi.fn(),
        handleRelaunch: vi.fn(),
        handleSendChat: vi.fn(async () => true),
        handleSendNowQueued: vi.fn(async () => true),
        handleCancelQueued: vi.fn(async () => true),
        isSendingChat: false,
        sendFeedbackMessage: null,
        pendingLocalMessage: null,
        pendingLocalMessages: [],
        retireEchoedPendingMessages: vi.fn(),
        handleFocusAgent: vi.fn(),
        isFocusingAgent: false,
    } as any
}

describe('mobile chat interactive prompt composition', () => {
    it('opens the selected session modal from the banner CTA in the same mobile room', () => {
        // Preserve the incident shape: another prompt-bearing session comes
        // first, while the mobile-local selection is wsA.
        ides.push(sessionEntry('e2e-ws'), sessionEntry('wsA'))

        act(() => root.render(
            <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <DashboardMobileChatRoom
                    selectedConversation={mobileConversation('wsA')}
                    isAcp
                    isStandalone={false}
                    actionLogs={[]}
                    commands={mobileCommands()}
                    onBack={() => {}}
                    onOpenNativeConversation={() => {}}
                    onOpenMachine={() => {}}
                    onOpenHistory={() => {}}
                    onOpenRemote={() => {}}
                    cliViewMode={null}
                    onSetCliViewMode={() => {}}
                />
            </MemoryRouter>,
        ))

        let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
        expect(dialog).not.toBeNull()
        expect(dialog?.textContent).toContain('Question from prompt-wsA')
        expect(dialog?.textContent).not.toContain('Question from prompt-e2e-ws')
        expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1)

        // The hook eagerly presents an undismissed prompt, so the banner CTA is
        // behind the already-open modal in a healthy composition. Drive that
        // real CTA anyway: without the room-owned modal (the live regression),
        // this same click leaves the document with zero dialogs.
        const answerButton = Array.from(document.body.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Answer the question'))
        expect(answerButton).not.toBeUndefined()
        act(() => (answerButton as HTMLButtonElement).click())

        dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
        expect(dialog).not.toBeNull()
        expect(dialog?.textContent).toContain('Question from prompt-wsA')
        expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    })
})
