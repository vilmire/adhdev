// @vitest-environment jsdom
//
// (G8-1 / G8-2) ApprovalBanner regression coverage.
//
// G8-1: the approval message must not be hard-truncated to a single 120-char
// line — the product promise is "push -> tap -> one-tap approve", which only
// holds if the user can actually read what they're approving. We assert the
// full text renders (clamped visually via CSS, not sliced in markup) and that
// the full text is always reachable via `title`.
//
// G8-2: cleanBtnText must not strip whole-word matches out of unrelated
// button labels ("Escalate" must not become "alate"). \b-anchoring fixes it;
// this locks the fix in with both the regression case and the original
// "strip a real shortcut suffix" behavior it must not break.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import ApprovalBanner, { cleanBtnText } from '../../src/components/dashboard/ApprovalBanner'
import type { ActiveConversation } from '../../src/components/dashboard/types'

function conv(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'route-1',
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
        ...overrides,
    }
}

describe('cleanBtnText', () => {
    it('does not mangle whole-word matches inside unrelated labels', () => {
        expect(cleanBtnText('Escalate')).toBe('Escalate')
        expect(cleanBtnText('Tabulate')).toBe('Tabulate')
        expect(cleanBtnText('Shift the paradigm')).toBe('the paradigm')
    })

    it('still strips real shortcut suffixes, including the parenthesized form', () => {
        expect(cleanBtnText('Always allow (Alt+A)')).toBe('Always allow')
        expect(cleanBtnText('Reject (Esc)')).toBe('Reject')
        expect(cleanBtnText('Approve (Ctrl+Enter)')).toBe('Approve')
        expect(cleanBtnText('Run Alt+Enter')).toBe('Run')
    })

    it('strips Mac symbol shortcuts', () => {
        expect(cleanBtnText('Approve ⌘⏎')).toBe('Approve')
    })
})

describe('ApprovalBanner', () => {
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
    })

    it('renders the full approval message text, not truncated to 120 chars', () => {
        const longMessage = 'git push --force origin main '.repeat(10).trim()
        expect(longMessage.length).toBeGreaterThan(120)

        act(() => {
            root.render(
                <ApprovalBanner activeConv={conv({ modalMessage: longMessage })} onModalButton={() => {}} />,
            )
        })

        const messageEl = container.querySelector('[title]') as HTMLElement
        expect(messageEl).not.toBeNull()
        // Full text must be present in the DOM (CSS line-clamp truncates the
        // rendered box visually; the markup itself must carry it all so a
        // tap-to-expand / title reveal can surface it).
        expect(messageEl.textContent).toBe(longMessage)
        expect(messageEl.getAttribute('title')).toBe(longMessage)
    })

    it('distinguishes destructive commands by full text (not just the first 120 chars)', () => {
        const rmMessage = `rm -rf build/ ${'x'.repeat(130)}`
        const pushMessage = `git push --force ${'x'.repeat(130)}`

        act(() => {
            root.render(<ApprovalBanner activeConv={conv({ modalMessage: rmMessage })} onModalButton={() => {}} />)
        })
        const rmText = (container.querySelector('[title]') as HTMLElement).textContent

        act(() => {
            root.render(<ApprovalBanner activeConv={conv({ modalMessage: pushMessage })} onModalButton={() => {}} />)
        })
        const pushText = (container.querySelector('[title]') as HTMLElement).textContent

        expect(rmText).toContain('rm -rf build/')
        expect(pushText).toContain('git push --force')
        expect(rmText).not.toBe(pushText)
    })

    it('renders "Escalate" as a button label without mangling it', () => {
        act(() => {
            root.render(
                <ApprovalBanner
                    activeConv={conv({ modalButtons: ['Approve', 'Escalate', 'Reject'] })}
                    onModalButton={() => {}}
                />,
            )
        })
        const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
        expect(buttons).toContain('Escalate')
        expect(buttons).not.toContain('alate')
    })

    it('does not give "Always allow" primary/strong styling (G8-3 minimal de-emphasis)', () => {
        act(() => {
            root.render(
                <ApprovalBanner
                    activeConv={conv({ modalButtons: ['Always allow', 'Reject'] })}
                    onModalButton={() => {}}
                />,
            )
        })
        const buttons = Array.from(container.querySelectorAll('button'))
        const alwaysAllowBtn = buttons.find((b) => b.textContent === 'Always allow')
        expect(alwaysAllowBtn).toBeDefined()
        // Primary buttons get font-extrabold; neutral ones get font-semibold.
        expect(alwaysAllowBtn!.className).not.toContain('font-extrabold')
        expect(alwaysAllowBtn!.className).toContain('font-semibold')
    })
})
