import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactKind } from '@adhdev/daemon-core'
import { isAllowedArtifactKindAndMime, type ArtifactResolvedPayload } from '../../hooks/useArtifactRead'
import { ChatMarkdownBody } from '../ChatMessageList/chat-row-content'
import ScreenshotViewer from '../remote/ScreenshotViewer'
import { CopyButton } from '../ui/TechnicalDetails'
import ModalPortal from '../ui/ModalPortal'
import { trArtifact } from './artifact-i18n'

const LIGHTBOX_FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type DiffLineKind = 'hunk' | 'meta' | 'add' | 'del' | 'context'

export function classifyDiffLine(line: string): DiffLineKind {
    if (line.startsWith('@@')) return 'hunk'
    if (
        line.startsWith('+++')
        || line.startsWith('---')
        || line.startsWith('diff --git')
        || line.startsWith('index ')
    ) {
        return 'meta'
    }
    if (line.startsWith('+')) return 'add'
    if (line.startsWith('-')) return 'del'
    return 'context'
}

function getDiffLineClassName(kind: DiffLineKind): string {
    switch (kind) {
        case 'hunk':
            return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 font-semibold'
        case 'meta':
            return 'bg-black/[0.04] dark:bg-white/[0.04] text-text-muted font-semibold'
        case 'add':
            return 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
        case 'del':
            return 'bg-rose-500/12 text-rose-800 dark:text-rose-300'
        default:
            return 'text-text-secondary'
    }
}

export function formatArtifactJson(raw: string): { formatted: string; valid: boolean } {
    const trimmed = raw.trim()
    if (!trimmed) return { formatted: '', valid: true }
    try {
        const parsed = JSON.parse(raw)
        return { formatted: JSON.stringify(parsed, null, 2), valid: true }
    } catch {
        return { formatted: raw, valid: false }
    }
}

export interface ArtifactContentRendererProps {
    payload: ArtifactResolvedPayload
    objectUrl: string | null
    /** `inline` (default) caps text in a small scroll box; `fullscreen` lets it fill the viewer. */
    variant?: 'inline' | 'fullscreen'
}

export function ArtifactContentRenderer({ payload, objectUrl, variant = 'inline' }: ArtifactContentRendererProps) {
    const fullscreen = variant === 'fullscreen'
    const boxMax = fullscreen ? '' : 'max-h-96 overflow-auto'
    const { t, i18n } = useTranslation('common')
    const [zoom, setZoom] = useState(100)
    const [lightboxOpen, setLightboxOpen] = useState(false)
    const openerButtonRef = useRef<HTMLButtonElement | null>(null)
    const dialogRef = useRef<HTMLDivElement | null>(null)
    const closeButtonRef = useRef<HTMLButtonElement | null>(null)
    const previousActiveElementRef = useRef<HTMLElement | null>(null)

    const restoreOpenerFocus = useCallback(() => {
        const target = openerButtonRef.current ?? previousActiveElementRef.current
        if (target && typeof target.focus === 'function' && document.contains(target)) {
            try {
                target.focus({ preventScroll: true })
            } catch {
                target.focus()
            }
        }
    }, [])

    const closeLightbox = useCallback(() => {
        setLightboxOpen(false)
        restoreOpenerFocus()
    }, [restoreOpenerFocus])

    useEffect(() => {
        if (!lightboxOpen || !objectUrl) return

        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        if (!previousActiveElementRef.current && document.activeElement instanceof HTMLElement) {
            previousActiveElementRef.current = document.activeElement
        }

        const initialFocusEl = closeButtonRef.current ?? dialogRef.current
        if (initialFocusEl && typeof initialFocusEl.focus === 'function') {
            try {
                initialFocusEl.focus({ preventScroll: true })
            } catch {
                initialFocusEl.focus()
            }
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeLightbox()
                return
            }
            if (event.key !== 'Tab') return
            const dialog = dialogRef.current
            if (!dialog) return
            const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(LIGHTBOX_FOCUSABLE_SELECTOR))
            if (focusables.length === 0) {
                event.preventDefault()
                dialog.focus({ preventScroll: true })
                return
            }
            const first = focusables[0]!
            const last = focusables[focusables.length - 1]!
            const active = document.activeElement as HTMLElement | null
            if (event.shiftKey) {
                if (!active || !dialog.contains(active) || active === first) {
                    event.preventDefault()
                    last.focus({ preventScroll: true })
                }
            } else if (!active || !dialog.contains(active) || active === last) {
                event.preventDefault()
                first.focus({ preventScroll: true })
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.body.style.overflow = prevOverflow
        }
    }, [closeLightbox, lightboxOpen, objectUrl])

    const kind: ArtifactKind = payload.kind
    const allowed = isAllowedArtifactKindAndMime(kind, payload.mime)
    const copyLabel = trArtifact(t, i18n.language, 'artifact.copyContent')
    const emptyLabel = trArtifact(t, i18n.language, 'artifact.emptyContent')

    if (!allowed) {
        return (
            <div
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                data-artifact-renderer="unsupported"
            >
                {trArtifact(t, i18n.language, 'artifact.errorUnsupported')}
            </div>
        )
    }

    if (kind === 'image') {
        const zoomInLabel = trArtifact(t, i18n.language, 'artifact.zoomIn')
        const zoomOutLabel = trArtifact(t, i18n.language, 'artifact.zoomOut')
        const zoomResetLabel = trArtifact(t, i18n.language, 'artifact.zoomReset')
        const openLightboxLabel = trArtifact(t, i18n.language, 'artifact.openLightbox')
        const closeLightboxLabel = trArtifact(t, i18n.language, 'artifact.closeLightbox')

        return (
            <div className="flex flex-col gap-2" data-artifact-renderer="image">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-3xs text-text-muted">{payload.mime}</span>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => setZoom((z) => Math.max(50, z - 25))}
                            className="inline-flex min-h-[28px] items-center rounded-md border border-border-subtle bg-bg-secondary px-2 py-0.5 text-3xs font-medium text-text-secondary hover:border-border-default hover:text-text-primary"
                            aria-label={zoomOutLabel}
                            title={zoomOutLabel}
                        >
                            −
                        </button>
                        <button
                            type="button"
                            onClick={() => setZoom(100)}
                            className="inline-flex min-h-[28px] items-center rounded-md border border-border-subtle bg-bg-secondary px-2 py-0.5 font-mono text-3xs text-text-secondary hover:border-border-default hover:text-text-primary"
                            aria-label={zoomResetLabel}
                            title={zoomResetLabel}
                        >
                            {`${zoom}%`}
                        </button>
                        <button
                            type="button"
                            onClick={() => setZoom((z) => Math.min(250, z + 25))}
                            className="inline-flex min-h-[28px] items-center rounded-md border border-border-subtle bg-bg-secondary px-2 py-0.5 text-3xs font-medium text-text-secondary hover:border-border-default hover:text-text-primary"
                            aria-label={zoomInLabel}
                            title={zoomInLabel}
                        >
                            +
                        </button>
                        {objectUrl && (
                            <button
                                ref={openerButtonRef}
                                type="button"
                                onClick={() => {
                                    previousActiveElementRef.current =
                                        document.activeElement instanceof HTMLElement
                                            ? document.activeElement
                                            : openerButtonRef.current
                                    setLightboxOpen(true)
                                }}
                                data-testid="artifact-image-lightbox-open"
                                className="inline-flex min-h-[28px] items-center rounded-md border border-border-subtle bg-bg-secondary px-2 py-0.5 text-3xs font-medium text-text-secondary hover:border-border-default hover:text-text-primary"
                                aria-label={openLightboxLabel}
                                title={openLightboxLabel}
                            >
                                {openLightboxLabel}
                            </button>
                        )}
                    </div>
                </div>
                <div className="h-64 w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-primary/60 p-2">
                    <ScreenshotViewer
                        screenshotUrl={objectUrl}
                        mode="full"
                        zoom={zoom}
                        badge={payload.filename}
                        className="h-full w-full"
                    />
                </div>
                {lightboxOpen && objectUrl && (
                    <ModalPortal>
                        <div
                            ref={dialogRef}
                            tabIndex={-1}
                            className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-black/85 p-4 backdrop-blur-sm"
                            role="dialog"
                            aria-modal="true"
                            aria-label={payload.title || payload.filename}
                            data-testid="artifact-image-lightbox"
                        >
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-white">{payload.title}</div>
                                    <div className="truncate font-mono text-2xs text-white/70">{payload.filename}</div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setZoom((z) => Math.max(50, z - 25))}
                                        className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-white/20 bg-white/10 px-2.5 text-xs font-semibold text-white hover:bg-white/20"
                                        aria-label={zoomOutLabel}
                                    >
                                        −
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setZoom(100)}
                                        className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-white/20 bg-white/10 px-2.5 font-mono text-xs text-white hover:bg-white/20"
                                        aria-label={zoomResetLabel}
                                    >
                                        {`${zoom}%`}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setZoom((z) => Math.min(250, z + 25))}
                                        className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-white/20 bg-white/10 px-2.5 text-xs font-semibold text-white hover:bg-white/20"
                                        aria-label={zoomInLabel}
                                    >
                                        +
                                    </button>
                                    <button
                                        ref={closeButtonRef}
                                        type="button"
                                        onClick={closeLightbox}
                                        data-testid="artifact-image-lightbox-close"
                                        className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-white/20 bg-white/15 px-3 text-xs font-semibold text-white hover:bg-white/25"
                                        aria-label={closeLightboxLabel}
                                    >
                                        {closeLightboxLabel}
                                    </button>
                                </div>
                            </div>
                            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-white/15 bg-black/50 p-2">
                                <ScreenshotViewer
                                    screenshotUrl={objectUrl}
                                    mode="full"
                                    zoom={zoom}
                                    badge={payload.filename}
                                    className="h-full w-full"
                                />
                            </div>
                        </div>
                    </ModalPortal>
                )}
            </div>
        )
    }

    const text = payload.textContent ?? payload.content ?? ''

    if (kind === 'markdown') {
        return (
            <div className="flex flex-col gap-2" data-artifact-renderer="markdown">
                {!fullscreen && (
                    <div className="flex items-center justify-end">
                        <CopyButton value={text} label={copyLabel} />
                    </div>
                )}
                <div className={`chat-markdown ${boxMax} rounded-lg border border-border-subtle bg-bg-primary/50 p-3 ${fullscreen ? 'mx-auto w-full max-w-[88ch] text-sm leading-relaxed sm:p-6' : 'text-xs'} text-text-primary`}>
                    {text ? (
                        <ChatMarkdownBody
                            content={text}
                            renderAsPreformatted={false}
                            renderAsMarkdown={true}
                            artifactSafeMode={true}
                        />
                    ) : (
                        <span className="text-text-muted">{emptyLabel}</span>
                    )}
                </div>
            </div>
        )
    }

    if (kind === 'diff') {
        const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : []
        return (
            <div className="flex flex-col gap-2" data-artifact-renderer="diff">
                {!fullscreen && (
                    <div className="flex items-center justify-end">
                        <CopyButton value={text} label={copyLabel} />
                    </div>
                )}
                <div className={`${boxMax} rounded-lg border border-border-subtle bg-bg-primary/60 py-1 font-mono ${fullscreen ? 'text-xs' : 'text-2xs'}`}>
                    {lines.length === 0 ? (
                        <div className="px-3 py-2 text-text-muted">{emptyLabel}</div>
                    ) : (
                        lines.map((line, idx) => {
                            const lineKind = classifyDiffLine(line)
                            return (
                                <div
                                    key={idx}
                                    data-diff-line-kind={lineKind}
                                    className={`flex min-w-max items-baseline gap-2 px-2.5 py-0.5 leading-relaxed ${getDiffLineClassName(lineKind)}`}
                                >
                                    <span className="w-7 shrink-0 select-none text-right text-3xs text-text-muted opacity-60">
                                        {idx + 1}
                                    </span>
                                    <span className="whitespace-pre">{line || ' '}</span>
                                </div>
                            )
                        })
                    )}
                </div>
            </div>
        )
    }

    if (kind === 'json') {
        const { formatted, valid } = formatArtifactJson(text)
        return (
            <div className="flex flex-col gap-2" data-artifact-renderer="json">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    {!valid ? (
                        <span
                            className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-3xs text-amber-800 dark:text-amber-300"
                            data-testid="artifact-json-invalid-notice"
                        >
                            {trArtifact(t, i18n.language, 'artifact.invalidJsonNotice')}
                        </span>
                    ) : (
                        <span />
                    )}
                    {!fullscreen && <CopyButton value={formatted} label={copyLabel} />}
                </div>
                <pre className={`${boxMax} rounded-lg border border-border-subtle bg-bg-primary/60 p-3 font-mono ${fullscreen ? 'text-xs' : 'text-2xs'} leading-relaxed text-text-primary`}>
                    <code>{formatted || emptyLabel}</code>
                </pre>
            </div>
        )
    }

    // Default / 'text' renderer
    return (
        <div className="flex flex-col gap-2" data-artifact-renderer="text">
            {!fullscreen && (
                <div className="flex items-center justify-end">
                    <CopyButton value={text} label={copyLabel} />
                </div>
            )}
            <pre className={`${boxMax} whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-primary/60 p-3 font-mono ${fullscreen ? 'text-xs' : 'text-2xs'} leading-relaxed text-text-primary`}>
                {text || emptyLabel}
            </pre>
        </div>
    )
}
