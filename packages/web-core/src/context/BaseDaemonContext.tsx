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
import { webDebugStore } from '../debug/webDebugStore'
import { summarizeDaemonEntriesForDebug } from '../debug/entryDebugSummary'
import { mergeActiveChatData, mergeSessionEntryChildren } from '../utils/session-entry-merge'
import { normalizeTextContent } from '../utils/text'

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
    if (ide.activeChat !== undefined) score += 4;      // P2P/chat-rich payloads carry this explicitly
    if (ide.childSessions?.length) score += 2;  // child session data
    if (ide.workspace) score += 1;             // workspace info
    if (ide.machine) score += 1;      // machine info (daemon entry)
    if (ide.agents?.length) score += 1;        // detected agents
    return score;
}

function mergeDaemonVersionFlags(existing: DaemonData, incoming: DaemonData, merged: DaemonData): DaemonData {
    if (merged.type !== 'adhdev-daemon') return merged

    const next: DaemonData = { ...merged }
    const daemonVersion = incoming.version ?? merged.version ?? existing.version
    const serverVersion = incoming.serverVersion ?? existing.serverVersion ?? merged.serverVersion
    const hasMismatchFlag = incoming.versionMismatch === true || existing.versionMismatch === true
    const requiredUpdate = incoming.versionUpdateRequired === true || existing.versionUpdateRequired === true
    const updateReason = incoming.versionUpdateReason ?? existing.versionUpdateReason ?? merged.versionUpdateReason

    if (daemonVersion) next.version = daemonVersion
    if (serverVersion) next.serverVersion = serverVersion
    if (updateReason) next.versionUpdateReason = updateReason

    if (daemonVersion && serverVersion && daemonVersion === serverVersion) {
        delete next.versionMismatch
        delete next.serverVersion
        delete next.versionUpdateRequired
        delete next.versionUpdateReason
        return next
    }

    if (incoming.versionMismatch === true || (hasMismatchFlag && daemonVersion && serverVersion && daemonVersion !== serverVersion)) {
        next.versionMismatch = true
    }
    if (requiredUpdate) next.versionUpdateRequired = true

    return next
}

function hashRenderText(value: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
}

function summarizeRenderableMessage(message: unknown): string {
    if (!message || typeof message !== 'object') return ''
    const record = message as Record<string, unknown>
    const contentHash = hashRenderText(normalizeTextContent(record.content).slice(0, 512))
    return [
        String(record.id || ''),
        String(record._localId || ''),
        String(record._turnKey || ''),
        String(record.index ?? ''),
        String(record.role || ''),
        String(record.receivedAt ?? record.timestamp ?? ''),
        contentHash,
    ].join(':')
}

function summarizeMessageList(messages: unknown, sharedMessageArrays?: WeakSet<unknown[]>): unknown {
    if (!Array.isArray(messages)) return messages
    if (sharedMessageArrays?.has(messages)) {
        // Metadata-only live status merges preserve the already loaded transcript array by reference.
        // In that path the message bodies cannot affect equivalence, so avoid re-hashing long chats.
        return {
            count: messages.length,
            sharedRef: true,
        }
    }
    let aggregate = 0x811c9dc5
    for (const message of messages) {
        const summary = summarizeRenderableMessage(message)
        for (let i = 0; i < summary.length; i += 1) {
            aggregate ^= summary.charCodeAt(i)
            aggregate = Math.imul(aggregate, 0x01000193) >>> 0
        }
    }
    return {
        count: messages.length,
        hash: aggregate.toString(16).padStart(8, '0'),
        first: summarizeRenderableMessage(messages[0]),
        last: summarizeRenderableMessage(messages[messages.length - 1]),
    }
}

function isActiveChatLike(value: unknown): value is Record<string, unknown> {
    return !!value
        && typeof value === 'object'
        && ('messages' in (value as Record<string, unknown>))
        && (
            'activeModal' in (value as Record<string, unknown>)
            || 'inputContent' in (value as Record<string, unknown>)
            || 'status' in (value as Record<string, unknown>)
        )
}

function collectSharedActiveChatMessageArrays(existing: unknown, next: unknown, shared: WeakSet<unknown[]>): void {
    if (!existing || !next || typeof existing !== 'object' || typeof next !== 'object') return

    if (isActiveChatLike(existing) && isActiveChatLike(next)) {
        const existingMessages = existing.messages
        if (Array.isArray(existingMessages) && existingMessages === next.messages) {
            shared.add(existingMessages)
        }
    }

    if (Array.isArray(existing) && Array.isArray(next)) {
        const length = Math.min(existing.length, next.length)
        for (let i = 0; i < length; i += 1) {
            collectSharedActiveChatMessageArrays(existing[i], next[i], shared)
        }
        return
    }

    const existingRecord = existing as Record<string, unknown>
    const nextRecord = next as Record<string, unknown>
    const keys = new Set([...Object.keys(existingRecord), ...Object.keys(nextRecord)])
    for (const key of keys) {
        if (key === 'messages') continue
        collectSharedActiveChatMessageArrays(existingRecord[key], nextRecord[key], shared)
    }
}

function stripVolatileEntryFields(value: unknown, sharedMessageArrays?: WeakSet<unknown[]>): unknown {
    if (Array.isArray(value)) {
        return value.map((nested) => stripVolatileEntryFields(nested, sharedMessageArrays))
    }
    if (!value || typeof value !== 'object') {
        return value
    }

    if (isActiveChatLike(value)) {
        const record = value as Record<string, unknown>
        return Object.fromEntries(
            Object.entries(record)
                .filter(([key]) => key !== 'timestamp' && key !== '_lastUpdate')
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, nested]) => [
                    key,
                    key === 'messages'
                        ? summarizeMessageList(nested, sharedMessageArrays)
                        : stripVolatileEntryFields(nested, sharedMessageArrays),
                ]),
        )
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== 'timestamp' && key !== '_lastUpdate')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, nested]) => [key, stripVolatileEntryFields(nested, sharedMessageArrays)]),
    )
}

function areEntriesRenderEquivalent(existing: DaemonData, next: DaemonData): boolean {
    try {
        const sharedMessageArrays = new WeakSet<unknown[]>()
        collectSharedActiveChatMessageArrays(existing, next, sharedMessageArrays)
        return JSON.stringify(stripVolatileEntryFields(existing, sharedMessageArrays)) === JSON.stringify(stripVolatileEntryFields(next, sharedMessageArrays))
    } catch {
        return false
    }
}

function preserveReferenceWhenOnlyVolatileFieldsChanged(existing: DaemonData, next: DaemonData, freshAt: number): DaemonData {
    if (!areEntriesRenderEquivalent(existing, next)) {
        return next
    }

    existing._lastUpdate = freshAt
    if (typeof next.timestamp === 'number') {
        existing.timestamp = next.timestamp
    }
    return existing
}

function getEntryDaemonId(entry: Pick<DaemonData, 'daemonId' | 'id'>): string {
    return entry.daemonId || entry.id?.split(':')[0] || entry.id
}

function copyDefinedField<K extends keyof DaemonData>(
    target: Partial<DaemonData>,
    source: DaemonData,
    key: K,
): void {
    if (source[key] !== undefined) {
        target[key] = source[key] as DaemonData[K]
    }
}

function buildMergedRichEntry(
    existing: DaemonData,
    incoming: DaemonData,
    now: number,
    preserveMissingChildSessions: boolean,
): DaemonData {
    const chats = (incoming.chats?.length) ? incoming.chats : existing.chats
    const childSessions = mergeSessionEntryChildren(existing.childSessions, incoming.childSessions, {
        preserveMissing: preserveMissingChildSessions,
    })
    const activeChat = mergeActiveChatData(incoming.activeChat, existing.activeChat)
    return mergeDaemonVersionFlags(existing, incoming, {
        ...existing,
        ...incoming,
        chats,
        childSessions,
        activeChat,
        _lastUpdate: now,
    })
}

function buildWeakMetadataUpdate(
    existing: DaemonData,
    incoming: DaemonData,
    preserveMissingChildSessions: boolean,
): Partial<DaemonData> {
    const safeUpdate: Partial<DaemonData> = {}

    if (incoming.status && incoming.status !== existing.status) safeUpdate.status = incoming.status
    if (incoming.cdpConnected !== undefined) safeUpdate.cdpConnected = incoming.cdpConnected
    if (incoming.childSessions !== undefined) {
        safeUpdate.childSessions = mergeSessionEntryChildren(existing.childSessions, incoming.childSessions, {
            preserveMissing: preserveMissingChildSessions,
        })
    }
    if (incoming.chats?.length && !existing.chats?.length) safeUpdate.chats = incoming.chats

    for (const key of [
        'title',
        'workspace',
        'providerSessionId',
        'parentSessionId',
        'sessionKind',
        'sessionCapabilities',
        'controlValues',
        'providerControls',
        'summaryMetadata',
        'lastMessagePreview',
        'lastMessageRole',
        'lastMessageAt',
        'lastMessageHash',
        'lastUpdated',
        'unread',
        'lastSeenAt',
        'inboxBucket',
        'completionMarker',
        'seenCompletionMarker',
        'surfaceHidden',
        'runtimeKey',
        'runtimeDisplayName',
        'runtimeWorkspaceLabel',
        'runtimeWriteOwner',
        'runtimeAttachedClients',
        'version',
        'serverVersion',
    ] as const) {
        copyDefinedField(safeUpdate, incoming, key)
    }

    if (incoming.machineNickname !== undefined && incoming.machineNickname !== existing.machineNickname) {
        safeUpdate.machineNickname = incoming.machineNickname
    }
    if (incoming.versionMismatch === true) safeUpdate.versionMismatch = true

    return safeUpdate
}

function mergeWeakEntry(
    existing: DaemonData,
    incoming: DaemonData,
    now: number,
    preserveMissingChildSessions: boolean,
): DaemonData {
    const safeUpdate = buildWeakMetadataUpdate(existing, incoming, preserveMissingChildSessions)
    const merged = Object.keys(safeUpdate).length > 0
        ? mergeDaemonVersionFlags(existing, incoming, { ...existing, ...safeUpdate, _lastUpdate: now })
        : { ...existing, _lastUpdate: now }
    return preserveReferenceWhenOnlyVolatileFieldsChanged(existing, merged, now)
}

function collectIncomingDaemonSets(incoming: DaemonData[]) {
    const incomingIds = new Set(incoming.map((entry) => entry.id))
    const incomingDaemonIds = new Set<string>()
    const daemonIdsWithSessionEntries = new Set<string>()
    const daemonIdsWithAuthoritativeSessionList = new Set<string>()

    for (const entry of incoming) {
        const daemonId = getEntryDaemonId(entry)
        if (daemonId) incomingDaemonIds.add(daemonId)
        if (daemonId && entry.type !== 'adhdev-daemon') {
            daemonIdsWithSessionEntries.add(daemonId)
        }
        if (daemonId && entry.type === 'adhdev-daemon' && entry._sessionListAuthoritative) {
            daemonIdsWithAuthoritativeSessionList.add(daemonId)
        }
    }

    return {
        incomingIds,
        incomingDaemonIds,
        daemonIdsWithSessionEntries,
        daemonIdsWithAuthoritativeSessionList,
    }
}

function shouldDropMissingAuthoritativeTransportEntry(
    entry: DaemonData,
    daemonId: string,
    age: number,
    incomingIds: Set<string>,
    authoritativeDaemonIds: Set<string>,
    daemonIdsWithSessionEntries: Set<string>,
): boolean {
    if (!authoritativeDaemonIds.has(daemonId)) return false
    if (!daemonIdsWithSessionEntries.has(daemonId)) return false
    if (incomingIds.has(entry.id)) return false

    if (entry.transport === 'pty' || entry.transport === 'acp') {
        return age > 10_000
    }
    if (entry.transport === 'cdp-page') {
        return age > 30_000
    }
    return false
}

function shouldSkipAgeCleanupForDaemonOnlyUpdate(
    entry: DaemonData,
    daemonId: string,
    incomingDaemonIds: Set<string>,
    daemonIdsWithSessionEntries: Set<string>,
): boolean {
    return !!(incomingDaemonIds.has(daemonId) && entry.transport && !daemonIdsWithSessionEntries.has(daemonId))
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

    const {
        incomingIds,
        incomingDaemonIds,
        daemonIdsWithSessionEntries,
        daemonIdsWithAuthoritativeSessionList,
    } = collectIncomingDaemonSets(incoming)

    for (const ide of incoming) {
        const existing = resultMap.get(ide.id)

        if (!existing) {
            resultMap.set(ide.id, { ...ide, _lastUpdate: now })
            continue
        }

        const incomingRichness = payloadRichness(ide)
        const existingRichness = payloadRichness(existing)
        const entryDaemonId = getEntryDaemonId(ide)
        const preserveMissingChildSessions = !authoritativeDaemonIds.has(entryDaemonId)

        if (incomingRichness > existingRichness) {
            const merged = buildMergedRichEntry(existing, ide, now, preserveMissingChildSessions)
            resultMap.set(ide.id, preserveReferenceWhenOnlyVolatileFieldsChanged(existing, merged, now))
            continue
        }

        if (incomingRichness < existingRichness) {
            resultMap.set(ide.id, mergeWeakEntry(existing, ide, now, preserveMissingChildSessions))
            continue
        }

        const incomingTs = ide.timestamp || now
        const existingTs = existing._lastUpdate || existing.timestamp || 0
        if (incomingTs >= existingTs) {
            const merged = buildMergedRichEntry(existing, ide, now, preserveMissingChildSessions)
            resultMap.set(ide.id, preserveReferenceWhenOnlyVolatileFieldsChanged(existing, merged, now))
            continue
        }

        if (ide.chats?.length && !existing.chats?.length) {
            resultMap.set(ide.id, { ...existing, chats: ide.chats })
        }
    }

    for (const [key, ide] of resultMap) {
        const entryDaemonId = ide.daemonId || key.split(':')[0]
        if (!incomingDaemonIds.has(entryDaemonId)) continue

        if (
            authoritativeDaemonIds.has(entryDaemonId)
            && daemonIdsWithAuthoritativeSessionList.has(entryDaemonId)
            && !incomingIds.has(key)
        ) {
            resultMap.delete(key)
            continue
        }

        const age = now - (ide._lastUpdate || ide.timestamp || 0)
        if (shouldDropMissingAuthoritativeTransportEntry(
            ide,
            entryDaemonId,
            age,
            incomingIds,
            authoritativeDaemonIds,
            daemonIdsWithSessionEntries,
        )) {
            resultMap.delete(key)
        }
    }

    for (const [key, ide] of resultMap) {
        const entryDaemonId = ide.daemonId || key.split(':')[0]
        if (shouldSkipAgeCleanupForDaemonOnlyUpdate(ide, entryDaemonId, incomingDaemonIds, daemonIdsWithSessionEntries)) {
            continue
        }
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
            // Version mismatch (server-driven flag)
            ...(d.versionMismatch && {
                versionMismatch: true,
                version: d.version,
                serverVersion: d.serverVersion,
                ...(d.versionUpdateRequired && { versionUpdateRequired: true }),
                ...(d.versionUpdateReason && { versionUpdateReason: d.versionUpdateReason }),
            }),
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
                activeChat: ide.activeChat,
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
                instanceId: cli.id,
                cliName: cli.providerName,
                title: cli.title,
                mode: 'chat',
                workspace: cli.workspace || '',
                activeChat: cli.activeChat,
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
                instanceId: acp.id,
                cliName: acp.providerName,
                title: acp.title,
                mode: 'chat',
                workspace: acp.workspace || '',
                activeChat: acp.activeChat,
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
