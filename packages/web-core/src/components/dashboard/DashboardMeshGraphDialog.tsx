import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { buildMeshGraph } from '../../utils/mesh-visualization'
import { getConversationTitle } from './conversation-presenters'
import type { ActiveConversation } from './types'
import { IconMesh, IconX } from '../Icons'
import { MeshObservabilitySurface } from '../MeshGraph'
import type { MeshGraphData } from '../MeshGraph'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'

interface DashboardMeshGraphDialogProps {
    activeConv: ActiveConversation
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
}

function extractMeshStatus(response: any): RepoMeshStatus | null {
    const body = response?.result ?? response
    const candidates = [response?.status, body?.status, body, response]
    for (const candidate of candidates) {
        if (candidate && Array.isArray(candidate.nodes) && typeof candidate.meshId === 'string') {
            return candidate as RepoMeshStatus
        }
    }
    return null
}

export default function DashboardMeshGraphDialog({ activeConv, sendDaemonCommand, onClose }: DashboardMeshGraphDialogProps) {
    const meshId = typeof activeConv.settings?.meshCoordinatorFor === 'string'
        ? activeConv.settings.meshCoordinatorFor
        : null
    const daemonId = activeConv.daemonId ?? null
    const meshOverrides = useDashboardMeshOverrides()
    const [graph, setGraph] = useState<MeshGraphData | null>(null)
    const [meshStatus, setMeshStatus] = useState<RepoMeshStatus | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)

    const loadGraph = useCallback(async () => {
        if (!daemonId || !meshId) {
            setError('This coordinator does not expose a live mesh id.')
            setGraph(null)
            setMeshStatus(null)
            return
        }

        setLoading(true)
        setError(null)
        try {
            const response = meshOverrides?.loadMeshStatus
                ? await meshOverrides.loadMeshStatus(daemonId, meshId)
                : await sendDaemonCommand(daemonId, 'mesh_status', { meshId })
            const status = extractMeshStatus(response)
            if (!status) {
                setGraph(null)
                setMeshStatus(null)
                setError('mesh_status returned an unexpected payload.')
                return
            }
            const nextGraph = buildMeshGraph(status)
            setMeshStatus(status)
            setGraph(nextGraph)
            setLastLoadedAt(status.refreshedAt || new Date().toISOString())
        } catch (err) {
            setGraph(null)
            setMeshStatus(null)
            setError(err instanceof Error ? err.message : 'Failed to load live mesh status')
        } finally {
            setLoading(false)
        }
    }, [daemonId, meshId, meshOverrides, sendDaemonCommand])

    useEffect(() => {
        loadGraph()
    }, [loadGraph])

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const detailLabel = graph?.meshName || meshStatus?.meshName || meshId || 'Repo Mesh'
    const lastLoadedLabel = lastLoadedAt ? new Date(lastLoadedAt).toLocaleTimeString() : null
    const emptyMessage = useMemo(
        () => (loading ? 'Loading live mesh status…' : 'No live mesh graph is available for this coordinator yet.'),
        [loading],
    )

    return (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-[#030617]/[0.58] p-0 md:p-4 backdrop-blur-md" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                className="flex h-[100dvh] w-full flex-col overflow-hidden bg-slate-950 md:h-[min(90vh,960px)] md:max-w-[min(1480px,calc(100vw-32px))] md:rounded-[24px] md:border md:border-white/10 md:bg-slate-950/96 md:shadow-[0_28px_120px_rgba(2,6,23,0.46)]"
                onClick={event => event.stopPropagation()}
            >
                <div className="flex shrink-0 flex-col gap-3 border-b border-white/10 bg-slate-950/92 px-4 pb-4 pt-[calc(16px+env(safe-area-inset-top,0px))] backdrop-blur md:flex-row md:items-center md:justify-between md:px-5">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-500/12 text-sky-200 shadow-[0_12px_30px_rgba(14,165,233,0.18)]">
                                <IconMesh size={18} />
                            </span>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="truncate text-lg font-semibold text-white md:text-xl">{detailLabel}</h2>
                                    <span className="rounded-full border border-white/10 bg-white/6 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-300">
                                        Mesh observability
                                    </span>
                                </div>
                                <p className="mt-1 truncate text-sm text-slate-400">
                                    {getConversationTitle(activeConv)}
                                    {activeConv.workspaceName ? ` · ${activeConv.workspaceName}` : ''}
                                    {graph?.repoIdentity ? ` · ${graph.repoIdentity}` : ''}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        {lastLoadedLabel && (
                            <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-slate-300">
                                Refreshed {lastLoadedLabel}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={loadGraph}
                            disabled={loading}
                            className="btn btn-secondary btn-sm rounded-xl px-3.5"
                            title="Refresh live mesh graph"
                        >
                            {loading ? 'Refreshing…' : 'Refresh'}
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/6 text-slate-300 transition hover:bg-white/10 hover:text-white"
                            aria-label="Close mesh graph"
                        >
                            <IconX size={16} />
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="shrink-0 border-b border-rose-400/20 bg-rose-500/12 px-4 py-2 text-sm text-rose-200 md:px-5">
                        {error}
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,rgba(2,6,23,0.95),rgba(15,23,42,0.98))] px-4 py-4 md:px-5 md:py-5">
                    {graph && meshStatus ? (
                        <MeshObservabilitySurface graph={graph} status={meshStatus} emptyMessage={emptyMessage} />
                    ) : (
                        <div className="flex h-full min-h-[320px] items-center justify-center rounded-[28px] border border-dashed border-white/10 bg-white/[0.03] px-6 text-center text-sm text-slate-400">
                            {emptyMessage}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
