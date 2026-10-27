// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CliViewModeToggle from '../../../src/components/dashboard/CliViewModeToggle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CliViewModeToggle (Mode control)', () => {
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

    const button = () => container.querySelector<HTMLButtonElement>('button')!

    it('names the action for assistive tech (an action label, so no aria-pressed) and marks the current view', () => {
        act(() => root.render(<CliViewModeToggle mode="chat" onChange={vi.fn()} />))
        expect(button().getAttribute('aria-label')).toBe('Switch to Terminal view')
        expect(button().hasAttribute('aria-pressed')).toBe(false)
        expect(button().getAttribute('data-mode')).toBe('chat')

        act(() => root.render(<CliViewModeToggle mode="terminal" onChange={vi.fn()} />))
        expect(button().getAttribute('aria-label')).toBe('Switch to Chat view')
        expect(button().getAttribute('data-mode')).toBe('terminal')
    })

    it('is a native button, so Enter/Space toggle it like a click', () => {
        const onChange = vi.fn()
        act(() => root.render(<CliViewModeToggle mode="chat" onChange={onChange} />))
        expect(button().tagName).toBe('BUTTON')
        expect(button().getAttribute('type')).toBe('button')
        act(() => button().click())
        expect(onChange).toHaveBeenCalledWith('terminal')
    })
})
