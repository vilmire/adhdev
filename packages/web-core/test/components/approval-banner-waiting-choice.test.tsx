// @vitest-environment jsdom
//
// WAITING-CHOICE-DASHBOARD-GATE — ApprovalBanner's early return
// (`!viewStates.isWaiting || !activeConv.modalButtons`) excluded
// `waiting_choice` conversations entirely, so the two structured-question
// branches below it (the answer CTA and the terminal-view dead-end) were
// unreachable for exactly the sessions they exist for: the banner rendered
// null and a parked AskUserQuestion looked indistinguishable from an idle
// session on the dashboard.
//
// The fix opens the gate to `waiting_choice` via a dedicated `isWaitingChoice`
// view-state flag — while keeping the raw modal buttons forbidden for it
// (MULTISELECT-REMOTE-DEADLOCK: a raw single-select `'{index}\r'` injection
// silently corrupts a checkbox picker one tap at a time). "Banner opens, raw
// buttons stay banned" is the exact contract these tests pin.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ApprovalBanner from '../../src/components/dashboard/ApprovalBanner'
import { BaseDaemonProvider, useBaseDaemonActions } from '../../src/context/BaseDaemonContext'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { DaemonData } from '../../src/types'

function conv(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'daemon-1:cli:sess-1',
        sessionId: 'sess-1',
        agentName: 'agent',
        agentType: 'claude-cli',
        status: 'waiting_choice',
        title: 'Session',
        messages: [],
        workspaceName: 'ws',
        displayPrimary: 'ws',
        displaySecondary: '',
        streamSource: 'native',
        tabKey: 'tab-1',
        modalButtons: ['Red', 'Green', 'Blue'],
        modalMessage: 'Pick any colors?',
        ...overrides,
    }
}

const MULTISELECT_PROMPT = {
    promptId: 'tool_multi_1',
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{
        questionId: 'q1',
        question: 'Pick any colors?',
        multiSelect: true,
        options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
    }],
} as unknown as DaemonData['activeInteractivePrompt']

function sessionEntry(overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id: 'daemon-1:cli:sess-1',
        sessionId: 'sess-1',
        daemonId: 'daemon-1',
        type: 'claude-cli',
        status: 'waiting_choice',
        timestamp: 1000,
        ...overrides,
    } as DaemonData
}

/** Seeds the provider's `ides` then renders the banner inside it. */
function Harness({ entries, activeConv, onModalButton }: {
    entries: DaemonData[]
    activeConv: ActiveConversation
    onModalButton: (b: string) => void
}) {
    return (
        <BaseDaemonProvider>
            <Seed entries={entries} />
            <ApprovalBanner activeConv={activeConv} onModalButton={onModalButton} />
        </BaseDaemonProvider>
    )
}

function Seed({ entries }: { entries: DaemonData[] }) {
    const { injectEntries } = useBaseDaemonActions()
    // Inject during render-commit so the banner's first paint already sees it.
    if (!(globalThis as any).__seeded) {
        (globalThis as any).__seeded = true
        queueMicrotask(() => injectEntries(entries))
    }
    return null
}

function buttonLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('button')).map(b => b.textContent || '')
}

describe('ApprovalBanner — waiting_choice gate (WAITING-CHOICE-DASHBOARD-GATE)', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        delete (globalThis as any).__seeded
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    async function renderWith(entries: DaemonData[], overrides: Partial<ActiveConversation> = {}, onModalButton = () => {}) {
        await act(async () => {
            root.render(<Harness entries={entries} activeConv={conv(overrides)} onModalButton={onModalButton} />)
        })
        // Let the queued injectEntries land and re-render.
        await act(async () => { await Promise.resolve() })
    }

    it('renders the answer CTA (not null) for waiting_choice with a tracked prompt', async () => {
        await renderWith([sessionEntry({ activeInteractivePrompt: MULTISELECT_PROMPT })])

        // The gate must not swallow the banner anymore…
        expect(container.textContent).not.toBe('')
        // …and the CTA is the structured-question one.
        expect(buttonLabels(container)).toEqual(['Answer the question'])
    })

    it('never renders the raw buttons for waiting_choice — prompt tracked or not', async () => {
        // Tracked prompt case.
        await renderWith([sessionEntry({ activeInteractivePrompt: MULTISELECT_PROMPT })])
        for (const raw of ['Red', 'Green', 'Blue']) {
            expect(buttonLabels(container)).not.toContain(raw)
        }
    })

    it('waiting_choice with NO tracked prompt shows the terminal-view dead-end, still no raw buttons', async () => {
        // Nothing hydrated (P2P event + rich sync both missed): the corrupting
        // verb must stay out of reach even though the banner opens.
        await renderWith([sessionEntry()])

        expect(container.textContent).toContain('Answer it in the terminal view')
        for (const raw of ['Red', 'Green', 'Blue']) {
            expect(buttonLabels(container)).not.toContain(raw)
        }
    })

    it('the dead-end renders no CTA that could fire a raw injection', async () => {
        const onModalButton = vi.fn()
        await renderWith([sessionEntry()], {}, onModalButton)

        expect(container.querySelector('button')).toBeNull()
        expect(onModalButton).not.toHaveBeenCalled()
    })

    it('waiting_approval without a structured prompt still gets the raw buttons (no gate regression)', async () => {
        await renderWith(
            [sessionEntry({ status: 'waiting_approval' })],
            { status: 'waiting_approval', modalButtons: ['Approve', 'Reject'] },
        )

        expect(buttonLabels(container)).toEqual(['Approve', 'Reject'])
    })
})
