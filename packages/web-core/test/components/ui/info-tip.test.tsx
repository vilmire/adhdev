// @vitest-environment jsdom
//
// InfoTip / Tooltip / PopoverButton — the shared "details on demand" primitives.
// Behaviour under test: click/tap toggles, desktop hover previews, keyboard
// (native button Enter/Space, Tooltip focus), Escape closes WITHOUT reaching an
// enclosing dialog's bubble-phase Escape handler, outside pointerdown closes,
// and the hint text is always present for screen readers (aria-describedby).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InfoTip, PopoverButton, Tooltip, computePopoverPosition } from '../../../src/components/ui/InfoTip'

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
    document.body.innerHTML = ''
})

function render(node: React.ReactNode) {
    act(() => { root.render(node) })
}

const popover = () => document.body.querySelector('[role="tooltip"]:not(.sr-only)')

function pointer(el: Element, type: string, pointerType: 'mouse' | 'touch' | 'pen') {
    // jsdom has no PointerEvent constructor in every version — synthesize one.
    const event = new MouseEvent(type, { bubbles: true, cancelable: true }) as MouseEvent & { pointerType: string }
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    act(() => { el.dispatchEvent(event) })
}

describe('InfoTip', () => {
    it('renders nothing for empty content', () => {
        render(<InfoTip content="" />)
        expect(container.querySelector('button')).toBeNull()
    })

    it('is a labelled button that describes itself with the hint text (screen readers, SSR)', () => {
        const html = renderToStaticMarkup(<InfoTip content="Why this matters" />)
        expect(html).toContain('aria-label="More info"')
        expect(html).toContain('aria-expanded="false"')
        expect(html).toMatch(/aria-describedby="([^"]+)"[\s\S]*id="\1" class="sr-only">Why this matters/)
    })

    it('click (tap) toggles a pinned popover, portaled to <body>', () => {
        render(<InfoTip content="Details here" />)
        const button = container.querySelector('button')!
        act(() => { button.click() })
        expect(button.getAttribute('aria-expanded')).toBe('true')
        expect(popover()?.textContent).toBe('Details here')
        expect(container.contains(popover())).toBe(false)
        act(() => { button.click() })
        expect(button.getAttribute('aria-expanded')).toBe('false')
        expect(popover()).toBeNull()
    })

    it('mouse hover previews it; leaving closes an unpinned preview', () => {
        render(<InfoTip content="Hover me" />)
        const button = container.querySelector('button')!
        // React derives onPointerEnter/Leave from pointerover/pointerout.
        pointer(button, 'pointerover', 'mouse')
        expect(popover()?.textContent).toBe('Hover me')
        pointer(button, 'pointerout', 'mouse')
        expect(popover()).toBeNull()
    })

    it('touch does not hover-open (tap is the only way)', () => {
        render(<InfoTip content="Tap only" />)
        const button = container.querySelector('button')!
        pointer(button, 'pointerover', 'touch')
        expect(popover()).toBeNull()
    })

    it('Escape closes it, returns focus, and does not reach a dialog-level Escape handler', () => {
        const dialogEscape = vi.fn()
        window.addEventListener('keydown', (e) => { if (e.key === 'Escape') dialogEscape() })
        render(<InfoTip content="Esc me" />)
        const button = container.querySelector('button')!
        act(() => { button.click() })
        expect(popover()).not.toBeNull()
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
        expect(popover()).toBeNull()
        expect(dialogEscape).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(button)
    })

    it('an outside pointerdown closes it; a pointerdown inside the popover does not', () => {
        render(<div><InfoTip content={<span data-inside>inside</span>} /><p id="outside">x</p></div>)
        const button = container.querySelector('button')!
        act(() => { button.click() })
        const inside = popover()!.querySelector('[data-inside]')!
        act(() => { inside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
        expect(popover()).not.toBeNull()
        act(() => { container.querySelector('#outside')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
        expect(popover()).toBeNull()
    })

    it('a click does not bubble to a clickable parent (e.g. a collapsible section header)', () => {
        const parentClick = vi.fn()
        render(<div onClick={parentClick}><InfoTip content="x" /></div>)
        act(() => { container.querySelector('button')!.click() })
        expect(parentClick).not.toHaveBeenCalled()
    })
})

describe('Tooltip', () => {
    it('passes the child through untouched when there is no hint', () => {
        const html = renderToStaticMarkup(<Tooltip content={undefined}><span id="chip">chip</span></Tooltip>)
        expect(html).toBe('<span id="chip">chip</span>')
    })

    it('keyboard focus shows the hint; blur hides it', () => {
        render(<Tooltip content="Chip hint"><span>chip</span></Tooltip>)
        const trigger = container.querySelector('[data-tooltip]') as HTMLElement
        expect(trigger.getAttribute('tabindex')).toBe('0')
        act(() => { trigger.focus() })
        expect(popover()?.textContent).toBe('Chip hint')
        act(() => { trigger.blur() })
        expect(popover()).toBeNull()
    })

    it('a tap (touch pointerup) toggles it, since touch has no hover', () => {
        render(<Tooltip content="Tap hint"><span>chip</span></Tooltip>)
        const trigger = container.querySelector('[data-tooltip]') as HTMLElement
        pointer(trigger, 'pointerup', 'touch')
        expect(popover()?.textContent).toBe('Tap hint')
        pointer(trigger, 'pointerup', 'touch')
        expect(popover()).toBeNull()
    })

    it('Enter toggles it for keyboard users', () => {
        render(<Tooltip content="Key hint"><span>chip</span></Tooltip>)
        const trigger = container.querySelector('[data-tooltip]') as HTMLElement
        act(() => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(popover()?.textContent).toBe('Key hint')
    })
})

describe('PopoverButton', () => {
    it('opens a dialog popover with interactive content on click; Escape closes', () => {
        const onToggle = vi.fn()
        render(<PopoverButton label="Legend" content={<button type="button" onClick={onToggle}>LR</button>}>Legend</PopoverButton>)
        const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
        act(() => { trigger.click() })
        const dialog = document.body.querySelector('[role="dialog"]')!
        expect(dialog.getAttribute('aria-label')).toBe('Legend')
        act(() => { (dialog.querySelector('button') as HTMLButtonElement).click() })
        expect(onToggle).toHaveBeenCalledTimes(1)
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
        expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    })
})

describe('computePopoverPosition (mobile-safe placement)', () => {
    const viewport = { width: 375, height: 700 }
    it('clamps horizontally inside the viewport with an 8px margin', () => {
        const pos = computePopoverPosition({ top: 100, bottom: 120, left: 360, width: 14 }, { width: 240, height: 80 }, viewport)
        expect(pos.left).toBe(375 - 240 - 8)
        expect(pos.placement).toBe('below')
    })
    it('flips above the anchor when there is no room below', () => {
        const pos = computePopoverPosition({ top: 650, bottom: 670, left: 20, width: 14 }, { width: 200, height: 120 }, viewport)
        expect(pos.placement).toBe('above')
        expect(pos.top).toBe(650 - 6 - 120)
    })
    it('never goes off the left edge', () => {
        const pos = computePopoverPosition({ top: 10, bottom: 30, left: 0, width: 10 }, { width: 300, height: 50 }, viewport)
        expect(pos.left).toBe(8)
    })
})
