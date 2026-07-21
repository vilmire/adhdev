import { describe, expect, it } from 'vitest'

import {
    computeLanguageMenuPosition,
    type Rect,
} from '../../src/components/languageMenuPosition'

// A sidebar-footer trigger near the bottom-left of the viewport.
function sidebarTrigger(overrides: Partial<Rect> = {}): Rect {
    return {
        top: 760,
        bottom: 792,
        left: 8,
        right: 200,
        width: 192,
        height: 32,
        ...overrides,
    }
}

// A collapsed-sidebar trigger: only 40px wide, hugging the left edge.
function collapsedTrigger(overrides: Partial<Rect> = {}): Rect {
    return {
        top: 760,
        bottom: 792,
        left: 8,
        right: 48,
        width: 40,
        height: 32,
        ...overrides,
    }
}

const VIEWPORT = { width: 1280, height: 800 }
const MENU = { width: 168, height: 220 }

describe('computeLanguageMenuPosition', () => {
    it('opens upward for the sidebar variant when there is room above', () => {
        const style = computeLanguageMenuPosition({
            trigger: sidebarTrigger(),
            viewport: VIEWPORT,
            menu: MENU,
            variant: 'sidebar',
        })
        // Menu bottom sits just above the trigger top (gap = 6).
        expect(style.top + style.maxHeight).toBeLessThanOrEqual(sidebarTrigger().top - 6 + 0.5)
        expect(style.top).toBeGreaterThanOrEqual(8)
    })

    it('opens downward for the landing variant', () => {
        const trigger = sidebarTrigger({ top: 12, bottom: 44 })
        const style = computeLanguageMenuPosition({
            trigger,
            viewport: VIEWPORT,
            menu: MENU,
            variant: 'landing',
        })
        expect(style.top).toBeGreaterThanOrEqual(trigger.bottom)
    })

    it('keeps the collapsed-sidebar menu fully on-screen (left edge, not clipped)', () => {
        // The core bug: a 168px menu anchored to a 40px collapsed trigger must not
        // spill off the left edge. Left must stay >= margin and within the viewport.
        const style = computeLanguageMenuPosition({
            trigger: collapsedTrigger(),
            viewport: VIEWPORT,
            menu: MENU,
            variant: 'sidebar',
        })
        expect(style.left).toBeGreaterThanOrEqual(8)
        expect(style.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - 8)
    })

    it('clamps left so the menu never overflows the right edge', () => {
        // Trigger pinned to the right edge — menu would overflow if left-aligned raw.
        const style = computeLanguageMenuPosition({
            trigger: sidebarTrigger({ left: 1250, right: 1272, width: 22 }),
            viewport: VIEWPORT,
            menu: MENU,
            variant: 'sidebar',
        })
        expect(style.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - 8)
    })

    it('flips to open downward when there is no room above', () => {
        // Trigger near the very top: not enough space above, so flip down.
        const trigger = sidebarTrigger({ top: 40, bottom: 72 })
        const style = computeLanguageMenuPosition({
            trigger,
            viewport: VIEWPORT,
            menu: MENU,
            variant: 'sidebar',
        })
        expect(style.top).toBeGreaterThanOrEqual(trigger.bottom)
    })

    it('caps max-height on a short viewport so the list scrolls instead of spilling', () => {
        const shortViewport = { width: 1280, height: 240 }
        const style = computeLanguageMenuPosition({
            trigger: sidebarTrigger({ top: 200, bottom: 232 }),
            viewport: shortViewport,
            menu: MENU,
            variant: 'sidebar',
        })
        expect(style.maxHeight).toBeLessThan(MENU.height)
        expect(style.maxHeight).toBeGreaterThanOrEqual(80)
        // Still fully within the viewport bounds.
        expect(style.top).toBeGreaterThanOrEqual(8)
        expect(style.top + style.maxHeight).toBeLessThanOrEqual(shortViewport.height - 8 + 0.5)
    })
})
