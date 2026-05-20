import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { buildMeshGraph } from '../../utils/mesh-visualization'
import { getConversationTitle } from './conversation-presenters'
import type { ActiveConversation } from './types'
import { IconMesh, IconX } from '../Icons'
import { MeshObservabilitySurface } from '../MeshGraph'
import type { MeshGraphData } from '../MeshGraph'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import { useTheme } from '../../hooks/useTheme'
import { hasPendingDashboardMeshRefresh, nextDashboardMeshRefreshDelayMs } from '../../utils/dashboard-mesh-live-refresh'
import { extractRepoMeshStatus } from '../../utils/repo-mesh-status'
import { getMeshGraphTheme } from '../MeshGraph/meshGraphTheme'

interface DashboardMeshGraphDialogProps {
    activeConv: ActiveConversation
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
}

export default function DashboardMeshGraphDialog({ activeConv, sendDaemonCommand, onClose }: DashboardMeshGraphDialogProps) {
    const meshId = typeof activeConv.settings?.meshCoordinatorFor === 'string'
        ? activeConv.settings.meshCoordinatorFor
        : null
    const daemonId = activeConv.daemonId ?? null
    const meshOverrides = useDashboardMeshOverrides()
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const [graph, setGraph] = useState<MeshGraphData | null>(null)
    const [meshStatus, setMeshStatus] = useState<RepoMeshStatus | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)
    const pendingRefreshAttemptRef = useRef(0)
    const pendingRefreshTimerRef = useRef<number | null>(null)

    const loadGraph = useCallback(async () => {
        if (pendingRefreshTimerRef.current != null) {
            window.clearTimeout(pendingRefreshTimerRef.current)
            pendingRefreshTimerRef.current = null
        }
        if (!daemonId || !meshId) {
            pendingRefreshAttemptRef.current = 0
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
            const status = extractRepoMeshStatus(response)
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
            pendingRefreshAttemptRef.current = 0
            setGraph(null)
            setMeshStatus(null)
            setError(err instanceof Error ? err.message : 'Failed to load live mesh status')
        } finally {
            setLoading(false)
        }
    }, [daemonId, meshId, meshOverrides, sendDaemonCommand])

    useEffect(() => {
        pendingRefreshAttemptRef.current = 0
        if (pendingRefreshTimerRef.current != null) {
            window.clearTimeout(pendingRefreshTimerRef.current)
            pendingRefreshTimerRef.current = null
        }
        loadGraph()
    }, [loadGraph])

    useEffect(() => {
        if (pendingRefreshTimerRef.current != null) {
            window.clearTimeout(pendingRefreshTimerRef.current)
            pendingRefreshTimerRef.current = null
        }
        if (loading || !meshStatus || !hasPendingDashboardMeshRefresh(meshStatus.nodes)) {
            if (!loading) pendingRefreshAttemptRef.current = 0
            return
        }
        const delayMs = nextDashboardMeshRefreshDelayMs(pendingRefreshAttemptRef.current)
        if (delayMs == null) return
        pendingRefreshTimerRef.current = window.setTimeout(() => {
            pendingRefreshAttemptRef.current += 1
            void loadGraph()
        }, delayMs)
        return () => {
            if (pendingRefreshTimerRef.current != null) {
                window.clearTimeout(pendingRefreshTimerRef.current)
                pendingRefreshTimerRef.current = null
            }
        }
    }, [loadGraph, loading, meshStatus])

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
        <div className={meshTheme.dialogOverlayClass} onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                className={meshTheme.dialogShellClass}
                onClick={event => event.stopPropagation()}
            >
                <div className={meshTheme.dialogHeaderClass}>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-500/12 text-sky-200 shadow-[0_12px_30px_rgba(14,165,233,0.18)]">
                                <IconMesh size={18} />
                            </span>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className={meshTheme.dialogTitleClass}>{detailLabel}</h2>
                                    <span className={meshTheme.dialogKickerClass}>
                                        Mesh observability
                                    </span>
                                </div>
                                <p className={meshTheme.dialogSubtitleClass}>
                                    {getConversationTitle(activeConv)}
                                    {activeConv.workspaceName ? ` · ${activeConv.workspaceName}` : ''}
                                    {graph?.repoIdentity ? ` · ${graph.repoIdentity}` : ''}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        {lastLoadedLabel && (
                            <span className={meshTheme.dialogRefreshedChipClass}>
                                Refreshed {lastLoadedLabel}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={() => {
                                pendingRefreshAttemptRef.current = 0
                                void loadGraph()
                            }}
                            disabled={loading}
                            className="btn btn-secondary btn-sm rounded-xl px-3.5"
                            title="Refresh live mesh graph"
                        >
                            {loading ? 'Refreshing…' : 'Refresh'}
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className={meshTheme.dialogCloseButtonClass}
                            aria-label="Close mesh graph"
                        >
                            <IconX size={16} />
                        </button>
                    </div>
                </div>

                {error && (
                    <div className={meshTheme.isDark ? 'shrink-0 border-b border-rose-400/20 bg-rose-500/12 px-4 py-2 text-sm text-rose-200 md:px-5' : 'shrink-0 border-b border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-700 md:px-5'}>
                        {error}
                    </div>
                )}

                <div className={meshTheme.dialogBodyClass}>
                    {graph && meshStatus ? (
                        <MeshObservabilitySurface
                            graph={graph}
                            status={meshStatus}
                            emptyMessage={emptyMessage}
                            daemonId={daemonId}
                            sendDaemonCommand={sendDaemonCommand}
                        />
                    ) : (
                        <div className={meshTheme.dialogEmptyClass}>
                            {emptyMessage}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
