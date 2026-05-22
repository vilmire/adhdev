import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { getConversationTitle } from './conversation-presenters'
import type { ActiveConversation } from './types'
import { IconMesh, IconX } from '../Icons'
import { MeshObservabilitySurface } from '../MeshGraph'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import { useTheme } from '../../hooks/useTheme'
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
    const [meshStatus, setMeshStatus] = useState<RepoMeshStatus | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)
    const hasUsableGraphRef = useRef(false)

    useEffect(() => {
        hasUsableGraphRef.current = meshStatus !== null
    }, [meshStatus])

    const loadGraph = useCallback(async (refresh = false) => {
        if (!daemonId || !meshId) {
            setError('This coordinator does not expose a live mesh id.')
            setMeshStatus(null)
            return
        }

        setLoading(!hasUsableGraphRef.current)
        setError(null)
        try {
            const response = meshOverrides?.loadMeshStatus
                ? await meshOverrides.loadMeshStatus(daemonId, meshId, { refresh })
                : await sendDaemonCommand(daemonId, 'mesh_status', { meshId, refresh })
            const status = extractRepoMeshStatus(response)
            if (!status) {
                setError('mesh_status returned an unexpected payload.')
                return
            }
            setMeshStatus(status)
            setLastLoadedAt(status.refreshedAt || new Date().toISOString())
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load live mesh status')
        } finally {
            setLoading(false)
        }
    }, [daemonId, meshId, meshOverrides, sendDaemonCommand])

    useEffect(() => {
        loadGraph(false)
    }, [loadGraph])

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const detailLabel = meshStatus?.meshName || meshId || 'Repo Mesh'
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
                                    {meshStatus?.repoIdentity ? ` · ${meshStatus.repoIdentity}` : ''}
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
                                void loadGraph(true)
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
                    {meshStatus ? (
                        <MeshObservabilitySurface
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
