import type {
    GitLogEntry,
    RepoMeshLedgerSummaryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueTask,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
// Value import is safe here: @adhdev/mesh-shared is the dependency-free leaf.
// (A VALUE import from the @adhdev/daemon-core barrel would drag Node builtins
// into the browser bundle and break the dashboard — types only from there.)
import { canonicalDaemonId } from '@adhdev/mesh-shared'
import type { MeshNodeFactsProviderQuota, MeshNodeFactsQuotaWindow } from '@adhdev/mesh-shared'
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

// ─── Provider quota (nodeFacts.quota) ───────────────────────────────────────
// Observation-only surfacing of the per-provider plan quota a node reports in
// its MeshNodeFacts bundle. THREE states must stay visually distinct, because
// two of them are normal and only one is a problem:
//   'unreported' — the node has sent facts but no quota key yet. This is the
//       EXPECTED state for a freshly started daemon: the refresh loop's first
//       tick is at +15min, not at boot, and it skips ticks entirely on an idle
//       machine. Rendering this like a failure would train the owner to read a
//       healthy daemon as broken, so it is deliberately muted, not a warning.
//   'unavailable' / 'error' — the node LOOKED and could not read the quota. The
//       daemon reports these explicitly (rather than omitting the provider) so
//       "never told us" and "told us it could not tell" stay distinguishable;
//       failureKind is surfaced because it is what separates "not installed"
//       from "channel broken".
//   'ok' — real numbers.

/** Provider ids are wire keys ('claude-cli'); show the product name. */
const QUOTA_PROVIDER_LABELS: Record<string, string> = {
    'claude-cli': 'Claude Code',
    'codex-cli': 'Codex CLI',
    kimi: 'Kimi Code',
}

export function quotaProviderLabel(provider: string): string {
    return QUOTA_PROVIDER_LABELS[provider] ?? provider
}

/**
 * Tone for a usage percentage. Same 70/90 thresholds the `adhdev quota` CLI
 * uses for its bar colour, so the two surfaces agree on what "getting close"
 * means.
 */
export function quotaUsageTone(usedPercent: number): 'default' | 'good' | 'warn' | 'danger' | 'info' {
    if (!Number.isFinite(usedPercent)) return 'default'
    if (usedPercent >= 90) return 'danger'
    if (usedPercent >= 70) return 'warn'
    return 'good'
}

/** "23.5% used" / "23.5% used · resets in 2h 14m" for one rolling window. */
export function formatQuotaWindow(window: MeshNodeFactsQuotaWindow | null | undefined, now: number = Date.now()): string | null {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null
    const used = `${window.usedPercent.toFixed(1)}% used`
    const resets = formatQuotaReset(window.resetsAt, now)
    return resets ? `${used} · ${resets}` : used
}

/** "resets in 2h 14m" — omitted entirely when the node reported no reset time. */
export function formatQuotaReset(resetsAt: number | null | undefined, now: number = Date.now()): string | null {
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null
    const deltaMs = resetsAt - now
    if (deltaMs <= 0) return 'resets now'
    const minutes = Math.round(deltaMs / 60_000)
    if (minutes < 60) return `resets in ${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`
    return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * The failure line for a non-ok provider. Prefers the daemon's own message and
 * appends failureKind when it adds information the message does not already
 * carry — the kind is the field that separates "not installed" from "expired
 * credentials" from "channel broken".
 */
export function describeQuotaFailure(quota: MeshNodeFactsProviderQuota): string {
    const message = typeof quota.error === 'string' ? quota.error.trim() : ''
    const kindRaw = quota.metadata?.failureKind
    const kind = typeof kindRaw === 'string' ? kindRaw.trim() : ''
    const kindLabel = kind ? kind.replace(/[_-]+/g, ' ') : ''
    if (message && kindLabel && !message.toLowerCase().includes(kindLabel.toLowerCase())) {
        return `${message} (${kindLabel})`
    }
    if (message) return message
    if (kindLabel) return kindLabel
    return quota.status === 'unavailable' ? 'not available on this node' : 'could not read quota'
}

export type NodeQuotaEntry = {
    provider: string
    quota: MeshNodeFactsProviderQuota
}

/**
 * Read the quota map off a node's facts bundle in a stable display order, so
 * providers do not reshuffle between refreshes. Returns [] for the unreported
 * state — the caller distinguishes that from "reported and failing".
 */
export function collectNodeQuotaEntries(node: RepoMeshNodeStatus): NodeQuotaEntry[] {
    const quota = node.nodeFacts?.quota
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return []
    const entries: NodeQuotaEntry[] = []
    for (const [provider, value] of Object.entries(quota)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        entries.push({ provider, quota: value as MeshNodeFactsProviderQuota })
    }
    return entries.sort((a, b) => quotaProviderLabel(a.provider).localeCompare(quotaProviderLabel(b.provider)))
}

export type MachineQuotaGroup = {
    /** Canonical grouping key — the machine core, not a raw daemon id form. */
    machineKey: string
    /** Human-facing machine name (operator nickname when the machine set one). */
    label: string
    /** Daemon build version, shown next to the name like the node build chip. */
    daemonBuildVersion?: string
    /** How many mesh nodes this machine hosts — they share this one quota. */
    nodeCount: number
    /** Freshest facts stamp across this machine's nodes. */
    reportedAt?: number
    quota: NodeQuotaEntry[]
}

/**
 * Group mesh nodes into MACHINES and attach each machine's quota once.
 *
 * Why grouping is required rather than rendering per node: quota is a machine
 * property (machine-local credentials, machine-wide 5h/7d windows) that rides a
 * per-node envelope because git_status is the transport. A machine hosting
 * several worktree nodes therefore reports the SAME numbers on every node, and
 * rendering them per node makes one codex reading look like N independent ones.
 *
 * Grouping key is `canonicalDaemonId` — NOT the raw daemonId string. The same
 * daemon legitimately appears as `mach_<hex>`, `daemon_mach_<hex>` and
 * `standalone_mach_<hex>`; comparing raw forms is the recurring identity defect
 * in this codebase and here it would split one machine into several cards,
 * reintroducing the duplication this function exists to remove. Nodes with no
 * usable daemon id fall back to their machineId, then to their own nodeId, so
 * an unidentified node becomes its own machine rather than colliding with
 * every other unidentified node under a shared empty key.
 *
 * Machines that never sent a facts bundle are OMITTED entirely: with no report
 * there is nothing to say, and claiming "not collected yet" would invent a
 * state the machine never described. A machine that sent facts but no quota
 * key IS included (with an empty quota list) — that is the real "not collected
 * yet", which the caller renders as a muted line.
 */
export function collectMachineQuotaGroups(status: RepoMeshStatus): MachineQuotaGroup[] {
    const groups = new Map<string, MachineQuotaGroup>()
    for (const node of status.nodes) {
        const facts = node.nodeFacts
        const machineKey = canonicalDaemonId(node.daemonId) || node.machineId || node.nodeId
        if (!machineKey) continue
        let group = groups.get(machineKey)
        if (!group) {
            group = { machineKey, label: '', nodeCount: 0, quota: [] }
            groups.set(machineKey, group)
        }
        group.nodeCount += 1
        // Prefer the freshest report when a machine's nodes disagree: the newest
        // bundle is the one whose quota numbers are least stale.
        const reportedAt = typeof facts?.reportedAt === 'number' && Number.isFinite(facts.reportedAt)
            ? facts.reportedAt
            : undefined
        const isFresher = reportedAt !== undefined && (group.reportedAt === undefined || reportedAt > group.reportedAt)
        if (isFresher) group.reportedAt = reportedAt
        const entries = collectNodeQuotaEntries(node)
        if (entries.length > 0 && (isFresher || group.quota.length === 0)) group.quota = entries
        const version = facts?.daemonBuild?.version || node.daemonBuildVersion
        if (version && (isFresher || !group.daemonBuildVersion)) group.daemonBuildVersion = version
        const label = machineDisplayName(node)
        if (label && (isFresher || !group.label)) group.label = label
    }
    return [...groups.values()]
        // A machine that never reported facts has nothing to say about quota.
        .filter(group => group.reportedAt !== undefined)
        .map(group => ({ ...group, label: group.label || group.machineKey }))
        .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The name to show for the machine hosting a node.
 *
 * `machineNickname` (operator-set, self-reported on the facts bundle) is the
 * only value that names the MACHINE. `node.machineLabel` is deliberately not
 * preferred: buildMeshNodeDisplayLabel falls back to a workspace basename, so
 * two worktrees on one machine carry different machineLabels and using it here
 * would label one machine inconsistently depending on which node was seen
 * first.
 */
function machineDisplayName(node: RepoMeshNodeStatus): string | undefined {
    const nickname = node.nodeFacts?.machineNickname
    if (typeof nickname === 'string' && nickname.trim()) return nickname.trim()
    return undefined
}

/**
 * Age of the facts bundle this quota rode in on. Deliberately derived from the
 * bundle's existing `reportedAt` rather than any TTL field: refresh cadence is
 * owned by the reporting node and delivery cadence by whoever calls git_status,
 * so neither end is in a position to assert an expiry (mesh-shared node-facts.ts).
 * The reader judges age instead.
 */
export function formatQuotaFreshness(reportedAt: number | null | undefined, now: number = Date.now()): string | null {
    if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt) || reportedAt <= 0) return null
    const ageMs = now - reportedAt
    if (ageMs < 0) return 'just now'
    const minutes = Math.floor(ageMs / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`
    return `${Math.floor(hours / 24)}d ${hours % 24}h ago`
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
