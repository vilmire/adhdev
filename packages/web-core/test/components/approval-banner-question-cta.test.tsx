// @vitest-environment jsdom
//
// MULTISELECT-REMOTE-DEADLOCK — when a session has an answerable STRUCTURED
// question, ApprovalBanner must offer the picker CTA and NOT the raw buttons.
//
// Root cause: the raw buttons' only verb is `resolve_action` → a single-select
// `'{index}\r'` injection. A claude-cli multi-select checkbox picker cannot be
// submitted that way at all (a digit toggles a box without advancing; Enter
// toggles the cursor's row rather than submitting — only Tab commits), so each
// remote tap flipped a checkbox the user never chose and submitted nothing. The
// session stayed parked, flapping PROCESSING ↔ ACTION REQUIRED, and the owner was
// locked out from mobile. Rendering the CTA instead removes the corrupting verb
// from the user's reach entirely.
//
// Also covers the pendingButton auto-reset: with no status change to clear it,
// a refused/ineffective press froze the banner (spinner + every sibling blurred)
// with no way back short of a reload.
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
        status: 'waiting_approval',
        title: 'Session',
        messages: [],
        workspaceName: 'ws',
        displayPrimary: 'ws',
        displaySecondary: '',
        streamSource: 'native',
        tabKey: 'tab-1',
        modalButtons: ['Approve', 'Reject'],
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
        status: 'waiting_approval',
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

describe('ApprovalBanner — structured question CTA (MULTISELECT-REMOTE-DEADLOCK)', () => {
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
        vi.useRealTimers()
    })

    async function renderWith(entries: DaemonData[], onModalButton = () => {}) {
        await act(async () => {
            root.render(<Harness entries={entries} activeConv={conv()} onModalButton={onModalButton} />)
        })
        // Let the queued injectEntries land and re-render.
        await act(async () => { await Promise.resolve() })
    }

    it('renders the answer CTA and NONE of the raw approval buttons', async () => {
        await renderWith([sessionEntry({ activeInteractivePrompt: MULTISELECT_PROMPT })])

        const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
        expect(labels).toEqual(['Answer the question'])
        // The corrupting verb must not be reachable at all.
        expect(labels).not.toContain('Approve')
        expect(labels).not.toContain('Reject')
    })

    it('clicking the CTA does NOT fire onModalButton (no raw injection)', async () => {
        const onModalButton = vi.fn()
        await renderWith([sessionEntry({ activeInteractivePrompt: MULTISELECT_PROMPT })], onModalButton)

        const cta = container.querySelector('button') as HTMLButtonElement
        await act(async () => { cta.click() })

        expect(onModalButton).not.toHaveBeenCalled()
    })

    it('still shows the modal message so the user knows what is being asked', async () => {
        await renderWith([sessionEntry({ activeInteractivePrompt: MULTISELECT_PROMPT })])
        expect(container.textContent).toContain('Pick any colors?')
    })

    it('a session with NO structured prompt keeps the raw buttons (no regression)', async () => {
        await renderWith([sessionEntry()])

        const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
        expect(labels).toEqual(['Approve', 'Reject'])
    })

    it('another session\'s prompt does NOT hijack this banner', async () => {
        // The lookup is scoped to this conversation's session; an unscoped scan
        // would surface a question the user is not looking at.
        await renderWith([
            sessionEntry(),
            sessionEntry({
                id: 'daemon-1:cli:sess-2',
                sessionId: 'sess-2',
                activeInteractivePrompt: MULTISELECT_PROMPT,
            }),
        ])

        const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
        expect(labels).toEqual(['Approve', 'Reject'])
    })
})

describe('ApprovalBanner — pendingButton auto-reset (un-stick)', () => {
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
        vi.useRealTimers()
    })

    it('re-enables the buttons after the timeout when the injection resolved nothing', () => {
        vi.useFakeTimers()
        act(() => {
            root.render(<ApprovalBanner activeConv={conv()} onModalButton={() => {}} />)
        })

        const before = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
        act(() => { before[0].click() })

        // Mid-flight: every button disabled (the PROCESSING/blur state).
        const during = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
        expect(during.every(b => b.disabled)).toBe(true)

        // Nothing else changes — status, modalMessage and connectionState all stay
        // put, which is exactly what a refused press looks like. Before the fix the
        // banner stayed frozen here forever.
        act(() => { vi.advanceTimersByTime(12_000) })

        const after = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
        expect(after.every(b => !b.disabled)).toBe(true)
    })

    it('does not re-enable early (a healthy press keeps its spinner until resolution)', () => {
        vi.useFakeTimers()
        act(() => {
            root.render(<ApprovalBanner activeConv={conv()} onModalButton={() => {}} />)
        })
        act(() => { (container.querySelector('button') as HTMLButtonElement).click() })

        act(() => { vi.advanceTimersByTime(5_000) })

        const mid = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
        expect(mid.every(b => b.disabled)).toBe(true)
    })
})
