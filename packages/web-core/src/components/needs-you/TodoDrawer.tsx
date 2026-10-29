/**
 * The "To do" surface: a right-side drawer on desktop, a full-height bottom sheet (drag handle,
 * safe-area insets, shrinks to the visual viewport while the on-screen keyboard is open) on
 * narrow screens. Open state is the URL (`useTodoDrawer`). Closes with Esc, a click outside,
 * the close button or a downward drag of the sheet handle; focus is trapped inside and restored
 * to the opener afterwards. `TodoDrawerHost` is mounted once per app, inside the router and the
 * NeedsYouProvider, and also provides a floating opener on screens that have no header button.
 */
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNeedsYouCount } from '../../context/NeedsYouContext'
import { useTodoDrawer } from '../../hooks/useTodoDrawer'
import { IconX } from '../Icons'
import TodoButton, { useTodoButtonMountedCount } from './TodoButton'
import TodoPanel from './TodoPanel'

const NARROW_QUERY = '(max-width: 767px)'
const DRAG_CLOSE_PX = 100

/** True below the `md` breakpoint; the drawer becomes a bottom sheet. */
export function useIsNarrow(): boolean {
    const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches
    const [narrow, setNarrow] = useState(get)
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
        const mq = window.matchMedia(NARROW_QUERY)
        const onChange = () => setNarrow(mq.matches)
        onChange()
        mq.addEventListener?.('change', onChange)
        return () => mq.removeEventListener?.('change', onChange)
    }, [])
    return narrow
}

/** Height of the visible viewport (shrinks under the on-screen keyboard); undefined when unsupported. */
function useVisualViewportHeight(enabled: boolean): number | undefined {
    const [h, setH] = useState<number | undefined>(undefined)
    useEffect(() => {
        const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
        if (!enabled || !vv) { setH(undefined); return }
        const update = () => setH(vv.height)
        update()
        vv.addEventListener('resize', update)
        return () => vv.removeEventListener('resize', update)
    }, [enabled])
    return h
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function TodoDrawerSurface({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation('common')
    const count = useNeedsYouCount()
    const narrow = useIsNarrow()
    const titleId = useId()
    const panelRef = useRef<HTMLDivElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)
    const vvHeight = useVisualViewportHeight(narrow)
    const [dragY, setDragY] = useState(0)
    const dragStart = useRef<number | null>(null)

    // Esc closes; Tab cycles inside the dialog.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
            if (e.key !== 'Tab') return
            const root = panelRef.current
            if (!root) return
            const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.hasAttribute('disabled'))
            if (items.length === 0) { e.preventDefault(); root.focus(); return }
            const first = items[0]!
            const last = items[items.length - 1]!
            const active = document.activeElement
            if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus() }
            else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
    }, [onClose])

    // Focus moves into the dialog and returns to the opener.
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null
        closeRef.current?.focus()
        return () => { opener?.focus?.() }
    }, [])

    const onHandleDown = (e: ReactPointerEvent) => {
        dragStart.current = e.clientY
        try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch { /* not capturable (synthetic) */ }
    }
    const onHandleMove = (e: ReactPointerEvent) => {
        if (dragStart.current === null) return
        setDragY(Math.max(0, e.clientY - dragStart.current))
    }
    const onHandleUp = useCallback((e: ReactPointerEvent) => {
        const start = dragStart.current
        dragStart.current = null
        const dy = start === null ? 0 : e.clientY - start
        setDragY(0)
        if (dy > DRAG_CLOSE_PX) onClose()
    }, [onClose])

    const variant = narrow ? 'sheet' : 'side'
    return (
        <div className="fixed inset-0 z-[70]" data-testid="todo-drawer-root" data-variant={variant}>
            <div className="absolute inset-0 bg-black/40 todo-drawer-backdrop" data-testid="todo-drawer-backdrop" aria-hidden="true" onClick={onClose} />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                data-testid="todo-drawer"
                className={narrow
                    ? 'absolute inset-x-0 bottom-0 flex flex-col bg-bg-primary border-t border-border-subtle rounded-t-2xl shadow-2xl todo-sheet-in pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]'
                    : 'absolute inset-y-0 right-0 flex flex-col w-[min(480px,100vw)] bg-bg-primary border-l border-border-subtle shadow-2xl todo-drawer-in'}
                style={narrow
                    ? {
                        height: vvHeight ? `${vvHeight}px` : '100dvh',
                        maxHeight: '100dvh',
                        transform: dragY ? `translateY(${dragY}px)` : undefined,
                        transition: dragY ? 'none' : undefined,
                    }
                    : undefined}
            >
                {narrow && (
                    <div
                        className="shrink-0 flex justify-center py-2.5 touch-none cursor-grab"
                        data-testid="todo-drawer-handle"
                        aria-label={t('needsYou.dragHandle')}
                        onPointerDown={onHandleDown}
                        onPointerMove={onHandleMove}
                        onPointerUp={onHandleUp}
                        onPointerCancel={onHandleUp}
                    >
                        <span className="h-1.5 w-10 rounded-full bg-border-default" aria-hidden="true" />
                    </div>
                )}
                <div className="shrink-0 flex items-center gap-2 px-3 md:px-4 py-2 border-b border-border-subtle">
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="m-0 text-sm font-bold text-text-primary flex items-center gap-2">
                            {t('needsYou.pageTitle')}
                            {count > 0 && (
                                <span className="rounded-full px-1.5 text-3xs font-bold tabular-nums" style={{ background: 'var(--status-warning)', color: 'var(--bg-base, #000)' }} data-testid="todo-drawer-count">{count}</span>
                            )}
                        </h2>
                        <div className="text-2xs text-text-muted">{t('needsYou.pageSubtitle')}</div>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        className="btn btn-icon min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
                        onClick={onClose}
                        aria-label={t('needsYou.close')}
                        title={t('needsYou.close')}
                        data-testid="todo-drawer-close"
                    >
                        <IconX size={16} />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]" data-testid="todo-drawer-scroll">
                    <TodoPanel />
                </div>
            </div>
        </div>
    )
}

export default function TodoDrawer() {
    const { open, closeDrawer } = useTodoDrawer()
    if (!open || typeof document === 'undefined') return null
    return createPortal(<TodoDrawerSurface onClose={closeDrawer} />, document.body)
}

/** Mount once per app (inside router + NeedsYouProvider): the drawer plus a floating opener where no header button exists. */
export function TodoDrawerHost() {
    const buttons = useTodoButtonMountedCount()
    const { open } = useTodoDrawer()
    return (
        <>
            {buttons === 0 && !open && (
                <div className="fixed top-2 right-3 z-40" data-testid="todo-floating-button">
                    <TodoButton floating className="bg-bg-secondary border border-border-subtle shadow-md" />
                </div>
            )}
            <TodoDrawer />
        </>
    )
}
