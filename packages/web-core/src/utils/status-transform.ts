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

type ExistingSessionLike = Partial<SessionEntry> & {
    parentSessionId?: string | null
    cliName?: string
    type?: string
    sessionCapabilities?: SessionEntry['capabilities']
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
            currentModel: entry.currentModel,
            currentPlan: entry.currentPlan,
            currentAutoApprove: entry.currentAutoApprove,
            controlValues: entry.controlValues,
            providerControls: entry.providerControls,
            acpConfigOptions: entry.acpConfigOptions,
            acpModes: entry.acpModes,
            runtimeWriteOwner: entry.runtimeWriteOwner,
            runtimeAttachedClients: entry.runtimeAttachedClients,
            cliName: entry.cliName,
            type: entry.type,
            status: entry.status as SessionEntry['status'],
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

function mergeSessionSummary(
    session: SessionEntry,
    existingEntry: ExistingSessionLike | undefined,
): SessionEntry {
    return {
        ...session,
        parentId: session.parentId ?? existingEntry?.parentSessionId ?? null,
        providerName: session.providerName ?? existingEntry?.cliName ?? existingEntry?.type ?? session.providerType,
        workspace: session.workspace ?? existingEntry?.workspace ?? null,
        capabilities: session.capabilities ?? (existingEntry?.sessionCapabilities as SessionEntry['capabilities']) ?? [],
        cdpConnected: session.cdpConnected ?? existingEntry?.cdpConnected,
    }
}

function groupChildSessions(sessions: SessionEntry[]) {
    const topLevel: SessionEntry[] = []
    const childrenByParent = new Map<string, SessionEntry[]>()

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
        const mergedSession = mergeSessionSummary(session, existingEntry)
        const childSessions = (childrenByParent.get(session.id) || []).map((child) =>
            mergeSessionSummary(child, existingSessionMap.get(child.id)),
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
            ...(mergedSession.currentModel !== undefined && { currentModel: mergedSession.currentModel }),
            ...(mergedSession.currentPlan !== undefined && { currentPlan: mergedSession.currentPlan }),
            ...(mergedSession.currentAutoApprove !== undefined && { currentAutoApprove: mergedSession.currentAutoApprove }),
            lastUpdated: mergedSession.lastUpdated,
            unread: mergedSession.unread,
            lastSeenAt: mergedSession.lastSeenAt,
            inboxBucket: mergedSession.inboxBucket,
            surfaceHidden: mergedSession.surfaceHidden,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            timestamp: ts,
        } as DaemonData)
    }

    // ─── 3. CLI entries ────────────────────────────────
    for (const session of cliSessions) {
        const existingEntry = existingSessionMap.get(session.id)
        const mergedSession = mergeSessionSummary(session, existingEntry)
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
            lastUpdated: mergedSession.lastUpdated,
            unread: mergedSession.unread,
            lastSeenAt: mergedSession.lastSeenAt,
            inboxBucket: mergedSession.inboxBucket,
            surfaceHidden: mergedSession.surfaceHidden,
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            timestamp: ts,
            _isCli: true,
        } as DaemonData)
    }

    // ─── 4. ACP entries ────────────────────────────────
    for (const session of acpSessions) {
        const existingEntry = existingSessionMap.get(session.id)
        const mergedSession = mergeSessionSummary(session, existingEntry)
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
            ...(mergedSession.currentModel !== undefined && { currentModel: mergedSession.currentModel }),
            ...(mergedSession.currentPlan !== undefined && { currentPlan: mergedSession.currentPlan }),
            lastUpdated: mergedSession.lastUpdated,
            unread: mergedSession.unread,
            lastSeenAt: mergedSession.lastSeenAt,
            inboxBucket: mergedSession.inboxBucket,
            surfaceHidden: mergedSession.surfaceHidden,
            ...(mergedSession.acpConfigOptions !== undefined && { acpConfigOptions: mergedSession.acpConfigOptions }),
            ...(mergedSession.acpModes !== undefined && { acpModes: mergedSession.acpModes }),
            ...(mergedSession.controlValues !== undefined && { controlValues: mergedSession.controlValues }),
            ...(mergedSession.providerControls !== undefined && { providerControls: mergedSession.providerControls }),
            timestamp: ts,
            _isAcp: true,
        } as DaemonData)
    }

    return entries
}
