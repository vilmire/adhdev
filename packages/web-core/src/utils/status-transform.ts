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
    /** Timestamp override */
    timestamp?: number
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
    const { daemonId, existingDaemon, timestamp: tsOverride } = options
    const ts = tsOverride || payload.timestamp || Date.now()
    const sessions = payload.sessions || []
    const { topLevel, childrenByParent } = groupChildSessions(sessions)

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
        daemonMode: true,
        timestamp: ts,
        ...(payload.version && { version: payload.version }),
        ...(payload.machine && { machine: payload.machine, platform: payload.machine.platform }),
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
        const childSessions = childrenByParent.get(session.id) || []
        entries.push({
            id: `${daemonId}:ide:${session.id}`,
            sessionId: session.id,
            providerSessionId: session.providerSessionId,
            parentSessionId: session.parentId,
            sessionKind: session.kind,
            transport: session.transport,
            sessionCapabilities: session.capabilities,
            type: session.providerType,
            ideType: session.providerType,
            status: session.cdpConnected ? 'online' : 'detected',
            daemonId,
            instanceId: session.id,
            workspace: session.workspace,
            terminals: 0,
            childSessions,
            agents: childSessions.map((child) => ({
                id: child.id,
                name: child.providerName,
                type: child.providerType,
                status: child.status,
            })),
            activeChat: session.activeChat,
            chats: [],
            cdpConnected: session.cdpConnected,
            currentModel: session.currentModel,
            currentPlan: session.currentPlan,
            currentAutoApprove: session.currentAutoApprove,
            lastUpdated: session.lastUpdated,
            unread: session.unread,
            lastSeenAt: session.lastSeenAt,
            inboxBucket: session.inboxBucket,
            surfaceHidden: session.surfaceHidden,
            controlValues: session.controlValues,
            providerControls: session.providerControls,
            timestamp: ts,
        } as DaemonData)
    }

    // ─── 3. CLI entries ────────────────────────────────
    for (const session of cliSessions) {
        entries.push({
            id: `${daemonId}:cli:${session.id}`,
            sessionId: session.id,
            providerSessionId: session.providerSessionId,
            parentSessionId: session.parentId,
            sessionKind: session.kind,
            transport: session.transport,
            sessionCapabilities: session.capabilities,
            type: session.providerType,
            ideType: session.providerType,
            agentType: session.providerType,
            status: session.status || 'running',
            daemonId,
            instanceId: session.id,
            cliName: session.providerName,
            mode: session.mode || 'terminal',
            workspace: session.workspace || '',
            activeChat: session.activeChat,
            resume: session.resume,
            runtimeKey: session.runtimeKey,
            runtimeDisplayName: session.runtimeDisplayName,
            runtimeWorkspaceLabel: session.runtimeWorkspaceLabel,
            runtimeWriteOwner: session.runtimeWriteOwner ?? null,
            runtimeAttachedClients: session.runtimeAttachedClients ?? [],
            lastUpdated: session.lastUpdated,
            unread: session.unread,
            lastSeenAt: session.lastSeenAt,
            inboxBucket: session.inboxBucket,
            surfaceHidden: session.surfaceHidden,
            controlValues: session.controlValues,
            providerControls: session.providerControls,
            timestamp: ts,
            _isCli: true,
        } as DaemonData)
    }

    // ─── 4. ACP entries ────────────────────────────────
    for (const session of acpSessions) {
        entries.push({
            id: `${daemonId}:acp:${session.id}`,
            sessionId: session.id,
            providerSessionId: session.providerSessionId,
            parentSessionId: session.parentId,
            sessionKind: session.kind,
            transport: session.transport,
            sessionCapabilities: session.capabilities,
            type: session.providerType,
            ideType: session.providerType,
            agentType: session.providerType,
            status: session.status || 'running',
            daemonId,
            instanceId: session.id,
            cliName: session.providerName,
            mode: 'chat',
            workspace: session.workspace || '',
            activeChat: session.activeChat,
            runtimeKey: session.runtimeKey,
            runtimeDisplayName: session.runtimeDisplayName,
            runtimeWorkspaceLabel: session.runtimeWorkspaceLabel,
            runtimeWriteOwner: session.runtimeWriteOwner ?? null,
            runtimeAttachedClients: session.runtimeAttachedClients ?? [],
            currentModel: session.currentModel,
            currentPlan: session.currentPlan,
            lastUpdated: session.lastUpdated,
            unread: session.unread,
            lastSeenAt: session.lastSeenAt,
            inboxBucket: session.inboxBucket,
            surfaceHidden: session.surfaceHidden,
            acpConfigOptions: session.acpConfigOptions,
            acpModes: session.acpModes,
            controlValues: session.controlValues,
            providerControls: session.providerControls,
            timestamp: ts,
            _isAcp: true,
        } as DaemonData)
    }

    return entries
}
