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
            settings: entry.settings,
            activeInteractivePrompt: entry.activeInteractivePrompt,
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

function scopeSessionInstanceId(daemonId: string, sessionId: string): string {
    if (!sessionId) return sessionId
    return sessionId.startsWith(`${daemonId}:`) ? sessionId : `${daemonId}:${sessionId}`
}

function isStatusTransformDebugEnabled(): boolean {
    if (typeof window === 'undefined') return false
    try {
        return !!((window as any).__ADHDEV_CONVERSATION_DEBUG__ || window.localStorage.getItem('adhdev_conversation_debug') === '1')
    } catch {
        return false
    }
}

function logStatusEntries(entries: DaemonData[]): void {
    if (!isStatusTransformDebugEnabled()) return
    console.debug('[dashboard-conversations] statusPayloadToEntries', entries.map(entry => ({
        id: entry.id,
        daemonId: entry.daemonId,
        sessionId: entry.sessionId,
        instanceId: entry.instanceId,
        providerSessionId: entry.providerSessionId,
        transport: entry.transport,
        type: entry.type,
    })))
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
        _sessionListAuthoritative: Array.isArray(payload.sessions),
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
            instanceId: scopeSessionInstanceId(daemonId, session.id),
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
            ...(mergedSession.activeInteractivePrompt !== undefined && { activeInteractivePrompt: mergedSession.activeInteractivePrompt }),
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
            muted: mergedSession.muted,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            ...(mergedSession.summaryMetadata !== undefined && { summaryMetadata: mergedSession.summaryMetadata }),
            ...(mergedSession.settings !== undefined && { settings: mergedSession.settings }),
            ...(mergedSession.messageInput !== undefined && { messageInput: mergedSession.messageInput }),
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
            instanceId: scopeSessionInstanceId(daemonId, session.id),
            cliName: mergedSession.providerName || mergedSession.providerType,
            mode: mergedSession.mode || existingEntry?.mode || 'terminal',
            workspace: mergedSession.workspace || '',
            // Mesh delegated sessions a coordinator synthesises into its own snapshot carry
            // the true owning node's attribution so the dashboard shows the worker machine.
            ...((session as { ownerDaemonId?: string }).ownerDaemonId && { ownerDaemonId: (session as { ownerDaemonId?: string }).ownerDaemonId }),
            ...((session as { ownerMachineName?: string }).ownerMachineName && { ownerMachineName: (session as { ownerMachineName?: string }).ownerMachineName }),
            activeChat: mergedSession.activeChat,
            ...(mergedSession.activeInteractivePrompt !== undefined && { activeInteractivePrompt: mergedSession.activeInteractivePrompt }),
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
            muted: mergedSession.muted,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            ...(mergedSession.summaryMetadata !== undefined && { summaryMetadata: mergedSession.summaryMetadata }),
            ...(mergedSession.settings !== undefined && { settings: mergedSession.settings }),
            ...(mergedSession.messageInput !== undefined && { messageInput: mergedSession.messageInput }),
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
            instanceId: scopeSessionInstanceId(daemonId, session.id),
            cliName: mergedSession.providerName || mergedSession.providerType,
            mode: 'chat',
            workspace: mergedSession.workspace || '',
            // See CLI block: carry mesh delegated-session owner attribution.
            ...((session as { ownerDaemonId?: string }).ownerDaemonId && { ownerDaemonId: (session as { ownerDaemonId?: string }).ownerDaemonId }),
            ...((session as { ownerMachineName?: string }).ownerMachineName && { ownerMachineName: (session as { ownerMachineName?: string }).ownerMachineName }),
            activeChat: mergedSession.activeChat,
            ...(mergedSession.activeInteractivePrompt !== undefined && { activeInteractivePrompt: mergedSession.activeInteractivePrompt }),
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
            muted: mergedSession.muted,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            ...(mergedSession.summaryMetadata !== undefined && { summaryMetadata: mergedSession.summaryMetadata }),
            ...(mergedSession.settings !== undefined && { settings: mergedSession.settings }),
            ...(mergedSession.messageInput !== undefined && { messageInput: mergedSession.messageInput }),
            timestamp: ts,
            _isAcp: true,
        } as DaemonData)
    }

    logStatusEntries(entries)
    return entries
}
