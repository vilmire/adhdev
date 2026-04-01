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
import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
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
        ...(payload.workspaceActivity && { workspaceActivity: payload.workspaceActivity }),
        ...(payload.detectedIdes && { detectedIdes: payload.detectedIdes }),
        ...(('availableProviders' in payload) && { availableProviders: (payload as any).availableProviders }),
        cdpConnected: ideSessions.some((session) => !!session.cdpConnected),
    } as any)

    // ─── 2. IDE entries ────────────────────────────────
    for (const session of ideSessions) {
        const childSessions = childrenByParent.get(session.id) || []
        entries.push({
            id: `${daemonId}:ide:${session.id}`,
            sessionId: session.id,
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
            agents: childSessions.map((child) => ({
                id: child.id,
                name: child.providerName,
                type: child.providerType,
                status: child.status,
            })),
            activeChat: session.activeChat,
            chats: [],
            agentStreams: childSessions.map((child) => ({
                sessionId: child.id,
                instanceId: child.id,
                parentSessionId: child.parentId,
                agentType: child.providerType,
                agentName: child.providerName,
                extensionId: child.providerType,
                transport: child.transport,
                status: normalizeManagedStatus(child.status, { activeModal: child.activeChat?.activeModal }),
                title: child.title,
                messages: child.activeChat?.messages || [],
                inputContent: child.activeChat?.inputContent || '',
                activeModal: child.activeChat?.activeModal || null,
                model: child.currentModel,
            })),
            cdpConnected: session.cdpConnected,
            currentModel: session.currentModel,
            currentPlan: session.currentPlan,
            currentAutoApprove: session.currentAutoApprove,
            timestamp: ts,
        } as any)
    }

    // ─── 3. CLI entries ────────────────────────────────
    for (const session of cliSessions) {
        const runtime = (session as any).runtime
        entries.push({
            id: `${daemonId}:cli:${session.id}`,
            sessionId: session.id,
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
            mode: 'terminal',
            workspace: session.workspace || '',
            activeChat: session.activeChat,
            resume: (session as any).resume,
            runtimeKey: (session as any).runtimeKey ?? runtime?.runtimeKey,
            runtimeDisplayName: (session as any).runtimeDisplayName ?? runtime?.displayName,
            runtimeWorkspaceLabel: (session as any).runtimeWorkspaceLabel ?? runtime?.workspaceLabel,
            runtimeWriteOwner: (session as any).runtimeWriteOwner ?? runtime?.writeOwner ?? null,
            runtimeAttachedClients: (session as any).runtimeAttachedClients ?? runtime?.attachedClients ?? [],
            agentStreams: [{
                sessionId: session.id,
                instanceId: session.id,
                parentSessionId: session.parentId,
                agentType: session.providerType,
                agentName: session.providerName,
                extensionId: 'cli-agent',
                transport: session.transport,
                status: normalizeManagedStatus(session.status, { activeModal: session.activeChat?.activeModal }),
                title: session.title,
                messages: session.activeChat?.messages || [],
                inputContent: session.activeChat?.inputContent || '',
                activeModal: session.activeChat?.activeModal,
            }],
            timestamp: ts,
            _isCli: true,
        } as any)
    }

    // ─── 4. ACP entries ────────────────────────────────
    for (const session of acpSessions) {
        const runtime = (session as any).runtime
        entries.push({
            id: `${daemonId}:acp:${session.id}`,
            sessionId: session.id,
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
            runtimeKey: (session as any).runtimeKey ?? runtime?.runtimeKey,
            runtimeDisplayName: (session as any).runtimeDisplayName ?? runtime?.displayName,
            runtimeWorkspaceLabel: (session as any).runtimeWorkspaceLabel ?? runtime?.workspaceLabel,
            runtimeWriteOwner: (session as any).runtimeWriteOwner ?? runtime?.writeOwner ?? null,
            runtimeAttachedClients: (session as any).runtimeAttachedClients ?? runtime?.attachedClients ?? [],
            currentModel: session.currentModel,
            currentPlan: session.currentPlan,
            acpConfigOptions: session.acpConfigOptions,
            acpModes: session.acpModes,
            agentStreams: [{
                sessionId: session.id,
                instanceId: session.id,
                parentSessionId: session.parentId,
                agentType: session.providerType,
                agentName: session.providerName,
                extensionId: 'acp-agent',
                transport: session.transport,
                status: normalizeManagedStatus(session.status, { activeModal: session.activeChat?.activeModal }),
                title: session.title,
                messages: session.activeChat?.messages || [],
                inputContent: session.activeChat?.inputContent || '',
                activeModal: session.activeChat?.activeModal,
            }],
            timestamp: ts,
            _isAcp: true,
        } as any)
    }

    return entries
}
