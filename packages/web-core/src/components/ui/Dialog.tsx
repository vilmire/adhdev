/**
 * Dialog — canonical modal shell primitive.
 *
 * Extracts the common overlay pattern shared by the well-built modals in this
 * codebase (InteractivePromptModal, OnboardingModal, GitStatusDialog, …):
 *   - fixed full-viewport overlay + dimmed backdrop
 *   - centered, size-capped, scrollable content surface
 *   - close on Escape and on backdrop click
 *   - single portal into <body> so stacking context is predictable
 *
 * This wave only *adds* the primitive — the existing modals are intentionally
 * left untouched. A later wave migrates them onto <Dialog>.
 *
 * Design invariants:
 *   - Uses ONLY canonical design tokens (surface-primary, border-default,
 *     text-*) and the canonical z-index scale (var(--z-modal-backdrop) for the
 *     overlay, var(--z-modal) for the surface — see index.css).
 *   - Pure UI: imports nothing from daemon-core. React + react-dom only.
 *   - SSR / test-safe: when `document` is unavailable (Node/vitest render)
 *     the tree renders inline instead of through a portal, so
 *     renderToStaticMarkup works without a DOM.
 */
import { useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import { IconX } from '../Icons'

export type DialogSize = 'sm' | 'md' | 'lg'

/** Size presets map to the max-width caps already used by hand-built modals. */
const SIZE_CLASS: Record<DialogSize, string> = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-3xl',
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
 * Modal dialog shell.
 *
 *   <Dialog open={open} onClose={close} title="Confirm" footer={actions}>
 *     …body…
 *   </Dialog>
 *
 * The content surface stops click propagation, so only clicks on the backdrop
 * itself trigger `closeOnBackdrop`.
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
    useEffect(() => {
        if (!open || !closeOnEsc) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [open, closeOnEsc, onClose])

    const onBackdropClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (closeOnBackdrop && event.target === event.currentTarget) onClose()
        },
        [closeOnBackdrop, onClose],
    )

    if (!open) return null

    const hasHeader = title != null || showClose

    const tree = (
        <div
            className={cn(
                // Safe-area-aware overlay padding: in the iOS installed PWA
                // (viewport-fit=cover) the fixed overlay extends under the
                // status bar / home indicator, so the centered surface must be
                // padded in from those edges to keep the header close control
                // out of the system UI band.
                'fixed inset-0 flex items-center justify-center bg-black/60 px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] pt-[calc(16px+env(safe-area-inset-top,0px))]',
                className,
            )}
            style={{ zIndex: 'var(--z-modal-backdrop)' }}
            onClick={onBackdropClick}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title == null ? ariaLabel : undefined}
                className={cn(
                    'relative flex max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem)] w-full flex-col overflow-hidden',
                    'rounded-xl border border-border-default bg-surface-primary shadow-2xl',
                    SIZE_CLASS[size],
                    contentClassName,
                )}
                style={{ zIndex: 'var(--z-modal)' }}
                onClick={(event) => event.stopPropagation()}
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
                                aria-label="Close dialog"
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
            </div>
        </div>
    )

    // Portal into <body> in the browser; render inline when there is no DOM
    // (SSR / vitest node environment) so static rendering still works.
    if (typeof document === 'undefined') return tree
    return createPortal(tree, document.body)
}
