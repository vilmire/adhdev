/**
 * statusPayloadToEntries — StatusResponse → DaemonData[]
 *
 * Shared conversion from daemon StatusResponse (received via P2P or localhost WS)
 * into the flat DaemonData[] array consumed by Dashboard, IDE page, etc.
 *
 * Used by:
 *   - web-standalone: StandaloneDaemonContext (localhost WS)
 */
import type { StatusReportPayload, SessionEntry } from '@adhdev/daemon-core'
import type { DaemonData } from '../types'
import {
    mergeSessionEntrySummary,
    type ExistingSessionLike,
    type SessionEntryWithInboxMarkers,
} from './session-entry-merge'

export interface StatusTransformOptions {
    /** Override daemon ID */
    daemonId: string
    /** Existing daemon entry to preserve */
    existingDaemon?: DaemonData
    /** Existing flat entries for session metadata fallback */
    existingEntries?: DaemonData[]
    /** Timestamp override */
    timestamp?: number
}

function buildExistingSessionMap(entries: DaemonData[] | undefined, daemonId: string) {
    const sessions = new Map<string, ExistingSessionLike>()
    for (const entry of entries || []) {
        const entryDaemonId = entry.daemonId || (entry.id.includes(':') ? entry.id.split(':')[0] || '' : '')
        if (entryDaemonId !== daemonId) continue

        if (!entry.sessionId) continue
        sessions.set(entry.sessionId, {
            parentSessionId: entry.parentSessionId,
            providerSessionId: entry.providerSessionId,
            workspace: entry.workspace ?? null,
            sessionCapabilities: entry.sessionCapabilities as SessionEntry['capabilities'] | undefined,
            cdpConnected: entry.cdpConnected,
            activeChat: entry.activeChat as SessionEntry['activeChat'] | undefined,
            controlValues: entry.controlValues,
            providerControls: entry.providerControls,
            summaryMetadata: entry.summaryMetadata,
            runtimeWriteOwner: entry.runtimeWriteOwner,
            runtimeAttachedClients: entry.runtimeAttachedClients,
            cliName: entry.cliName,
            type: entry.type,
            mode: entry.mode,
            status: entry.status as SessionEntry['status'],
            lastMessagePreview: entry.lastMessagePreview,
            lastMessageRole: entry.lastMessageRole,
            lastMessageAt: entry.lastMessageAt,
            lastMessageHash: entry.lastMessageHash,
            completionMarker: entry.completionMarker,
            seenCompletionMarker: entry.seenCompletionMarker,
        })

        for (const child of entry.childSessions || []) {
            if (!child?.id) continue
            const existingChild = sessions.get(child.id) || {}
            sessions.set(child.id, {
                ...existingChild,
                ...child,
            })
        }
    }
    return sessions
}

function groupChildSessions(sessions: SessionEntryWithInboxMarkers[]) {
    const topLevel: SessionEntryWithInboxMarkers[] = []
    const childrenByParent = new Map<string, SessionEntryWithInboxMarkers[]>()

    for (const session of sessions) {
        if (session.parentId) {
            const existing = childrenByParent.get(session.parentId) || []
            existing.push(session)
            childrenByParent.set(session.parentId, existing)
        } else {
            topLevel.push(session)
        }
    }

    return { topLevel, childrenByParent }
}

/**
 * Convert a StatusResponse payload into DaemonData[] entries.
 * Returns: [daemonEntry, ...ideEntries, ...cliEntries, ...acpEntries]
 */
export function statusPayloadToEntries(
    payload: StatusReportPayload,
    options: StatusTransformOptions,
): DaemonData[] {
    const entries: DaemonData[] = []
    const { daemonId, existingDaemon, existingEntries, timestamp: tsOverride } = options
    const ts = tsOverride || payload.timestamp || Date.now()
    const sessions = payload.sessions || []
    const { topLevel, childrenByParent } = groupChildSessions(sessions)
    const existingSessionMap = buildExistingSessionMap(existingEntries, daemonId)
    const mergedMachine = payload.machine
        ? {
            ...(existingDaemon?.machine || {}),
            ...payload.machine,
        }
        : existingDaemon?.machine

    const ideSessions = topLevel.filter((session) =>
        session.kind === 'workspace' && session.transport === 'cdp-page',
    )
    const cliSessions = topLevel.filter((session) =>
        session.kind === 'agent' && session.transport === 'pty',
    )
    const acpSessions = topLevel.filter((session) =>
        session.kind === 'agent' && session.transport === 'acp',
    )

    // ─── 1. Machine-level daemon entry ─────────────────
    entries.push({
        ...(existingDaemon || {}),
        id: daemonId,
        type: 'adhdev-daemon',
        status: 'online',
        timestamp: ts,
        ...(payload.version && { version: payload.version }),
        ...(mergedMachine && { machine: mergedMachine, platform: mergedMachine.platform }),
        ...(payload.instanceId && { instanceId: payload.instanceId }),
        ...(payload.machineNickname !== undefined && { machineNickname: payload.machineNickname }),
        ...(payload.p2p && { p2p: payload.p2p }),
        ...(payload.workspaces && { workspaces: payload.workspaces }),
        ...(payload.defaultWorkspaceId !== undefined && { defaultWorkspaceId: payload.defaultWorkspaceId }),
        ...(payload.defaultWorkspacePath !== undefined && { defaultWorkspacePath: payload.defaultWorkspacePath }),
        ...(payload.terminalSizingMode !== undefined && { terminalSizingMode: payload.terminalSizingMode }),
        ...(payload.recentLaunches && { recentLaunches: payload.recentLaunches }),
        ...(payload.terminalBackend && { terminalBackend: payload.terminalBackend }),
        ...(payload.detectedIdes && { detectedIdes: payload.detectedIdes }),
        ...(payload.availableProviders && { availableProviders: payload.availableProviders }),
        cdpConnected: ideSessions.some((session) => !!session.cdpConnected),
    } as DaemonData)

    // ─── 2. IDE entries ────────────────────────────────
    for (const session of ideSessions) {
        const existingEntry = existingSessionMap.get(session.id)
        const mergedSession = mergeSessionEntrySummary(session, existingEntry)
        const childSessions = (childrenByParent.get(session.id) || []).map((child) =>
            mergeSessionEntrySummary(child, existingSessionMap.get(child.id)),
        )
        entries.push({
            id: `${daemonId}:ide:${session.id}`,
            sessionId: session.id,
            providerSessionId: session.providerSessionId ?? existingEntry?.providerSessionId,
            parentSessionId: mergedSession.parentId,
            sessionKind: mergedSession.kind,
            transport: mergedSession.transport,
            sessionCapabilities: mergedSession.capabilities,
            type: mergedSession.providerType,
            status: mergedSession.cdpConnected ? 'online' : 'detected',
            daemonId,
            instanceId: session.id,
            workspace: mergedSession.workspace,
            terminals: 0,
            childSessions,
            agents: childSessions.map((child) => ({
                id: child.id,
                name: child.providerName || child.providerType,
                type: child.providerType,
                status: child.status,
            })),
            activeChat: mergedSession.activeChat,
            chats: [],
            cdpConnected: mergedSession.cdpConnected,
            ...(mergedSession.lastMessagePreview !== undefined && { lastMessagePreview: mergedSession.lastMessagePreview }),
            ...(mergedSession.lastMessageRole !== undefined && { lastMessageRole: mergedSession.lastMessageRole }),
            ...(mergedSession.lastMessageAt !== undefined && { lastMessageAt: mergedSession.lastMessageAt }),
            ...(mergedSession.lastMessageHash !== undefined && { lastMessageHash: mergedSession.lastMessageHash }),
            lastUpdated: mergedSession.lastUpdated,
            unread: mergedSession.unread,
            lastSeenAt: mergedSession.lastSeenAt,
            inboxBucket: mergedSession.inboxBucket,
            completionMarker: mergedSession.completionMarker,
            seenCompletionMarker: mergedSession.seenCompletionMarker,
            surfaceHidden: mergedSession.surfaceHidden,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            ...(mergedSession.summaryMetadata !== undefined && { summaryMetadata: mergedSession.summaryMetadata }),
            timestamp: ts,
        } as DaemonData)
    }

    // ─── 3. CLI entries ────────────────────────────────
    for (const session of cliSessions) {
        const existingEntry = existingSessionMap.get(session.id)
        const mergedSession = mergeSessionEntrySummary(session, existingEntry)
        entries.push({
            id: `${daemonId}:cli:${session.id}`,
            sessionId: session.id,
            providerSessionId: session.providerSessionId ?? existingEntry?.providerSessionId,
            parentSessionId: mergedSession.parentId,
            sessionKind: mergedSession.kind,
            transport: mergedSession.transport,
            sessionCapabilities: mergedSession.capabilities,
            type: mergedSession.providerType,
            agentType: mergedSession.providerType,
            status: mergedSession.status || 'running',
            daemonId,
            instanceId: session.id,
            cliName: mergedSession.providerName || mergedSession.providerType,
            mode: mergedSession.mode || existingEntry?.mode || 'terminal',
            workspace: mergedSession.workspace || '',
            activeChat: mergedSession.activeChat,
            ...(mergedSession.resume !== undefined && { resume: mergedSession.resume }),
            ...(mergedSession.runtimeKey !== undefined && { runtimeKey: mergedSession.runtimeKey }),
            ...(mergedSession.runtimeDisplayName !== undefined && { runtimeDisplayName: mergedSession.runtimeDisplayName }),
            ...(mergedSession.runtimeWorkspaceLabel !== undefined && { runtimeWorkspaceLabel: mergedSession.runtimeWorkspaceLabel }),
            ...(mergedSession.runtimeWriteOwner !== undefined && { runtimeWriteOwner: mergedSession.runtimeWriteOwner }),
            ...(mergedSession.runtimeAttachedClients !== undefined && { runtimeAttachedClients: mergedSession.runtimeAttachedClients }),
            ...(mergedSession.lastMessagePreview !== undefined && { lastMessagePreview: mergedSession.lastMessagePreview }),
            ...(mergedSession.lastMessageRole !== undefined && { lastMessageRole: mergedSession.lastMessageRole }),
            ...(mergedSession.lastMessageAt !== undefined && { lastMessageAt: mergedSession.lastMessageAt }),
            ...(mergedSession.lastMessageHash !== undefined && { lastMessageHash: mergedSession.lastMessageHash }),
            lastUpdated: mergedSession.lastUpdated,
            unread: mergedSession.unread,
            lastSeenAt: mergedSession.lastSeenAt,
            inboxBucket: mergedSession.inboxBucket,
            completionMarker: mergedSession.completionMarker,
            seenCompletionMarker: mergedSession.seenCompletionMarker,
            surfaceHidden: mergedSession.surfaceHidden,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            ...(mergedSession.summaryMetadata !== undefined && { summaryMetadata: mergedSession.summaryMetadata }),
            timestamp: ts,
            _isCli: true,
        } as DaemonData)
    }

    // ─── 4. ACP entries ────────────────────────────────
    for (const session of acpSessions) {
        const existingEntry = existingSessionMap.get(session.id)
        const mergedSession = mergeSessionEntrySummary(session, existingEntry)
        entries.push({
            id: `${daemonId}:acp:${session.id}`,
            sessionId: session.id,
            providerSessionId: session.providerSessionId ?? existingEntry?.providerSessionId,
            parentSessionId: mergedSession.parentId,
            sessionKind: mergedSession.kind,
            transport: mergedSession.transport,
            sessionCapabilities: mergedSession.capabilities,
            type: mergedSession.providerType,
            agentType: mergedSession.providerType,
            status: mergedSession.status || 'running',
            daemonId,
            instanceId: session.id,
            cliName: mergedSession.providerName || mergedSession.providerType,
            mode: 'chat',
            workspace: mergedSession.workspace || '',
            activeChat: mergedSession.activeChat,
            ...(mergedSession.runtimeKey !== undefined && { runtimeKey: mergedSession.runtimeKey }),
            ...(mergedSession.runtimeDisplayName !== undefined && { runtimeDisplayName: mergedSession.runtimeDisplayName }),
            ...(mergedSession.runtimeWorkspaceLabel !== undefined && { runtimeWorkspaceLabel: mergedSession.runtimeWorkspaceLabel }),
            ...(mergedSession.runtimeWriteOwner !== undefined && { runtimeWriteOwner: mergedSession.runtimeWriteOwner }),
            ...(mergedSession.runtimeAttachedClients !== undefined && { runtimeAttachedClients: mergedSession.runtimeAttachedClients }),
            ...(mergedSession.lastMessagePreview !== undefined && { lastMessagePreview: mergedSession.lastMessagePreview }),
            ...(mergedSession.lastMessageRole !== undefined && { lastMessageRole: mergedSession.lastMessageRole }),
            ...(mergedSession.lastMessageAt !== undefined && { lastMessageAt: mergedSession.lastMessageAt }),
            ...(mergedSession.lastMessageHash !== undefined && { lastMessageHash: mergedSession.lastMessageHash }),
            lastUpdated: mergedSession.lastUpdated,
            unread: mergedSession.unread,
            lastSeenAt: mergedSession.lastSeenAt,
            inboxBucket: mergedSession.inboxBucket,
            completionMarker: mergedSession.completionMarker,
            seenCompletionMarker: mergedSession.seenCompletionMarker,
            surfaceHidden: mergedSession.surfaceHidden,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            ...(mergedSession.summaryMetadata !== undefined && { summaryMetadata: mergedSession.summaryMetadata }),
            timestamp: ts,
            _isAcp: true,
        } as DaemonData)
    }

    return entries
}
