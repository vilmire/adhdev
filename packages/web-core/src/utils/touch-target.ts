/**
 * Touch-target floor for tappable controls (WCAG 2.5.5 / Apple HIG: 44×44 CSS px).
 *
 * Many controls keep a calm 32–36px visual footprint and reach the floor
 * through an out-of-flow `::after` hit-area extension (owner decision
 * 2026-10-21, see the "Touch hit-target restoration" block in index.css), so
 * the measurement adds a positioned, rendered `::after`'s negative insets to
 * the element box instead of reading the box alone.
 */
export const MIN_TOUCH_TARGET_PX = 44

export interface TouchTargetMeasure {
    width: number
    height: number
    ok: boolean
}

function negativeInset(value: string): number {
    const px = Number.parseFloat(value)
    return Number.isFinite(px) && px < 0 ? -px : 0
}

export function measureTouchTarget(el: Element): TouchTargetMeasure {
    const rect = el.getBoundingClientRect()
    let width = rect.width
    let height = rect.height
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const after = window.getComputedStyle(el, '::after')
        const content = after.getPropertyValue('content')
        const position = after.getPropertyValue('position')
        if (content && content !== 'none' && content !== 'normal' && (position === 'absolute' || position === 'fixed')) {
            width += negativeInset(after.getPropertyValue('left')) + negativeInset(after.getPropertyValue('right'))
            height += negativeInset(after.getPropertyValue('top')) + negativeInset(after.getPropertyValue('bottom'))
        }
    }
    return { width, height, ok: width >= MIN_TOUCH_TARGET_PX && height >= MIN_TOUCH_TARGET_PX }
}

/**
 * Console-warns when a laid-out control is below the floor; returns whether it
 * passes. Elements with no box (display:none, detached) are not judged.
 * Diagnostics only — never changes layout or blocks the control.
 */
export function warnIfBelowTouchTarget(el: Element, label: string): boolean {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return true
    const measure = measureTouchTarget(el)
    if (!measure.ok) {
        console.warn(
            `[touch-target] ${label} hit area ${Math.round(measure.width)}×${Math.round(measure.height)}px is below ${MIN_TOUCH_TARGET_PX}×${MIN_TOUCH_TARGET_PX}px`,
        )
    }
    return measure.ok
}

function isTouchLayout(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(max-width: 767px), (pointer: coarse)').matches
}

function isDevBuild(): boolean {
    return !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV
}

/**
 * Dev-build audit: on a touch layout (the same query index.css uses for its
 * hit-area extensions), warn for every `selector` match inside `container`
 * whose hit area is under the floor. Production builds skip it entirely.
 */
export function auditTouchTargets(container: Element | null, selector: string, label: string): void {
    if (!container || !isDevBuild() || !isTouchLayout()) return
    container.querySelectorAll(selector).forEach(el => {
        warnIfBelowTouchTarget(el, `${label} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`)
    })
}
