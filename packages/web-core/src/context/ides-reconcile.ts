/**
 * ides-reconcile — pure IDE/daemon status merge engine (extracted from BaseDaemonContext)
 *
 * No React. Holds the richness-aware reconcile logic and its helpers so the
 * Provider can stay focused on state/context wiring. Behaviour is identical to
 * the previous in-file implementation; this is a pure code move.
 *
 * CRITICAL INVARIANT: A rich payload (from P2P, score > 0) is NEVER overwritten
 * by a weak payload (from WS compact, score = 0). See `reconcileIdes`.
 */
import type { DaemonData } from '../types'
import { mergeActiveChatData, mergeSessionEntryChildren } from '../utils/session-entry-merge'
import { normalizeTextContent } from '../utils/text'

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
    if (ide.activeInteractivePrompt !== undefined) score += 2;
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
    // workspace is immutable for a session's lifetime (a new workspace = new launch = new ide.id),
    // so an empty/undefined incoming.workspace means "unknown", not "cleared". Fill-if-empty here
    // prevents an idle snapshot that drops workspace from clobbering a good value and flapping the
    // session tab title between the real workspace name and the 'Terminal (Mesh Node)' fallback.
    const workspace = incoming.workspace || existing.workspace
    return mergeDaemonVersionFlags(existing, incoming, {
        ...existing,
        ...incoming,
        chats,
        childSessions,
        activeChat,
        workspace,
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

    // workspace is handled explicitly below: copyDefinedField only guards against `undefined`,
    // so a falsy-but-defined incoming.workspace ('') would still clobber a good existing value
    // and flap the session tab title to the 'Terminal (Mesh Node)' fallback. Keep it out of the
    // generic loop and apply fill-if-empty (truthy incoming wins; empty incoming preserves existing).
    if (incoming.workspace) safeUpdate.workspace = incoming.workspace

    for (const key of [
        'title',
        'providerSessionId',
        'parentSessionId',
        'sessionKind',
        'sessionCapabilities',
        'controlValues',
        'providerControls',
        'summaryMetadata',
        'activeInteractivePrompt',
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
        'muted',
        'runtimeKey',
        'runtimeDisplayName',
        'runtimeWorkspaceLabel',
        'runtimeWriteOwner',
        'runtimeAttachedClients',
        'version',
        'serverVersion',
        'versionUpdateReason',
        'versionUpdateRequired',
        'updateCommand',
        'updatePolicy',
        'updateChannel',
        'releaseChannel',
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

function shouldSkipAgeCleanupForLiveTransportEntry(
    entry: DaemonData,
    daemonId: string,
    incomingDaemonIds: Set<string>,
    daemonIdsWithSessionEntries: Set<string>,
    resultMap: Map<string, DaemonData>,
): boolean {
    if (!entry.transport) return false
    if (incomingDaemonIds.has(daemonId) && !daemonIdsWithSessionEntries.has(daemonId)) return true
    return resultMap.has(daemonId)
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
        if (shouldSkipAgeCleanupForLiveTransportEntry(ide, entryDaemonId, incomingDaemonIds, daemonIdsWithSessionEntries, resultMap)) {
            continue
        }
        const age = now - (ide._lastUpdate || ide.timestamp || 0)
        if (age > 300_000 && ide.status !== 'online') {
            resultMap.delete(key)
        }
    }

    return Array.from(resultMap.values())
}

export function daemonArraysEqual(prev: DaemonData[], next: DaemonData[]): boolean {
    if (prev.length !== next.length) return false
    for (let i = 0; i < prev.length; i += 1) {
        if (prev[i] !== next[i]) return false
    }
    return true
}
