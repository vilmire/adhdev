import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonMetadataUpdate, RepoMeshStatus } from '@adhdev/daemon-core'
import { getConversationTitle } from './conversation-presenters'
import type { ActiveConversation } from './types'
import { IconMesh, IconX } from '../Icons'
import { MeshObservabilitySurface } from '../MeshGraph'
import { useDashboardMeshOverrides } from '../../context/DashboardMeshContext'
import { useTransport } from '../../context/TransportContext'
import { useTheme } from '../../hooks/useTheme'
import { subscriptionManager } from '../../managers/SubscriptionManager'
import { extractRepoMeshStatus } from '../../utils/repo-mesh-status'
import { getMeshGraphTheme } from '../MeshGraph/meshGraphTheme'

interface DashboardMeshGraphDialogProps {
    activeConv: ActiveConversation
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
}

const dashboardMeshGraphStatusCache = new Map<string, RepoMeshStatus>()
const MESH_GRAPH_BACKGROUND_REFRESH_MS = 4_000
const MESH_GRAPH_EVENT_REFRESH_MIN_MS = 250

function dashboardMeshGraphStatusCacheKey(daemonId: string | null, meshId: string | null): string | null {
    if (!daemonId || !meshId) return null
    return `${daemonId}::${meshId}`
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

export function getDashboardMeshMetadataSignature(update: DaemonMetadataUpdate, meshId: string | null): string | null {
    if (!meshId) return null
    const sessions = Array.isArray(update.status?.sessions) ? update.status.sessions : []
    const parts = sessions
        .map((session: any) => {
            const settings = readRecord(session?.settings)
            const coordinatorMeshId = readString(session?.coordinator?.meshId) || readString(settings.meshCoordinatorFor)
            const nodeMeshId = readString(settings.meshNodeFor)
            if (coordinatorMeshId !== meshId && nodeMeshId !== meshId) return null
            const activeChat = readRecord(session?.activeChat)
            const prompt = readRecord(session?.activeInteractivePrompt)
            const meshQueueStats = session?.meshQueueStats && typeof session.meshQueueStats === 'object'
                ? JSON.stringify(session.meshQueueStats)
                : ''
            return [
                readString(session?.id),
                readString(session?.providerType),
                readString(session?.status),
                readString(activeChat.status),
                readString(session?.runtimeLifecycle),
                readString(session?.runtimeSurfaceKind),
                readString(session?.runtimeRecoveryState),
                readString(prompt.status) || readString(prompt.kind) || readString(prompt.type),
                readString(settings.meshNodeId),
                coordinatorMeshId ? 'coordinator' : 'worker',
                meshQueueStats,
            ].join('|')
        })
        .filter((part): part is string => !!part)
        .sort()

    return parts.length > 0 ? parts.join('\n') : null
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
    const [meshStatus, setMeshStatus] = useState<RepoMeshStatus | null>(initialMeshStatus)
    const [loading, setLoading] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(initialMeshStatus?.refreshedAt ?? null)
    const hasUsableGraphRef = useRef(initialMeshStatus !== null)
    const loadInFlightRef = useRef(false)
    const pendingRefreshRef = useRef(false)
    const metadataSignatureRef = useRef<string | null>(null)
    const lastEventRefreshAtRef = useRef(0)
    const pendingEventTimerRef = useRef<number | null>(null)
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
        metadataSignatureRef.current = null
        setRefreshing(false)
        setError(null)
    }, [cacheKey])

    const loadGraph = useCallback(async (refresh = false, options?: { background?: boolean }) => {
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
        const showInitialLoader = !hasUsableGraphRef.current && !options?.background
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
                    if (mountedRef.current) void loadGraph(true, { background: true })
                }, 0)
            }
        }
    }, [cacheKey, daemonId, meshId, meshOverrides, sendDaemonCommand])

    const scheduleEventDrivenRefresh = useCallback(() => {
        if (document.visibilityState === 'hidden') return
        const now = Date.now()
        const elapsed = now - lastEventRefreshAtRef.current
        const run = () => {
            pendingEventTimerRef.current = null
            lastEventRefreshAtRef.current = Date.now()
            void loadGraph(true, { background: true })
        }
        if (elapsed >= MESH_GRAPH_EVENT_REFRESH_MIN_MS) {
            if (pendingEventTimerRef.current !== null) {
                window.clearTimeout(pendingEventTimerRef.current)
                pendingEventTimerRef.current = null
            }
            run()
            return
        }
        if (pendingEventTimerRef.current !== null) return
        pendingEventTimerRef.current = window.setTimeout(run, MESH_GRAPH_EVENT_REFRESH_MIN_MS - elapsed)
    }, [loadGraph])

    useEffect(() => {
        mountedRef.current = true
        loadGraph(false)
        return () => {
            mountedRef.current = false
            if (pendingEventTimerRef.current !== null) {
                window.clearTimeout(pendingEventTimerRef.current)
                pendingEventTimerRef.current = null
            }
        }
    }, [loadGraph])

    useEffect(() => {
        if (!daemonId || !meshId || !sendData) return
        // Daemon metadata carries delegated worker and mesh queue/session transitions.
        // A coordinator's own in-flight turn may still surface only when its provider reports status, so the timer below remains a reconciliation path.
        const unsubscribe = subscriptionManager.subscribe(
            { sendData },
            daemonId,
            {
                type: 'subscribe',
                topic: 'daemon.metadata',
                key: `daemon:metadata:${daemonId}`,
                params: {
                    includeSessions: true,
                },
            },
            (update: DaemonMetadataUpdate) => {
                if (update.topic !== 'daemon.metadata') return
                const signature = getDashboardMeshMetadataSignature(update, meshId)
                if (!signature || signature === metadataSignatureRef.current) return
                metadataSignatureRef.current = signature
                scheduleEventDrivenRefresh()
            },
        )
        return () => {
            unsubscribe()
        }
    }, [daemonId, meshId, scheduleEventDrivenRefresh, sendData])

    useEffect(() => {
        if (!daemonId || !meshId) return
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'hidden') return
            void loadGraph(true, { background: true })
        }, MESH_GRAPH_BACKGROUND_REFRESH_MS)
        return () => window.clearInterval(timer)
    }, [daemonId, loadGraph, meshId])

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
                                {refreshing ? 'Refreshing mesh...' : `Refreshed ${lastLoadedLabel}`}
                            </span>
                        )}
                        {!refreshing && meshStatus && (
                            <span className={meshTheme.dialogRefreshedChipClass}>
                                Live events + 4s fallback
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
