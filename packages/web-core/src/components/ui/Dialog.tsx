/**
 * Dialog — canonical modal shell primitives.
 *
 * Two layers:
 *
 *   `DialogShell` — the behavior/shell layer every dashboard dialog shares:
 *     - single portal into <body> so stacking context is predictable
 *     - fixed full-viewport overlay + backdrop-click-to-close policy
 *     - close on Escape (bubble phase — see note below)
 *     - role="dialog" / aria-modal semantics on the content surface
 *     With `chrome` (default) it also paints the canonical overlay/surface
 *     styling (tokens, z-scale, safe-area padding, size caps). With
 *     `chrome={false}` it renders ONLY the structural minimum
 *     (`fixed inset-0 flex` + alignment) and the consumer's own classes
 *     verbatim — used by dialogs that keep bespoke visuals (mesh graph theme
 *     shell, bottom-sheet cards) while sharing the shell behavior.
 *
 *   `Dialog` — the headed convenience built ON TOP of DialogShell: header
 *     row (title + ✕), scrollable body, footer slot. Existing consumers
 *     (SessionInfoDialog, …) keep their exact behavior.
 *
 * Design invariants:
 *   - Chrome mode uses ONLY canonical design tokens (surface-primary,
 *     border-default, text-*) and the canonical z-index scale
 *     (var(--z-modal-backdrop) overlay / var(--z-modal) surface — index.css).
 *   - Escape closes via a *bubble-phase* document listener on purpose:
 *     nested popovers that must win Escape (e.g. MeshBlueprintView's
 *     scheduling popover, MeshOverviewCards' DetailModal via
 *     installTopModalEscapeHandler) attach capture-phase window listeners and
 *     stopPropagation — the shell must never fire before them.
 *   - Pure UI: imports nothing from daemon-core. React + react-dom only.
 *   - SSR / test-safe: when `document` is unavailable (Node/vitest render)
 *     the tree renders inline instead of through a portal, so
 *     renderToStaticMarkup works without a DOM.
 */
import i18next from 'i18next'
import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import { IconX } from '../Icons'

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not(:disabled)',
    'input:not(:disabled):not([type="hidden"])',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    '[tabindex]:not([tabindex="-1"])',
].join(',')

function isElementFocusableAndVisible(el: HTMLElement, container: HTMLElement): boolean {
    if (el.hasAttribute('disabled') || el.hasAttribute('hidden')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false

    let current: HTMLElement | null = el
    while (current) {
        const inlineDisplay = current.style?.display
        const inlineVisibility = current.style?.visibility
        if (inlineDisplay === 'none' || inlineVisibility === 'hidden' || inlineVisibility === 'collapse') {
            return false
        }
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            const computed = window.getComputedStyle(current)
            if (
                computed.display === 'none'
                || computed.visibility === 'hidden'
                || computed.visibility === 'collapse'
            ) {
                return false
            }
        }
        if (current === container || current === document.body) break
        current = current.parentElement
    }
    return true
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => isElementFocusableAndVisible(el, container),
    )
}

function focusFirstAvailable(surface: HTMLElement, candidates: HTMLElement[]): void {
    for (const candidate of candidates) {
        candidate.focus({ preventScroll: true })
        if (typeof document !== 'undefined' && document.activeElement === candidate) {
            return
        }
    }
    surface.focus({ preventScroll: true })
}

interface DialogStackEntry {
    overlay: HTMLDivElement
    surface: HTMLDivElement
    depth: number
    order: number
}

const DialogDepthContext = createContext<number>(0)
const openDialogEntries: DialogStackEntry[] = []
const inertManagedBodyChildren = new Set<HTMLElement>()
let nextDialogMountOrder = 0
let initialStackTriggerElement: HTMLElement | null = null

function sortDialogEntries() {
    openDialogEntries.sort((a, b) => (a.depth - b.depth) || (a.order - b.order))
    if (typeof document !== 'undefined' && document.body && openDialogEntries.length > 1) {
        for (let i = openDialogEntries.length - 1; i > 0; i -= 1) {
            const higher = openDialogEntries[i]!
            const lower = openDialogEntries[i - 1]!
            if (
                higher.overlay.parentElement === document.body
                && lower.overlay.parentElement === document.body
                && (higher.overlay.compareDocumentPosition(lower.overlay) & Node.DOCUMENT_POSITION_FOLLOWING)
            ) {
                document.body.insertBefore(lower.overlay, higher.overlay)
            }
        }
    }
}

function getTopDialogEntry(): DialogStackEntry | null {
    return openDialogEntries[openDialogEntries.length - 1] ?? null
}

function hasExternalModalAbove(overlay: HTMLElement): boolean {
    if (typeof document === 'undefined' || !document.body) return false
    const modals = document.body.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]')
    for (const modal of Array.from(modals)) {
        if (modal === overlay || overlay.contains(modal) || modal.contains(overlay)) continue
        const isRegisteredDialog = openDialogEntries.some(
            (entry) => entry.overlay === modal || entry.overlay.contains(modal),
        )
        if (isRegisteredDialog) continue
        if (modal.closest('[inert], [hidden], [aria-hidden="true"]')) continue
        if (overlay.compareDocumentPosition(modal) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return true
        }
    }
    return false
}

function syncDialogBodyInertness() {
    if (typeof document === 'undefined' || !document.body) return
    const topEntry = getTopDialogEntry()
    const topOverlay = topEntry?.overlay ?? null
    for (const child of Array.from(document.body.children)) {
        if (!(child instanceof HTMLElement)) continue
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue
        const isAfterTopOverlayWithExternalDialog = Boolean(
            topOverlay
            && child !== topOverlay
            && !openDialogEntries.some((entry) => entry.overlay === child || child.contains(entry.overlay))
            && (topOverlay.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING)
            && (child.matches('[role="dialog"], [aria-modal="true"]') || child.querySelector('[role="dialog"], [aria-modal="true"]')),
        )
        const shouldBeInert = Boolean(
            topOverlay
            && child !== topOverlay
            && !child.contains(topOverlay)
            && !isAfterTopOverlayWithExternalDialog,
        )
        if (shouldBeInert) {
            if (!child.inert && !child.hasAttribute('inert')) {
                child.inert = true
                child.setAttribute('inert', '')
                inertManagedBodyChildren.add(child)
            }
        } else if (inertManagedBodyChildren.has(child)) {
            child.inert = false
            child.removeAttribute('inert')
            inertManagedBodyChildren.delete(child)
        }
    }
}

export type DialogSize = 'sm' | 'md' | 'lg'

/** Size presets map to the max-width caps already used by hand-built modals. */
const SIZE_CLASS: Record<DialogSize, string> = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-3xl',
}

/**
 * Overlay alignment variants:
 *   - `center`  — classic centered modal (default)
 *   - `sheet`   — mobile bottom sheet that centers from `sm:` up
 *   - `stretch` — full-height on mobile, centered from `md:` up (mesh dialog)
 */
export type DialogAlign = 'center' | 'sheet' | 'stretch'

const ALIGN_CLASS: Record<DialogAlign, string> = {
    center: 'items-center justify-center',
    sheet: 'items-end justify-center sm:items-center',
    stretch: 'items-stretch justify-center md:items-center',
}

export interface DialogShellProps {
    /** Controls visibility. Defaults to true so `{cond && <DialogShell…>}` call sites work. */
    open?: boolean
    /** Invoked on Escape and/or backdrop click (per the close policies below). */
    onClose: () => void
    /** Overlay alignment variant. Default `center`. */
    align?: DialogAlign
    /** Width preset (chrome mode only). Default `md`. */
    size?: DialogSize
    /**
     * When true (default) the shell paints the canonical overlay/surface
     * chrome and `overlayClassName`/`surfaceClassName` extend it (tailwind-
     * merged). When false the consumer's classes are rendered verbatim on a
     * structural-minimum shell — for dialogs with fully bespoke visuals.
     */
    chrome?: boolean
    /** Close when the backdrop (area outside the surface) is clicked. Default true. */
    closeOnBackdrop?: boolean
    /** Close when Escape is pressed (bubble phase). Default true. */
    closeOnEsc?: boolean
    /** Accessible label for the dialog surface. */
    ariaLabel?: string
    /** Id of the element labelling the dialog surface. */
    ariaLabelledBy?: string
    /** Classes for the overlay element (merged onto chrome defaults, or verbatim when `chrome={false}`). */
    overlayClassName?: string
    /** Classes for the content surface element (same merge rule). */
    surfaceClassName?: string
    /** Surface content. */
    children?: ReactNode
}

/**
 * Shared modal shell. All dashboard dialogs (Dialog, HistoryModal,
 * DashboardNewSessionDialog, DashboardMeshGraphDialog, the dashboard guide)
 * render through this so portal/backdrop/Escape/stacking behavior stays
 * single-sourced.
 *
 * The content surface stops click propagation and the backdrop handler also
 * checks `event.target === event.currentTarget`, so only true backdrop clicks
 * trigger `closeOnBackdrop`.
 */
export function DialogShell({
    open = true,
    onClose,
    align = 'center',
    size = 'md',
    chrome = true,
    closeOnBackdrop = true,
    closeOnEsc = true,
    ariaLabel,
    ariaLabelledBy,
    overlayClassName,
    surfaceClassName,
    children,
}: DialogShellProps) {
    const depth = useContext(DialogDepthContext)
    const overlayRef = useRef<HTMLDivElement | null>(null)
    const surfaceRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (!open || !closeOnEsc) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            const overlay = overlayRef.current
            const topEntry = getTopDialogEntry()
            if (topEntry && overlay && topEntry.overlay !== overlay) return
            if (overlay && hasExternalModalAbove(overlay)) return
            onClose()
        }
        // Bubble phase on purpose — capture-phase inner-layer handlers
        // (scheduling popover, mesh detail modal) must be able to consume
        // Escape before the shell closes the whole dialog.
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [open, closeOnEsc, onClose])

    useEffect(() => {
        if (!open || typeof document === 'undefined') return
        const overlay = overlayRef.current
        const surface = surfaceRef.current
        if (!overlay || !surface) return

        const activeBeforeMount = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
        if (openDialogEntries.length === 0) {
            initialStackTriggerElement = activeBeforeMount
        }
        const activeIsInHigherRegisteredDialog = Boolean(
            activeBeforeMount
            && openDialogEntries.some((entry) => entry.depth > depth && entry.overlay.contains(activeBeforeMount)),
        )
        const previousActiveElement = activeIsInHigherRegisteredDialog
            ? initialStackTriggerElement
            : activeBeforeMount

        const stackEntry: DialogStackEntry = {
            overlay,
            surface,
            depth,
            order: ++nextDialogMountOrder,
        }
        openDialogEntries.push(stackEntry)
        sortDialogEntries()
        syncDialogBodyInertness()

        if (!surface.hasAttribute('tabindex')) {
            surface.tabIndex = -1
        }

        const topOnMount = getTopDialogEntry()
        if (topOnMount && topOnMount.overlay === overlay && !hasExternalModalAbove(overlay)) {
            if (!surface.contains(document.activeElement)) {
                focusFirstAvailable(surface, getFocusableElements(surface))
            }
        } else if (topOnMount && !topOnMount.surface.contains(document.activeElement) && !hasExternalModalAbove(topOnMount.overlay)) {
            focusFirstAvailable(topOnMount.surface, getFocusableElements(topOnMount.surface))
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Tab') return
            const topEntry = getTopDialogEntry()
            if (topEntry && topEntry.overlay !== overlay) return
            if (hasExternalModalAbove(overlay)) return

            const focusables = getFocusableElements(surface)
            if (focusables.length === 0) {
                event.preventDefault()
                surface.focus({ preventScroll: true })
                return
            }

            const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
            const index = active ? focusables.indexOf(active) : -1

            if (event.shiftKey) {
                if (index <= 0 || !surface.contains(active)) {
                    event.preventDefault()
                    focusFirstAvailable(surface, [...focusables].reverse())
                }
            } else if (index === -1 || index === focusables.length - 1 || !surface.contains(active)) {
                event.preventDefault()
                focusFirstAvailable(surface, focusables)
            }
        }

        const onFocusIn = (event: FocusEvent) => {
            const topEntry = getTopDialogEntry()
            if (topEntry && topEntry.overlay !== overlay) return
            if (hasExternalModalAbove(overlay)) return
            const target = event.target instanceof HTMLElement ? event.target : null
            if (!target || surface.contains(target)) return
            const enclosingDialog = target.closest('[role="dialog"], [aria-modal="true"]')
            if (enclosingDialog && enclosingDialog !== surface && !overlay.contains(enclosingDialog)) {
                return
            }
            focusFirstAvailable(surface, getFocusableElements(surface))
        }

        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('focusin', onFocusIn)

        return () => {
            document.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('focusin', onFocusIn)
            const idx = openDialogEntries.indexOf(stackEntry)
            if (idx !== -1) openDialogEntries.splice(idx, 1)
            if (openDialogEntries.length === 0) {
                initialStackTriggerElement = null
            }
            syncDialogBodyInertness()

            if (
                previousActiveElement
                && previousActiveElement.isConnected
                && !previousActiveElement.closest('[inert]')
            ) {
                const currentActive = document.activeElement
                if (!currentActive || currentActive === document.body || surface.contains(currentActive)) {
                    previousActiveElement.focus({ preventScroll: true })
                }
            } else {
                const remainingTop = getTopDialogEntry()
                if (remainingTop && !remainingTop.surface.contains(document.activeElement)) {
                    focusFirstAvailable(remainingTop.surface, getFocusableElements(remainingTop.surface))
                }
            }
        }
    }, [open, depth])

    const onBackdropClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (closeOnBackdrop && event.target === event.currentTarget) onClose()
        },
        [closeOnBackdrop, onClose],
    )

    if (!open) return null

    const overlayClasses = chrome
        ? cn(
            // Safe-area-aware overlay padding: in the iOS installed PWA
            // (viewport-fit=cover) the fixed overlay extends under the
            // status bar / home indicator, so the centered surface must be
            // padded in from those edges to keep the header close control
            // out of the system UI band.
            'fixed inset-0 flex',
            ALIGN_CLASS[align],
            'bg-black/60 px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] pt-[calc(16px+env(safe-area-inset-top,0px))]',
            overlayClassName,
        )
        : cn('fixed inset-0 flex', ALIGN_CLASS[align], overlayClassName)

    const surfaceClasses = chrome
        ? cn(
            'relative flex max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem)] w-full flex-col overflow-hidden',
            'rounded-xl border border-border-default bg-surface-primary shadow-2xl',
            SIZE_CLASS[size],
            surfaceClassName,
        )
        : cn(surfaceClassName)

    const tree = (
        <div
            ref={overlayRef}
            className={overlayClasses}
            style={chrome ? { zIndex: 'var(--z-modal-backdrop)' } : undefined}
            onClick={onBackdropClick}
        >
            <div
                ref={surfaceRef}
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
                className={surfaceClasses}
                style={chrome ? { zIndex: 'var(--z-modal)' } : undefined}
                onClick={(event) => event.stopPropagation()}
            >
                <DialogDepthContext.Provider value={depth + 1}>
                    {children}
                </DialogDepthContext.Provider>
            </div>
        </div>
    )

    // Portal into <body> in the browser; render inline when there is no DOM
    // (SSR / vitest node environment) so static rendering still works.
    if (typeof document === 'undefined') return tree
    return createPortal(tree, document.body)
}

export interface DialogProps {
    /** Controls visibility. When false the component renders nothing. */
    open: boolean
    /** Invoked on Escape, backdrop click, or the header close button. */
    onClose: () => void
    /** Width preset. Default `md`. */
    size?: DialogSize
    /** Optional header title. When provided (or `showClose`), a header row renders. */
    title?: ReactNode
    /** Optional footer slot (typically action buttons). */
    footer?: ReactNode
    /** Body content. */
    children?: ReactNode
    /** Show the header close (✕) button. Default true. */
    showClose?: boolean
    /** Close when the backdrop (area outside the surface) is clicked. Default true. */
    closeOnBackdrop?: boolean
    /** Close when Escape is pressed. Default true. */
    closeOnEsc?: boolean
    /** Accessible label used when no visible `title` is supplied. */
    ariaLabel?: string
    /** Extra classes for the backdrop/overlay element. */
    className?: string
    /** Extra classes for the content surface element. */
    contentClassName?: string
}

/**
 * Headed modal dialog (DialogShell + canonical header/body/footer chrome).
 *
 *   <Dialog open={open} onClose={close} title="Confirm" footer={actions}>
 *     …body…
 *   </Dialog>
 */
export default function Dialog({
    open,
    onClose,
    size = 'md',
    title,
    footer,
    children,
    showClose = true,
    closeOnBackdrop = true,
    closeOnEsc = true,
    ariaLabel,
    className,
    contentClassName,
}: DialogProps) {
    const hasHeader = title != null || showClose

    return (
        <DialogShell
            open={open}
            onClose={onClose}
            size={size}
            closeOnBackdrop={closeOnBackdrop}
            closeOnEsc={closeOnEsc}
            ariaLabel={title == null ? ariaLabel : undefined}
            overlayClassName={className}
            surfaceClassName={contentClassName}
        >
            {hasHeader && (
                <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-default px-5 py-4">
                    <div className="min-w-0">
                        {typeof title === 'string' || typeof title === 'number' ? (
                            <h2 className="truncate text-lg font-bold text-text-primary">{title}</h2>
                        ) : (
                            title
                        )}
                    </div>
                    {showClose && (
                        // >=44px tap target (Apple HIG) with the visual scale
                        // preserved: the outer button owns the hit area, the
                        // inner span owns the 32px visual chrome; -m-1.5 keeps
                        // the header layout footprint unchanged.
                        <button
                            type="button"
                            onClick={onClose}
                            className="-m-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center"
                            aria-label={i18next.t('common.closeDialog')}
                        >
                            <span className="btn btn-ghost btn-sm inline-flex h-8 w-8 items-center justify-center p-0">
                                <IconX size={16} />
                            </span>
                        </button>
                    )}
                </div>
            )}

            {/* Body scrolls independently so header/footer stay pinned. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

            {footer != null && (
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-default px-5 py-4">
                    {footer}
                </div>
            )}
        </DialogShell>
    )
}
