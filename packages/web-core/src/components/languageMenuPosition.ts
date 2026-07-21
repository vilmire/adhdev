/**
 * languageMenuPosition — pure viewport-collision math for the LanguageSelector popover.
 *
 * The popover is portaled to <body> and positioned `fixed`, so it must be placed
 * from the trigger's viewport rect by hand (no CSS `absolute` anchor). Extracting
 * the math here keeps it deterministic and unit-testable without a DOM.
 *
 * Placement rules, mirroring the previous CSS behaviour but now viewport-aware:
 *  - "sidebar" variant opens UPWARD (the trigger lives in the sidebar footer at the
 *    bottom of the screen); "landing" opens DOWNWARD (header at the top).
 *  - The chosen side flips if there isn't enough room, so the menu never leaves the
 *    viewport on short heights.
 *  - The menu is left-aligned to the trigger, then clamped horizontally so it stays
 *    fully on-screen — this is what fixes the collapsed (56px) sidebar clipping,
 *    where a 168px menu would otherwise overflow the narrow sidebar / left edge.
 *  - `maxHeight` is capped to the available space so long lists scroll instead of
 *    spilling off-screen on short viewports.
 */

export interface Rect {
    top: number
    left: number
    right: number
    bottom: number
    width: number
    height: number
}

export interface Viewport {
    width: number
    height: number
}

export interface LangMenuStyle {
    /** `fixed` offset from the top of the viewport, in px (set when opening downward). */
    top?: number
    /** `fixed` offset from the left of the viewport, in px. */
    left: number
    /** Cap so the list scrolls rather than overflowing the viewport. */
    maxHeight: number
}

export interface ComputeArgs {
    trigger: Rect
    viewport: Viewport
    /** Natural (unclamped) menu size. */
    menu: { width: number; height: number }
    variant: 'sidebar' | 'landing'
    /** Gap between trigger and menu, px. Defaults to 6. */
    gap?: number
    /** Min inset from viewport edges, px. Defaults to 8. */
    margin?: number
}

/**
 * Compute the `fixed` position + max-height for the language popover so it stays
 * next to its trigger and fully inside the viewport.
 */
export function computeLanguageMenuPosition({
    trigger,
    viewport,
    menu,
    variant,
    gap = 6,
    margin = 8,
}: ComputeArgs): LangMenuStyle {
    const spaceAbove = trigger.top - margin
    const spaceBelow = viewport.height - trigger.bottom - margin

    // Preferred side per variant, but flip when the preferred side can't fit the
    // menu and the opposite side has more room.
    const prefersUp = variant === 'sidebar'
    let openUp = prefersUp
    if (prefersUp && spaceAbove < menu.height && spaceBelow > spaceAbove) openUp = false
    if (!prefersUp && spaceBelow < menu.height && spaceAbove > spaceBelow) openUp = true

    const available = openUp ? spaceAbove : spaceBelow
    // Never smaller than a couple of rows; the list scrolls inside this cap.
    const maxHeight = Math.max(80, Math.min(menu.height, available))

    let top: number
    if (openUp) {
        top = trigger.top - gap - maxHeight
    } else {
        top = trigger.bottom + gap
    }
    // Final clamp so rounding / a too-tall cap can't push it off either edge.
    top = clamp(top, margin, Math.max(margin, viewport.height - maxHeight - margin))

    // Left-align to the trigger, then clamp horizontally into the viewport.
    const left = clamp(
        trigger.left,
        margin,
        Math.max(margin, viewport.width - menu.width - margin),
    )

    return { top, left, maxHeight }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}
