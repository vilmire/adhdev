import { useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonMetadataUpdate, RepoMeshStatus } from '@adhdev/daemon-core'
import { subscriptionManager } from '../managers/SubscriptionManager'

export type MeshGraphLiveSessionStatus = {
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

type MeshGraphMetadataSubscriptionArgs = {
    status: RepoMeshStatus | null
    daemonId: string | null
    meshId: string | null
    sendData?: (daemonId: string, data: any) => boolean
    extraLiveSessions?: Array<MeshGraphLiveSessionStatus | null | undefined>
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

export function collectSessionAliases(...values: unknown[]): string[] {
    const aliases = new Set<string>()
    for (const value of values) {
        const text = readString(value)
        if (text) aliases.add(text)
    }
    return [...aliases]
}

function buildLiveSessionStatus(session: any, meshId: string): MeshGraphLiveSessionStatus | null {
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

export function collectMeshGraphLiveSessionStatuses(update: DaemonMetadataUpdate, meshId: string | null): MeshGraphLiveSessionStatus[] {
    if (!meshId) return []
    const sessions = Array.isArray(update.status?.sessions) ? update.status.sessions : []
    return sessions
        .map(session => buildLiveSessionStatus(session, meshId))
        .filter((session): session is MeshGraphLiveSessionStatus => session !== null)
}

function liveSessionAliases(session: MeshGraphLiveSessionStatus): string[] {
    return session.aliases && session.aliases.length > 0 ? session.aliases : [session.sessionId]
}

function liveSessionsOverlap(left: MeshGraphLiveSessionStatus, right: MeshGraphLiveSessionStatus): boolean {
    const rightAliases = new Set(liveSessionAliases(right))
    return liveSessionAliases(left).some(alias => rightAliases.has(alias))
}

function mergeExtraLiveSessions(
    metadataLiveSessions: MeshGraphLiveSessionStatus[],
    extraLiveSessions: Array<MeshGraphLiveSessionStatus | null | undefined>,
): MeshGraphLiveSessionStatus[] {
    const extras = extraLiveSessions.filter((session): session is MeshGraphLiveSessionStatus => Boolean(session))
    if (extras.length === 0) return metadataLiveSessions
    const merged = metadataLiveSessions.filter(session => !extras.some(extra => liveSessionsOverlap(session, extra)))
    return [...merged, ...extras]
}

export function mergeMeshGraphLiveSessionStatusIntoMeshStatus(
    status: RepoMeshStatus,
    liveSessions: MeshGraphLiveSessionStatus[],
): RepoMeshStatus {
    if (liveSessions.length === 0) return status
    const liveById = new Map<string, MeshGraphLiveSessionStatus>()
    for (const session of liveSessions) {
        for (const alias of liveSessionAliases(session)) liveById.set(alias, session)
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
            const aliases = liveSessionAliases(live)
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

export function getMeshGraphMetadataSignature(update: DaemonMetadataUpdate, meshId: string | null): string | null {
    const liveSessions = collectMeshGraphLiveSessionStatuses(update, meshId)
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

export function useMeshGraphMetadataSubscription({
    status,
    daemonId,
    meshId,
    sendData,
    extraLiveSessions = [],
}: MeshGraphMetadataSubscriptionArgs): RepoMeshStatus | null {
    const [metadataLiveSessions, setMetadataLiveSessions] = useState<MeshGraphLiveSessionStatus[]>([])
    const metadataSignatureRef = useRef<string | null>(null)

    useEffect(() => {
        metadataSignatureRef.current = null
        setMetadataLiveSessions([])
    }, [daemonId, meshId])

    useEffect(() => {
        if (!daemonId || !meshId || !sendData) return
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
                const signature = getMeshGraphMetadataSignature(update, meshId)
                if (signature === metadataSignatureRef.current) return
                metadataSignatureRef.current = signature
                setMetadataLiveSessions(collectMeshGraphLiveSessionStatuses(update, meshId))
            },
        )
        return () => {
            unsubscribe()
        }
    }, [daemonId, meshId, sendData])

    const liveMeshSessions = useMemo(
        () => mergeExtraLiveSessions(metadataLiveSessions, extraLiveSessions),
        [extraLiveSessions, metadataLiveSessions],
    )

    return useMemo(
        () => status ? mergeMeshGraphLiveSessionStatusIntoMeshStatus(status, liveMeshSessions) : null,
        [liveMeshSessions, status],
    )
}
