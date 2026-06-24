/**
 * BaseDaemonContext — shared daemon status management (web-core)
 *
 * Does not include transport layers like P2P or WS.
 * When standalone/cloud injects data, this Context manages status.
 *
 * Usage:
 *   const { injectEntries, injectDaemonIds } = useBaseDaemonActions()
 *   // standalone: receive data from localhost WS and call injectEntries
 *   // cloud: receive data from CF WS + P2P and call injectEntries
 */
import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react'
import type { DaemonData, SessionEntry, WebVersionUpdateReason } from '../types'
import type { InteractivePrompt } from '../interactive-prompt/types'
import { webDebugStore } from '../debug/webDebugStore'
import { summarizeDaemonEntriesForDebug } from '../debug/entryDebugSummary'
import { mergeActiveChatData } from '../utils/session-entry-merge'
import { reconcileIdes, daemonArraysEqual } from './ides-reconcile'

// reconcileIdes lives in ./ides-reconcile (pure merge engine); re-exported here so the
// existing import path (and the web-core barrel) stays byte-stable for consumers/tests.
export { reconcileIdes } from './ides-reconcile'

// ─── Types ────────────────────────────────────────────

export interface Toast {
    id: number
    message: string
    type: 'success' | 'info' | 'warning'
    timestamp: number
    targetKey?: string
    /** Optional inline action buttons (e.g., approve/reject for approval toasts) */
    actions?: { label: string; onClick: () => void; variant?: 'primary' | 'danger' | 'default' }[]
}

export interface BaseDaemonContextValue {
    ides: DaemonData[]
    updateRouteChats: (routeId: string, chats: DaemonData['chats']) => void
    initialLoaded: boolean
    toasts: Toast[]
    setToasts: React.Dispatch<React.SetStateAction<Toast[]>>
    // Abstract connection state (injected by platform: cloud=P2P, standalone=local)
    wsStatus: string
    isConnected: boolean
    connectionStates: Record<string, string>   // machineId → 'connected' | 'connecting' | ...
    connectionTransports: Record<string, string> // machineId → 'relay' | 'direct' | ...
    showReconnected: boolean
    retryConnection?: (machineId: string) => void
    retryServerConnection?: () => void
    /** Login URL for cloud auth/session-expired connection banners. */
    connectionLoginUrl?: string
    /** User display name for chat messages */
    userName?: string
    setUserName?: (name: string) => void
    // Cloud-specific optional fields (used by Layout/ConnectionLoader)
    /** Whether any P2P connection is active */
    isP2PActive?: boolean
    /** Per-daemon P2P connection state map */
    p2pStates?: Record<string, string>
    /** User role for admin gating */
    userRole?: string
    /** Per-daemon P2P reconnect status (blocked after exhausting auto budget) */
    connectionRetryStatuses?: Record<string, { attempts: number; maxAttempts: number; blocked: boolean; nextRetryAt?: number }>
}

/** Data injection interface (used by standalone/cloud) */
export interface BaseDaemonActions {
    /** Merge entries received from server/WS into status */
    injectEntries: (entries: DaemonData[], options?: { authoritativeDaemonIds?: string[] }) => void
    /** Mark initial load complete */
    markLoaded: () => void
    /** Current ides reference */
    getIdes: () => DaemonData[]
}

const BaseDaemonCtx = createContext<BaseDaemonContextValue>({
    ides: [],
    updateRouteChats: () => {},
    initialLoaded: false,
    toasts: [],
    setToasts: () => {},
    wsStatus: 'connected',
    isConnected: true,
    connectionStates: {},
    connectionTransports: {},
    showReconnected: false,
    userName: undefined,
    setUserName: () => {},
    isP2PActive: false,
    p2pStates: {},
    userRole: undefined,
    connectionRetryStatuses: undefined,
})

const ActionsCtx = createContext<BaseDaemonActions>({
    injectEntries: () => {},
    markLoaded: () => {},
    getIdes: () => [],
})

// ─── Helpers ──────────────────────────────────────────
// The richness-aware merge engine (reconcileIdes + helpers) lives in
// ./ides-reconcile. Only Provider/compact-expansion code remains below.

/**
 * expandCompactDaemons — server compact format → flat DaemonData[]
 * standalone/cloud shared
 */
export interface CompactSessionEntry {
    id: string
    parentId?: string | null
    providerType: string
    providerName?: string
    providerSessionId?: string
    kind: SessionEntry['kind']
    transport: SessionEntry['transport']
    status?: SessionEntry['status'] | 'online'
    title?: string
    workspace?: string | null
    activeChat?: DaemonData['activeChat']
    capabilities?: string[]
    cdpConnected?: boolean
    runtimeKey?: string
    runtimeDisplayName?: string
    runtimeWorkspaceLabel?: string
    runtimeWriteOwner?: DaemonData['runtimeWriteOwner']
    runtimeAttachedClients?: DaemonData['runtimeAttachedClients']
    lastMessagePreview?: string
    lastMessageRole?: string
    lastMessageAt?: number
    lastMessageHash?: string
    lastUpdated?: number
    unread?: boolean
    lastSeenAt?: number
    inboxBucket?: DaemonData['inboxBucket']
    completionMarker?: string
    seenCompletionMarker?: string
    surfaceHidden?: boolean
    controlValues?: DaemonData['controlValues']
    providerControls?: DaemonData['providerControls']
    summaryMetadata?: DaemonData['summaryMetadata']
    activeInteractivePrompt?: InteractivePrompt | null
    /**
     * True owning-daemon id for a session that a coordinator synthesises into its own
     * snapshot (mesh delegated sessions). When present, the expanded entry is attributed
     * to this daemon instead of the snapshot daemon so the dashboard shows the worker
     * machine, not the coordinator.
     */
    ownerDaemonId?: string
    /** True owning-machine display name fallback when the owning daemon is not aggregated. */
    ownerMachineName?: string
    settings?: Record<string, any>
}

export interface CompactDaemon {
    id: string
    type?: string
    machineId?: string
    platform?: string
    hostname?: string
    nickname?: string
    p2p?: DaemonData['p2p']
    cdp?: boolean
    cdpConnected?: boolean
    ts?: number
    timestamp?: number
    version?: string
    serverVersion?: string
    versionMismatch?: boolean
    versionUpdateRequired?: boolean
    versionUpdateReason?: WebVersionUpdateReason
    releaseChannel?: DaemonData['releaseChannel']
    updateChannel?: DaemonData['updateChannel']
    updatePolicy?: DaemonData['updatePolicy']
    updateCommand?: string
    terminalBackend?: DaemonData['terminalBackend']
    detectedIdes?: DaemonData['detectedIdes']
    availableProviders?: DaemonData['availableProviders']
    sessions?: CompactSessionEntry[]
}

function normalizeCompactSession(session: CompactSessionEntry): SessionEntry {
    const rawStatus = session.status
    const normalizedStatus: SessionEntry['status'] = !rawStatus || rawStatus === 'online'
        ? 'idle'
        : rawStatus

    return {
        id: session.id,
        parentId: session.parentId ?? null,
        providerType: session.providerType,
        providerName: session.providerName || session.providerType,
        providerSessionId: session.providerSessionId,
        kind: session.kind,
        transport: session.transport,
        status: normalizedStatus,
        title: session.title || session.providerName || session.providerType,
        workspace: session.workspace ?? null,
        activeChat: null,
        capabilities: [],
        cdpConnected: session.cdpConnected,
        summaryMetadata: session.summaryMetadata,
        completionMarker: session.completionMarker,
        seenCompletionMarker: session.seenCompletionMarker,
        activeInteractivePrompt: session.activeInteractivePrompt ?? null,
    } as SessionEntry
}

export type CompactDaemonCompat = CompactDaemon & {
    cdp?: boolean
    ts?: number
}

export function expandCompactDaemons(
    compactDaemons: CompactDaemonCompat[],
    options?: {
        skipDaemonId?: (id: string) => boolean
        /** Keep daemon-level metadata but strip all session expansion for matching daemons. */
        daemonOnlyId?: (id: string) => boolean
    }
): { entries: DaemonData[]; allDaemonIds: Set<string> } {
    const entries: DaemonData[] = []
    const allDaemonIds = new Set<string>()

    for (const d of compactDaemons) {
        allDaemonIds.add(d.id)

        if (options?.skipDaemonId?.(d.id)) continue

        const ts = d.timestamp || d.ts || Date.now()
        const cdp = d.cdpConnected ?? d.cdp
        const daemonOnly = options?.daemonOnlyId?.(d.id) === true
        const sessions = daemonOnly ? [] : (d.sessions || [])
        const topLevelIdeSessions = sessions.filter(s => !s.parentId && s.kind === 'workspace' && s.transport === 'cdp-page')
        const topLevelCliSessions = sessions.filter(s => !s.parentId && s.kind === 'agent' && s.transport === 'pty')
        const topLevelAcpSessions = sessions.filter(s => !s.parentId && s.kind === 'agent' && s.transport === 'acp')

        entries.push({
            id: d.id,
            type: d.type || 'adhdev-daemon',
            status: 'online',
            machineNickname: d.nickname,
            hostname: d.hostname,
            p2p: d.p2p,
            cdpConnected: cdp,
            timestamp: ts,
            ...(d.version && { version: d.version }),
            ...(d.serverVersion && { serverVersion: d.serverVersion }),
            ...(d.releaseChannel && { releaseChannel: d.releaseChannel }),
            ...(d.updateChannel && { updateChannel: d.updateChannel }),
            ...(d.updatePolicy && { updatePolicy: d.updatePolicy }),
            ...(d.updateCommand && { updateCommand: d.updateCommand }),
            ...(d.versionMismatch && { versionMismatch: true }),
            ...(d.versionUpdateRequired && { versionUpdateRequired: true }),
            ...(d.versionUpdateReason && { versionUpdateReason: d.versionUpdateReason }),
            ...(d.detectedIdes && { detectedIdes: d.detectedIdes }),
            ...(d.availableProviders && { availableProviders: d.availableProviders }),
        })

        for (const ide of topLevelIdeSessions) {
            const childSessions = sessions
                .filter(s => s.parentId === ide.id)
                .map(normalizeCompactSession)
            const ideFullId = `${d.id}:ide:${ide.id}`
            entries.push({
                id: ideFullId,
                sessionId: ide.id,
                ...(ide.providerSessionId !== undefined && { providerSessionId: ide.providerSessionId }),
                parentSessionId: ide.parentId ?? null,
                sessionKind: ide.kind,
                transport: ide.transport,
                sessionCapabilities: ide.capabilities,
                type: ide.providerType,
                status: ide.status || 'online',
                daemonId: d.id,
                cdpConnected: ide.cdpConnected,
                title: ide.title,
                workspace: ide.workspace || null,
                activeChat: mergeActiveChatData(ide.activeChat, null),
                ...(ide.activeInteractivePrompt !== undefined && { activeInteractivePrompt: ide.activeInteractivePrompt }),
                childSessions,
                ...(ide.lastMessagePreview !== undefined && { lastMessagePreview: ide.lastMessagePreview }),
                ...(ide.lastMessageRole !== undefined && { lastMessageRole: ide.lastMessageRole }),
                ...(ide.lastMessageAt !== undefined && { lastMessageAt: ide.lastMessageAt }),
                ...(ide.lastMessageHash !== undefined && { lastMessageHash: ide.lastMessageHash }),
                ...(ide.lastUpdated !== undefined && { lastUpdated: ide.lastUpdated }),
                ...(ide.unread !== undefined && { unread: ide.unread }),
                ...(ide.lastSeenAt !== undefined && { lastSeenAt: ide.lastSeenAt }),
                ...(ide.inboxBucket !== undefined && { inboxBucket: ide.inboxBucket }),
                ...(ide.completionMarker !== undefined && { completionMarker: ide.completionMarker }),
                ...(ide.seenCompletionMarker !== undefined && { seenCompletionMarker: ide.seenCompletionMarker }),
                ...(ide.surfaceHidden !== undefined && { surfaceHidden: ide.surfaceHidden }),
                ...(ide.controlValues !== undefined && { controlValues: ide.controlValues }),
                ...(ide.providerControls !== undefined && { providerControls: ide.providerControls }),
                summaryMetadata: ide.summaryMetadata,
                timestamp: ts,
            })
        }

        for (const cli of topLevelCliSessions) {
            const cliFullId = `${d.id}:cli:${cli.id}`
            entries.push({
                id: cliFullId,
                sessionId: cli.id,
                ...(cli.providerSessionId !== undefined && { providerSessionId: cli.providerSessionId }),
                parentSessionId: cli.parentId ?? null,
                sessionKind: cli.kind,
                transport: cli.transport,
                sessionCapabilities: cli.capabilities,
                type: cli.providerType,
                agentType: cli.providerType,
                status: cli.status || 'online',
                daemonId: d.id,
                ...(cli.ownerDaemonId && { ownerDaemonId: cli.ownerDaemonId }),
                ...(cli.ownerMachineName && { ownerMachineName: cli.ownerMachineName }),
                ...(cli.settings && { settings: cli.settings }),
                instanceId: cli.id,
                cliName: cli.providerName,
                title: cli.title,
                mode: 'chat',
                workspace: cli.workspace || '',
                activeChat: mergeActiveChatData(cli.activeChat, null),
                ...(cli.activeInteractivePrompt !== undefined && { activeInteractivePrompt: cli.activeInteractivePrompt }),
                ...(cli.runtimeKey !== undefined && { runtimeKey: cli.runtimeKey }),
                ...(cli.runtimeDisplayName !== undefined && { runtimeDisplayName: cli.runtimeDisplayName }),
                ...(cli.runtimeWorkspaceLabel !== undefined && { runtimeWorkspaceLabel: cli.runtimeWorkspaceLabel }),
                ...(cli.runtimeWriteOwner !== undefined && { runtimeWriteOwner: cli.runtimeWriteOwner }),
                ...(cli.runtimeAttachedClients !== undefined && { runtimeAttachedClients: cli.runtimeAttachedClients }),
                ...(cli.lastMessagePreview !== undefined && { lastMessagePreview: cli.lastMessagePreview }),
                ...(cli.lastMessageRole !== undefined && { lastMessageRole: cli.lastMessageRole }),
                ...(cli.lastMessageAt !== undefined && { lastMessageAt: cli.lastMessageAt }),
                ...(cli.lastMessageHash !== undefined && { lastMessageHash: cli.lastMessageHash }),
                ...(cli.lastUpdated !== undefined && { lastUpdated: cli.lastUpdated }),
                ...(cli.unread !== undefined && { unread: cli.unread }),
                ...(cli.lastSeenAt !== undefined && { lastSeenAt: cli.lastSeenAt }),
                ...(cli.inboxBucket !== undefined && { inboxBucket: cli.inboxBucket }),
                ...(cli.completionMarker !== undefined && { completionMarker: cli.completionMarker }),
                ...(cli.seenCompletionMarker !== undefined && { seenCompletionMarker: cli.seenCompletionMarker }),
                ...(cli.surfaceHidden !== undefined && { surfaceHidden: cli.surfaceHidden }),
                ...(cli.controlValues !== undefined && { controlValues: cli.controlValues }),
                ...(cli.providerControls !== undefined && { providerControls: cli.providerControls }),
                summaryMetadata: cli.summaryMetadata,
                timestamp: ts,
                _isCli: true,
            })
        }

        for (const acp of topLevelAcpSessions) {
            const acpFullId = `${d.id}:acp:${acp.id}`
            entries.push({
                id: acpFullId,
                sessionId: acp.id,
                ...(acp.providerSessionId !== undefined && { providerSessionId: acp.providerSessionId }),
                parentSessionId: acp.parentId ?? null,
                sessionKind: acp.kind,
                transport: acp.transport,
                sessionCapabilities: acp.capabilities,
                type: acp.providerType,
                agentType: acp.providerType,
                status: acp.status || 'online',
                daemonId: d.id,
                ...(acp.ownerDaemonId && { ownerDaemonId: acp.ownerDaemonId }),
                ...(acp.ownerMachineName && { ownerMachineName: acp.ownerMachineName }),
                ...(acp.settings && { settings: acp.settings }),
                instanceId: acp.id,
                cliName: acp.providerName,
                title: acp.title,
                mode: 'chat',
                workspace: acp.workspace || '',
                activeChat: mergeActiveChatData(acp.activeChat, null),
                ...(acp.activeInteractivePrompt !== undefined && { activeInteractivePrompt: acp.activeInteractivePrompt }),
                ...(acp.runtimeKey !== undefined && { runtimeKey: acp.runtimeKey }),
                ...(acp.runtimeDisplayName !== undefined && { runtimeDisplayName: acp.runtimeDisplayName }),
                ...(acp.runtimeWorkspaceLabel !== undefined && { runtimeWorkspaceLabel: acp.runtimeWorkspaceLabel }),
                ...(acp.runtimeWriteOwner !== undefined && { runtimeWriteOwner: acp.runtimeWriteOwner }),
                ...(acp.runtimeAttachedClients !== undefined && { runtimeAttachedClients: acp.runtimeAttachedClients }),
                ...(acp.lastMessagePreview !== undefined && { lastMessagePreview: acp.lastMessagePreview }),
                ...(acp.lastMessageRole !== undefined && { lastMessageRole: acp.lastMessageRole }),
                ...(acp.lastMessageAt !== undefined && { lastMessageAt: acp.lastMessageAt }),
                ...(acp.lastMessageHash !== undefined && { lastMessageHash: acp.lastMessageHash }),
                ...(acp.lastUpdated !== undefined && { lastUpdated: acp.lastUpdated }),
                ...(acp.unread !== undefined && { unread: acp.unread }),
                ...(acp.lastSeenAt !== undefined && { lastSeenAt: acp.lastSeenAt }),
                ...(acp.inboxBucket !== undefined && { inboxBucket: acp.inboxBucket }),
                ...(acp.completionMarker !== undefined && { completionMarker: acp.completionMarker }),
                ...(acp.seenCompletionMarker !== undefined && { seenCompletionMarker: acp.seenCompletionMarker }),
                ...(acp.surfaceHidden !== undefined && { surfaceHidden: acp.surfaceHidden }),
                ...(acp.controlValues !== undefined && { controlValues: acp.controlValues }),
                ...(acp.providerControls !== undefined && { providerControls: acp.providerControls }),
                summaryMetadata: acp.summaryMetadata,
                timestamp: ts,
                _isAcp: true,
            })
        }
    }

    return { entries, allDaemonIds }
}

// ─── Provider ─────────────────────────────────────────

/**
 * Connection overrides — injected by platform-specific connector components.
 * Cloud: provides WS status, P2P states, user role.
 * Standalone: uses defaults (always connected).
 */
export interface ConnectionOverrides {
    wsStatus?: string
    isConnected?: boolean
    connectionStates?: Record<string, string>
    connectionTransports?: Record<string, string>
    showReconnected?: boolean
    retryConnection?: (machineId: string) => void
    retryServerConnection?: () => void
    connectionLoginUrl?: string
    isP2PActive?: boolean
    p2pStates?: Record<string, string>
    userRole?: string
    /** Per-daemon P2P reconnect status (blocked after exhausting auto budget) */
    connectionRetryStatuses?: Record<string, { attempts: number; maxAttempts: number; blocked: boolean; nextRetryAt?: number }>
}

export function BaseDaemonProvider({ children, connectionOverrides }: {
    children: ReactNode
    connectionOverrides?: ConnectionOverrides
}) {
    const [ides, setIdes] = useState<DaemonData[]>([])
    const [initialLoaded, setInitialLoaded] = useState(false)
    const [toasts, setToasts] = useState<Toast[]>([])
    const [userName, setUserName] = useState<string | undefined>(undefined)
    const idesRef = useRef(ides)

    useEffect(() => {
        idesRef.current = ides
    }, [ides])

    const updateRouteChats = useCallback((routeId: string, chats: DaemonData['chats']) => {
        setIdes(prev => {
            let changed = false
            const next = prev.map(ide => {
                if (ide.id !== routeId) return ide
                if (ide.chats === chats) return ide
                changed = true
                return { ...ide, chats }
            })
            return changed ? next : prev
        })
    }, [])

    const injectEntries = useCallback((entries: DaemonData[], options?: { authoritativeDaemonIds?: string[] }) => {
        setIdes(prev => {
            const next = prev.length === 0 ? entries : reconcileIdes(entries, prev, options)
            const changed = !daemonArraysEqual(prev, next)
            if (changed) {
                webDebugStore.record({
                    kind: 'dashboard.entries_applied',
                    payload: {
                        incoming: summarizeDaemonEntriesForDebug(entries),
                        next: summarizeDaemonEntriesForDebug(next),
                    },
                })
            }
            return changed ? next : prev
        })
    }, [])

    const markLoaded = useCallback(() => setInitialLoaded(true), [])

    const actions = useMemo<BaseDaemonActions>(() => ({
        injectEntries,
        markLoaded,
        getIdes: () => idesRef.current,
    }), [injectEntries, markLoaded])

    const co = connectionOverrides
    const contextValue = useMemo<BaseDaemonContextValue>(() => ({
        ides, updateRouteChats,
        initialLoaded,
        toasts, setToasts,
        // Connection state — overrides from platform or defaults for standalone
        wsStatus: co?.wsStatus ?? 'connected',
        isConnected: co?.isConnected ?? true,
        connectionStates: co?.connectionStates ?? {},
        connectionTransports: co?.connectionTransports ?? {},
        showReconnected: co?.showReconnected ?? false,
        retryConnection: co?.retryConnection,
        retryServerConnection: co?.retryServerConnection,
        connectionLoginUrl: co?.connectionLoginUrl,
        // Cloud-specific
        isP2PActive: co?.isP2PActive ?? false,
        p2pStates: co?.p2pStates ?? {},
        userRole: co?.userRole,
        connectionRetryStatuses: co?.connectionRetryStatuses,
        userName,
        setUserName,
    }), [
        ides,
        updateRouteChats,
        initialLoaded,
        toasts,
        co?.wsStatus,
        co?.isConnected,
        co?.connectionStates,
        co?.connectionTransports,
        co?.showReconnected,
        co?.retryConnection,
        co?.retryServerConnection,
        co?.connectionLoginUrl,
        co?.isP2PActive,
        co?.p2pStates,
        co?.userRole,
        co?.connectionRetryStatuses,
        userName,
    ])

    return (
        <ActionsCtx.Provider value={actions}>
            <BaseDaemonCtx.Provider value={contextValue}>
                {children}
            </BaseDaemonCtx.Provider>
        </ActionsCtx.Provider>
    )
}

export function useBaseDaemons() {
    return useContext(BaseDaemonCtx)
}

export function useBaseDaemonActions() {
    return useContext(ActionsCtx)
}
