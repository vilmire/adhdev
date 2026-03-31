/**
 * statusPayloadToEntries — StatusResponse → DaemonData[]
 *
 * Shared conversion from daemon StatusResponse (received via P2P or localhost WS)
 * into the flat DaemonData[] array consumed by Dashboard, IDE page, etc.
 *
 * Used by:
 *   - web-standalone: StandaloneDaemonContext (localhost WS)
 */
import type { StatusReportPayload, ManagedIdeEntry, ManagedCliEntry, ManagedAcpEntry } from '@adhdev/daemon-core'
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
        // System info
        ...(('system' in payload) && { system: (payload as any).system }),
        ...(('hostname' in payload) && { hostname: (payload as any).hostname }),
        // Workspaces
        ...(payload.workspaces && { workspaces: payload.workspaces }),
        ...(payload.defaultWorkspaceId !== undefined && { defaultWorkspaceId: payload.defaultWorkspaceId }),
        ...(payload.defaultWorkspacePath !== undefined && { defaultWorkspacePath: payload.defaultWorkspacePath }),
        ...(payload.workspaceActivity && { workspaceActivity: payload.workspaceActivity }),
        // IDE detection
        ...(payload.detectedIdes && { detectedIdes: payload.detectedIdes }),
        // Provider info
        ...(('availableProviders' in payload) && { availableProviders: (payload as any).availableProviders }),
        // CDP status (derived from managed IDEs)
        cdpConnected: payload.managedIdes.some((i: ManagedIdeEntry) => i.cdpConnected),
        // Managed IDs for cross-reference
        managedIdeIds: payload.managedIdes.map((i: ManagedIdeEntry) => `${daemonId}:ide:${i.instanceId}`),
        managedCliIds: payload.managedClis.map((c: ManagedCliEntry) => c.id ? `${daemonId}:cli:${c.id}` : `${daemonId}:cli:${c.cliType}`),
        managedAcpIds: payload.managedAcps.map((a: ManagedAcpEntry) => a.id ? `${daemonId}:acp:${a.id}` : `${daemonId}:acp:${a.acpType}`),
    } as any)

    // ─── 2. IDE entries ────────────────────────────────
    for (const ide of payload.managedIdes) {
        entries.push({
            id: `${daemonId}:ide:${ide.instanceId}`,
            type: ide.ideType,
            ideType: ide.ideType,
            version: ide.ideVersion,
            status: ide.cdpConnected ? 'online' : 'detected',
            daemonId,
            instanceId: ide.instanceId,
            workspace: ide.workspace,
            terminals: ide.terminals,
            agents: ide.aiAgents,
            activeChat: ide.activeChat,
            chats: ide.chats,
            agentStreams: ide.agentStreams,
            cdpConnected: ide.cdpConnected,
            currentModel: ide.currentModel,
            currentPlan: ide.currentPlan,
            currentAutoApprove: ide.currentAutoApprove,
            timestamp: ts,
        } as any)
    }

    // ─── 3. CLI entries ────────────────────────────────
    for (const cli of payload.managedClis) {
        const cliId = cli.id ? `${daemonId}:cli:${cli.id}` : `${daemonId}:cli:${cli.cliType}`
        entries.push({
            id: cliId,
            type: cli.cliType,
            ideType: cli.cliType,
            agentType: cli.cliType,
            status: cli.status || 'running',
            daemonId,
            instanceId: cli.id,
            cliName: cli.cliName,
            mode: cli.mode || 'terminal',
            workspace: cli.workspace,
            activeChat: cli.activeChat,
            agentStreams: [{
                agentType: cli.cliType,
                agentName: cli.cliName,
                extensionId: 'cli-agent',
                status: normalizeManagedStatus(cli.status, { activeModal: cli.activeChat?.activeModal }),
                messages: cli.activeChat?.messages || [],
                inputContent: '',
                activeModal: cli.activeChat?.activeModal,
            }],
            timestamp: ts,
            _isCli: true,
        } as any)
    }

    // ─── 4. ACP entries ────────────────────────────────
    for (const acp of payload.managedAcps) {
        const acpId = acp.id ? `${daemonId}:acp:${acp.id}` : `${daemonId}:acp:${acp.acpType}`
        entries.push({
            id: acpId,
            type: acp.acpType,
            ideType: acp.acpType,
            agentType: acp.acpType,
            status: acp.status || 'running',
            daemonId,
            instanceId: acp.id,
            cliName: acp.acpName,
            mode: 'chat',
            workspace: acp.workspace,
            activeChat: acp.activeChat,
            currentModel: acp.currentModel,
            currentPlan: acp.currentPlan,
            acpConfigOptions: acp.acpConfigOptions,
            acpModes: acp.acpModes,
            agentStreams: [{
                agentType: acp.acpType,
                agentName: acp.acpName,
                extensionId: 'acp-agent',
                status: normalizeManagedStatus(acp.status, { activeModal: acp.activeChat?.activeModal }),
                messages: acp.activeChat?.messages || [],
                inputContent: '',
                activeModal: acp.activeChat?.activeModal,
            }],
            timestamp: ts,
            _isAcp: true,
        } as any)
    }

    return entries
}
