// @vitest-environment jsdom
//
// PICKER-PARSE-DEADLOCK-ESCAPE (remote-answer-picker-parse): a structured
// question is tracked (hasActivePrompt) but the modal surface has nothing to
// render for it (promptSession null — e.g. reopen() cleared a dismissal but
// findInteractivePromptSession still can't resolve a session, one of the
// after-effects of the daemon-side TUI parse failure this branch of work
// fixes). ApprovalBanner must show neither the raw approval buttons (a raw
// press can silently corrupt a multi-select picker — MULTISELECT-REMOTE-
// DEADLOCK) nor the "Answer the question" CTA (which would open nothing) —
// only an escape-hatch message pointing at the terminal view.
//
// useInteractivePrompt itself is mocked here so the test can drive
// {hasActivePrompt: true, promptSession: null} directly rather than trying to
// reproduce the exact daemon-data shape that produces it end-to-end (covered
// separately by the useInteractivePrompt hook tests).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveConversation } from '../../src/components/dashboard/types'

const mockUseInteractivePrompt = vi.fn()
vi.mock('../../src/hooks/useInteractivePrompt', () => ({
    useInteractivePrompt: (...args: unknown[]) => mockUseInteractivePrompt(...args),
}))

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}))

// Imported AFTER the mocks so ApprovalBanner picks up the mocked hook.
const { default: ApprovalBanner } = await import('../../src/components/dashboard/ApprovalBanner')

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

describe('ApprovalBanner — PICKER-PARSE-DEADLOCK-ESCAPE (hasActivePrompt=true, promptSession=null)', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        mockUseInteractivePrompt.mockReset()
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    it('renders neither the raw approval buttons nor the "Answer the question" CTA', () => {
        mockUseInteractivePrompt.mockReturnValue({
            hasActivePrompt: true,
            promptSession: null,
            reopen: () => {},
        })

        act(() => {
            root.render(<ApprovalBanner activeConv={conv()} onModalButton={() => {}} />)
        })

        const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
        expect(labels).not.toContain('Approve')
        expect(labels).not.toContain('Reject')
        expect(labels).not.toContain('Answer the question')
    })

    it('points the owner at the terminal view instead of a dead-end CTA', () => {
        mockUseInteractivePrompt.mockReturnValue({
            hasActivePrompt: true,
            promptSession: null,
            reopen: () => {},
        })

        act(() => {
            root.render(<ApprovalBanner activeConv={conv()} onModalButton={() => {}} />)
        })

        expect(container.textContent).toMatch(/terminal/i)
    })

    it('the normal CTA still renders once promptSession resolves (no regression)', () => {
        mockUseInteractivePrompt.mockReturnValue({
            hasActivePrompt: true,
            promptSession: { daemonId: 'daemon-1', sessionId: 'sess-1', routeId: 'daemon-1:cli:sess-1', providerType: 'claude-cli', title: 'Session', prompt: {} },
            reopen: () => {},
        })

        act(() => {
            root.render(<ApprovalBanner activeConv={conv()} onModalButton={() => {}} />)
        })

        const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
        expect(labels).toEqual(['Answer the question'])
    })

    it('the raw buttons still render when there is no active prompt at all (no regression)', () => {
        mockUseInteractivePrompt.mockReturnValue({
            hasActivePrompt: false,
            promptSession: null,
            reopen: () => {},
        })

        act(() => {
            root.render(<ApprovalBanner activeConv={conv()} onModalButton={() => {}} />)
        })

        const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
        expect(labels).toEqual(['Approve', 'Reject'])
    })
})
