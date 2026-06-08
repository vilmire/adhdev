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
const MESH_GRAPH_CONNECTED_BACKGROUND_REFRESH_MS = 15_000
const MESH_GRAPH_RECONNECTING_BACKGROUND_REFRESH_MS = 4_000
const MESH_GRAPH_EVENT_REFRESH_MIN_MS = 250

type DashboardLiveMeshSessionStatus = {
    sessionId: string
    aliases?: string[]
    meshId: string
    nodeId?: string | null
    providerType?: string
    state?: string
    chatStatus?: string
    lifecycle?: string
    surfaceKind?: string
    recoveryState?: string
    role?: string
    isSelfCoordinator?: boolean
    workspace?: string | null
}

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

function collectSessionAliases(...values: unknown[]): string[] {
    const aliases = new Set<string>()
    for (const value of values) {
        const text = readString(value)
        if (text) aliases.add(text)
    }
    return [...aliases]
}

function buildLiveSessionStatus(session: any, meshId: string): DashboardLiveMeshSessionStatus | null {
    const settings = readRecord(session?.settings)
    const coordinatorMeshId = readString(session?.coordinator?.meshId) || readString(settings.meshCoordinatorFor)
    const nodeMeshId = readString(settings.meshNodeFor)
    const hasMeshContext = !!coordinatorMeshId || !!nodeMeshId
    const belongsToRequestedMesh = coordinatorMeshId === meshId || nodeMeshId === meshId
    if (hasMeshContext && !belongsToRequestedMesh) return null
    const activeChat = readRecord(session?.activeChat)
    const aliases = collectSessionAliases(
        session?.id,
        session?.sessionId,
        session?.session_id,
        session?.providerSessionId,
        session?.provider_session_id,
        session?.targetSessionId,
        session?.target_session_id,
        activeChat.sessionId,
        activeChat.session_id,
        activeChat.providerSessionId,
        activeChat.provider_session_id,
    )
    const sessionId = aliases[0] || ''
    if (!sessionId) return null
    const role = coordinatorMeshId === meshId
        ? readString(session?.coordinator?.role) || 'coordinator'
        : nodeMeshId === meshId
            ? readString(settings.meshNodeRole) || 'worker'
            : readString(session?.role) || readString(settings.meshNodeRole) || undefined
    return {
        sessionId,
        aliases,
        meshId,
        nodeId: belongsToRequestedMesh ? readString(settings.meshNodeId) || null : null,
        providerType: readString(session?.providerType) || undefined,
        state: readString(session?.status) || undefined,
        chatStatus: readString(activeChat.status) || undefined,
        lifecycle: readString(session?.runtimeLifecycle) || undefined,
        surfaceKind: readString(session?.runtimeSurfaceKind) || undefined,
        recoveryState: readString(session?.runtimeRecoveryState) || undefined,
        ...(role ? { role } : {}),
        ...(belongsToRequestedMesh ? { isSelfCoordinator: coordinatorMeshId === meshId } : {}),
        workspace: readString(session?.workspace) || null,
    }
}

function buildActiveConversationLiveSessionStatus(activeConv: ActiveConversation, meshId: string | null): DashboardLiveMeshSessionStatus | null {
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

export function collectDashboardLiveMeshSessionStatuses(update: DaemonMetadataUpdate, meshId: string | null): DashboardLiveMeshSessionStatus[] {
    if (!meshId) return []
    const sessions = Array.isArray(update.status?.sessions) ? update.status.sessions : []
    return sessions
        .map(session => buildLiveSessionStatus(session, meshId))
        .filter((session): session is DashboardLiveMeshSessionStatus => session !== null)
}

export function mergeDashboardLiveSessionStatusIntoMeshStatus(
    status: RepoMeshStatus,
    liveSessions: DashboardLiveMeshSessionStatus[],
): RepoMeshStatus {
    if (liveSessions.length === 0) return status
    const liveById = new Map<string, DashboardLiveMeshSessionStatus>()
    for (const session of liveSessions) {
        const aliases = session.aliases && session.aliases.length > 0 ? session.aliases : [session.sessionId]
        for (const alias of aliases) liveById.set(alias, session)
    }
    let changed = false
    const nodes = (status.nodes ?? []).map(node => {
        const rawDetails = Array.isArray(node.activeSessionDetails)
            ? node.activeSessionDetails as any[]
            : Array.isArray((node as any).sessions)
                ? (node as any).sessions as any[]
                : []
        const byId = new Map<string, any>()
        for (const session of rawDetails) {
            const sessionAliases = collectSessionAliases(
                session?.sessionId,
                session?.session_id,
                session?.id,
                session?.providerSessionId,
                session?.provider_session_id,
            )
            const sessionId = sessionAliases[0] || ''
            if (!sessionId) continue
            const live = sessionAliases.map(alias => liveById.get(alias)).find(Boolean)
            if (live) changed = true
            byId.set(sessionId, live ? {
                ...session,
                sessionId,
                providerType: live.providerType || session.providerType,
                state: live.state || session.state,
                chatStatus: live.chatStatus || session.chatStatus,
                lifecycle: live.lifecycle || session.lifecycle,
                surfaceKind: live.surfaceKind || session.surfaceKind,
                recoveryState: live.recoveryState || session.recoveryState,
                role: live.role || session.role,
                isSelfCoordinator: live.isSelfCoordinator ?? session.isSelfCoordinator,
                workspace: live.workspace || session.workspace,
            } : { ...session, sessionId })
        }
        for (const sessionId of node.activeSessions ?? []) {
            if (!byId.has(sessionId)) byId.set(sessionId, { sessionId, workspace: node.workspace, isCached: true })
        }
        for (const live of liveSessions) {
            const aliases = live.aliases && live.aliases.length > 0 ? live.aliases : [live.sessionId]
            if (aliases.some(alias => byId.has(alias))) continue
            if (live.nodeId !== node.nodeId) continue
            changed = true
            byId.set(live.sessionId, {
                sessionId: live.sessionId,
                providerType: live.providerType,
                state: live.state,
                chatStatus: live.chatStatus,
                lifecycle: live.lifecycle,
                surfaceKind: live.surfaceKind,
                recoveryState: live.recoveryState,
                role: live.role,
                isSelfCoordinator: live.isSelfCoordinator,
                workspace: live.workspace || node.workspace,
            })
        }
        const activeSessionDetails = [...byId.values()]
        if (activeSessionDetails.length === 0) return node
        return {
            ...node,
            activeSessionDetails,
            activeSessions: activeSessionDetails.map(session => session.sessionId),
        }
    })
    return changed ? { ...status, nodes } : status
}

export function getDashboardMeshMetadataSignature(update: DaemonMetadataUpdate, meshId: string | null): string | null {
    const liveSessions = collectDashboardLiveMeshSessionStatuses(update, meshId)
    const parts = liveSessions
        .map((session) => {
            const rawSession = (Array.isArray(update.status?.sessions) ? update.status.sessions : []).find((entry: any) => readString(entry?.id) === session.sessionId)
            const prompt = readRecord(rawSession?.activeInteractivePrompt)
            const meshQueueStats = rawSession?.meshQueueStats && typeof rawSession.meshQueueStats === 'object'
                ? JSON.stringify(rawSession.meshQueueStats)
                : ''
            return [
                session.sessionId,
                session.providerType ?? '',
                session.state ?? '',
                session.chatStatus ?? '',
                session.lifecycle ?? '',
                session.surfaceKind ?? '',
                session.recoveryState ?? '',
                readString(prompt.status) || readString(prompt.kind) || readString(prompt.type),
                session.nodeId ?? '',
                session.isSelfCoordinator ? 'coordinator' : 'worker',
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
    const [metadataLiveMeshSessions, setMetadataLiveMeshSessions] = useState<DashboardLiveMeshSessionStatus[]>([])
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
        setMetadataLiveMeshSessions([])
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
                setMetadataLiveMeshSessions(collectDashboardLiveMeshSessionStatuses(update, meshId))
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
        const intervalMs = sendData && !error
            ? MESH_GRAPH_CONNECTED_BACKGROUND_REFRESH_MS
            : MESH_GRAPH_RECONNECTING_BACKGROUND_REFRESH_MS
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'hidden') return
            void loadGraph(true, { background: true })
        }, intervalMs)
        return () => window.clearInterval(timer)
    }, [daemonId, error, loadGraph, meshId, sendData])

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const detailLabel = meshStatus?.meshName || meshId || 'Repo Mesh'
    const liveMeshSessions = useMemo(
        () => activeConversationLiveSession
            ? [
                ...metadataLiveMeshSessions.filter(session => session.sessionId !== activeConversationLiveSession.sessionId),
                activeConversationLiveSession,
            ]
            : metadataLiveMeshSessions,
        [activeConversationLiveSession, metadataLiveMeshSessions],
    )
    const displayedMeshStatus = useMemo(
        () => meshStatus ? mergeDashboardLiveSessionStatusIntoMeshStatus(meshStatus, liveMeshSessions) : null,
        [liveMeshSessions, meshStatus],
    )
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
                                {sendData && !error ? 'Live events + 15s reconciliation' : 'Reconnecting + 4s reconciliation'}
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
