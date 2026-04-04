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
import type { DaemonData, SessionTransport, RuntimeWriteOwner, RuntimeAttachedClient } from '../types'

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
    updateIdeChats: (ideId: string, chats: DaemonData['chats']) => void
    screenshotMap: Record<string, string>
    setScreenshotMap: React.Dispatch<React.SetStateAction<Record<string, string>>>
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
    updateIdeChats: () => {},
    screenshotMap: {},
    setScreenshotMap: () => {},
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
})

const ActionsCtx = createContext<BaseDaemonActions>({
    injectEntries: () => {},
    markLoaded: () => {},
    getIdes: () => [],
})

// ─── Helpers ──────────────────────────────────────────

/**
 * Payload richness score — higher = richer data.
 * P2P payloads contain activeChat, childSessions, workspace etc.
 * WS compact payloads only have routing metadata (id, type, cdpConnected).
 * 
 * This score is the SINGLE source of truth for data quality comparison.
 * A rich payload must NEVER be overwritten by a weak payload, regardless of timestamp.
 */
function payloadRichness(ide: DaemonData): number {
    let score = 0;
    if ('activeChat' in ide) score += 4;      // P2P always has this
    if ((ide as any).childSessions?.length) score += 2;  // child session data
    if (ide.workspace) score += 1;             // workspace info
    if ((ide as any).machine) score += 1;      // machine info (daemon entry)
    if (ide.agents?.length) score += 1;        // detected agents
    return score;
}

function mergeDaemonVersionFlags(existing: DaemonData, incoming: DaemonData, merged: DaemonData): DaemonData {
    if (merged.type !== 'adhdev-daemon') return merged

    const next = { ...merged } as any
    const daemonVersion = (incoming as any).version ?? (merged as any).version ?? (existing as any).version
    const serverVersion = (incoming as any).serverVersion ?? (existing as any).serverVersion ?? (merged as any).serverVersion
    const hasMismatchFlag = (incoming as any).versionMismatch === true || (existing as any).versionMismatch === true

    if (daemonVersion) next.version = daemonVersion
    if (serverVersion) next.serverVersion = serverVersion

    if (daemonVersion && serverVersion && daemonVersion === serverVersion) {
        delete next.versionMismatch
        delete next.serverVersion
        return next
    }

    if ((incoming as any).versionMismatch === true || (hasMismatchFlag && daemonVersion && serverVersion && daemonVersion !== serverVersion)) {
        next.versionMismatch = true
    }

    return next
}

/**
 * reconcileIdes — merge IDE status with richness-aware priority.
 *
 * CRITICAL INVARIANT: A rich payload (from P2P, score > 0) is NEVER
 * overwritten by a weak payload (from WS compact, score = 0).
 * This eliminates the "phantom connection" bug where WS routing metadata
 * would silently discard P2P chat data.
 */
export function reconcileIdes(
    incoming: DaemonData[],
    prev: DaemonData[],
    options?: { authoritativeDaemonIds?: string[] },
): DaemonData[] {
    const now = Date.now()
    const authoritativeDaemonIds = new Set(options?.authoritativeDaemonIds || [])
    if (prev.length === 0) {
        return incoming.map(ide => ({ ...ide, _lastUpdate: now }))
    }

    const resultMap = new Map<string, DaemonData>()

    for (const ide of prev) {
        resultMap.set(ide.id, ide)
    }

    for (const ide of incoming) {
        const existing = resultMap.get(ide.id)

        if (!existing) {
            resultMap.set(ide.id, { ...ide, _lastUpdate: now })
            continue
        }

        const incomingRichness = payloadRichness(ide);
        const existingRichness = payloadRichness(existing);

        // RULE 1: Rich payload always wins over weak payload (regardless of timestamp)
        // This is the core fix: WS compact data (richness=0) can never overwrite
        // P2P data (richness>0) that contains actual chat messages.
        if (incomingRichness > existingRichness) {
            // Incoming is richer → always overwrite, preserve chats if incoming lacks them
            const chats = (ide.chats?.length) ? ide.chats : existing.chats;
            const merged = mergeDaemonVersionFlags(existing, ide, { ...existing, ...ide, chats, _lastUpdate: now } as any)
            resultMap.set(ide.id, merged as any);
        } else if (incomingRichness < existingRichness) {
            // Incoming is weaker → NEVER overwrite core data.
            // Only merge non-destructive routing metadata (status, cdpConnected, timestamp).
            const safeUpdate: Partial<DaemonData> = {};
            if (ide.status && ide.status !== existing.status) safeUpdate.status = ide.status;
            if (ide.cdpConnected !== undefined) safeUpdate.cdpConnected = ide.cdpConnected;
            if (ide.chats?.length && !existing.chats?.length) safeUpdate.chats = ide.chats;
            
            // Allow server updates to override machineNickname safely even if P2P is active
            if (ide.machineNickname !== undefined && ide.machineNickname !== existing.machineNickname) {
                safeUpdate.machineNickname = ide.machineNickname;
            }
            if ((ide as any).version !== undefined) (safeUpdate as any).version = (ide as any).version
            if ((ide as any).serverVersion !== undefined) (safeUpdate as any).serverVersion = (ide as any).serverVersion
            if ((ide as any).versionMismatch === true) (safeUpdate as any).versionMismatch = true

            if (Object.keys(safeUpdate).length > 0) {
                const merged = mergeDaemonVersionFlags(existing, ide, { ...existing, ...safeUpdate, _lastUpdate: existing._lastUpdate } as any)
                resultMap.set(ide.id, merged as any);
            }
            // Do NOT update _lastUpdate — preserve rich data's timestamp authority
        } else {
            // Same richness → use timestamp (standard merge)
            const incomingTs = ide.timestamp || now;
            const existingTs = existing._lastUpdate || existing.timestamp || 0;
            if (incomingTs >= existingTs) {
                const chats = (ide.chats?.length) ? ide.chats : existing.chats;
                const merged = mergeDaemonVersionFlags(existing, ide, { ...existing, ...ide, chats, _lastUpdate: now } as any)
                resultMap.set(ide.id, merged as any);
            } else {
                if (ide.chats?.length && !existing.chats?.length) {
                    resultMap.set(ide.id, { ...existing, chats: ide.chats });
                }
            }
        }
    }

    // Stale Cleanup
    const incomingIds = new Set(incoming.map(i => i.id))
    const incomingDaemonIds = new Set<string>()
    for (const ide of incoming) {
        const did = (ide as any).daemonId || ide.id?.split(':')[0]
        if (did) incomingDaemonIds.add(did)
    }

    for (const [key, ide] of resultMap) {
        const entryDaemonId = (ide as any).daemonId || key.split(':')[0]
        if (!incomingDaemonIds.has(entryDaemonId)) continue

        if (authoritativeDaemonIds.has(entryDaemonId) && !incomingIds.has(key)) {
            resultMap.delete(key)
            continue
        }

        const age = now - (ide._lastUpdate || ide.timestamp || 0)

        if (ide.transport === 'pty' && !incomingIds.has(key) && age > 10_000) {
            resultMap.delete(key)
        } else if (ide.transport === 'acp' && !incomingIds.has(key) && age > 10_000) {
            resultMap.delete(key)
        } else if (ide.transport === 'cdp-page' && !incomingIds.has(key) && age > 30_000) {
            resultMap.delete(key)
        }
    }

    for (const [key, ide] of resultMap) {
        const age = now - (ide._lastUpdate || ide.timestamp || 0)
        if (age > 300_000 && ide.status !== 'online') {
            resultMap.delete(key)
        }
    }

    return Array.from(resultMap.values())
}

function daemonArraysEqual(prev: DaemonData[], next: DaemonData[]): boolean {
    if (prev.length !== next.length) return false
    for (let i = 0; i < prev.length; i += 1) {
        if (prev[i] !== next[i]) return false
    }
    return true
}

/**
 * expandCompactDaemons — server compact format → flat DaemonData[]
 * standalone/cloud shared
 */
export interface CompactDaemon {
    id: string
    type?: string
    platform?: string
    hostname?: string
    nickname?: string
    p2p?: any
    cdp?: boolean
    cdpConnected?: boolean
    ts?: number
    timestamp?: number
    sessions?: {
        id: string
        parentId?: string | null
        providerType: string
        providerName?: string
        kind: 'workspace' | 'agent'
        transport: SessionTransport
        status?: string
        workspace?: string | null
        runtimeKey?: string
        runtimeDisplayName?: string
        runtimeWorkspaceLabel?: string
        runtimeWriteOwner?: RuntimeWriteOwner | null
        runtimeAttachedClients?: RuntimeAttachedClient[]
        title?: string
        cdpConnected?: boolean
        currentModel?: string
        currentPlan?: string
        currentAutoApprove?: string
    }[]
}

export function expandCompactDaemons(
    compactDaemons: CompactDaemon[],
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
            daemonMode: true,
            machineNickname: d.nickname,
            hostname: d.hostname,
            p2p: d.p2p,
            cdpConnected: cdp,
            timestamp: ts,
            // Version mismatch (server-driven flag)
            ...((d as any).versionMismatch && {
                versionMismatch: true,
                version: (d as any).version,
                serverVersion: (d as any).serverVersion,
            }),
            ...((d as any).detectedIdes && { detectedIdes: (d as any).detectedIdes }),
            ...((d as any).availableProviders && { availableProviders: (d as any).availableProviders }),
        } as any)

        for (const ide of topLevelIdeSessions) {
            const childSessions = sessions.filter(s => s.parentId === ide.id)
            const ideFullId = `${d.id}:ide:${ide.id}`
            entries.push({
                id: ideFullId,
                sessionId: ide.id,
                type: ide.providerType,
                status: ide.status || 'online',
                daemonId: d.id,
                cdpConnected: ide.cdpConnected,
                currentModel: ide.currentModel,
                currentPlan: ide.currentPlan,
                currentAutoApprove: ide.currentAutoApprove,
                workspace: ide.workspace || null,
                childSessions,
                timestamp: ts,
            } as any)
        }

        for (const cli of topLevelCliSessions) {
            const cliFullId = `${d.id}:cli:${cli.id}`
            entries.push({
                id: cliFullId,
                sessionId: cli.id,
                type: cli.providerType,
                status: cli.status || 'online',
                daemonId: d.id,
                cliName: cli.providerName,
                workspace: cli.workspace || '',
                activeChat: (cli as any).activeChat || null,
                runtimeKey: cli.runtimeKey,
                runtimeDisplayName: cli.runtimeDisplayName,
                runtimeWorkspaceLabel: cli.runtimeWorkspaceLabel,
                runtimeWriteOwner: cli.runtimeWriteOwner || null,
                runtimeAttachedClients: cli.runtimeAttachedClients || [],
                timestamp: ts,
            } as any)
        }

        for (const acp of topLevelAcpSessions) {
            const acpFullId = `${d.id}:acp:${acp.id}`
            entries.push({
                id: acpFullId,
                sessionId: acp.id,
                type: acp.providerType,
                status: acp.status || 'online',
                daemonId: d.id,
                cliName: acp.providerName,
                workspace: acp.workspace || '',
                currentModel: acp.currentModel,
                currentPlan: acp.currentPlan,
                timestamp: ts,
            } as any)
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
    isP2PActive?: boolean
    p2pStates?: Record<string, string>
    userRole?: string
}

export function BaseDaemonProvider({ children, connectionOverrides }: {
    children: ReactNode
    connectionOverrides?: ConnectionOverrides
}) {
    const [ides, setIdes] = useState<DaemonData[]>([])
    const [screenshotMap, setScreenshotMap] = useState<Record<string, string>>({})
    const [initialLoaded, setInitialLoaded] = useState(false)
    const [toasts, setToasts] = useState<Toast[]>([])
    const [userName, setUserName] = useState<string | undefined>(undefined)
    const idesRef = useRef(ides)

    useEffect(() => {
        idesRef.current = ides
    }, [ides])

    const updateIdeChats = useCallback((ideId: string, chats: DaemonData['chats']) => {
        setIdes(prev => {
            let changed = false
            const next = prev.map(ide => {
                if (ide.id !== ideId) return ide
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
            return daemonArraysEqual(prev, next) ? prev : next
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
        ides, updateIdeChats,
        screenshotMap, setScreenshotMap,
        initialLoaded,
        toasts, setToasts,
        // Connection state — overrides from platform or defaults for standalone
        wsStatus: co?.wsStatus ?? 'connected',
        isConnected: co?.isConnected ?? true,
        connectionStates: co?.connectionStates ?? {},
        connectionTransports: co?.connectionTransports ?? {},
        showReconnected: co?.showReconnected ?? false,
        retryConnection: co?.retryConnection,
        // Cloud-specific
        isP2PActive: co?.isP2PActive ?? false,
        p2pStates: co?.p2pStates ?? {},
        userRole: co?.userRole,
        userName,
        setUserName,
    }), [
        ides,
        updateIdeChats,
        screenshotMap,
        initialLoaded,
        toasts,
        co?.wsStatus,
        co?.isConnected,
        co?.connectionStates,
        co?.connectionTransports,
        co?.showReconnected,
        co?.retryConnection,
        co?.isP2PActive,
        co?.p2pStates,
        co?.userRole,
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
