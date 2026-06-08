import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import { getConversationTitle } from './conversation-presenters'
import type { ActiveConversation } from './types'
import { IconMesh, IconX } from '../Icons'
import { MeshObservabilitySurface } from '../MeshGraph'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import { useTransport } from '../../context/TransportContext'
import { useTheme } from '../../hooks/useTheme'
import {
    collectSessionAliases,
    useMeshGraphMetadataSubscription,
    type MeshGraphLiveSessionStatus,
} from '../../hooks/useMeshGraphMetadataSubscription'
import { extractRepoMeshStatus } from '../../utils/repo-mesh-status'
import { getMeshGraphTheme } from '../MeshGraph/meshGraphTheme'

export {
    collectMeshGraphLiveSessionStatuses as collectDashboardLiveMeshSessionStatuses,
    getMeshGraphMetadataSignature as getDashboardMeshMetadataSignature,
    mergeMeshGraphLiveSessionStatusIntoMeshStatus as mergeDashboardLiveSessionStatusIntoMeshStatus,
} from '../../hooks/useMeshGraphMetadataSubscription'

interface DashboardMeshGraphDialogProps {
    activeConv: ActiveConversation
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
}

const dashboardMeshGraphStatusCache = new Map<string, RepoMeshStatus>()

function dashboardMeshGraphStatusCacheKey(daemonId: string | null, meshId: string | null): string | null {
    if (!daemonId || !meshId) return null
    return `${daemonId}::${meshId}`
}

function buildActiveConversationLiveSessionStatus(activeConv: ActiveConversation, meshId: string | null): MeshGraphLiveSessionStatus | null {
    if (!meshId || !activeConv.sessionId) return null
    const coordinatorMeshId = activeConv.coordinator?.meshId
        ?? (typeof activeConv.settings?.meshCoordinatorFor === 'string' ? activeConv.settings.meshCoordinatorFor : null)
    const nodeMeshId = typeof activeConv.settings?.meshNodeFor === 'string' ? activeConv.settings.meshNodeFor : null
    if (coordinatorMeshId !== meshId && nodeMeshId !== meshId) return null
    const nodeId = typeof activeConv.settings?.meshNodeId === 'string' ? activeConv.settings.meshNodeId : null
    return {
        sessionId: activeConv.sessionId,
        aliases: collectSessionAliases(activeConv.sessionId, activeConv.providerSessionId, activeConv.historySessionId, activeConv.nativeSessionId),
        meshId,
        nodeId,
        providerType: activeConv.agentType,
        state: activeConv.status,
        chatStatus: activeConv.status,
        role: coordinatorMeshId === meshId ? 'coordinator' : 'worker',
        isSelfCoordinator: coordinatorMeshId === meshId,
        workspace: activeConv.workspacePath ?? null,
    }
}

export default function DashboardMeshGraphDialog({ activeConv, sendDaemonCommand, onClose }: DashboardMeshGraphDialogProps) {
    const meshId = activeConv.coordinator?.meshId
        ?? (typeof activeConv.settings?.meshCoordinatorFor === 'string' ? activeConv.settings.meshCoordinatorFor : null)
    const daemonId = activeConv.daemonId ?? null
    const cacheKey = dashboardMeshGraphStatusCacheKey(daemonId, meshId)
    const initialMeshStatus = cacheKey ? dashboardMeshGraphStatusCache.get(cacheKey) ?? null : null
    const meshOverrides = useDashboardMeshOverrides()
    const { sendData } = useTransport()
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const activeConversationLiveSession = useMemo(
        () => buildActiveConversationLiveSessionStatus(activeConv, meshId),
        [
            activeConv.agentType,
            activeConv.coordinator?.meshId,
            activeConv.sessionId,
            activeConv.settings?.meshCoordinatorFor,
            activeConv.settings?.meshNodeFor,
            activeConv.settings?.meshNodeId,
            activeConv.status,
            activeConv.workspacePath,
            meshId,
        ],
    )
    const [meshStatus, setMeshStatus] = useState<RepoMeshStatus | null>(initialMeshStatus)
    const [loading, setLoading] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(initialMeshStatus?.refreshedAt ?? null)
    const hasUsableGraphRef = useRef(initialMeshStatus !== null)
    const loadInFlightRef = useRef(false)
    const pendingRefreshRef = useRef(false)
    const mountedRef = useRef(true)

    useEffect(() => {
        hasUsableGraphRef.current = meshStatus !== null
    }, [meshStatus])

    useEffect(() => {
        const cachedStatus = cacheKey ? dashboardMeshGraphStatusCache.get(cacheKey) ?? null : null
        setMeshStatus(cachedStatus)
        setLastLoadedAt(cachedStatus?.refreshedAt ?? null)
        hasUsableGraphRef.current = cachedStatus !== null
        pendingRefreshRef.current = false
        setRefreshing(false)
        setError(null)
    }, [cacheKey])

    const loadGraph = useCallback(async (refresh = false) => {
        if (!daemonId || !meshId) {
            setError('This coordinator does not expose a live mesh id.')
            setMeshStatus(null)
            return
        }

        if (loadInFlightRef.current) {
            if (refresh) pendingRefreshRef.current = true
            return
        }

        if (!refresh && cacheKey) {
            const cachedStatus = dashboardMeshGraphStatusCache.get(cacheKey)
            if (cachedStatus) {
                setMeshStatus(cachedStatus)
                setLastLoadedAt(cachedStatus.refreshedAt || null)
                hasUsableGraphRef.current = true
                setLoading(false)
                setError(null)
                return
            }
        }

        loadInFlightRef.current = true
        const showInitialLoader = !hasUsableGraphRef.current
        setLoading(showInitialLoader)
        setRefreshing(refresh && hasUsableGraphRef.current)
        setError(null)
        try {
            const response = meshOverrides?.loadMeshStatus
                ? await meshOverrides.loadMeshStatus(daemonId, meshId, {
                    refresh,
                    retryProfile: refresh ? 'settled' : 'interactive',
                })
                : await sendDaemonCommand(daemonId, 'mesh_status', { meshId, refresh })
            const status = extractRepoMeshStatus(response)
            if (!status) {
                setError('mesh_status returned an unexpected payload.')
                return
            }
            if (cacheKey) dashboardMeshGraphStatusCache.set(cacheKey, status)
            setMeshStatus(status)
            hasUsableGraphRef.current = true
            setLastLoadedAt(status.refreshedAt || new Date().toISOString())
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load live mesh status')
        } finally {
            loadInFlightRef.current = false
            setLoading(false)
            setRefreshing(false)
            if (pendingRefreshRef.current && mountedRef.current) {
                pendingRefreshRef.current = false
                window.setTimeout(() => {
                    if (mountedRef.current) void loadGraph(true)
                }, 0)
            }
        }
    }, [cacheKey, daemonId, meshId, meshOverrides, sendDaemonCommand])

    useEffect(() => {
        mountedRef.current = true
        loadGraph(false)
        return () => {
            mountedRef.current = false
        }
    }, [loadGraph])

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const detailLabel = meshStatus?.meshName || meshId || 'Repo Mesh'
    const extraLiveSessions = useMemo(
        () => activeConversationLiveSession ? [activeConversationLiveSession] : [],
        [activeConversationLiveSession],
    )
    const displayedMeshStatus = useMeshGraphMetadataSubscription({
        status: meshStatus,
        daemonId,
        meshId,
        sendData,
        extraLiveSessions,
    })
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
                                {refreshing ? 'Refreshing mesh...' : `Refreshed ${lastLoadedLabel}`}
                            </span>
                        )}
                        {!refreshing && meshStatus && (
                            <span className={meshTheme.dialogRefreshedChipClass}>
                                {sendData && !error ? 'Live daemon metadata' : 'Metadata subscription unavailable'}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={() => {
                                void loadGraph(true)
                            }}
                            disabled={loading || refreshing}
                            className="btn btn-secondary btn-sm rounded-xl px-3.5"
                            title="Refresh live mesh graph"
                        >
                            {loading || refreshing ? 'Refreshing...' : 'Refresh'}
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
                    {displayedMeshStatus ? (
                        <MeshObservabilitySurface
                            status={displayedMeshStatus}
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
