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
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { DaemonData } from '../types'

// ─── Types ────────────────────────────────────────────

export interface Toast {
    id: number
    message: string
    type: 'success' | 'info' | 'warning'
    timestamp: number
    ideId?: string
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
    injectEntries: (entries: DaemonData[]) => void
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
 * P2P payloads contain activeChat, agentStreams, workspace etc.
 * WS compact payloads only have routing metadata (id, type, cdpConnected).
 * 
 * This score is the SINGLE source of truth for data quality comparison.
 * A rich payload must NEVER be overwritten by a weak payload, regardless of timestamp.
 */
function payloadRichness(ide: DaemonData): number {
    let score = 0;
    if ('activeChat' in ide) score += 4;      // P2P always has this
    if (ide.agentStreams?.length) score += 2;  // agent stream data
    if (ide.workspace) score += 1;             // workspace info
    if ((ide as any).machine) score += 1;      // machine info (daemon entry)
    if (ide.agents?.length) score += 1;        // detected agents
    return score;
}

/**
 * reconcileIdes — merge IDE status with richness-aware priority.
 *
 * CRITICAL INVARIANT: A rich payload (from P2P, score > 0) is NEVER
 * overwritten by a weak payload (from WS compact, score = 0).
 * This eliminates the "phantom connection" bug where WS routing metadata
 * would silently discard P2P chat data.
 */
export function reconcileIdes(incoming: DaemonData[], prev: DaemonData[]): DaemonData[] {
    const now = Date.now()
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
            resultMap.set(ide.id, { ...existing, ...ide, chats, _lastUpdate: now } as any);
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

            if (Object.keys(safeUpdate).length > 0) {
                resultMap.set(ide.id, { ...existing, ...safeUpdate, _lastUpdate: existing._lastUpdate } as any);
            }
            // Do NOT update _lastUpdate — preserve rich data's timestamp authority
        } else {
            // Same richness → use timestamp (standard merge)
            const incomingTs = ide.timestamp || now;
            const existingTs = existing._lastUpdate || existing.timestamp || 0;
            if (incomingTs >= existingTs) {
                const chats = (ide.chats?.length) ? ide.chats : existing.chats;
                resultMap.set(ide.id, { ...existing, ...ide, chats, _lastUpdate: now } as any);
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

        const age = now - (ide._lastUpdate || ide.timestamp || 0)

        if (key.includes(':cli:') && !incomingIds.has(key) && age > 10_000) {
            resultMap.delete(key)
        } else if (key.includes(':acp:') && !incomingIds.has(key) && age > 10_000) {
            resultMap.delete(key)
        } else if (key.includes(':ide:') && !incomingIds.has(key) && age > 30_000) {
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
    ides?: { iid?: string; instanceId?: string; id?: string; type: string; cdp?: boolean; cdpConnected?: boolean }[]
    clis?: { cid?: string; cliId?: string; id?: string; type: string; name?: string }[]
    acps?: { aid?: string; acpId?: string; id?: string; type: string; name?: string }[]
}

export function expandCompactDaemons(
    compactDaemons: CompactDaemon[],
    options?: { skipDaemonId?: (id: string) => boolean }
): { entries: DaemonData[]; allDaemonIds: Set<string> } {
    const entries: DaemonData[] = []
    const allDaemonIds = new Set<string>()

    for (const d of compactDaemons) {
        allDaemonIds.add(d.id)

        if (options?.skipDaemonId?.(d.id)) continue

        const ts = d.timestamp || d.ts || Date.now()
        const cdp = d.cdpConnected ?? d.cdp

        const ideIds = (d.ides || []).map(i => i.id || `${d.id}:ide:${i.instanceId || i.iid}`)
        const cliIds = (d.clis || []).map(c => c.id || `${d.id}:cli:${c.cliId || c.cid}`)

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
            managedIdeIds: ideIds,
            managedCliIds: cliIds,
            // Version mismatch (server-driven flag)
            ...((d as any).versionMismatch && {
                versionMismatch: true,
                version: (d as any).version,
                serverVersion: (d as any).serverVersion,
            }),
        } as any)

        for (const ide of (d.ides || [])) {
            const ideInstanceId = ide.instanceId || ide.iid
            const ideFullId = ide.id || `${d.id}:ide:${ideInstanceId}`
            entries.push({
                id: ideFullId,
                type: ide.type,
                status: 'online',
                daemonId: d.id,
                cdpConnected: ide.cdpConnected ?? ide.cdp,
                timestamp: ts,
            } as any)
        }

        for (const cli of (d.clis || [])) {
            const cliCid = cli.cliId || cli.cid
            const cliFullId = cli.id || `${d.id}:cli:${cliCid}`
            entries.push({
                id: cliFullId,
                type: cli.type,
                status: 'online',
                daemonId: d.id,
                cliName: cli.name,
                timestamp: ts,
            } as any)
        }

        for (const acp of (d.acps || [])) {
            const acpAid = acp.acpId || acp.aid
            const acpFullId = acp.id || `${d.id}:acp:${acpAid}`
            entries.push({
                id: acpFullId,
                type: acp.type,
                status: 'online',
                daemonId: d.id,
                cliName: acp.name,
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

    const updateIdeChats = useCallback((ideId: string, chats: DaemonData['chats']) => {
        setIdes(prev => prev.map(ide => ide.id === ideId ? { ...ide, chats } : ide))
    }, [])

    const actions: BaseDaemonActions = {
        injectEntries: (entries: DaemonData[]) => {
            setIdes(prev => prev.length === 0 ? entries : reconcileIdes(entries, prev))
        },
        markLoaded: () => setInitialLoaded(true),
        getIdes: () => ides,
    }

    const co = connectionOverrides

    return (
        <ActionsCtx.Provider value={actions}>
            <BaseDaemonCtx.Provider value={{
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
            }}>
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
