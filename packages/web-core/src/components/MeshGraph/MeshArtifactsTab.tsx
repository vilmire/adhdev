import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactKind, ChatAttachmentMeta, RepoMeshStatus } from '@adhdev/daemon-core'
import { useMeshArtifacts } from '../../hooks/useMeshArtifacts'
import { fetchMeshArtifactPayload, type MeshArtifactSendCommand } from '../../utils/mesh-artifact-fetch'
import { formatBytes } from '../../utils/daemon-utils'
import { formatAbsoluteTime, formatRelativeTimeLocalized } from '../../utils/time'
import { RefreshButton } from '../ui/RefreshButton'
import { ArtifactFullscreenViewer } from '../attachments/ArtifactFullscreenViewer'
import { getArtifactKindLabel } from '../attachments/artifact-i18n'
import { toArtifactViewerItem, type ArtifactViewerItem } from '../attachments/artifact-viewer-item'
import { Badge } from './MeshObservabilitySurface/meshSurfacePrimitives'
import {
    buildMeshArtifactsView,
    type MeshArtifactItem,
    type MeshArtifactKindFilter,
} from './meshArtifactsModel'

const KIND_FILTERS: readonly MeshArtifactKindFilter[] = ['all', 'markdown', 'image', 'diff', 'json', 'text']
const KIND_GLYPH: Record<ArtifactKind, string> = { markdown: 'MD', image: 'IMG', diff: '±', json: '{ }', text: 'TXT' }
/** Thumbnails are best-effort: skip big images so scrolling the tab stays cheap. */
const THUMBNAIL_MAX_BYTES = 1_500_000

interface MeshArtifactsTabProps {
    status: RepoMeshStatus
    /** The mesh host (coordinator) daemon — list + fetch target. */
    daemonId?: string | null
    sendDaemonCommand?: MeshArtifactSendCommand | null
    /** True while the tab is visible; nothing loads before the first visit. */
    active: boolean
    refreshToken?: number
    /** "Used by" chip click — the surface switches to the Tasks tab. */
    onOpenTask?: (taskId: string) => void
}

function ArtifactThumb({ attachment, hostDaemonId, sendCommand }: {
    attachment: ChatAttachmentMeta
    hostDaemonId: string
    sendCommand: MeshArtifactSendCommand
}) {
    const ref = useRef<HTMLDivElement>(null)
    const [src, setSrc] = useState<string | null>(null)
    const eligible = attachment.kind === 'image' && attachment.sizeBytes <= THUMBNAIL_MAX_BYTES
    useEffect(() => {
        if (!eligible || typeof IntersectionObserver === 'undefined' || !ref.current) return
        let cancelled = false
        let url: string | null = null
        const observer = new IntersectionObserver(entries => {
            if (!entries.some(e => e.isIntersecting)) return
            observer.disconnect()
            fetchMeshArtifactPayload({ sendCommand, hostDaemonId, attachment }).then(payload => {
                if (cancelled || typeof URL.createObjectURL !== 'function') return
                const copy = new Uint8Array(payload.bytes.byteLength)
                copy.set(payload.bytes)
                url = URL.createObjectURL(new Blob([copy.buffer], { type: payload.mime }))
                setSrc(url)
            }).catch(() => { /* the glyph stays; open the viewer for the real error */ })
        }, { rootMargin: '120px' })
        observer.observe(ref.current)
        return () => {
            cancelled = true
            observer.disconnect()
            if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
        }
    }, [attachment, eligible, hostDaemonId, sendCommand])
    return (
        <div ref={ref} className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-secondary text-3xs font-bold text-text-muted" aria-hidden="true">
            {src ? <img src={src} alt="" className="h-full w-full object-cover" data-testid="mesh-artifact-thumb" /> : KIND_GLYPH[attachment.kind]}
        </div>
    )
}

export default function MeshArtifactsTab({ status, daemonId = null, sendDaemonCommand = null, active, refreshToken, onOpenTask }: MeshArtifactsTabProps) {
    const { t, i18n } = useTranslation('common')
    const [kind, setKind] = useState<MeshArtifactKindFilter>('all')
    const [query, setQuery] = useState('')
    const [viewer, setViewer] = useState<{ artifactId: string; item: ArtifactViewerItem } | null>(null)
    const [openError, setOpenError] = useState<string | null>(null)
    const [opening, setOpening] = useState(false)
    const { attachments, loading, loadingMore, error, hasMore, refresh, loadMore } = useMeshArtifacts({
        meshId: status.meshId,
        hostDaemonId: daemonId,
        sendCommand: sendDaemonCommand,
        enabled: active,
        refreshToken,
    })
    const tasks = useMemo(() => {
        const raw = (status.queue as any)?.tasks
        return Array.isArray(raw) ? raw : []
    }, [status.queue])
    const view = useMemo(
        () => buildMeshArtifactsView({ attachments, tasks, missions: status.missions, kind, query }),
        [attachments, kind, query, status.missions, tasks],
    )

    const openAt = useCallback(async (index: number) => {
        const target = view.ordered[index]
        if (!target || !daemonId || !sendDaemonCommand) return
        setOpening(true)
        setOpenError(null)
        try {
            const payload = await fetchMeshArtifactPayload({ sendCommand: sendDaemonCommand, hostDaemonId: daemonId, attachment: target.attachment })
            setViewer({ artifactId: target.attachment.artifactId, item: toArtifactViewerItem(payload) })
        } catch (err) {
            setOpenError(err instanceof Error ? err.message : String(err))
        } finally {
            setOpening(false)
        }
    }, [daemonId, sendDaemonCommand, view.ordered])

    const viewerIndex = viewer ? view.ordered.findIndex(i => i.attachment.artifactId === viewer.artifactId) : -1
    const onNavigate = useCallback((delta: -1 | 1) => {
        if (opening || viewerIndex < 0) return
        const next = viewerIndex + delta
        if (next >= 0 && next < view.ordered.length) void openAt(next)
    }, [opening, openAt, view.ordered.length, viewerIndex])

    const kindLabel = (k: MeshArtifactKindFilter) => (k === 'all' ? t('mesh.obs.artifactsKindAll') : getArtifactKindLabel(t, i18n.language, k))
    const noHost = !daemonId || !sendDaemonCommand
    const filtered = kind !== 'all' || query.trim() !== ''

    const renderItem = (item: MeshArtifactItem) => {
        const att = item.attachment
        const title = att.title || att.filename
        const index = view.ordered.indexOf(item)
        return (
            <li key={att.artifactId} className="flex items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-secondary/40 p-2" data-testid="mesh-artifact-row" data-artifact-id={att.artifactId}>
                {daemonId && sendDaemonCommand
                    ? <ArtifactThumb attachment={att} hostDaemonId={daemonId} sendCommand={sendDaemonCommand} />
                    : <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border-subtle text-3xs font-bold text-text-muted" aria-hidden="true">{KIND_GLYPH[att.kind]}</div>}
                <div className="min-w-0 flex-1">
                    <button
                        type="button"
                        onClick={() => void openAt(index)}
                        aria-label={t('mesh.obs.artifactsOpenAria', { title })}
                        className="block max-w-full truncate text-left text-sm font-semibold text-text-primary hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        data-testid="mesh-artifact-open"
                    >
                        {title}
                    </button>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-3xs text-text-muted">
                        <span>{kindLabel(att.kind)}</span>
                        {att.filename && att.filename !== title && <span className="truncate">{att.filename}</span>}
                        <span>{formatBytes(att.sizeBytes)}</span>
                        <time title={formatAbsoluteTime(att.createdAt, { locale: i18n.language })}>{formatRelativeTimeLocalized(att.createdAt, { locale: i18n.language })}</time>
                    </div>
                    {att.previewText && <p className="mt-0.5 truncate text-2xs text-text-secondary">{att.previewText.split('\n').find(l => l.trim()) ?? ''}</p>}
                    {item.usedBy.length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="mesh-artifact-used-by">
                            <span className="text-3xs font-medium text-text-muted">{t('mesh.obs.artifactsUsedBy')}</span>
                            {item.usedBy.map(ref => (
                                <button
                                    key={ref.taskId}
                                    type="button"
                                    onClick={() => onOpenTask?.(ref.taskId)}
                                    disabled={!onOpenTask}
                                    title={ref.title}
                                    className="max-w-[16rem] truncate rounded-full border border-border-subtle px-2 py-0.5 text-3xs text-text-secondary hover:border-border-default hover:text-text-primary disabled:cursor-default"
                                >
                                    {ref.title}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </li>
        )
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-3" data-testid="mesh-artifacts-tab">
            <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                    type="search"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={t('mesh.obs.artifactsSearchPlaceholder')}
                    aria-label={t('mesh.obs.artifactsSearchPlaceholder')}
                    className="min-w-[10rem] flex-1 rounded-lg border border-border-subtle bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                />
                <div role="group" aria-label={t('mesh.obs.artifactsKindAria')} className="flex flex-wrap items-center gap-1">
                    {KIND_FILTERS.map(k => (
                        <button
                            key={k}
                            type="button"
                            aria-pressed={kind === k}
                            onClick={() => setKind(k)}
                            data-testid={`mesh-artifact-kind-${k}`}
                            className={`rounded-full border px-2.5 py-1 text-2xs font-medium ${kind === k ? 'border-accent text-accent' : 'border-border-subtle text-text-secondary hover:border-border-default'}`}
                        >
                            {kindLabel(k)}
                        </button>
                    ))}
                </div>
                <RefreshButton onClick={refresh} refreshing={loading} disabled={noHost} className="h-8 w-8" />
            </div>

            {openError && <div role="alert" className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">{t('mesh.obs.artifactsOpenFailed', { reason: openError })}</div>}

            {noHost ? (
                <div className="px-3 py-8 text-center text-sm text-text-muted">{t('mesh.obs.artifactsNoHost')}</div>
            ) : error && attachments.length === 0 ? (
                <div role="alert" className="px-3 py-8 text-center text-sm text-rose-700 dark:text-rose-200">{t('mesh.obs.artifactsError', { reason: error })}</div>
            ) : loading && attachments.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-text-muted" aria-busy="true">{t('mesh.obs.artifactsLoading')}</div>
            ) : view.total === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-text-muted">{filtered && attachments.length > 0 ? t('mesh.obs.artifactsNoMatches') : t('mesh.obs.artifactsEmpty')}</div>
            ) : (
                view.missions.map(mission => (
                    <section key={mission.missionId ?? 'none'} className="flex flex-col gap-2" data-testid="mesh-artifact-mission" data-mission-id={mission.missionId ?? ''}>
                        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                            <span className="truncate">{mission.missionId ? mission.title : t('mesh.obs.artifactsUnassigned')}</span>
                            <Badge label={t('mesh.obs.artifactsCount', { count: mission.count })} />
                        </h3>
                        {mission.tasks.map(group => (
                            <div key={group.taskId ?? 'none'} className="flex flex-col gap-1.5 pl-2" data-testid="mesh-artifact-task" data-task-id={group.taskId ?? ''}>
                                <div className="flex flex-wrap items-center gap-1.5 text-2xs text-text-secondary">
                                    <span className="min-w-0 truncate font-medium">{group.taskId ? group.title : t('mesh.obs.artifactsNoTask')}</span>
                                    {group.producerRole && <Badge label={group.producerRole} tone="info" />}
                                    {group.sessionId && <span className="text-3xs text-text-muted" title={group.sessionId}>{t('mesh.obs.artifactsSession', { id: group.sessionId.slice(0, 8) })}</span>}
                                </div>
                                <ul className="flex flex-col gap-1.5">{group.items.map(renderItem)}</ul>
                            </div>
                        ))}
                    </section>
                ))
            )}

            {hasMore && !noHost && (
                <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="self-center rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-border-default disabled:opacity-50"
                    data-testid="mesh-artifacts-load-more"
                >
                    {loadingMore ? t('mesh.obs.artifactsLoading') : t('mesh.obs.artifactsLoadMore')}
                </button>
            )}

            {viewer && (
                <ArtifactFullscreenViewer
                    item={viewer.item}
                    popOutPayload={viewer.item}
                    onClose={() => setViewer(null)}
                    position={viewerIndex >= 0 ? { index: viewerIndex, total: view.ordered.length } : undefined}
                    onNavigate={viewerIndex >= 0 ? onNavigate : undefined}
                />
            )}
        </div>
    )
}
