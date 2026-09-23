// @vitest-environment jsdom
//
// DashboardMobileChatRoom owns the interactive-prompt modal while mobile chat
// mode is active. DashboardOverlays must therefore suppress its desktop/group-
// scoped instance; two mounted fixed overlays would stack and race for focus.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const interactivePromptModalSpy = vi.fn(() => null)

vi.mock('../../../src/components/interactive-prompt/InteractivePromptModal', () => ({
    default: (props: unknown) => interactivePromptModalSpy(props),
}))
vi.mock('../../../src/components/OnboardingModal', () => ({ default: () => null }))
vi.mock('../../../src/components/dashboard/ConnectionBanner', () => ({ default: () => null }))
vi.mock('../../../src/components/dashboard/DashboardRemoteDialog', () => ({ default: () => null }))
vi.mock('../../../src/components/dashboard/HistoryModal', () => ({ default: () => null }))
vi.mock('../../../src/components/dashboard/CliStopDialog', () => ({ default: () => null }))
vi.mock('../../../src/components/dashboard/ToastContainer', () => ({ default: () => null }))

const { default: DashboardOverlays } = await import('../../../src/components/dashboard/DashboardOverlays')

function overlayProps(suppressInteractivePrompt: boolean) {
    return {
        historyModal: {
            open: false,
            ides: [],
            isCreatingChat: false,
            isRefreshingHistory: false,
            savedSessions: [],
            savedHistoryFilters: { textQuery: '', workspaceQuery: '', modelQuery: '', resumableOnly: false, sortMode: 'recent' },
            onSavedHistoryFiltersChange: () => {},
            isSavedSessionsLoading: false,
            isResumingSavedSessionId: null,
            onClose: () => {},
            onNewChat: () => {},
            onSwitchSession: () => {},
            onRefreshHistory: () => {},
            onResumeSavedSession: () => {},
        },
        remoteDialog: {
            conversation: null,
            ides: [],
            connectionStates: {},
            actionLogs: [],
            sendDaemonCommand: async () => ({}),
            setActionLogs: () => {},
            isStandalone: false,
            onOpenHistory: () => {},
            onConversationChange: () => {},
            onClose: () => {},
        },
        cliStopDialog: { open: false, onCancel: () => {}, onStopNow: () => {}, onSaveAndStop: () => {} },
        connectionBanner: { wsStatus: 'connected', showReconnected: false },
        toastOverlay: { toasts: [], onDismiss: () => {} },
        onboarding: { open: false, onClose: () => {} },
        interactivePrompt: {
            promptSession: null,
            hasActivePrompt: false,
            responseError: null,
            isSubmitting: false,
            submit: async () => {},
            cancel: () => {},
            reopen: () => {},
        },
        suppressInteractivePrompt,
    } as any
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    interactivePromptModalSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

describe('DashboardOverlays interactive-prompt ownership', () => {
    it('does not mount the desktop modal when mobile chat owns the prompt surface', () => {
        act(() => root.render(<DashboardOverlays {...overlayProps(true)} />))

        expect(interactivePromptModalSpy).not.toHaveBeenCalled()
    })

    it('keeps the desktop modal mounted outside mobile chat mode', () => {
        act(() => root.render(<DashboardOverlays {...overlayProps(false)} />))

        expect(interactivePromptModalSpy).toHaveBeenCalledTimes(1)
    })
})
