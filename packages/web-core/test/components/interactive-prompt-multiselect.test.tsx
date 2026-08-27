// @vitest-environment jsdom
//
// Multi-select rendering + selection semantics for InteractivePromptModal.
//
// This suite previously asserted on the *source text* of InteractivePromptModal.tsx
// (`expect(source).toContain("multiSelect ? 'rounded-sm' : 'rounded-full'")` and
// friends). That shape passed as long as the string survived, so a refactor that
// renamed the class, moved the ternary into a helper, or stopped threading
// `question.multiSelect` down to the option at all would keep the suite green while
// the checkbox silently rendered as a radio — and any purely cosmetic rewording of
// the same working code turned the suite red. Both failure directions are wrong.
//
// Everything the old assertions cared about is observable in the rendered DOM, so
// it is asserted there instead: the indicator shape, the ARIA roles/state, the hint
// copy, and — the actual regression this file exists for — that clicking a second
// option in a multi-select question ACCUMULATES rather than replaces.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import InteractivePromptModal from '../../src/components/interactive-prompt/InteractivePromptModal'
import type { InteractivePromptSession } from '../../src/interactive-prompt/interactive-prompt-utils'

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
    document.body.innerHTML = ''
    vi.useRealTimers()
})

function session(multiSelect: boolean): InteractivePromptSession {
    return {
        daemonId: 'daemon-1',
        sessionId: 'session-1',
        routeId: 'route-1',
        providerType: 'claude-cli',
        prompt: {
            promptId: 'prompt-1',
            origin: 'agent',
            providerType: 'claude-cli',
            createdAt: 0,
            questions: [
                {
                    questionId: 'q1',
                    question: 'Which features do you want?',
                    multiSelect,
                    options: [
                        { label: 'Alpha' },
                        { label: 'Beta' },
                        { label: 'Gamma' },
                    ],
                },
            ],
        },
    }
}

function render(multiSelect: boolean, onSubmit = vi.fn()) {
    act(() => {
        root.render(
            <InteractivePromptModal
                promptSession={session(multiSelect)}
                onSubmit={onSubmit}
                onCancel={vi.fn()}
            />
        )
    })
    return onSubmit
}

// The modal renders through ModalPortal into document.body, not into `container`.
function optionButtons(): HTMLButtonElement[] {
    return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="checkbox"], [role="radio"]'))
}

function optionByLabel(label: string): HTMLButtonElement {
    const found = optionButtons().find(btn => btn.textContent?.includes(label))
    if (!found) throw new Error(`option not found: ${label}`)
    return found
}

// The selection indicator is the leading 4x4 marker span inside the option button.
function indicatorOf(button: HTMLButtonElement): HTMLElement {
    const marker = button.querySelector<HTMLElement>('span.h-4.w-4')
    if (!marker) throw new Error('option indicator not found')
    return marker
}

function selectedLabels(): string[] {
    return optionButtons()
        .filter(btn => btn.getAttribute('aria-checked') === 'true')
        .map(btn => btn.querySelector('span.block')?.textContent || '')
}

describe('InteractivePromptModal multi-select rendering', () => {
    it('renders a square checkbox indicator for multi-select questions', () => {
        render(true)
        const indicator = indicatorOf(optionByLabel('Alpha'))
        expect(indicator.className).toContain('rounded-sm')
        expect(indicator.className).not.toContain('rounded-full')
    })

    it('renders a round radio indicator for single-select questions', () => {
        render(false)
        const indicator = indicatorOf(optionByLabel('Alpha'))
        expect(indicator.className).toContain('rounded-full')
        expect(indicator.className).not.toContain('rounded-sm')
    })

    it('exposes checkbox/group semantics for multi-select and radio/radiogroup for single-select', () => {
        render(true)
        expect(optionButtons()).toHaveLength(3)
        for (const btn of optionButtons()) {
            expect(btn.getAttribute('role')).toBe('checkbox')
            expect(btn.getAttribute('aria-checked')).toBe('false')
        }
        expect(document.body.querySelector('[role="group"]')).not.toBeNull()
        expect(document.body.querySelector('[role="radiogroup"]')).toBeNull()

        act(() => root.unmount())
        root = createRoot(container)
        render(false)
        for (const btn of optionButtons()) {
            expect(btn.getAttribute('role')).toBe('radio')
        }
        expect(document.body.querySelector('[role="radiogroup"]')).not.toBeNull()
    })

    it('reflects selection in aria-checked when an option is clicked', () => {
        render(true)
        expect(optionByLabel('Alpha').getAttribute('aria-checked')).toBe('false')
        act(() => optionByLabel('Alpha').click())
        expect(optionByLabel('Alpha').getAttribute('aria-checked')).toBe('true')
    })

    it('shows the "Select all that apply" hint only for multi-select questions', () => {
        render(true)
        expect(document.body.textContent).toContain('Select all that apply')

        act(() => root.unmount())
        root = createRoot(container)
        render(false)
        expect(document.body.textContent).not.toContain('Select all that apply')
    })
})

describe('InteractivePromptModal selection accumulation', () => {
    it('accumulates multiple selections in a multi-select question', () => {
        render(true)
        act(() => optionByLabel('Alpha').click())
        act(() => optionByLabel('Gamma').click())
        expect(selectedLabels()).toEqual(['Alpha', 'Gamma'])
    })

    it('toggles a multi-select option back off when clicked again', () => {
        render(true)
        act(() => optionByLabel('Alpha').click())
        act(() => optionByLabel('Gamma').click())
        act(() => optionByLabel('Alpha').click())
        expect(selectedLabels()).toEqual(['Gamma'])
    })

    it('replaces the selection in a single-select question', () => {
        render(false)
        act(() => optionByLabel('Alpha').click())
        expect(selectedLabels()).toEqual(['Alpha'])
        act(() => optionByLabel('Gamma').click())
        expect(selectedLabels()).toEqual(['Gamma'])
    })

    it('submits every accumulated multi-select label, not just the last one', async () => {
        vi.useFakeTimers()
        const onSubmit = vi.fn()
        render(true, onSubmit)

        act(() => optionByLabel('Alpha').click())
        act(() => optionByLabel('Beta').click())

        // Submit is gated for SUBMIT_READY_DELAY_MS after the prompt renders.
        act(() => {
            vi.advanceTimersByTime(300)
        })

        const submit = Array.from(document.body.querySelectorAll('button'))
            .find(btn => btn.textContent?.trim() === 'Submit')
        expect(submit, 'submit button not found').toBeTruthy()
        act(() => submit!.click())

        expect(onSubmit).toHaveBeenCalledTimes(1)
        expect(onSubmit.mock.calls[0][0].q1.selectedLabels).toEqual(['Alpha', 'Beta'])
    })
})
