// Pure viewport-collision math for the mobile inbox row "…" menu overlay.
// The defect these rules pin: the menu was inline `absolute` inside a rounded
// `overflow-hidden` row, so on the LAST card of a bucket the Hide item was
// clipped away. The overlay must flip/clamp instead — these cases cover
// below/above preference, both-axis clamping, visualViewport offsets and the
// safe-area "subtract exactly once" rule.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
    computeAnchoredMenuPlacement,
    resolveVisibleViewport,
    type AnchoredRect,
    type VisibleViewport,
} from '../../src/components/dashboard/anchored-menu-position'

const fullViewport: VisibleViewport = { top: 0, left: 0, width: 390, height: 844 }
const menu = { width: 192, height: 96 } // two 44px-ish items + padding, as rendered

function trigger(top: number, bottom = top + 64): AnchoredRect {
    return { top, left: 150, right: 374, bottom, width: 224, height: bottom - top }
}

describe('computeAnchoredMenuPlacement', () => {
    it('opens below the trigger, right-aligned, when there is room (first/middle card)', () => {
        const placement = computeAnchoredMenuPlacement({ trigger: trigger(100), menu, viewport: fullViewport })
        expect(placement.openUp).toBe(false)
        expect(placement.top).toBe(164 + 4) // trigger.bottom + gap
        expect(placement.left).toBe(374 - 192) // right-aligned
        expect(placement.maxHeight).toBe(96)
    })

    it('flips above the trigger when the space below cannot fit the menu (last card)', () => {
        const placement = computeAnchoredMenuPlacement({ trigger: trigger(700), menu, viewport: fullViewport })
        expect(placement.openUp).toBe(true)
        expect(placement.top).toBe(700 - 4 - 96)
        expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(700 - 4)
        expect(placement.maxHeight).toBe(96)
    })

    it('clamps the menu into the viewport when neither side fits fully (short viewport)', () => {
        const short: VisibleViewport = { top: 0, left: 0, width: 390, height: 220 }
        const tallMenu = { width: 192, height: 140 }
        const placement = computeAnchoredMenuPlacement({ trigger: trigger(120), menu: tallMenu, viewport: short })
        expect(placement.openUp).toBe(true) // above (108px) has more room than below (24px)
        expect(placement.maxHeight).toBe(108) // capped to the space above
        expect(placement.top).toBeGreaterThanOrEqual(8)
        expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(220 - 8)
    })

    it('never reserves more height than the visible space that actually remains', () => {
        // A minimum-height floor (like the language menu's 80px) would overflow
        // the viewport again on a keyboard-shrunk screen: with a 200px-tall menu
        // and only 138px free on the better side, the cap must be exactly 138.
        const cramped: VisibleViewport = { top: 0, left: 0, width: 390, height: 300 }
        const placement = computeAnchoredMenuPlacement({
            trigger: trigger(150, 170),
            menu: { width: 192, height: 200 },
            viewport: cramped,
        })
        expect(placement.openUp).toBe(true)
        expect(placement.maxHeight).toBe(150 - 4 - 8)
        expect(placement.top).toBeGreaterThanOrEqual(8)
        expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(300 - 8)
    })

    it('clamps horizontally so the menu never leaves the visible viewport', () => {
        const wide = { width: 300, height: 96 }
        const placement = computeAnchoredMenuPlacement({ trigger: trigger(100), menu: wide, viewport: fullViewport })
        expect(placement.left).toBeGreaterThanOrEqual(8)
        expect(placement.left + placement.width).toBeLessThanOrEqual(390 - 8)
        // Narrower than the menu itself: width is capped, not overflowing.
        const narrow: VisibleViewport = { top: 0, left: 0, width: 160, height: 844 }
        const capped = computeAnchoredMenuPlacement({ trigger: trigger(100), menu: wide, viewport: narrow })
        expect(capped.width).toBe(160 - 16)
        expect(capped.left).toBe(8)
    })

    it('respects a visualViewport offset region (PWA keyboard / browser chrome)', () => {
        const visible: VisibleViewport = { top: 40, left: 0, width: 390, height: 500 }
        const placement = computeAnchoredMenuPlacement({ trigger: trigger(500, 528), menu, viewport: visible })
        expect(placement.openUp).toBe(true)
        expect(placement.top).toBeGreaterThanOrEqual(40 + 8)
        expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(540 - 8)
    })
})

describe('resolveVisibleViewport — offsets and safe area, consumed exactly once', () => {
    it('falls back to the layout viewport when visualViewport is unsupported', () => {
        expect(resolveVisibleViewport({ innerWidth: 390, innerHeight: 844 })).toEqual(fullViewport)
    })

    it('maps visualViewport offsets straight into client coordinates', () => {
        expect(resolveVisibleViewport({
            innerWidth: 390,
            innerHeight: 844,
            visualViewport: { offsetTop: 100, offsetLeft: 0, width: 390, height: 500 },
        })).toEqual({ top: 100, left: 0, width: 390, height: 500 })
    })

    it('subtracts the home-indicator inset once in standalone (visual viewport NOT shrunk)', () => {
        expect(resolveVisibleViewport({
            innerWidth: 390,
            innerHeight: 844,
            visualViewport: { offsetTop: 0, offsetLeft: 0, width: 390, height: 844 },
            safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
        })).toEqual({ top: 59, left: 0, width: 390, height: 844 - 59 - 34 })
    })

    it('does NOT double-subtract an inset the visual viewport already excluded', () => {
        // Browser chrome shrank the visual viewport by 90px at the bottom; the
        // 34px home-indicator inset lives inside that excluded strip, so the
        // effective extra exclusion is 0 — not another 34px.
        expect(resolveVisibleViewport({
            innerWidth: 390,
            innerHeight: 844,
            visualViewport: { offsetTop: 0, offsetLeft: 0, width: 390, height: 754 },
            safeAreaInsets: { top: 0, right: 0, bottom: 34, left: 0 },
        })).toEqual({ top: 0, left: 0, width: 390, height: 754 })
    })

    it('subtracts only the part of the inset not already excluded', () => {
        // 20px of the 34px inset is outside the visual viewport already.
        expect(resolveVisibleViewport({
            innerWidth: 390,
            innerHeight: 844,
            visualViewport: { offsetTop: 0, offsetLeft: 0, width: 390, height: 824 },
            safeAreaInsets: { top: 0, right: 0, bottom: 34, left: 0 },
        })).toEqual({ top: 0, left: 0, width: 390, height: 824 - 14 })
    })
})

describe('browser hit-test guard helper (actual source from mobile-inbox-row-menu-overlay.browser.test.tsx)', () => {
    function loadActualHitTestHelpers(getHit: () => unknown) {
        const browserTestFile = path.resolve(
            __dirname,
            '../../test-browser/components/mobile-inbox-row-menu-overlay.browser.test.tsx',
        )
        const sourceText = fs.readFileSync(browserTestFile, 'utf8')
        const ast = ts.createSourceFile(browserTestFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        const extracted = ast.statements
            .filter(
                (node): node is ts.FunctionDeclaration =>
                    ts.isFunctionDeclaration(node) &&
                    ['center', 'hitTest', 'expectHitTestable'].includes(node.name?.text ?? ''),
            )
            .map(node => node.getText(ast))
            .join('\n')
        const transpiled = ts.transpileModule(extracted, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText
        let lastAssertionOk: boolean | undefined
        let lastAssertionMessage = ''
        const context = {
            document: {
                elementFromPoint: () => getHit(),
            },
            expect: (ok: boolean, message: string) => ({
                toBe: (expected: boolean) => {
                    lastAssertionOk = ok
                    lastAssertionMessage = message
                    if (ok !== expected) {
                        throw new Error(message)
                    }
                },
            }),
        }
        vm.createContext(context)
        vm.runInContext(transpiled, context)
        return {
            expectHitTestable: (context as unknown as { expectHitTestable: (el: unknown, ctx: string) => void }).expectHitTestable,
            getLastResult: () => ({ ok: lastAssertionOk, message: lastAssertionMessage }),
        }
    }

    const childPath = { tagName: ' path', className: '', contains: (node: unknown) => node === childPath }
    const childSvg = {
        tagName: 'svg',
        className: 'lucide-eye-off',
        contains: (node: unknown) => node === childSvg || node === childPath,
    }
    const childSpan = {
        tagName: 'SPAN',
        className: 'menu-label',
        contains: (node: unknown) => node === childSpan,
    }
    const targetMenuItem = {
        tagName: 'BUTTON',
        className: 'mobile-inbox-hide-button',
        getBoundingClientRect: () => ({ x: 200, y: 300, width: 160, height: 44 }),
        contains: (node: unknown) =>
            node === targetMenuItem || node === childSpan || node === childSvg || node === childPath,
    }
    const wrongMenuItem = {
        tagName: 'BUTTON',
        className: 'mobile-inbox-mute-button',
        contains: (node: unknown) => node === wrongMenuItem,
    }
    const menuContainer = {
        tagName: 'DIV',
        className: 'fixed z-[var(--z-popover)]',
        contains: (node: unknown) =>
            node === menuContainer || targetMenuItem.contains(node) || wrongMenuItem.contains(node),
    }
    const otherRow = {
        tagName: 'DIV',
        className: 'group',
        contains: (node: unknown) => node === otherRow,
    }
    const hiddenTabsToggle = {
        tagName: 'BUTTON',
        className: 'mobile-hidden-tabs-toggle',
        contains: (node: unknown) => node === hiddenTabsToggle,
    }
    const documentBody = {
        tagName: 'BODY',
        className: '',
        contains: () => true,
    }

    it('accepts the intended menuitem itself and genuine descendant span/svg/path elements', () => {
        let currentHit: unknown = targetMenuItem
        const { expectHitTestable, getLastResult } = loadActualHitTestHelpers(() => currentHit)

        for (const positive of [targetMenuItem, childSpan, childSvg, childPath]) {
            currentHit = positive
            expect(() => expectHitTestable(targetMenuItem, 'positive control')).not.toThrow()
            expect(getLastResult().ok).toBe(true)
        }
    })

    it('rejects document.body, null, ancestor menu container, other row, Hidden tabs button, and wrong sibling menuitem', () => {
        let currentHit: unknown = null
        const { expectHitTestable, getLastResult } = loadActualHitTestHelpers(() => currentHit)

        for (const [label, negative] of [
            ['document.body', documentBody],
            ['null', null],
            ['ancestor menu container', menuContainer],
            ['other row', otherRow],
            ['Hidden tabs toggle', hiddenTabsToggle],
            ['wrong menuitem', wrongMenuItem],
        ] as const) {
            currentHit = negative
            expect(() => expectHitTestable(targetMenuItem, `negative ${label}`)).toThrow(
                /must hit the item itself or its descendant/,
            )
            expect(getLastResult().ok).toBe(false)
        }
    })
})
