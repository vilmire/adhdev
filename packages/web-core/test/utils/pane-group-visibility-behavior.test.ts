/**
 * Behavioral suite for the pane-group visibility rule.
 *
 * This replaces the `PaneGroupContent.tsx` / `ChatPane.tsx` source-text
 * assertions in the old `test/utils/cli-terminal-measured-layout.test.ts`, which
 * matched strings like
 * `expect(paneGroupSource.includes("visibility: showTerminalPane ? 'visible' : 'hidden'")).toBe(true)`
 * and `expect(paneGroupSource.includes("display: isCliTerminal ? 'flex' : 'none'")).toBe(false)`.
 *
 * The rule those assertions were protecting is a real invariant with a real
 * regression behind it. Both CLI panes (terminal and chat) stay MOUNTED and are
 * toggled with `visibility`, never `display:none` and never conditional
 * rendering, because an unmounted or display-none xterm measures against a
 * zero-size box — which is what made the terminal come back mis-sized after a
 * tab switch. The consequence is that a pane can be mounted while not being
 * shown, so "is this pane actually visible to the user?" is the product of the
 * parent's visibility and the pane's own slot — which is exactly what
 * `getPaneGroupContentChildVisibility` computes, and what the child panes gate
 * their subscriptions and input focus on.
 *
 * That function is the extracted, directly testable form of the rule, so it is
 * tested directly rather than by reading the JSX around it.
 */
import { describe, expect, it } from 'vitest'

import { getPaneGroupContentChildVisibility } from '../../src/components/dashboard/PaneGroupContent'

describe('getPaneGroupContentChildVisibility', () => {
    it('is visible when the parent is visible and the pane owns the slot', () => {
        expect(getPaneGroupContentChildVisibility(true, true)).toBe(true)
    })

    it('is hidden when the parent is hidden, even for the pane that owns the slot', () => {
        // The whole tab is off-screen: the terminal is still mounted (so it keeps
        // its buffer and geometry) but must not be treated as visible, or it will
        // write and measure against a zero-size box.
        expect(getPaneGroupContentChildVisibility(false, true)).toBe(false)
    })

    it('is hidden when the parent is visible but the pane does not own the slot', () => {
        // Chat and terminal share one measured slot; the one not selected is
        // mounted-but-hidden.
        expect(getPaneGroupContentChildVisibility(true, false)).toBe(false)
    })

    it('is hidden when neither the parent nor the slot is active', () => {
        expect(getPaneGroupContentChildVisibility(false, false)).toBe(false)
    })

    it('treats an unspecified parent visibility as visible', () => {
        // Callers that never pass `isVisible` (single-pane hosts) must not have
        // every child silently gated off.
        expect(getPaneGroupContentChildVisibility(undefined, true)).toBe(true)
        expect(getPaneGroupContentChildVisibility(undefined, false)).toBe(false)
    })

    it('defaults the local slot to owned when it is not specified', () => {
        expect(getPaneGroupContentChildVisibility(true)).toBe(true)
        expect(getPaneGroupContentChildVisibility(false)).toBe(false)
        expect(getPaneGroupContentChildVisibility(undefined)).toBe(true)
    })

    it('is exactly the conjunction of the two inputs', () => {
        // Stated as a property so a future refactor to e.g. `parent || local`
        // fails here rather than in a screenshot two releases later.
        for (const parent of [true, false]) {
            for (const local of [true, false]) {
                expect(getPaneGroupContentChildVisibility(parent, local)).toBe(parent && local)
            }
        }
    })
})
