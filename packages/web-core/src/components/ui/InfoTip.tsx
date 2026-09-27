/**
 * InfoTip / Tooltip — the shared "details on demand" primitives.
 *
 * Production UI keeps visible text short and puts the explanation one hover or
 * tap away. Native `title=` cannot do that on touch screens or for keyboard
 * users, so these two components are the single implementation:
 *
 *   `InfoTip`  — an ⓘ button. Click/tap toggles a pinned popover; hovering with
 *                a mouse previews it; keyboard focus + Enter/Space toggles.
 *   `Tooltip`  — wraps an existing chip/badge/label. Hover or focus shows the
 *                hint; a tap (touch/pen) toggles it, since touch has no hover.
 *
 * Shared behaviour (usePopoverAnchor):
 *   - Escape closes. The listener is CAPTURE-phase on window and stops
 *     propagation while open, so an open tip inside a dialog closes first
 *     instead of closing the dialog (same convention as the mesh dialog's
 *     nested popovers — see components/ui/Dialog.tsx).
 *   - Outside pointerdown closes a pinned popover.
 *   - The popover is portaled to <body> with `position: fixed`, clamped to the
 *     viewport (8px margin) and flipped above the anchor when there is no room
 *     below, so it is never clipped by an `overflow` ancestor on mobile.
 *   - The hint text is ALSO rendered in a visually-hidden span referenced by
 *     `aria-describedby`, so screen readers get it without opening anything
 *     and server-rendered markup keeps the text.
 *   - Colours come from theme tokens only (bg-bg-card / border-border-default /
 *     text-text-*), so light/dark follow the app theme in cloud and standalone.
 */
import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { IconInfo } from '../Icons'

const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 6

type PopoverPosition = { top: number; left: number; placement: 'below' | 'above' }

/** Pure positioning math, exported for tests. */
export function computePopoverPosition(
    anchor: { top: number; bottom: number; left: number; width: number },
    popover: { width: number; height: number },
    viewport: { width: number; height: number },
): PopoverPosition {
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - popover.width - VIEWPORT_MARGIN)
    const centered = anchor.left + anchor.width / 2 - popover.width / 2
    const left = Math.min(Math.max(VIEWPORT_MARGIN, centered), maxLeft)
    const below = anchor.bottom + ANCHOR_GAP
    const fitsBelow = below + popover.height <= viewport.height - VIEWPORT_MARGIN
    const above = anchor.top - ANCHOR_GAP - popover.height
    if (!fitsBelow && above >= VIEWPORT_MARGIN) return { top: above, left, placement: 'above' }
    const top = Math.max(VIEWPORT_MARGIN, Math.min(below, viewport.height - popover.height - VIEWPORT_MARGIN))
    return { top, left, placement: 'below' }
}

interface PopoverState {
    /** Visible because of a click/tap (stays until toggled, Escape or outside click). */
    pinned: boolean
    /** Visible because of mouse hover / keyboard focus. */
    peeking: boolean
}

function usePopoverAnchor() {
    const anchorRef = useRef<HTMLElement | null>(null)
    const popoverRef = useRef<HTMLDivElement | null>(null)
    const [state, setState] = useState<PopoverState>({ pinned: false, peeking: false })
    const [position, setPosition] = useState<PopoverPosition | null>(null)
    const open = state.pinned || state.peeking

    const close = useCallback(() => setState({ pinned: false, peeking: false }), [])
    // Closed → pin. Hover-previewed (peeking) → pin so it stays after the pointer leaves. Pinned → close.
    const togglePinned = useCallback(() => setState(s => (s.pinned ? { pinned: false, peeking: false } : { pinned: true, peeking: false })), [])
    const setPeeking = useCallback((peeking: boolean) => setState(s => (s.peeking === peeking ? s : { ...s, peeking })), [])

    const reposition = useCallback(() => {
        const anchor = anchorRef.current
        const pop = popoverRef.current
        if (!anchor || !pop || typeof window === 'undefined') return
        const a = anchor.getBoundingClientRect()
        const p = pop.getBoundingClientRect()
        setPosition(computePopoverPosition(
            { top: a.top, bottom: a.bottom, left: a.left, width: a.width },
            { width: p.width, height: p.height },
            { width: window.innerWidth, height: window.innerHeight },
        ))
    }, [])

    useLayoutEffect(() => {
        if (!open) {
            setPosition(null)
            return
        }
        reposition()
    }, [open, reposition])

    useEffect(() => {
        if (!open || typeof window === 'undefined') return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            close()
            anchorRef.current?.focus?.()
        }
        const onPointerDown = (event: PointerEvent | MouseEvent) => {
            const target = event.target as Node | null
            if (!target) return
            if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return
            close()
        }
        const onScrollOrResize = () => reposition()
        window.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('mousedown', onPointerDown, true)
        window.addEventListener('resize', onScrollOrResize)
        window.addEventListener('scroll', onScrollOrResize, true)
        return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('mousedown', onPointerDown, true)
            window.removeEventListener('resize', onScrollOrResize)
            window.removeEventListener('scroll', onScrollOrResize, true)
        }
    }, [close, open, reposition])

    return { anchorRef, popoverRef, open, pinned: state.pinned, position, close, togglePinned, setPeeking }
}

function PopoverSurface({
    id,
    popoverRef,
    position,
    children,
    className,
    role = 'tooltip',
    ariaLabel,
}: {
    id: string
    popoverRef: React.MutableRefObject<HTMLDivElement | null>
    position: PopoverPosition | null
    children: ReactNode
    className?: string
    role?: 'tooltip' | 'dialog'
    ariaLabel?: string
}) {
    if (typeof document === 'undefined') return null
    return createPortal(
        <div
            ref={popoverRef}
            id={id}
            role={role}
            aria-label={ariaLabel}
            data-placement={position?.placement ?? 'below'}
            className={cn(
                'fixed z-[var(--z-tooltip)] max-w-[min(20rem,calc(100vw-16px))] rounded-lg border border-border-default bg-bg-card px-3 py-2 text-xs leading-relaxed text-text-secondary shadow-xl backdrop-blur-xl',
                'whitespace-pre-line break-words normal-case tracking-normal font-normal text-left',
                className,
            )}
            // First frame renders off-screen for measurement, then snaps into place.
            style={position ? { top: position.top, left: position.left } : { top: -9999, left: -9999, visibility: 'hidden' }}
        >
            {children}
        </div>,
        document.body,
    )
}

function isEmptyContent(content: ReactNode): boolean {
    return content === null || content === undefined || content === false || content === ''
}

export interface InfoTipProps {
    /** The explanation. Empty/undefined renders nothing. */
    content: ReactNode
    /** Accessible name of the ⓘ button. Defaults to the localized "More info". */
    label?: string
    /** Icon size in px. Default 13. */
    size?: number
    className?: string
    popoverClassName?: string
}

/**
 * ⓘ button with a click/tap popover (desktop hover previews it). Use next to a
 * label/title whose explanation should not be pre-exposed.
 */
export function InfoTip({ content, label, size = 13, className, popoverClassName }: InfoTipProps) {
    const { t } = useTranslation('common')
    const baseId = useId()
    const popoverId = `${baseId}-pop`
    const descId = `${baseId}-desc`
    const { anchorRef, popoverRef, open, position, togglePinned, setPeeking } = usePopoverAnchor()
    if (isEmptyContent(content)) return null
    return (
        <span className="inline-flex items-center align-middle">
            <button
                ref={node => { anchorRef.current = node }}
                type="button"
                data-infotip=""
                aria-label={label ?? t('common.moreInfo')}
                aria-expanded={open}
                aria-controls={open ? popoverId : undefined}
                aria-describedby={descId}
                onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    togglePinned()
                }}
                onPointerEnter={event => { if (event.pointerType === 'mouse') setPeeking(true) }}
                onPointerLeave={event => { if (event.pointerType === 'mouse') setPeeking(false) }}
                className={cn(
                    'inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full border-none bg-transparent p-0 text-text-muted transition-colors hover:text-text-primary focus-visible:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
                    open && 'text-text-primary',
                    className,
                )}
            >
                <IconInfo size={size} />
            </button>
            <span id={descId} className="sr-only">{content}</span>
            {open && (
                <PopoverSurface id={popoverId} popoverRef={popoverRef} position={position} className={popoverClassName}>
                    {content}
                </PopoverSurface>
            )}
        </span>
    )
}

export interface TooltipProps {
    /** Hint text. Empty/undefined renders the child untouched. */
    content: ReactNode
    /** A single element (chip, badge, label). Non-focusable children get a focusable wrapper. */
    children: ReactNode
    className?: string
    popoverClassName?: string
}

/**
 * Hover/focus/tap hint for chips and badges — the accessible replacement for a
 * bare `title=`. The child keeps its own look; the hint lives in a popover.
 */
export function Tooltip({ content, children, className, popoverClassName }: TooltipProps) {
    const baseId = useId()
    const popoverId = `${baseId}-pop`
    const descId = `${baseId}-desc`
    const { anchorRef, popoverRef, open, position, togglePinned, setPeeking } = usePopoverAnchor()
    if (isEmptyContent(content)) return <>{children}</>
    const trigger = (
        <span
            ref={node => { anchorRef.current = node }}
            data-tooltip=""
            tabIndex={0}
            aria-describedby={descId}
            className={cn('inline-flex max-w-full cursor-default items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/60', className)}
            onPointerEnter={event => { if (event.pointerType === 'mouse') setPeeking(true) }}
            onPointerLeave={event => { if (event.pointerType === 'mouse') setPeeking(false) }}
            onPointerUp={event => {
                if (event.pointerType === 'mouse') return
                togglePinned()
            }}
            onFocus={() => setPeeking(true)}
            onBlur={() => setPeeking(false)}
            onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    togglePinned()
                }
            }}
        >
            {children}
        </span>
    )
    return (
        <>
            {trigger}
            <span id={descId} className="sr-only">{content}</span>
            {open && (
                <PopoverSurface id={popoverId} popoverRef={popoverRef} position={position} className={popoverClassName}>
                    {content}
                </PopoverSurface>
            )}
        </>
    )
}

export interface PopoverButtonProps {
    /** Button content (icon and/or label). */
    children: ReactNode
    /** Popover content — may be interactive (buttons, toggles). */
    content: ReactNode
    /** Accessible name of the button and the popover dialog. */
    label: string
    className?: string
    popoverClassName?: string
}

/**
 * A button that toggles a small click popover with interactive content (a
 * legend with a layout toggle, a filter menu). Same positioning / Escape /
 * outside-click behaviour as InfoTip, but no hover-open and role="dialog".
 */
export function PopoverButton({ children, content, label, className, popoverClassName }: PopoverButtonProps) {
    const baseId = useId()
    const popoverId = `${baseId}-pop`
    const { anchorRef, popoverRef, open, position, togglePinned } = usePopoverAnchor()
    return (
        <>
            <button
                ref={node => { anchorRef.current = node }}
                type="button"
                aria-label={label}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-controls={open ? popoverId : undefined}
                onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    togglePinned()
                }}
                className={className}
            >
                {children}
            </button>
            {open && (
                <PopoverSurface id={popoverId} popoverRef={popoverRef} position={position} role="dialog" ariaLabel={label} className={cn('whitespace-normal', popoverClassName)}>
                    {content}
                </PopoverSurface>
            )}
        </>
    )
}

export default InfoTip
