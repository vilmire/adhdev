import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactResolvedPayload } from '../../hooks/useArtifactRead'
import { formatBytes } from '../../utils/daemon-utils'
import ModalPortal from '../ui/ModalPortal'
import { writeClipboard } from '../ui/TechnicalDetails'
import { ArtifactContentRenderer } from './ArtifactContentRenderers'
import { getArtifactKindLabel, trArtifact } from './artifact-i18n'
import { openArtifactInNewWindow } from './artifact-popout'
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
    position?: { index: number; total: number }
    onNavigate?: (delta: -1 | 1) => void
    /** Hide the "open in new window" button (it is always hidden in `page` mode). */
    disablePopOut?: boolean
    /** Full payload for the pop-out; defaults to the item itself. */
    popOutPayload?: ArtifactResolvedPayload | ArtifactViewerItem
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
    return (
        <button
            type="button"
            data-testid="artifact-fullscreen-copy"
            aria-label={label}
            className={`${btn} text-2xs`}
            onClick={async () => {
                if (!(await writeClipboard(value))) return
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
            }}
        >
            <span aria-live="polite">{copied ? t('common.copied') : label}</span>
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
    const [tocOpen, setTocOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768)

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

    // Reset per-artifact view state when navigating between artifacts.
    useEffect(() => {
        setZoom(100)
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
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
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
            className={`${isModal ? 'fixed inset-0 z-50' : 'h-screen w-screen'} flex flex-col bg-bg-primary text-text-primary`}
        >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 sm:px-4">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" data-testid="artifact-fullscreen-title">{item.title || item.filename}</div>
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-3xs text-text-muted">
                        <span className="truncate">{item.filename}</span>
                        <span aria-hidden="true">·</span>
                        <span>{getArtifactKindLabel(t, i18n.language, item.kind)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{sizeLabel}</span>
                        {position && position.total > 1 && (
                            <>
                                <span aria-hidden="true">·</span>
                                <span data-testid="artifact-fullscreen-position">{`${position.index + 1}/${position.total}`}</span>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
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
                        <ToolbarButton label={tr('artifact.toc')} onClick={() => setTocOpen((o) => !o)} testId="artifact-toc-toggle">☰</ToolbarButton>
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
            {popOutBlocked && (
                <div role="alert" data-testid="artifact-popout-blocked" className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-2xs text-amber-800 dark:text-amber-200">
                    {tr('artifact.popoutBlocked')}
                </div>
            )}
            <div className="flex min-h-0 flex-1">
                {showToc && tocOpen && (
                    <nav aria-label={tr('artifact.toc')} data-testid="artifact-toc" className="w-56 shrink-0 overflow-auto border-r border-border-subtle p-3 text-2xs max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-10 max-md:mt-14 max-md:bg-bg-primary max-md:shadow-xl">
                        <div className="mb-2 font-semibold text-text-muted">{tr('artifact.toc')}</div>
                        <ul className="flex flex-col gap-0.5">
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
                    className="min-w-0 flex-1 overflow-auto p-2 sm:p-4"
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
                        imageUrl ? (
                            <div className="flex min-h-full min-w-full items-center justify-center" style={{ touchAction: 'pan-x pan-y' }}>
                                <img
                                    src={imageUrl}
                                    alt={item.title || item.filename}
                                    data-testid="artifact-fullscreen-image"
                                    draggable={false}
                                    style={{ width: `${zoom}%`, maxWidth: zoom <= 100 ? '100%' : 'none', maxHeight: zoom <= 100 ? '100%' : 'none', objectFit: 'contain' }}
                                />
                            </div>
                        ) : null
                    ) : (
                        <div ref={contentRef} data-testid="artifact-fullscreen-content" data-text-scale={textScale} style={{ zoom: textScale } as React.CSSProperties}>
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
                        </div>
                    )}
                </div>
            </div>
        </div>
    )

    return isModal ? <ModalPortal>{body}</ModalPortal> : body
}

export default ArtifactFullscreenViewer
