// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    MIN_TOUCH_TARGET_PX,
    measureTouchTarget,
    warnIfBelowTouchTarget,
} from '../../src/utils/touch-target'

function stubElement(width: number, height: number, after?: Partial<Record<'top' | 'right' | 'bottom' | 'left' | 'content' | 'position', string>>) {
    const el = document.createElement('button')
    el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation(((target: Element, pseudo?: string | null) => {
        const base = { content: 'none', position: 'static', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto' }
        const values = pseudo === '::after' && target === el ? { ...base, ...after } : base
        return { getPropertyValue: (name: string) => (values as Record<string, string>)[name] ?? '' } as CSSStyleDeclaration
    }) as typeof window.getComputedStyle)
    return { el, restore: () => spy.mockRestore() }
}

describe('touch-target', () => {
    afterEach(() => vi.restoreAllMocks())

    it('uses the 44px platform minimum', () => {
        expect(MIN_TOUCH_TARGET_PX).toBe(44)
    })

    it('measures the element box when no ::after hit-area extension exists', () => {
        const { el } = stubElement(36, 36)
        expect(measureTouchTarget(el)).toEqual({ width: 36, height: 36, ok: false })
    })

    it('counts an out-of-flow ::after extension (the calm 32px pill + 44px hit area pattern)', () => {
        const { el } = stubElement(32, 32, { content: '""', position: 'absolute', top: '-7px', bottom: '-7px', left: '-7px', right: '-7px' })
        expect(measureTouchTarget(el)).toEqual({ width: 46, height: 46, ok: true })
    })

    it('ignores ::after when it is not rendered or not positioned', () => {
        const { el } = stubElement(32, 32, { content: 'none', position: 'absolute', top: '-7px', bottom: '-7px', left: '-7px', right: '-7px' })
        expect(measureTouchTarget(el).ok).toBe(false)
    })

    it('warns below the minimum and stays quiet at or above it', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const small = stubElement(40, 44)
        expect(warnIfBelowTouchTarget(small.el, 'mode toggle')).toBe(false)
        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0][0])).toContain('mode toggle')
        expect(String(warn.mock.calls[0][0])).toContain('40×44')
        small.restore()

        const big = stubElement(52, 52)
        expect(warnIfBelowTouchTarget(big.el, 'hidden row')).toBe(true)
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it('does not warn for an element that is not laid out (display:none / detached)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { el } = stubElement(0, 0)
        expect(warnIfBelowTouchTarget(el, 'hidden')).toBe(true)
        expect(warn).not.toHaveBeenCalled()
    })
})
