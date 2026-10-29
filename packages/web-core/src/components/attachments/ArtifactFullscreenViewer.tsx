import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactResolvedPayload } from '../../hooks/useArtifactRead'
import { formatBytes } from '../../utils/daemon-utils'
import ModalPortal from '../ui/ModalPortal'
import { writeClipboard } from '../ui/TechnicalDetails'
import { ArtifactLinkContext, type ArtifactLinkResolver } from './artifact-link-context'
import { ArtifactContentRenderer } from './ArtifactContentRenderers'
import { getArtifactKindLabel, trArtifact } from './artifact-i18n'
import { openArtifactInNewWindow } from './artifact-popout'
import DriverBundleInstall, { isDriverBundleItem } from './DriverBundleInstall'
import {
    downloadArtifactViewerItem,
    extractMarkdownHeadings,
    type ArtifactViewerItem,
} from './artifact-viewer-item'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const TEXT_SCALE_MIN = 0.7
const TEXT_SCALE_MAX = 2
const TEXT_SCALE_STEP = 0.1
const IMAGE_ZOOM_MIN = 25
const IMAGE_ZOOM_MAX = 500
const TOC_MIN_HEADINGS = 3

export interface ArtifactFullscreenViewerProps {
    item: ArtifactViewerItem
    /** Required in `modal` mode (Esc / close button). In `page` mode it is optional. */
    onClose?: () => void
    /** `modal` (default) portals over the app; `page` fills a standalone window. */
    mode?: 'modal' | 'page'
    /** Optional prev/next across artifacts of the same chat (arrow keys). */
    position?: { index: number; total: number; /** More artifacts exist beyond the loaded `total` (shown as "N+"). */ more?: boolean }
    onNavigate?: (delta: -1 | 1) => void
    /** Hide the "open in new window" button (it is always hidden in `page` mode). */
    disablePopOut?: boolean
    /** Full payload for the pop-out; defaults to the item itself. */
    popOutPayload?: ArtifactResolvedPayload | ArtifactViewerItem
    /** Maps a relative markdown link onto another artifact of the same list (opener) or null. Without it relative links are plain text. */
    resolveLink?: ArtifactLinkResolver
}

/**
 * Displayed pixel size for the image viewer: natural x fitScale x zoom/100, where
 * fitScale = min(1, bodyW/naturalW, bodyH/naturalH). Null until both sizes are known.
 */
export function imageDisplaySize(
    natural: { w: number; h: number } | null,
    body: { w: number; h: number } | null,
    zoom: number,
): { width: number; height: number; maxWidth: 'none'; maxHeight: 'none' } | null {
    if (!natural || !body || natural.w <= 0 || natural.h <= 0 || body.w <= 0 || body.h <= 0) return null
    const fit = Math.min(1, body.w / natural.w, body.h / natural.h)
    const scale = fit * (zoom / 100)
    return { width: natural.w * scale, height: natural.h * scale, maxWidth: 'none', maxHeight: 'none' }
}

/** md breakpoint: the contents panel starts open only when there is room beside the text. */
function isWideViewport(): boolean {
    if (typeof window === 'undefined') return true
    if (typeof window.matchMedia === 'function') return window.matchMedia('(min-width: 768px)').matches
    return window.innerWidth >= 768
}

/** True when `el` or an ancestor below `root` is a horizontal scroller that can still move in `dir`. */
export function canScrollHorizontally(el: Element | null, root: Element | null, dir: -1 | 1): boolean {
    for (let node: Element | null = el; node && node !== root?.parentElement; node = node.parentElement) {
        const h = node as HTMLElement
        if (h.scrollWidth <= h.clientWidth) continue
        const overflowX = typeof getComputedStyle === 'function' ? getComputedStyle(h).overflowX : ''
        if (overflowX !== 'auto' && overflowX !== 'scroll') continue
        if (dir < 0 ? h.scrollLeft > 0 : h.scrollLeft + h.clientWidth < h.scrollWidth - 1) return true
    }
    return false
}

const btn = 'inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-border-subtle bg-bg-secondary px-2.5 text-xs font-semibold text-text-secondary hover:border-border-default hover:text-text-primary disabled:opacity-40'

function ToolbarButton({ label, onClick, disabled, testId, children }: {
    label: string
    onClick: () => void
    disabled?: boolean
    testId?: string
    children: ReactNode
}) {
    return (
        <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} data-testid={testId} className={btn}>
            {children}
        </button>
    )
}

function ViewerCopyButton({ value, label }: { value: string; label: string }) {
    const { t } = useTranslation('common')
    const [copied, setCopied] = useState(false)
    const shown = copied ? t('common.copied') : label
    return (
        <button
            type="button"
            data-testid="artifact-fullscreen-copy"
            aria-label={shown}
            title={shown}
            className={btn}
            onClick={async () => {
                if (!(await writeClipboard(value))) return
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
            }}
        >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {copied
                    ? <path d="M3 8.5l3.5 3.5L13 4.5" />
                    : (<><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>)}
            </svg>
            <span className="sr-only" aria-live="polite">{shown}</span>
        </button>
    )
}

export function ArtifactFullscreenViewer({
    item,
    onClose,
    mode = 'modal',
    position,
    onNavigate,
    disablePopOut,
    popOutPayload,
    resolveLink,
}: ArtifactFullscreenViewerProps) {
    const { t, i18n } = useTranslation('common')
    const tr = (key: Parameters<typeof trArtifact>[2]) => trArtifact(t, i18n.language, key)
    const isModal = mode === 'modal'
    const isImage = item.kind === 'image'
    const dialogRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const openerRef = useRef<HTMLElement | null>(null)
    const [textScale, setTextScale] = useState(1)
    const [zoom, setZoom] = useState(100)
    const [popOutBlocked, setPopOutBlocked] = useState(false)
    const [imageFailed, setImageFailed] = useState(false)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
    const [bodySize, setBodySize] = useState<{ w: number; h: number } | null>(null)
    const measureBody = useCallback(() => {
        const el = bodyRef.current
        if (!el) return
        const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
        const pad = (side: string) => parseFloat(cs?.getPropertyValue(side) ?? '') || 0
        const w = el.clientWidth - pad('padding-left') - pad('padding-right')
        const h = el.clientHeight - pad('padding-top') - pad('padding-bottom')
        setBodySize(prev => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }, [])
    const [tocOpen, setTocOpen] = useState(isWideViewport)

    // Capture the opener once so focus can return to it on close.
    if (openerRef.current === null && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        openerRef.current = document.activeElement
    }

    const [imageUrl, setImageUrl] = useState<string | null>(null)
    useEffect(() => {
        if (!isImage || !item.blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            setImageUrl(null)
            return
        }
        const url = URL.createObjectURL(item.blob)
        setImageUrl(url)
        return () => URL.revokeObjectURL(url)
    }, [isImage, item.blob])

    useEffect(() => {
        if (!isImage) return
        measureBody()
        const el = bodyRef.current
        let observer: ResizeObserver | null = null
        if (el && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => measureBody())
            observer.observe(el)
        }
        window.addEventListener('resize', measureBody)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measureBody) }
    }, [isImage, measureBody])

    // Reset per-artifact view state when navigating between artifacts.
    useEffect(() => {
        setZoom(100)
        setImageFailed(false)
        setNaturalSize(null)
    }, [item])

    const close = useCallback(() => {
        onClose?.()
        const target = openerRef.current
        if (target && document.contains(target)) {
            try { target.focus({ preventScroll: true }) } catch { target.focus() }
        }
    }, [onClose])

    useEffect(() => {
        if (!isModal) return
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const dialog = dialogRef.current
        const first = dialog?.querySelector<HTMLElement>('[data-viewer-close]') ?? dialog
        first?.focus({ preventScroll: true })
        return () => { document.body.style.overflow = prevOverflow }
    }, [isModal])

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && isModal) {
                event.preventDefault()
                event.stopPropagation()
                close()
                return
            }
            if (onNavigate && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                const target = event.target as HTMLElement | null
                if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
                // Let wide diff/code scroll sideways instead of switching artifacts.
                if (canScrollHorizontally(target, dialogRef.current, event.key === 'ArrowLeft' ? -1 : 1)) return
                event.preventDefault()
                onNavigate(event.key === 'ArrowLeft' ? -1 : 1)
                return
            }
            if (event.key !== 'Tab' || !isModal) return
            const dialog = dialogRef.current
            if (!dialog) return
            const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
            if (focusables.length === 0) { event.preventDefault(); return }
            const firstEl = focusables[0]!
            const lastEl = focusables[focusables.length - 1]!
            const active = document.activeElement as HTMLElement | null
            if (event.shiftKey && (!active || !dialog.contains(active) || active === firstEl)) {
                event.preventDefault(); lastEl.focus()
            } else if (!event.shiftKey && (!active || !dialog.contains(active) || active === lastEl)) {
                event.preventDefault(); firstEl.focus()
            }
        }
        // Capture phase on window: the viewer can open on top of another dialog (the mesh
        // surface), whose own Escape handler must not also close underneath it.
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [close, isModal, onNavigate])

    const headings = useMemo(
        () => (item.kind === 'markdown' && item.text ? extractMarkdownHeadings(item.text) : []),
        [item.kind, item.text],
    )
    const showToc = headings.length >= TOC_MIN_HEADINGS

    const jumpToHeading = (index: number) => {
        const nodes = contentRef.current?.querySelectorAll('h1, h2, h3, h4')
        const node = nodes?.[index] as HTMLElement | undefined
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }

    // Pinch-to-zoom for images on touch screens.
    const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)
    const touchDist = (e: React.TouchEvent) => {
        const [a, b] = [e.touches[0]!, e.touches[1]!]
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    }
    const clampZoom = (z: number) => Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, Math.round(z)))

    const handlePopOut = () => {
        const ok = openArtifactInNewWindow(popOutPayload ?? item)
        setPopOutBlocked(!ok)
    }

    const sizeLabel = formatBytes(item.sizeBytes)
    const copyText = item.text ?? ''
    const scalePct = `${Math.round(textScale * 100)}%`

    const body = (
        <div
            ref={dialogRef}
            tabIndex={-1}
            role={isModal ? 'dialog' : undefined}
            aria-modal={isModal ? true : undefined}
            aria-label={item.title || item.filename}
            data-testid="artifact-fullscreen-viewer"
            data-viewer-mode={mode}
            className={`${isModal ? 'fixed inset-0 z-[var(--z-modal)]' : 'h-screen w-screen'} flex flex-col bg-bg-primary text-text-primary`}
        >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 sm:px-4">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" data-testid="artifact-fullscreen-title" title={item.title || item.filename}>{item.title || item.filename}</div>
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-3xs text-text-muted">
                        <span className="truncate">{item.filename}</span>
                        <span aria-hidden="true">·</span>
                        <span>{getArtifactKindLabel(t, i18n.language, item.kind)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{sizeLabel}</span>
                        {position && position.total > 1 && (
                            <>
                                <span aria-hidden="true">·</span>
                                <span data-testid="artifact-fullscreen-position">{`${position.index + 1}/${position.total}${position.more ? '+' : ''}`}</span>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
                    {onNavigate && position && position.total > 1 && (
                        <>
                            <ToolbarButton label={tr('artifact.previous')} onClick={() => onNavigate(-1)} disabled={position.index <= 0} testId="artifact-fullscreen-prev">‹</ToolbarButton>
                            <ToolbarButton label={tr('artifact.next')} onClick={() => onNavigate(1)} disabled={position.index >= position.total - 1} testId="artifact-fullscreen-next">›</ToolbarButton>
                        </>
                    )}
                    {!isImage ? (
                        <>
                            <ToolbarButton label={tr('artifact.textSmaller')} onClick={() => setTextScale((s) => Math.max(TEXT_SCALE_MIN, +(s - TEXT_SCALE_STEP).toFixed(2)))} disabled={textScale <= TEXT_SCALE_MIN} testId="artifact-text-smaller">A−</ToolbarButton>
                            <ToolbarButton label={tr('artifact.textReset')} onClick={() => setTextScale(1)} testId="artifact-text-reset"><span className="font-mono">{scalePct}</span></ToolbarButton>
                            <ToolbarButton label={tr('artifact.textLarger')} onClick={() => setTextScale((s) => Math.min(TEXT_SCALE_MAX, +(s + TEXT_SCALE_STEP).toFixed(2)))} disabled={textScale >= TEXT_SCALE_MAX} testId="artifact-text-larger">A+</ToolbarButton>
                        </>
                    ) : (
                        <>
                            <ToolbarButton label={tr('artifact.zoomOut')} onClick={() => setZoom((z) => clampZoom(z - 25))} testId="artifact-zoom-out">−</ToolbarButton>
                            <ToolbarButton label={tr('artifact.fit')} onClick={() => setZoom(100)} testId="artifact-zoom-fit"><span className="font-mono">{`${zoom}%`}</span></ToolbarButton>
                            <ToolbarButton label={tr('artifact.zoomIn')} onClick={() => setZoom((z) => clampZoom(z + 25))} testId="artifact-zoom-in">+</ToolbarButton>
                        </>
                    )}
                    {showToc && (
                        <button type="button" onClick={() => setTocOpen((o) => !o)} aria-label={tr('artifact.toc')} aria-expanded={tocOpen} title={tr('artifact.toc')} data-testid="artifact-toc-toggle" className={`${btn} gap-1.5`}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" /></svg>
                            <span className="max-sm:sr-only">{tr('artifact.toc')}</span>
                        </button>
                    )}
                    {!isImage && copyText && <ViewerCopyButton value={copyText} label={tr('artifact.copyContent')} />}
                    <ToolbarButton label={tr('artifact.download')} onClick={() => { downloadArtifactViewerItem(item) }} testId="artifact-fullscreen-download">⬇</ToolbarButton>
                    {isModal && !disablePopOut && (
                        <ToolbarButton label={tr('artifact.openInNewWindow')} onClick={handlePopOut} testId="artifact-fullscreen-popout">⧉</ToolbarButton>
                    )}
                    {(isModal || onClose) && (
                        <button type="button" data-viewer-close="" data-testid="artifact-fullscreen-close" onClick={close} aria-label={tr('artifact.closeViewer')} title={tr('artifact.closeViewer')} className={btn}>✕</button>
                    )}
                </div>
            </header>
            {isModal && isDriverBundleItem(item) && <DriverBundleInstall item={item} />}
            {popOutBlocked && (
                <div role="alert" data-testid="artifact-popout-blocked" className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-2xs text-amber-800 dark:text-amber-200">
                    {tr('artifact.popoutBlocked')}
                </div>
            )}
            {item.sha256Changed && (
                <div role="status" data-testid="artifact-changed-notice" className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-2xs text-amber-800 dark:text-amber-200">
                    {tr('artifact.changedNotice')}
                </div>
            )}
            <div className="relative flex min-h-0 flex-1">
                {showToc && tocOpen && (
                    <nav aria-label={tr('artifact.toc')} data-testid="artifact-toc" className="w-56 shrink-0 overflow-auto border-r border-border-subtle p-3 text-2xs max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-10 max-md:bg-bg-primary max-md:shadow-xl">
                        <div className="mb-2 font-semibold text-text-muted">{tr('artifact.toc')}</div>
                        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                            {headings.map((h, i) => (
                                <li key={i} style={{ paddingLeft: `${(h.level - 1) * 10}px` }}>
                                    <button type="button" onClick={() => jumpToHeading(i)} className="w-full truncate rounded px-1.5 py-1 text-left text-text-secondary hover:bg-bg-secondary hover:text-text-primary" title={h.text}>
                                        {h.text}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </nav>
                )}
                <div
                    ref={bodyRef}
                    className={`min-w-0 flex-1 overflow-auto p-2 sm:p-4${isImage ? ' flex' : ''}`}
                    data-testid="artifact-fullscreen-body"
                    onTouchStart={(e) => { if (isImage && e.touches.length === 2) pinchRef.current = { dist: touchDist(e), zoom } }}
                    onTouchMove={(e) => {
                        if (isImage && e.touches.length === 2 && pinchRef.current && pinchRef.current.dist > 0) {
                            setZoom(clampZoom(pinchRef.current.zoom * (touchDist(e) / pinchRef.current.dist)))
                        }
                    }}
                    onTouchEnd={() => { pinchRef.current = null }}
                >
                    {isImage ? (
                        imageFailed ? (
                            <div role="alert" data-testid="artifact-image-broken" className="m-auto max-w-md px-4 py-8 text-center text-sm text-text-secondary">
                                {tr('artifact.imageBroken')}
                            </div>
                        ) : imageUrl ? (
                            // 100% = the whole image fits the body (never upscaled). Displayed size =
                            // natural x fitScale x zoom/100, so zoom-in enlarges tiny images too and
                            // anything larger than the body scrolls. `margin:auto` on the child of the
                            // flex scroll container centres small images without clipping the top-left
                            // of large ones (justify-center would make that part unreachable).
                            <img
                                src={imageUrl}
                                alt={item.title || item.filename}
                                data-testid="artifact-fullscreen-image"
                                draggable={false}
                                onLoad={(e) => {
                                    setNaturalSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                                    measureBody()
                                }}
                                onError={() => setImageFailed(true)}
                                style={imageDisplaySize(naturalSize, bodySize, zoom) ?? { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' }}
                                className="m-auto shrink-0 object-contain"
                            />
                        ) : null
                    ) : (
                        <div ref={contentRef} data-testid="artifact-fullscreen-content" data-text-scale={textScale} style={{ zoom: textScale } as React.CSSProperties}>
                            <ArtifactLinkContext.Provider value={resolveLink ?? null}>
                            <ArtifactContentRenderer
                                variant="fullscreen"
                                objectUrl={null}
                                payload={{
                                    artifactId: '', sessionId: '', daemonId: '', kind: item.kind, mime: item.mime,
                                    filename: item.filename, title: item.title, sizeBytes: item.sizeBytes,
                                    sha256: '', registeredSha256: '', sha256Changed: false, hashChanged: false,
                                    encoding: 'utf8', content: item.text ?? '', textContent: item.text ?? '', bytes: new Uint8Array(0),
                                }}
                            />
                            </ArtifactLinkContext.Provider>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )

    return isModal ? <ModalPortal>{body}</ModalPortal> : body
}

export default ArtifactFullscreenViewer
