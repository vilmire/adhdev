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
import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from '../types'
import type { MeshGraphSessionDetail } from '../../../utils/mesh-visualization'
// Presentation-tier quota helpers moved to utils/quota-format.ts (pure move —
// they depend only on @adhdev/mesh-shared types, not on anything MeshGraph-
// specific) so the machine page and session-info dialog can format the same
// quota values without importing from this mesh-observability subtree.
// Re-exported here so existing imports of this file keep working unchanged.
import {
    quotaProviderLabel,
    quotaUsageTone,
    formatQuotaReset,
    formatQuotaWindow,
    buildQuotaDisplayModel,
    collectQuotaBucketChips,
    describeQuotaFailure,
    describeQuotaOkWithoutWindows,
    formatQuotaFreshness,
    formatQuotaAccount,
    shouldShowClaudeSetupHint,
    quotaWindowCue,
    type QuotaChipHint,
    type QuotaDisplayModel,
} from '../../../utils/quota-format'
export {
    quotaProviderLabel,
    quotaUsageTone,
    formatQuotaAccount,
    shouldShowClaudeSetupHint,
    formatQuotaReset,
    formatQuotaWindow,
    buildQuotaDisplayModel,
    collectQuotaBucketChips,
    describeQuotaFailure,
    describeQuotaOkWithoutWindows,
    formatQuotaFreshness,
    quotaWindowCue,
    type QuotaChipHint,
    type QuotaDisplayModel,
}

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
    /**
     * Did ANY of this machine's nodes send a runtime facts bundle? False for a
     * machine that is in the mesh (its nodes are listed) but is offline/degraded
     * enough that no facts have arrived. The card still renders — a machine that
     * exists must not vanish from the machine list — but it says "has not
     * reported", never a fabricated number.
     */
    hasReported: boolean
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
 * EVERY machine that owns at least one mesh node gets a group, including one
 * that has never sent a facts bundle (offline/degraded peers typically have
 * not). Omitting those made a machine visible under "nodes" disappear from the
 * machine list entirely, which reads as "this machine does not exist" — a worse
 * lie than the one the omission was avoiding. The honest split is carried by
 * `hasReported`: the card renders, and the quota area says "has not reported"
 * instead of a number. No quota value is ever synthesised for such a machine —
 * `quota` stays empty, exactly as before.
 */
/**
 * The canonical "which machine hosts this node" key — shared by the quota
 * grouping, the node→machine section grouping, and the scheduling views, so
 * every surface agrees on the machine ⊃ nodes hierarchy.
 */
export function machineKeyForMeshNode(node: Pick<RepoMeshNodeStatus, 'daemonId' | 'machineId' | 'nodeId'>): string {
    return canonicalDaemonId(node.daemonId) || node.machineId || node.nodeId
}

export function collectMachineQuotaGroups(status: RepoMeshStatus): MachineQuotaGroup[] {
    const groups = new Map<string, MachineQuotaGroup>()
    for (const node of status.nodes) {
        const facts = node.nodeFacts
        const machineKey = machineKeyForMeshNode(node)
        if (!machineKey) continue
        let group = groups.get(machineKey)
        if (!group) {
            group = { machineKey, label: '', nodeCount: 0, hasReported: false, quota: [] }
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
        if (facts) group.hasReported = true
        const entries = collectNodeQuotaEntries(node)
        if (entries.length > 0 && (isFresher || group.quota.length === 0)) group.quota = entries
        const version = facts?.daemonBuild?.version || node.daemonBuildVersion
        if (version && (isFresher || !group.daemonBuildVersion)) group.daemonBuildVersion = version
    }
    // Names are resolved in a SECOND pass, over each machine's full node set, so
    // the result cannot depend on node iteration order — see resolveMachineLabel.
    for (const group of groups.values()) {
        group.label = resolveMachineLabel(status, group.machineKey)
    }
    return [...groups.values()]
        .sort((a, b) => a.label.localeCompare(b.label) || a.machineKey.localeCompare(b.machineKey))
}

/**
 * NODE/CHECKOUT-axis display label — the web mirror of daemon-core's
 * buildMeshNodeCheckoutLabel (axis separation 2026-08-24: machineLabel names
 * the MACHINE, this names the checkout on it). Worktrees render as
 * `⎇ branch`; base checkouts as their workspace basename; daemon-provided
 * `nodeLabel` is honoured when neither local derivation applies.
 */
export function nodeCheckoutLabel(node: Pick<RepoMeshNodeStatus, 'nodeId' | 'machineLabel' | 'workspace'> & { worktreeBranch?: string; nodeLabel?: string }): string {
    const branch = typeof node.worktreeBranch === 'string' && node.worktreeBranch.trim() ? node.worktreeBranch.trim() : ''
    if (branch) return `⎇ ${branch}`
    const provided = typeof node.nodeLabel === 'string' && node.nodeLabel.trim() ? node.nodeLabel.trim() : ''
    if (provided) return provided
    const basename = typeof node.workspace === 'string' ? node.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''
    return basename || node.machineLabel || (node.nodeId ? node.nodeId.slice(0, 12) : 'node')
}

/**
 * Both axes in one line for pickers, task targets and inbox rows —
 * `<checkout> · <machine>`, deduped when they resolve to the same string
 * (base checkout named after its machine, or an old-daemon status whose
 * machineLabel still is the workspace basename).
 */
export function nodeDisplayName(node: Pick<RepoMeshNodeStatus, 'nodeId' | 'machineLabel' | 'workspace'> & { worktreeBranch?: string; nodeLabel?: string }): string {
    const checkout = nodeCheckoutLabel(node)
    const machine = typeof node.machineLabel === 'string' ? node.machineLabel.trim() : ''
    if (!machine || machine === checkout) return checkout
    return `${checkout} · ${machine}`
}

/**
 * The name to show for a machine, resolved DETERMINISTICALLY from its whole
 * node set rather than from whichever node happened to be seen first.
 *
 * Fallback chain:
 *   1. `machineNickname` — operator-set and self-reported on the facts bundle.
 *      The only field that names the MACHINE itself.
 *   2. a node's `machineLabel` — what the Nodes section already calls this
 *      machine, so the two sections agree instead of one showing a raw id.
 *   3. a short prefix of the machine key.
 *
 * `machineLabel` is step 2, never step 1, originally because the pre-2026-08-24
 * daemon builder (old buildMeshNodeDisplayLabel) fell back to a workspace
 * basename, so two worktrees on one machine carried DIFFERENT machineLabels.
 * Current daemons emit a machine-axis-only label (buildMeshNodeMachineLabel) —
 * but statuses from older daemons still arrive, so the deterministic pick
 * (candidates collected across ALL the machine's nodes, lexicographically
 * smallest wins) stays as the mixed-version guard.
 */
export function resolveMachineLabel(status: RepoMeshStatus, machineKey: string): string {
    const nicknames: string[] = []
    const hostnames: string[] = []
    const nodeLabels: string[] = []
    for (const node of status.nodes) {
        const key = machineKeyForMeshNode(node)
        if (key !== machineKey) continue
        const nickname = node.nodeFacts?.machineNickname
        if (typeof nickname === 'string' && nickname.trim()) nicknames.push(nickname.trim())
        // Hostname beats the derived node label: "vilmire-MacBookAir" names the
        // MACHINE, while the derived label ("adhdev · claude-cli") is really
        // checkout+provider context wearing a machine costume.
        const machine = node.machine
        const hostname = (machine?.sameMachine ? machine.coordinatorHostname : undefined)
            ?? machine?.identityEvidence?.find(e => (e?.label === 'hostname' || e?.label === 'machineName') && typeof e.value === 'string' && e.value.trim())?.value
        if (typeof hostname === 'string' && hostname.trim()) hostnames.push(hostname.trim().replace(/\.local$/i, ''))
        const label = typeof node.machineLabel === 'string' ? node.machineLabel.trim() : ''
        // A machineLabel that is just the raw id carries no more information than
        // the fallback, so it is not treated as a name.
        if (label && label !== node.nodeId && label !== node.daemonId && label !== machineKey) nodeLabels.push(label)
    }
    const pick = (values: string[]): string | undefined =>
        values.length === 0 ? undefined : [...values].sort((a, b) => a.localeCompare(b))[0]
    return pick(nicknames) ?? pick(hostnames) ?? pick(nodeLabels) ?? shortMachineKey(machineKey)
}

/** `daemon_mach_1b46842a…` → `mach_1b46842a` — readable without inventing a name. */
export function shortMachineKey(machineKey: string): string {
    const core = machineKey.replace(/^(daemon_|standalone_)/, '')
    return core.length <= 20 ? core : `${core.slice(0, 17)}…`
}

// Maps the raw daemon-reported strategy to the 2-mode product vocabulary (Smart /
// In order). The legacy least_loaded / round_robin / priority_only values can still
// surface from a hand-edited meshes.json (or an older daemon) and are labelled as
// Smart variants — current daemons normalize the first two to 'fitness'.
export const SCHEDULING_STRATEGY_LABELS: Record<string, string> = {
    first_eligible: 'In order',
    fitness: 'Smart',
    least_loaded: 'Smart',
    round_robin: 'Smart (round-robin)',
    priority_only: 'Smart (priority)',
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
