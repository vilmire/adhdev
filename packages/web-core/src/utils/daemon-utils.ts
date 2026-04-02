/**
 * daemon-utils.ts — Daemon-related shared utilities
 *
 * Commonly used by Machines, MachineDetail, Dashboard, etc.
 */
import type { DaemonData } from '../types'
import type { MachineInfo, DetectedIdeInfo, SessionEntry } from '@adhdev/daemon-core'
import { isManagedStatusWaiting, isManagedStatusWorking, normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'

// ─── Formatters ──────────────────────────────────

/** Format IDE type string (e.g. 'cursor' → 'Cursor') */
export function formatIdeType(type: string): string {
    return type ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() : 'IDE'
}

/** Convert seconds to human-readable uptime format */
export function formatUptime(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`
    const m = Math.floor(seconds / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    const rm = m % 60
    if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`
    const d = Math.floor(h / 24)
    const rh = h % 24
    return `${d}d ${rh}h`
}

/** Convert bytes to MB/GB format */
export function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Human-friendly workspace label from optional custom label or path basename */
export function getWorkspaceDisplayLabel(path?: string | null, label?: string | null): string {
    const customLabel = typeof label === 'string' ? label.trim() : ''
    if (customLabel) return customLabel

    const rawPath = typeof path === 'string' ? path.trim() : ''
    if (!rawPath) return ''

    const normalized = rawPath.replace(/[\\/]+$/, '')
    const parts = normalized.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || normalized
}

/** Shorten long hostname to human-readable form */
export function formatMachineName(raw: string): string {
    if (raw.length > 16 && /^[a-f0-9]+$/i.test(raw)) return `Machine-${raw.substring(0, 8)}`
    if (raw.includes('_')) {
        const parts = raw.split('_')
        const last = parts[parts.length - 1]
        if (last.length > 12) return `Machine-${last.substring(0, 8)}`
        return last
    }
    return raw
}

export interface MachineNameSource {
    id?: string
    nickname?: string | null
    machineNickname?: string | null
    hostname?: string | null
    machine?: { hostname?: string | null }
    system?: { hostname?: string | null }
}

export interface MachineNameOptions {
    fallbackId?: string
    fallbackLabel?: string
}

function normalizeMachineHostname(raw: string): string {
    return formatMachineName(raw.trim().replace(/\.local$/i, ''))
}

export function getMachineNickname(source: MachineNameSource): string | null {
    const value = source.machineNickname ?? source.nickname
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed || null
}

export function getMachineHostnameLabel(
    source: MachineNameSource,
    options: MachineNameOptions = {},
): string {
    const rawHostname = [
        source.hostname,
        source.machine?.hostname,
        source.system?.hostname,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)

    if (rawHostname && rawHostname !== 'Unknown') {
        return normalizeMachineHostname(rawHostname)
    }

    const fallbackId = options.fallbackId || source.id
    if (fallbackId) return `Machine-${fallbackId.substring(0, 8)}`
    return options.fallbackLabel || 'Machine'
}

export function getMachineDisplayName(
    source: MachineNameSource,
    options: MachineNameOptions = {},
): string {
    return getMachineNickname(source) || getMachineHostnameLabel(source, options)
}

// ─── ID / Type Helpers ───────────────────────────

/** Determine if entry is a PTY-backed CLI session */
export function isCliEntry(entry: { transport?: string }): boolean {
    return entry.transport === 'pty'
}

/** Determine if entry is an ACP session */
export function isAcpEntry(entry: { transport?: string }): boolean {
    return entry.transport === 'acp'
}

/** Per-platform icon — now rendered as SVG at component level, kept for compat */
export const PLATFORM_ICONS: Record<string, string> = {}

// ─── Display Name ────────────────────────────────

/**
 * Determine agent stream/IDE display name (shared — same across Dashboard, IDE, AgentStreamPanel)
 *
 * Priority order:
 * 1. provider displayName (official name forwarded from daemon)
 * 2. agentName (agent stream name)
 * 3. formatIdeType(type) fallback (capitalize)
 */
export function getAgentDisplayName(
    type: string,
    opts?: { providerLabels?: Record<string, string>; agentName?: string },
): string {
    // Prefer displayName registered in provider list
    if (opts?.providerLabels?.[type]) return opts.providerLabels[type]
    if (opts?.providerLabels?.[type?.toLowerCase()]) return opts.providerLabels[type.toLowerCase()]
    // When agentName is explicitly provided
    if (opts?.agentName && opts.agentName !== type) return opts.agentName
    // fallback: capitalize
    return formatIdeType(type)
}

export function isGenericAgentTitle(
    title: string | null | undefined,
    agentName: string | null | undefined,
    agentType: string | null | undefined,
): boolean {
    const normalizedTitle = (title || '').trim().toLowerCase()
    if (!normalizedTitle) return true

    const normalizedAgentName = (agentName || '').trim().toLowerCase()
    const normalizedAgentType = (agentType || '').trim().toLowerCase()
    const formattedAgentType = formatIdeType(agentType || '').trim().toLowerCase()

    return normalizedTitle === normalizedAgentName
        || normalizedTitle === normalizedAgentType
        || normalizedTitle === formattedAgentType
}


/** Build provider icon/label map from daemon data */
export function buildProviderMaps(daemons: DaemonData[]): {
    icons: Record<string, string>
    labels: Record<string, string>
} {
    const icons: Record<string, string> = {}
    const labels: Record<string, string> = {}
    for (const d of daemons) {
        for (const p of d.availableProviders || []) {
            icons[p.type] = p.icon || ''
            labels[p.type] = p.displayName || formatIdeType(p.type)
        }
    }
    return { icons, labels }
}

// ─── Agent Status ────────────────────────────────

/** Determine if any agent/stream/chat is currently generating */
export function isAgentActive(
    agents: { status: string }[],
    streams: { status: string }[],
    activeChat?: { status?: string },
): boolean {
    return agents.some(a => isManagedStatusWorking(a.status))
        || streams.some(s => isManagedStatusWorking(s.status))
        || isManagedStatusWorking(activeChat?.status)
}

type StatusLike = { status?: string | null; activeModal?: { buttons?: unknown[] | null } | null }

/**
 * Native IDE chat status can lag behind extension streams.
 * Prefer explicit native chat state, then active stream state, then agent fallback state.
 */
export function deriveNativeConversationStatus(
    activeChat?: StatusLike | null,
    streams: StatusLike[] = [],
    agents: StatusLike[] = [],
): string {
    const chatStatus = normalizeManagedStatus(activeChat?.status, { activeModal: activeChat?.activeModal })
    if (chatStatus === 'waiting_approval') return 'waiting_approval'
    if (chatStatus === 'generating') return 'generating'

    const activeStream = streams.find(stream =>
        isManagedStatusWaiting(stream.status, { activeModal: stream.activeModal }) || isManagedStatusWorking(stream.status)
    )
    if (activeStream) {
        return normalizeManagedStatus(activeStream.status, { activeModal: activeStream.activeModal })
    }

    const activeAgent = agents.find(agent =>
        isManagedStatusWaiting(agent.status, { activeModal: agent.activeModal }) || isManagedStatusWorking(agent.status)
    )
    if (activeAgent) {
        return normalizeManagedStatus(activeAgent.status, { activeModal: activeAgent.activeModal })
    }

    return chatStatus || normalizeManagedStatus(agents[0]?.status) || 'idle'
}

export function deriveStreamConversationStatus(
    stream?: StatusLike | null,
): string {
    return normalizeManagedStatus(stream?.status, { activeModal: stream?.activeModal })
}

/** Remove aiAgents duplicates, prioritizing generating/waiting entries over idle ones */
export function dedupeAgents(agents: { id: string; name: string; status: string; version?: string }[]): typeof agents {
    if (!Array.isArray(agents) || agents.length <= 1) return agents
    const map = new Map<string, typeof agents[number]>()
    const priority = ['generating', 'waiting_approval', 'connected', 'idle', 'panel_hidden']
    for (const a of agents) {
        const key = (a.name || a.id || '').toLowerCase().replace(/\s+/g, '-')
        const existing = map.get(key)
        const normalized = normalizeManagedStatus(a.status)
        if (!existing) { map.set(key, { ...a, status: normalized }); continue }
        const existingIdx = priority.indexOf(existing.status || 'idle')
        const newIdx = priority.indexOf(normalized || 'idle')
        if (newIdx >= 0 && (existingIdx < 0 || newIdx < existingIdx)) {
            map.set(key, { ...a, status: normalized })
        }
    }
    return Array.from(map.values())
}

// ─── Machine Grouping ────────────────────────────

/** Machine group type (shared by Machines.tsx / MachineDetail.tsx) */
export interface MachineGroup {
    machineId: string
    hostname: string
    nickname: string | null
    platform: string
    system?: Partial<MachineInfo>
    daemonIde: DaemonData
    ideSessions: IdeSessionSummary[]
    cliSessions: CliSessionSummary[]
    acpSessions: AcpSessionSummary[]
    detectedIdes: DetectedIdeInfo[]
    p2p?: { available: boolean; state: string; peers: number }
}

/** IDE session summary for machine detail/overview display */
export interface IdeSessionSummary {
    id: string
    sessionId?: string
    type: string
    name: string
    status: string
    workspace: string
    agents: { id: string; name: string; status: string }[]
    childSessions: SessionEntry[]
    activeChat?: { status?: string }
}

/** CLI session summary for machine detail/overview display */
export interface CliSessionSummary {
    id: string
    sessionId?: string
    cliType: string
    cliName: string
    status: string
    workspace: string
    runtimeKey?: string
    runtimeDisplayName?: string
    runtimeWorkspaceLabel?: string
    runtimeWriteOwner?: { clientId: string; ownerType: 'agent' | 'user' } | null
}

/** ACP session summary for machine detail/overview display */
export interface AcpSessionSummary {
    id: string
    sessionId?: string
    acpType: string
    acpName: string
    status: string
    workspace: string
    model?: string
}

/** Group daemon array by machine */
export function groupByMachine(daemons: DaemonData[], providerLabels: Record<string, string>): MachineGroup[] {
    const machines: MachineGroup[] = []

    // 1st pass: daemon entry → create machine group
    for (const daemon of daemons) {
        if (daemon.type === 'adhdev-daemon' || daemon.daemonMode) {
            const machineInfo = daemon.machine
            const hostname = getMachineHostnameLabel(daemon, {
                fallbackId: daemon.id,
            })

            const system = daemon.system || (machineInfo?.hostname ? {
                arch: machineInfo.arch, cpus: machineInfo.cpus,
                totalMem: machineInfo.totalMem, freeMem: machineInfo.freeMem,
                availableMem: machineInfo.availableMem,
                loadavg: machineInfo.loadavg, uptime: machineInfo.uptime, release: machineInfo.release,
            } : undefined)

            machines.push({
                machineId: daemon.id,
                hostname,
                nickname: getMachineNickname(daemon),
                platform: machineInfo?.platform || daemon.platform || 'unknown',
                system,
                daemonIde: daemon,
                ideSessions: [],
                cliSessions: [],
                acpSessions: [],
                detectedIdes: daemon.detectedIdes || [],
                p2p: daemon.p2p,
            })
        }
    }

    // 2nd pass: managed IDEs/CLIs → assign to parent machine
    for (const daemon of daemons) {
        if (!daemon.daemonId || daemon.type === 'adhdev-daemon' || daemon.daemonMode) continue
        const parent = machines.find(m => m.machineId === daemon.daemonId)
        if (!parent) continue

        if (isAcpEntry(daemon)) {
            if (!parent.acpSessions.some(a => a.id === daemon.id)) {
                parent.acpSessions.push({
                    id: daemon.id,
                    sessionId: daemon.sessionId,
                    acpType: daemon.type,
                    acpName: daemon.cliName || daemon.type,
                    status: daemon.status || 'online',
                    workspace: daemon.workspace || '',
                    model: (daemon as any).model,
                })
            }
        } else if (isCliEntry(daemon)) {
            if (!parent.cliSessions.some(c => c.id === daemon.id)) {
                parent.cliSessions.push({
                    id: daemon.id,
                    sessionId: daemon.sessionId,
                    cliType: daemon.type,
                    cliName: daemon.cliName || daemon.type,
                    status: daemon.status || 'online',
                    workspace: daemon.workspace || '',
                    runtimeKey: daemon.runtimeKey,
                    runtimeDisplayName: daemon.runtimeDisplayName,
                    runtimeWorkspaceLabel: daemon.runtimeWorkspaceLabel,
                    runtimeWriteOwner: daemon.runtimeWriteOwner || null,
                })
            }
        } else {
            if (!parent.ideSessions.some(i => i.id === daemon.id)) {
                parent.ideSessions.push({
                    id: daemon.id,
                    sessionId: daemon.sessionId,
                    type: daemon.type,
                    name: providerLabels[daemon.type?.toLowerCase()] || formatIdeType(daemon.type || ''),
                    status: daemon.status || 'online',
                    workspace: daemon.workspace || '',
                    agents: (daemon.agents || daemon.aiAgents || []).map(a => ({ id: (a as any).id || a.name, name: a.name, status: a.status })),
                    childSessions: daemon.childSessions || [],
                    activeChat: daemon.activeChat || undefined,
                })
            }
        }
    }

    return machines
}
