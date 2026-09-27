// @vitest-environment jsdom
//
// Switch — the one on/off control (replaces five hand-rolled toggles).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Switch } from '../../../src/components/ui/Switch'
import { ToggleRow } from '../../../src/components/settings/ToggleRow'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

describe('Switch', () => {
    it('is a role=switch button reflecting aria-checked, with theme-token colours only', () => {
        const on = renderToStaticMarkup(<Switch checked onChange={() => {}} aria-label="Alerts" />)
        expect(on).toContain('role="switch"')
        expect(on).toContain('aria-checked="true"')
        expect(on).toContain('aria-label="Alerts"')
        expect(on).toContain('var(--accent-primary)')
        expect(on).not.toContain('#8b5cf6')
        const off = renderToStaticMarkup(<Switch checked={false} onChange={() => {}} />)
        expect(off).toContain('aria-checked="false"')
    })

    it('click calls onChange with the next value and does not bubble to a parent', () => {
        const onChange = vi.fn()
        const parent = vi.fn()
        act(() => { root.render(<div onClick={parent}><Switch checked={false} onChange={onChange} /></div>) })
        act(() => { (container.querySelector('[role="switch"]') as HTMLElement).click() })
        expect(onChange).toHaveBeenCalledWith(true)
        expect(parent).not.toHaveBeenCalled()
    })

    it('disabled and busy ignore input', () => {
        const onChange = vi.fn()
        act(() => { root.render(<><Switch checked onChange={onChange} disabled /><Switch checked onChange={onChange} busy /></>) })
        const [a, b] = Array.from(container.querySelectorAll('[role="switch"]')) as HTMLElement[]
        act(() => { a.click(); b.click() })
        expect(onChange).not.toHaveBeenCalled()
        expect(b.getAttribute('aria-busy')).toBe('true')
    })

    it('as="span" (inside another button) is focusable and toggles with Space/Enter', () => {
        const onChange = vi.fn()
        act(() => { root.render(<button type="button"><Switch as="span" checked={false} onChange={onChange} aria-label="Enable" /></button>) })
        const sw = container.querySelector('span[role="switch"]') as HTMLElement
        expect(sw.getAttribute('tabindex')).toBe('0')
        act(() => { sw.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
        act(() => { sw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(onChange).toHaveBeenCalledTimes(2)
    })
})

describe('ToggleRow', () => {
    it('description is optional and shown as an ⓘ tip by default, labelled switch', () => {
        const withTip = renderToStaticMarkup(<ToggleRow label="Sounds" description="Plays a chime" checked onChange={() => {}} />)
        expect(withTip).toContain('aria-label="More info"')
        expect(withTip).toMatch(/aria-labelledby="([^"]+)"/)
        const bare = renderToStaticMarkup(<ToggleRow label="Sounds" checked onChange={() => {}} />)
        expect(bare).not.toContain('More info')
    })

    it('descriptionInline keeps visible text for warnings', () => {
        const html = renderToStaticMarkup(<ToggleRow label="Danger" description="Runs without approval" descriptionInline checked={false} onChange={() => {}} />)
        expect(html).not.toContain('aria-label="More info"')
        expect(html).toContain('Runs without approval')
    })
})
