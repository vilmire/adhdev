/**
 * anchored-menu-position — pure viewport-collision math for popups anchored to
 * a trigger (the mobile inbox row "…" menu). The popup is portaled to <body>
 * and positioned `fixed`, so it must be placed from the trigger's viewport
 * rect by hand; extracting the math here keeps it deterministic and
 * unit-testable without a DOM. Mirrors the languageMenuPosition.ts pattern,
 * generalized for a right-aligned, prefer-below menu.
 *
 * Placement rules:
 *  - Prefer BELOW the trigger; flip ABOVE when there isn't enough room below
 *    and there is more room above (last row in a bucket, cards near the
 *    bottom nav).
 *  - The menu is right-aligned to the trigger, then clamped horizontally so
 *    it never leaves the visible viewport.
 *  - `maxHeight` is capped to the ACTUAL space on the chosen side (the menu
 *    scrolls with overflow-y:auto); there is deliberately no minimum floor —
 *    a floor larger than the remaining visible space would re-introduce the
 *    clipping this helper exists to fix (short landscape/keyboard viewports).
 *  - `viewport` is the VISIBLE region in client coordinates (see
 *    `resolveVisibleViewport`), not necessarily the full layout viewport, so
 *    the iOS keyboard / browser chrome / safe-area exclusion happens exactly
 *    once.
 */

export interface AnchoredRect {
    top: number
    left: number
    right: number
    bottom: number
    width: number
    height: number
}

/** Visible region in client (fixed-positioning) coordinates. */
export interface VisibleViewport {
    top: number
    left: number
    width: number
    height: number
}

export interface AnchoredMenuPlacement {
    top: number
    left: number
    width: number
    maxHeight: number
    openUp: boolean
}

export interface ComputeAnchoredMenuArgs {
    trigger: AnchoredRect
    /** Natural (unclamped) menu size. */
    menu: { width: number; height: number }
    viewport: VisibleViewport
    /** Gap between trigger and menu, px. Defaults to 4 (matches mt-1). */
    gap?: number
    /** Min inset from the visible viewport edges, px. Defaults to 8. */
    margin?: number
}

/**
 * Compute the `fixed` position + size caps for a trigger-anchored menu so it
 * stays fully inside the visible viewport.
 */
export function computeAnchoredMenuPlacement({
    trigger,
    menu,
    viewport,
    gap = 4,
    margin = 8,
}: ComputeAnchoredMenuArgs): AnchoredMenuPlacement {
    const viewportBottom = viewport.top + viewport.height
    const viewportRight = viewport.left + viewport.width

    const spaceBelow = viewportBottom - margin - (trigger.bottom + gap)
    const spaceAbove = trigger.top - gap - (viewport.top + margin)

    // Prefer below; flip up only when below can't fit the menu and above has
    // strictly more room.
    const openUp = spaceBelow < menu.height && spaceAbove > spaceBelow

    const available = Math.max(0, openUp ? spaceAbove : spaceBelow)
    // No floor: never cap larger than the space that actually remains.
    const maxHeight = Math.max(0, Math.min(menu.height, available))

    let top = openUp ? trigger.top - gap - maxHeight : trigger.bottom + gap
    top = clamp(top, viewport.top + margin, Math.max(viewport.top + margin, viewportBottom - margin - maxHeight))

    // Right-align to the trigger (the old CSS was `absolute right-0`), then
    // clamp horizontally into the visible viewport; narrow viewports also cap
    // the width.
    const width = Math.min(menu.width, Math.max(0, viewport.width - margin * 2))
    const left = clamp(
        trigger.right - width,
        viewport.left + margin,
        Math.max(viewport.left + margin, viewportRight - margin - width),
    )

    return { top, left, width, maxHeight, openUp }
}

export interface ResolveVisibleViewportArgs {
    /** Layout viewport size (window.innerWidth / innerHeight). */
    innerWidth: number
    innerHeight: number
    /** window.visualViewport, when supported. */
    visualViewport?: { offsetTop: number; offsetLeft: number; width: number; height: number } | null
    /** CSS env(safe-area-inset-*) values resolved once from a probe element. */
    safeAreaInsets?: { top: number; right: number; bottom: number; left: number }
}

/**
 * The one place viewport offsets and safe-area insets are combined.
 *
 * `getBoundingClientRect` and `position:fixed` share layout-viewport client
 * coordinates, and visualViewport.offset* already sit in that same space —
 * so the visible region is a direct read, no conversion. The only double-
 * counting hazard is the safe area: browser chrome (e.g. the Safari toolbar)
 * can shrink the visual viewport over a region that ALSO contains a safe-area
 * inset. Subtracting both would exclude the same strip twice, so each inset
 * is reduced by what the visual viewport has already excluded on that edge.
 */
export function resolveVisibleViewport({
    innerWidth,
    innerHeight,
    visualViewport,
    safeAreaInsets,
}: ResolveVisibleViewportArgs): VisibleViewport {
    const base: VisibleViewport = visualViewport
        ? {
            top: visualViewport.offsetTop,
            left: visualViewport.offsetLeft,
            width: visualViewport.width,
            height: visualViewport.height,
        }
        : { top: 0, left: 0, width: innerWidth, height: innerHeight }

    if (!safeAreaInsets) return base

    const excludedAbove = Math.max(0, base.top)
    const excludedBelow = Math.max(0, innerHeight - (base.top + base.height))
    const excludedLeft = Math.max(0, base.left)
    const excludedRight = Math.max(0, innerWidth - (base.left + base.width))

    const insetTop = Math.max(0, safeAreaInsets.top - excludedAbove)
    const insetBottom = Math.max(0, safeAreaInsets.bottom - excludedBelow)
    const insetLeft = Math.max(0, safeAreaInsets.left - excludedLeft)
    const insetRight = Math.max(0, safeAreaInsets.right - excludedRight)

    return {
        top: base.top + insetTop,
        left: base.left + insetLeft,
        width: Math.max(0, base.width - insetLeft - insetRight),
        height: Math.max(0, base.height - insetTop - insetBottom),
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}
