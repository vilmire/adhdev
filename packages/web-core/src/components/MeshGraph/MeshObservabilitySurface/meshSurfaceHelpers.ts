import type {
    GitLogEntry,
    RepoMeshLedgerSummaryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueTask,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from '../types'
import type { MeshGraphSessionDetail } from '../../../utils/mesh-visualization'

export type SessionListEntry = {
    nodeId: string
    machineLabel: string
    workspace: string
    branch: string | null
    nodeHealth: string
    session: MeshGraphSessionDetail
}

export type GitHistoryState = {
    loading: boolean
    error: string | null
    entries: GitLogEntry[]
}

export type HealPreviewState = {
    phase: 'dry_run' | 'execute'
    code?: string
    error?: string | null
    executed?: boolean
}

export type AsyncRefineJob = {
    jobId: string
    status: 'accepted' | 'running' | 'completed' | 'failed'
    branch?: string
    into?: string
    completedAt?: string
    startedAt?: string
}

export const EMPTY_LEDGER_SUMMARY: RepoMeshLedgerSummaryStatus = {
    meshId: '',
    totalEntries: 0,
    taskDispatched: 0,
    taskCompleted: 0,
    taskFailed: 0,
    taskStalled: 0,
    sessionLaunched: 0,
    checkpointCreated: 0,
    lastActivityAt: null,
    recentFailures: 0,
}

export function healthTone(status: string): 'default' | 'good' | 'warn' | 'danger' | 'info' {
    switch (status) {
        case 'online':
            return 'good'
        case 'dirty':
            return 'warn'
        case 'degraded':
        case 'offline':
            return 'danger'
        case 'wrong_branch':
            return 'info'
        default:
            return 'default'
    }
}

export function sessionTone(state: string | null | undefined): 'default' | 'good' | 'warn' | 'danger' | 'info' {
    switch ((state || '').toLowerCase()) {
        case 'idle':
            return 'good'
        case 'generating':
        case 'running':
            return 'info'
        case 'waiting_approval':
        case 'starting':
        case 'pending':
            return 'warn'
        case 'failed':
        case 'stopped':
        case 'interrupted':
            return 'danger'
        default:
            return 'default'
    }
}

export function sessionStatusLabel(session: MeshGraphSessionDetail): string {
    const raw = (session.chatStatus || session.state || session.lifecycle || '').trim()
    if (!raw) return 'unknown'
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized.includes('approval')) return 'awaiting approval'
    if (normalized.includes('generating') || normalized.includes('running') || normalized.includes('busy')) return 'generating'
    if (normalized.includes('idle') || normalized.includes('ready') || normalized.includes('waiting_input')) return 'idle'
    return normalized.replace(/_/g, ' ')
}

export function sessionRoleLabel(session: MeshGraphSessionDetail): string {
    if (session.isSelfCoordinator) return 'coordinator'
    const role = typeof session.role === 'string' ? session.role.trim() : ''
    return role || 'worker'
}

export function sessionStartedAt(session: MeshGraphSessionDetail): string | null {
    return session.startedAt || session.createdAt || null
}

export function sessionElapsedLabel(session: MeshGraphSessionDetail): string {
    const startedAt = sessionStartedAt(session)
    if (!startedAt) return 'runtime age not reported'
    const parsed = Date.parse(startedAt)
    if (!Number.isFinite(parsed)) return 'runtime age not reported'
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000))
    if (elapsedSeconds < 60) return `${elapsedSeconds}s`
    const minutes = Math.floor(elapsedSeconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h ${minutes % 60}m`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
}

export function shortSessionId(sessionId: string): string {
    if (sessionId.length <= 18) return sessionId
    return `${sessionId.slice(0, 10)}...${sessionId.slice(-4)}`
}

export function connectionTone(connection: RepoMeshNodeStatus['connection'] | null | undefined): 'default' | 'good' | 'warn' | 'danger' | 'info' {
    if (!connection) return 'default'
    if (connection.state === 'self') return 'info'
    if (connection.transport === 'direct' && connection.state === 'connected') return 'good'
    if (connection.transport === 'relay' && connection.state === 'connected') return 'info'
    switch (connection.state) {
        case 'connected':
            return 'good'
        case 'connecting':
            return 'warn'
        case 'disconnected':
        case 'failed':
        case 'closed':
            return 'danger'
        default:
            return 'default'
    }
}

export function connectionLabel(connection: RepoMeshNodeStatus['connection'] | null | undefined): string {
    if (!connection) return 'mesh unknown'
    if (connection.state === 'self') return 'mesh self'
    if (connection.transport === 'direct' && connection.state === 'connected') return 'mesh direct'
    if (connection.transport === 'relay' && connection.state === 'connected') return 'mesh relay'
    if (!connection.reported && connection.source === 'not_reported') return 'mesh unknown / not reported'
    return `mesh ${connection.state}`
}

export function summarizeNodeDrift(node: RepoMeshNodeStatus): string {
    const git = node.git
    if (!git) return node.gitProbePending ? 'Git probe pending' : 'No git probe'
    const changes = (git.staged ?? 0) + (git.modified ?? 0) + (git.untracked ?? 0) + (git.deleted ?? 0) + (git.renamed ?? 0)
    const parts: string[] = []
    if (git.branch) parts.push(git.branch)
    if (git.upstream && git.upstreamStatus !== 'fresh') parts.push('upstream unverified')
    if (git.upstreamStatus === 'fresh' && ((git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0)) parts.push(`↑${git.ahead ?? 0}/↓${git.behind ?? 0}`)
    if (changes > 0) parts.push(`${changes} dirty`)
    const dirtySubmodules = (git.submodules ?? []).filter(submodule => submodule.dirty)
    const driftedSubmodules = (git.submodules ?? []).filter(submodule => submodule.outOfSync || submodule.error)
    if (dirtySubmodules.length > 0) parts.push(`${dirtySubmodules.length} submodule dirty`)
    if (driftedSubmodules.length > 0) parts.push(`${driftedSubmodules.length} submodule drift`)
    if (git.hasConflicts) parts.push('conflicts')
    return parts.join(' · ') || 'Clean'
}

// Maps the raw daemon-reported strategy to the 2-mode product vocabulary (Spread /
// In order). The legacy round_robin / priority_only values still surface (an
// escape-hatch meshes.json may set them) and are labelled as Spread variants.
export const SCHEDULING_STRATEGY_LABELS: Record<string, string> = {
    first_eligible: 'In order',
    least_loaded: 'Spread',
    round_robin: 'Spread (round-robin)',
    priority_only: 'Spread (priority)',
}

/** Human-readable label for a structured claim-block reason code. */
export function schedulingReasonLabel(reason: string): string {
    if (reason.startsWith('max_provider_parallel_reached:')) {
        return `provider cap reached (${reason.slice('max_provider_parallel_reached:'.length)})`
    }
    switch (reason) {
        case 'global_max_parallel_tasks_reached': return 'global parallel cap reached'
        case 'node_has_active_assignment': return 'already running a write task'
        default: return reason.replace(/_/g, ' ')
    }
}

export function collectSessionEntries(status: RepoMeshStatus): SessionListEntry[] {
    const entries: SessionListEntry[] = []
    for (const node of status.nodes) {
        const sessions: MeshGraphSessionDetail[] = (node.activeSessionDetails && node.activeSessionDetails.length > 0)
            ? node.activeSessionDetails as MeshGraphSessionDetail[]
            : (node.activeSessions ?? []).map(sessionId => ({ sessionId, workspace: node.workspace, isCached: true }))
        for (const session of sessions) {
            entries.push({
                nodeId: node.nodeId,
                machineLabel: node.machineLabel,
                workspace: node.workspace,
                branch: node.git?.branch ?? null,
                nodeHealth: node.health,
                session,
            })
        }
    }
    return entries
}

export function getQueueTaskNodeTarget(task: RepoMeshQueueTask): string | null {
    return task.assignedNodeId || task.targetNodeId || null
}

export function getQueueTaskSessionTarget(task: RepoMeshQueueTask): string | null {
    return task.assignedSessionId || task.targetSessionId || task.autoLaunch?.sessionId || null
}

export function shortCommit(commit: string | null | undefined): string | null {
    if (!commit) return null
    return commit.slice(0, 7)
}

function summarizeHead(statusNode: RepoMeshNodeStatus | null, historyEntries: GitLogEntry[]): string | null {
    const headCommit = shortCommit(statusNode?.git?.headCommit)
    const headMessage = statusNode?.git?.headMessage?.trim() || ''
    if (headCommit || headMessage) return [headCommit, headMessage].filter(Boolean).join(' · ')
    const latestEntry = historyEntries[0]
    if (!latestEntry) return null
    return [shortCommit(latestEntry.commit), latestEntry.message].filter(Boolean).join(' · ')
}

export function summarizeSelectedHead(statusNode: RepoMeshNodeStatus | null, historyEntries: GitLogEntry[]): string | null {
    const summary = summarizeHead(statusNode, historyEntries)
    if (summary) return summary
    return statusNode?.gitProbePending ? 'Pending live git probe' : null
}

export function extractGitLogEntries(response: any): GitLogEntry[] {
    const body = response?.result ?? response
    const log = body?.log ?? response?.log ?? body
    return Array.isArray(log?.entries) ? log.entries : []
}

export function resolveGitLogRequest(args: {
    coordinatorDaemonId: string | null
    selectedNodeStatus: RepoMeshNodeStatus | null
    selectedSessionEntry: SessionListEntry | null
    selectedGraphNode: MeshGraphNode | null
}): { daemonId: string; workspace: string } | null {
    const workspace = args.selectedSessionEntry?.session.workspace
        || args.selectedSessionEntry?.workspace
        || args.selectedNodeStatus?.git?.workspace
        || args.selectedNodeStatus?.workspace
        || null
    if (workspace && args.selectedSessionEntry) {
        const daemonId = args.selectedNodeStatus?.daemonId || args.coordinatorDaemonId
        return daemonId ? { daemonId, workspace } : null
    }
    if (workspace && args.selectedNodeStatus) {
        const daemonId = args.selectedNodeStatus.daemonId || args.coordinatorDaemonId
        return daemonId ? { daemonId, workspace } : null
    }
    return null
}

export function describeProviders(node: RepoMeshNodeStatus): string {
    if ((node.providers ?? []).length > 0) return node.providers.join(', ')
    if ((node.providerPriority ?? []).length > 0) return `installed providers not reported; priority ${(node.providerPriority ?? []).join(', ')}`
    return 'not reported yet'
}

export function describeConnection(node: RepoMeshNodeStatus): string {
    if (node.gitProbePending && (!node.connection || node.connection.state === 'unknown')) return 'mesh pending'
    return connectionLabel(node.connection)
}

export function describeGraphNodeSource(node: MeshGraphNode): string {
    const source = node.source as { kind?: string; connection?: RepoMeshNodeStatus['connection'] } | null | undefined
    if (source?.kind) return source.kind
    return source?.connection?.source ?? 'mesh_status'
}

export function edgeTypeLabel(edge: MeshGraphEdge): string {
    switch (edge.type) {
        case 'parentBranch':
            return 'default branch link'
        case 'worktreeLink':
            return 'worktree relationship'
        case 'sessionLink':
            return 'session relationship'
        case 'orphanLink':
            return 'orphan relationship'
        case 'submoduleLink':
            return 'submodule relationship'
        case 'cloneLink':
            return 'clone relationship'
        default:
            return edge.type
    }
}

export function edgeDirectionLabel(edge: MeshGraphEdge): string {
    return edge.direction === 'directed' ? 'directed' : 'undirected'
}

export function resolveSelectedGraphNodeForDetail(graph: MeshGraphData, selectedNodeId: string | null | undefined): MeshGraphNode | null {
    if (!selectedNodeId) return null
    return graph.nodes.find(node => node.id === selectedNodeId) ?? null
}

export function getRepoMeshStatusGraphFingerprint(status: RepoMeshStatus): string {
    return [
        status.meshId,
        status.refreshedAt,
        status.nodes.length,
        status.queue?.summary?.active ?? '',
        status.ledger?.summary?.recentFailures ?? '',
        ...status.nodes.map(node => [
            node.nodeId,
            node.daemonId ?? '',
            node.machineId ?? '',
            node.machineLabel,
            node.machineStatus ?? '',
            node.connection?.state ?? '',
            node.connection?.transport ?? '',
            node.connection?.source ?? '',
            node.health,
            node.gitProbePending ? 1 : 0,
            node.git?.branch ?? '',
            node.git?.upstream ?? '',
            node.git?.upstreamStatus ?? '',
            node.git?.ahead ?? '',
            node.git?.behind ?? '',
            node.git?.headCommit ?? '',
            node.git?.staged ?? '',
            node.git?.modified ?? '',
            node.git?.untracked ?? '',
            node.git?.deleted ?? '',
            node.git?.renamed ?? '',
            node.git?.hasConflicts ? 1 : 0,
            node.git?.lastCheckedAt ?? '',
            node.activeSessions?.join(',') ?? '',
            node.activeSessionDetails?.length ?? '',
            (node.activeSessionDetails as MeshGraphSessionDetail[] | undefined)?.map(session => [
                session.sessionId,
                session.providerType ?? '',
                session.state ?? '',
                session.chatStatus ?? '',
                session.lifecycle ?? '',
                session.role ?? '',
                session.isSelfCoordinator ? 1 : 0,
                session.statusNote ?? '',
                session.startedAt ?? '',
                session.createdAt ?? '',
            ].join('/')).join(',') ?? '',
            node.providers?.join(',') ?? '',
            node.providerPriority?.join(',') ?? '',
            node.error ?? '',
            (node.git?.submodules ?? []).map(submodule => [
                submodule.path,
                submodule.commit,
                submodule.dirty ? 1 : 0,
                submodule.outOfSync ? 1 : 0,
                submodule.error ?? '',
            ].join('/')).join(','),
        ].join('|')),
    ].join('::')
}

export function isBootstrapFallbackStatus(status: RepoMeshStatus): boolean {
    if (status.nodes.length === 0) return false
    return status.nodes.every(
        node => node.health === 'unknown'
            && (!node.connection || node.connection.state === 'unknown'),
    )
}
