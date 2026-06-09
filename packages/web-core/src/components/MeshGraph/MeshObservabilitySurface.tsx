import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
    GitLogEntry,
    RepoMeshNodeStatus,
    RepoMeshQueueTask,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import MeshGraphView from './MeshGraphView'
import { getMeshGraphTheme } from './meshGraphTheme'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'
import { buildMeshGraph, type MeshGraphSessionDetail } from '../../utils/mesh-visualization'
import { canonicalizeRepoMeshStatus, summarizeRepoMeshCanonicalNodeDebug } from '../../utils/repo-mesh-status'

type DetailSelection =
    | { kind: 'node'; nodeId: string }
    | { kind: 'session'; nodeId: string; sessionId: string }
    | { kind: 'queue'; taskId: string }

interface MeshObservabilitySurfaceProps {
    status: RepoMeshStatus
    emptyMessage?: string
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}

type SessionListEntry = {
    nodeId: string
    machineLabel: string
    workspace: string
    branch: string | null
    nodeHealth: string
    session: MeshGraphSessionDetail
}

type GitHistoryState = {
    loading: boolean
    error: string | null
    entries: GitLogEntry[]
}

type HealPreviewState = {
    phase: 'dry_run' | 'execute'
    code?: string
    error?: string | null
    executed?: boolean
}

const EMPTY_LEDGER_SUMMARY = { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 }

const MeshGraphThemeContext = createContext(getMeshGraphTheme('dark'))

function Badge({ label, tone = 'default' }: { label: string; tone?: 'default' | 'good' | 'warn' | 'danger' | 'info' }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${meshTheme.badge(tone)}`}>{label}</span>
}

function Row({ label, value }: { label: string; value: ReactNode }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return (
        <div className={meshTheme.rowClass}>
            <span className={meshTheme.rowLabelClass}>{label}</span>
            <span className={meshTheme.rowValueClass}>{value}</span>
        </div>
    )
}

function healthTone(status: string): 'default' | 'good' | 'warn' | 'danger' | 'info' {
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

function sessionTone(state: string | null | undefined): 'default' | 'good' | 'warn' | 'danger' | 'info' {
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

function sessionStatusLabel(session: MeshGraphSessionDetail): string {
    const raw = (session.chatStatus || session.state || session.lifecycle || '').trim()
    if (!raw) return 'unknown'
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized.includes('approval')) return 'awaiting approval'
    if (normalized.includes('generating') || normalized.includes('running') || normalized.includes('busy')) return 'generating'
    if (normalized.includes('idle') || normalized.includes('ready') || normalized.includes('waiting_input')) return 'idle'
    return normalized.replace(/_/g, ' ')
}

function sessionRoleLabel(session: MeshGraphSessionDetail): string {
    if (session.isSelfCoordinator) return 'coordinator'
    const role = typeof session.role === 'string' ? session.role.trim() : ''
    return role || 'worker'
}

function sessionStartedAt(session: MeshGraphSessionDetail): string | null {
    return session.startedAt || session.createdAt || null
}

function sessionElapsedLabel(session: MeshGraphSessionDetail): string {
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

function shortSessionId(sessionId: string): string {
    if (sessionId.length <= 18) return sessionId
    return `${sessionId.slice(0, 10)}...${sessionId.slice(-4)}`
}

function connectionTone(connection: RepoMeshNodeStatus['connection'] | null | undefined): 'default' | 'good' | 'warn' | 'danger' | 'info' {
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

function connectionLabel(connection: RepoMeshNodeStatus['connection'] | null | undefined): string {
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

function collectSessionEntries(status: RepoMeshStatus): SessionListEntry[] {
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

function shortCommit(commit: string | null | undefined): string | null {
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

function extractGitLogEntries(response: any): GitLogEntry[] {
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

function describeConnection(node: RepoMeshNodeStatus): string {
    if (node.gitProbePending && (!node.connection || node.connection.state === 'unknown')) return 'mesh pending'
    return connectionLabel(node.connection)
}

function describeGraphNodeSource(node: MeshGraphNode): string {
    const source = node.source as { kind?: string; connection?: RepoMeshNodeStatus['connection'] } | null | undefined
    if (source?.kind) return source.kind
    return source?.connection?.source ?? 'mesh_status'
}

function edgeTypeLabel(edge: MeshGraphEdge): string {
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

function edgeDirectionLabel(edge: MeshGraphEdge): string {
    return edge.direction === 'directed' ? 'directed' : 'undirected'
}

export function resolveSelectedGraphNodeForDetail(graph: MeshGraphData, selectedNodeId: string | null | undefined): MeshGraphNode | null {
    if (!selectedNodeId) return null
    return graph.nodes.find(node => node.id === selectedNodeId) ?? null
}

function getRepoMeshStatusGraphFingerprint(status: RepoMeshStatus): string {
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

export default function MeshObservabilitySurface({
    status,
    emptyMessage = 'No live mesh graph is available for this coordinator yet.',
    daemonId = null,
    sendDaemonCommand = null,
}: MeshObservabilitySurfaceProps) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const canonicalStatus = useMemo(() => canonicalizeRepoMeshStatus(status), [status])
    const statusGraphFingerprint = useMemo(() => getRepoMeshStatusGraphFingerprint(canonicalStatus), [canonicalStatus])
    const canonicalGraph = useMemo(() => buildMeshGraph(canonicalStatus), [statusGraphFingerprint]) as MeshGraphData
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
    const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
    const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null)
    const [gitHistoryByWorkspace, setGitHistoryByWorkspace] = useState<Record<string, GitHistoryState>>({})
    const [healPreview, setHealPreview] = useState<HealPreviewState | null>(null)
    const [healingNodeId, setHealingNodeId] = useState<string | null>(null)

    const nodeStatusById = useMemo(() => new Map(canonicalStatus.nodes.map(node => [node.nodeId, node])), [canonicalStatus.nodes])
    const graphNodeById = useMemo(() => new Map(canonicalGraph.nodes.map(node => [node.id, node])), [canonicalGraph.nodes])
    const queueSummary = canonicalStatus.queue?.summary ?? null
    const ledgerSummary = canonicalStatus.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const sessionEntries = useMemo(() => collectSessionEntries(canonicalStatus), [canonicalStatus])
    const stateCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const entry of sessionEntries) {
            const label = sessionStatusLabel(entry.session)
            counts.set(label, (counts.get(label) ?? 0) + 1)
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])
    }, [sessionEntries])
    useEffect(() => {
        if (!selectedNodeId) return
        if (graphNodeById.has(selectedNodeId)) return
        setSelectedNodeId(null)
        setDetailSelection(current => {
            if (!current) return null
            if ('nodeId' in current && current.nodeId === selectedNodeId) return null
            return current
        })
    }, [graphNodeById, selectedNodeId])

    const selectedNodeStatus = selectedNodeId ? nodeStatusById.get(selectedNodeId) ?? null : null
    const selectedGraphNode = resolveSelectedGraphNodeForDetail(canonicalGraph, selectedNodeId)
    const hoveredGraphNode = resolveSelectedGraphNodeForDetail(canonicalGraph, hoveredNodeId)
    const hoveredGraphEdge = hoveredEdgeId
        ? canonicalGraph.edges.find(edge => edge.id === hoveredEdgeId) ?? null
        : null
    const hoveredEdgeSource = hoveredGraphEdge
        ? canonicalGraph.nodes.find(node => node.id === hoveredGraphEdge.source) ?? null
        : null
    const hoveredEdgeTarget = hoveredGraphEdge
        ? canonicalGraph.nodes.find(node => node.id === hoveredGraphEdge.target) ?? null
        : null

    useEffect(() => {
        if (!selectedNodeId) return
        try {
            console.info('[RepoMeshGraphDebug]', {
                event: 'selected_canonical_node',
                meshId: canonicalStatus.meshId,
                selectedNodeId,
                canonicalNode: summarizeRepoMeshCanonicalNodeDebug(selectedNodeStatus),
                graphNode: selectedGraphNode ? {
                    id: selectedGraphNode.id,
                    branch: selectedGraphNode.branch,
                    upstream: selectedGraphNode.upstream,
                    headCommit: selectedGraphNode.submoduleCommit,
                    submoduleCount: selectedNodeStatus?.git?.submodules?.length ?? 0,
                    snapshotCompleteness: selectedGraphNode.snapshotCompleteness,
                    snapshotWarnings: selectedGraphNode.snapshotWarnings,
                    branchConvergence: selectedGraphNode.branchConvergence?.status ?? null,
                } : null,
            })
        } catch {
            // Debug logging must never affect rendering.
        }
    }, [canonicalStatus.meshId, selectedGraphNode, selectedNodeId, selectedNodeStatus])
    const selectedSessionEntry = detailSelection?.kind === 'session'
        ? sessionEntries.find(entry => entry.nodeId === detailSelection.nodeId && entry.session.sessionId === detailSelection.sessionId) ?? null
        : null
    const selectedNodeSessionEntries = useMemo(
        () => sessionEntries.filter(entry => entry.nodeId === selectedNodeId),
        [selectedNodeId, sessionEntries],
    )
    const selectedGitRequest = resolveGitLogRequest({
        coordinatorDaemonId: daemonId,
        selectedNodeStatus,
        selectedSessionEntry,
        selectedGraphNode,
    })
    const selectedGitWorkspace = selectedGitRequest?.workspace ?? null
    const selectedGitHistory = selectedGitWorkspace ? gitHistoryByWorkspace[selectedGitWorkspace] ?? null : null
    const selectedHeadSummary = summarizeSelectedHead(selectedNodeStatus, selectedGitHistory?.entries ?? [])
    const selectedHealDaemonId = selectedGraphNode?.daemonId ?? selectedNodeStatus?.daemonId ?? daemonId ?? null
    const canHealSelectedNode = !!(
        selectedGraphNode
        && sendDaemonCommand
        && selectedHealDaemonId
        && selectedGraphNode.type !== 'submoduleNode'
        && selectedGraphNode.behind > 0
        && selectedGraphNode.ahead === 0
        && selectedGraphNode.dirtyFiles === 0
        && !selectedGraphNode.dirty
        && !selectedGraphNode.hasConflicts
        && selectedGraphNode.upstreamStatus === 'fresh'
    )

    const closeGraphDetail = useCallback(() => {
        setSelectedNodeId(null)
        setDetailSelection(null)
        setHealPreview(null)
    }, [])

    useEffect(() => {
        setHealPreview(null)
    }, [selectedNodeId])

    const handleHealSelectedNode = useCallback(async () => {
        if (!selectedGraphNode || !selectedHealDaemonId || !sendDaemonCommand || !canHealSelectedNode) return
        setHealingNodeId(selectedGraphNode.id)
        setHealPreview(null)
        try {
            const dryRun = await sendDaemonCommand(selectedHealDaemonId, 'fast_forward_mesh_node', {
                meshId: canonicalStatus.meshId,
                nodeId: selectedGraphNode.id,
                dryRun: true,
                execute: false,
            })
            setHealPreview({
                phase: 'dry_run',
                code: typeof dryRun?.code === 'string' ? dryRun.code : undefined,
                error: typeof dryRun?.operationError === 'string' ? dryRun.operationError : null,
                executed: dryRun?.executed === true,
            })
            if (!dryRun?.success || dryRun.code !== 'fast_forward_available') return
            const ok = window.confirm(`Apply fast-forward for ${selectedGraphNode.label}?`)
            if (!ok) return
            const executed = await sendDaemonCommand(selectedHealDaemonId, 'fast_forward_mesh_node', {
                meshId: canonicalStatus.meshId,
                nodeId: selectedGraphNode.id,
                dryRun: false,
                execute: true,
            })
            setHealPreview({
                phase: 'execute',
                code: typeof executed?.code === 'string' ? executed.code : undefined,
                error: typeof executed?.operationError === 'string' ? executed.operationError : null,
                executed: executed?.executed === true,
            })
        } catch (error) {
            setHealPreview({
                phase: 'dry_run',
                error: error instanceof Error ? error.message : 'fast-forward failed',
            })
        } finally {
            setHealingNodeId(null)
        }
    }, [canHealSelectedNode, canonicalStatus.meshId, selectedGraphNode, selectedHealDaemonId, sendDaemonCommand])

    useEffect(() => {
        if (!selectedGraphNode) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeGraphDetail()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [closeGraphDetail, selectedGraphNode])

    useEffect(() => {
        if (!selectedGitRequest || !sendDaemonCommand) return
        const { daemonId: targetDaemonId, workspace } = selectedGitRequest
        const existing = gitHistoryByWorkspace[workspace]
        if (existing?.loading || (existing && (existing.entries.length > 0 || existing.error))) return

        let cancelled = false
        setGitHistoryByWorkspace(current => ({
            ...current,
            [workspace]: {
                loading: true,
                error: null,
                entries: current[workspace]?.entries ?? [],
            },
        }))

        void sendDaemonCommand(targetDaemonId, 'git_log', { workspace, limit: 5 })
            .then(response => {
                if (cancelled) return
                setGitHistoryByWorkspace(current => ({
                    ...current,
                    [workspace]: {
                        loading: false,
                        error: null,
                        entries: extractGitLogEntries(response),
                    },
                }))
            })
            .catch(error => {
                if (cancelled) return
                setGitHistoryByWorkspace(current => ({
                    ...current,
                    [workspace]: {
                        loading: false,
                        error: error instanceof Error ? error.message : 'git_log failed',
                        entries: [],
                    },
                }))
            })

        return () => {
            cancelled = true
        }
    }, [gitHistoryByWorkspace, selectedGitRequest, sendDaemonCommand])

    const statusWarnings = [
        ...(canonicalGraph.warnings ?? []),
        ...(canonicalStatus.nodes.filter(node => node.machineStatus && node.machineStatus !== 'online').map(node => `${node.machineLabel}: ${node.machineStatus}`)),
    ]
    const hasSnapshotGaps = canonicalGraph.stats.incompleteSnapshotNodes > 0
    const headlineLabel = canonicalGraph.stats.followUpNodes > 0
        ? `${canonicalGraph.stats.followUpNodes} need follow-up`
        : hasSnapshotGaps
            ? 'mesh visibility incomplete'
            : 'mesh converged'
    const headlineTone = canonicalGraph.stats.followUpNodes > 0 ? 'danger' : hasSnapshotGaps ? 'warn' : 'good'

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                <div className={`${meshTheme.cardClass} relative flex min-h-0 flex-1 flex-col rounded-[28px] p-3 sm:p-4`} style={{ minHeight: 420 }}>
                    <div className={`absolute inset-x-4 top-4 z-30 flex max-h-[42dvh] flex-wrap items-start justify-between gap-3 overflow-y-auto rounded-2xl px-3.5 py-3 backdrop-blur-xl sm:static sm:mb-3 sm:max-h-none sm:overflow-visible sm:backdrop-blur-none ${meshTheme.isDark ? 'border border-white/10 bg-slate-950/85 sm:bg-slate-950/45' : 'border border-slate-200 bg-white/95 shadow-lg shadow-slate-900/10 sm:bg-white/95 sm:shadow-sm'}`}>
                        <div className={`flex min-w-0 flex-1 flex-wrap gap-2 text-xs ${meshTheme.textSecondary}`}>
                            <Badge
                                label={headlineLabel}
                                tone={headlineTone}
                            />
                            {canonicalGraph.stats.blockedReviewNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.blockedReviewNodes} blocked review`} tone="danger" />
                            )}
                            {canonicalGraph.stats.notMergeableNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.notMergeableNodes} not mergeable`} tone="danger" />
                            )}
                            {canonicalGraph.stats.mergeReadyNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.mergeReadyNodes} need merge`} tone="warn" />
                            )}
                            {canonicalGraph.stats.cleanupCandidateNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.cleanupCandidateNodes} refine/cleanup`} tone="info" />
                            )}
                            {canonicalGraph.stats.offlineNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.offlineNodes} offline`} tone="danger" />
                            )}
                            {canonicalGraph.stats.incompleteSnapshotNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.incompleteSnapshotNodes} incomplete peer snapshot`} tone="warn" />
                            )}
                            {canonicalGraph.stats.missingGitSnapshotNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.missingGitSnapshotNodes} no git snapshot`} tone="warn" />
                            )}
                            {canonicalGraph.stats.missingSubmoduleSnapshotNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.missingSubmoduleSnapshotNodes} missing submodule visibility`} tone="warn" />
                            )}
                            {canonicalGraph.stats.staleGitSnapshotNodes > 0 && (
                                <Badge label={`${canonicalGraph.stats.staleGitSnapshotNodes} stale peer snapshot`} tone="warn" />
                            )}
                            {(queueSummary?.active ?? 0) > 0 && (
                                <Badge label={`${queueSummary?.active ?? 0} active queue`} tone="info" />
                            )}
                            <Badge label={`${canonicalGraph.stats.totalNodes} nodes`} tone="default" />
                            {canonicalGraph.stats.totalActiveSessions > 0 && (
                                <Badge label={`${canonicalGraph.stats.totalActiveSessions} attached chats`} tone="info" />
                            )}
                        </div>
                        <details className={`max-w-full rounded-xl px-3 py-2 text-xs ${meshTheme.isDark ? 'border border-white/10 bg-white/[0.03] text-slate-300' : 'border border-slate-200 bg-slate-50 text-slate-600'}`}>
                            <summary className={`cursor-pointer list-none font-medium ${meshTheme.textSecondary} [&::-webkit-details-marker]:hidden`}>
                                Legend & secondary details
                            </summary>
                            <div className="mt-3 flex flex-col gap-3">
                                <div className="flex flex-wrap gap-2">
                                    <Badge label={`${canonicalGraph.stats.dirtyNodes} dirty`} tone={canonicalGraph.stats.dirtyNodes > 0 ? 'warn' : 'good'} />
                                    <Badge label={`${canonicalGraph.stats.orphanNodes} orphan`} tone={canonicalGraph.stats.orphanNodes > 0 ? 'warn' : 'good'} />
                                    <Badge label={`${ledgerSummary.recentFailures} recent failures`} tone={ledgerSummary.recentFailures > 0 ? 'danger' : 'good'} />
                                    {stateCounts.length === 0 ? (
                                        <Badge label="no session metadata" />
                                    ) : stateCounts.slice(0, 2).map(([label, count]) => (
                                        <Badge key={label} label={`${count} ${label}`} tone={sessionTone(label)} />
                                    ))}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Badge label="Anchor = default branch" tone="info" />
                                    <Badge label="Peer link = same-branch worktree" tone="default" />
                                    <Badge label="Submodule link = child checkout" tone="warn" />
                                </div>
                                {statusWarnings.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {statusWarnings.map(warning => (
                                            <span key={warning} className={meshTheme.isDark ? 'rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-100' : 'rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700'}>{warning}</span>
                                        ))}
                                    </div>
                                )}
                                <div className={`text-xs ${meshTheme.textMuted}`}>
                                    Hover nodes or edges for a quick preview. Click a node when you want pinned drill-down details.
                                </div>
                            </div>
                        </details>
                    </div>
                    {canonicalGraph.nodes.length > 0 ? (
                        <MeshGraphView
                            data={canonicalGraph}
                            selectedNodeId={selectedNodeId}
                            onNodeHoverChange={node => {
                                setHoveredNodeId(node?.id ?? null)
                                if (node) setHoveredEdgeId(null)
                            }}
                            onEdgeHoverChange={edge => {
                                setHoveredEdgeId(edge?.id ?? null)
                                if (edge) setHoveredNodeId(null)
                            }}
                            onNodeClick={node => {
                                const shouldCollapse = detailSelection?.kind === 'node' && selectedNodeId === node.id
                                if (shouldCollapse) {
                                    setSelectedNodeId(null)
                                    setDetailSelection(null)
                                    return
                                }
                                setSelectedNodeId(node.id)
                                setDetailSelection({ kind: 'node', nodeId: node.id })
                            }}
                        />
                    ) : (
                        <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-slate-400">{emptyMessage}</div>
                    )}
                    {!selectedGraphNode && hoveredGraphNode && (
                        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center p-2 sm:inset-x-auto sm:right-5 sm:top-24 sm:bottom-auto sm:justify-end">
                            <section
                                aria-label="Hovered node preview"
                                className={meshTheme.isDark
                                    ? 'w-full max-w-[min(24rem,calc(100vw-2.5rem))] rounded-2xl border border-white/12 bg-slate-950/94 p-4 shadow-2xl shadow-black/35 backdrop-blur-xl'
                                    : 'w-full max-w-[min(24rem,calc(100vw-2.5rem))] rounded-2xl border border-slate-200 bg-white/96 p-4 shadow-2xl shadow-slate-900/12 backdrop-blur-xl'}
                            >
                                <div className="mb-3 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{hoveredGraphNode.label}</div>
                                        <div className={`mt-1 font-mono text-[11px] ${meshTheme.textMuted}`}>{hoveredGraphNode.id.slice(0, 16)}</div>
                                    </div>
                                    <Badge label="hover preview" tone="info" />
                                </div>
                                <div className="mb-3 flex flex-wrap gap-2">
                                    <Badge label={hoveredGraphNode.health} tone={healthTone(hoveredGraphNode.health)} />
                                    {hoveredGraphNode.branch && <Badge label={hoveredGraphNode.branch} tone="default" />}
                                    {hoveredGraphNode.ahead > 0 && <Badge label={`ahead ${hoveredGraphNode.ahead}`} tone="warn" />}
                                    {hoveredGraphNode.behind > 0 && <Badge label={`behind ${hoveredGraphNode.behind}`} tone="warn" />}
                                    {hoveredGraphNode.dirtyFiles > 0 && <Badge label={`${hoveredGraphNode.dirtyFiles} dirty`} tone="warn" />}
                                    {hoveredGraphNode.activeSessionCount > 0 && <Badge label={`${hoveredGraphNode.activeSessionCount} sessions`} tone="info" />}
                                </div>
                                <div className="grid gap-2 text-xs sm:grid-cols-2">
                                    <Row label="Machine" value={hoveredGraphNode.machineLabel ?? 'not reported'} />
                                    <Row label="Locality" value={hoveredGraphNode.locality} />
                                    <Row label="Workspace" value={hoveredGraphNode.workspace} />
                                    <Row label="Upstream" value={hoveredGraphNode.upstream ?? 'none'} />
                                    <Row label="Dirty/ahead/behind" value={`${hoveredGraphNode.dirtyFiles} dirty · ↑${hoveredGraphNode.ahead}/↓${hoveredGraphNode.behind}`} />
                                    <Row label="Source" value={describeGraphNodeSource(hoveredGraphNode)} />
                                </div>
                            </section>
                        </div>
                    )}
                    {!selectedGraphNode && !hoveredGraphNode && hoveredGraphEdge && (
                        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center p-2 sm:inset-x-auto sm:right-5 sm:top-24 sm:bottom-auto sm:justify-end">
                            <section
                                aria-label="Hovered edge preview"
                                className={meshTheme.isDark
                                    ? 'w-full max-w-[min(22rem,calc(100vw-2.5rem))] rounded-2xl border border-white/12 bg-slate-950/94 p-4 shadow-2xl shadow-black/35 backdrop-blur-xl'
                                    : 'w-full max-w-[min(22rem,calc(100vw-2.5rem))] rounded-2xl border border-slate-200 bg-white/96 p-4 shadow-2xl shadow-slate-900/12 backdrop-blur-xl'}
                            >
                                <div className="mb-3 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{hoveredGraphEdge.label || edgeTypeLabel(hoveredGraphEdge)}</div>
                                        <div className={`mt-1 text-[11px] ${meshTheme.textMuted}`}>{hoveredGraphEdge.id}</div>
                                    </div>
                                    <Badge label="hover preview" tone="info" />
                                </div>
                                <div className="mb-3 flex flex-wrap gap-2">
                                    <Badge label={edgeTypeLabel(hoveredGraphEdge)} tone="default" />
                                    <Badge label={edgeDirectionLabel(hoveredGraphEdge)} tone="info" />
                                </div>
                                <div className="grid gap-2 text-xs">
                                    <Row label="From" value={hoveredEdgeSource?.label ?? hoveredGraphEdge.source} />
                                    <Row label="To" value={hoveredEdgeTarget?.label ?? hoveredGraphEdge.target} />
                                    <Row label="Label" value={hoveredGraphEdge.label ?? 'none'} />
                                </div>
                            </section>
                        </div>
                    )}
                    {selectedGraphNode && detailSelection?.kind === 'node' && (
                        <div className="absolute inset-x-3 bottom-3 top-20 z-20 flex items-end justify-center p-2 sm:inset-5 sm:top-24 sm:items-start sm:justify-end" onClick={closeGraphDetail} role="presentation">
                            <section
                                role="dialog"
                                aria-modal="false"
                                aria-label="Selected node"
                                className={meshTheme.isDark
                                    ? 'max-h-[min(72vh,540px)] w-full max-w-[min(28rem,calc(100vw-2.5rem))] overflow-y-auto rounded-2xl border border-white/12 bg-slate-950/96 p-4 shadow-2xl shadow-black/40 backdrop-blur-xl'
                                    : 'max-h-[min(72vh,540px)] w-full max-w-[min(28rem,calc(100vw-2.5rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white/96 p-4 shadow-2xl shadow-slate-900/15 backdrop-blur-xl'}
                                onClick={event => event.stopPropagation()}
                            >
                                <div className="mb-3 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{selectedGraphNode.label}</div>
                                        <div className={`mt-1 font-mono text-[11px] ${meshTheme.textMuted}`}>{selectedGraphNode.id.slice(0, 16)}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {selectedGraphNode.behind > 0 && (
                                            <button
                                                type="button"
                                                onClick={() => { void handleHealSelectedNode() }}
                                                disabled={!canHealSelectedNode || healingNodeId === selectedGraphNode.id}
                                                className={meshTheme.isDark ? 'rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-45' : 'rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-45'}
                                            >
                                                {healingNodeId === selectedGraphNode.id ? 'Checking' : 'Heal'}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={closeGraphDetail}
                                            className={meshTheme.isDark ? 'rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/[0.08]' : 'rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50'}
                                        >
                                            Close
                                        </button>
                                    </div>
                                </div>
                                <div className="mb-3 flex flex-wrap gap-2">
                                    <Badge label={selectedNodeStatus?.health ?? selectedGraphNode.health} tone={healthTone(selectedNodeStatus?.health ?? selectedGraphNode.health)} />
                                    {selectedGraphNode.branch && <Badge label={selectedGraphNode.branch} tone="default" />}
                                    {selectedGraphNode.ahead > 0 && <Badge label={`ahead ${selectedGraphNode.ahead}`} tone="warn" />}
                                    {selectedGraphNode.behind > 0 && <Badge label={`behind ${selectedGraphNode.behind}`} tone="warn" />}
                                    {selectedGraphNode.dirtyFiles > 0 && <Badge label={`${selectedGraphNode.dirtyFiles} dirty`} tone="warn" />}
                                    {selectedNodeStatus?.connection && <Badge label={describeConnection(selectedNodeStatus)} tone={connectionTone(selectedNodeStatus.connection)} />}
                                    {selectedNodeSessionEntries.length > 0 && <Badge label={`${selectedNodeSessionEntries.length} sessions`} tone="info" />}
                                </div>
                                <div className="grid gap-2 text-xs sm:grid-cols-2">
                                    <Row label="Machine" value={selectedGraphNode.machineLabel ?? 'not reported'} />
                                    <Row label="Locality" value={selectedGraphNode.locality} />
                                    <Row label="Machine id" value={selectedGraphNode.machineId ?? selectedNodeStatus?.machineId ?? 'not reported'} />
                                    <Row label="Daemon id" value={selectedGraphNode.daemonId ?? selectedNodeStatus?.daemonId ?? 'not reported'} />
                                    <Row label="Workspace" value={selectedNodeStatus?.workspace ?? selectedGraphNode.workspace} />
                                    <Row label="Branch" value={selectedGraphNode.branch ?? 'unknown'} />
                                    <Row label="HEAD" value={selectedHeadSummary ?? (selectedNodeStatus?.gitProbePending ? 'Pending live git probe' : 'not reported')} />
                                    <Row label="Upstream" value={selectedGraphNode.upstream ?? 'none'} />
                                    <Row label="Dirty/ahead/behind" value={`${selectedGraphNode.dirtyFiles} dirty · ↑${selectedGraphNode.ahead}/↓${selectedGraphNode.behind}`} />
                                    <Row label="Source" value={String(selectedNodeStatus?.connection?.source ?? describeGraphNodeSource(selectedGraphNode))} />
                                    <Row label="Transport" value={selectedNodeStatus?.connection?.transport ?? 'unknown'} />
                                    <Row label="Sessions" value={selectedNodeSessionEntries.length > 0 ? selectedNodeSessionEntries.map(entry => sessionStatusLabel(entry.session)).join(', ') : 'none active'} />
                                </div>
                                {selectedNodeSessionEntries.length > 0 && (
                                    <div className="mt-3">
                                        <div className={`mb-1.5 text-[10px] uppercase tracking-wide ${meshTheme.textMuted}`}>Active Sessions</div>
                                        <div className="flex flex-col gap-1.5">
                                            {selectedNodeSessionEntries.map(entry => (
                                                <div key={entry.session.sessionId} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${meshTheme.isDark ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-slate-50/80'}`}>
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className={`min-w-0 truncate font-mono select-text ${meshTheme.textMuted}`} title={entry.session.sessionId}>{shortSessionId(entry.session.sessionId)}</span>
                                                        <Badge label={sessionStatusLabel(entry.session)} tone={sessionTone(sessionStatusLabel(entry.session))} />
                                                    </div>
                                                    <div className={`mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 ${meshTheme.textMuted}`}>
                                                        <span className="truncate">{entry.session.providerType || 'provider unknown'}</span>
                                                        <span>{sessionRoleLabel(entry.session)}</span>
                                                        <span>{sessionElapsedLabel(entry.session)}</span>
                                                    </div>
                                                    {entry.session.statusNote && (
                                                        <div className={`mt-1 text-[10px] leading-4 ${meshTheme.textMuted}`}>
                                                            {entry.session.statusNote}
                                                        </div>
                                                    )}
                                                    <div className={`mt-0.5 truncate ${meshTheme.textMuted}`} title={entry.session.workspace || entry.workspace}>
                                                        {(entry.session.workspace || entry.workspace).slice(0, 42)}{entry.branch ? ` · ${entry.branch}` : ''}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div className="mt-3">
                                    <div className={`mb-1.5 text-[10px] uppercase tracking-wide ${meshTheme.textMuted}`}>Ledger (mesh-wide)</div>
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <Row label="Completed" value={String(ledgerSummary.taskCompleted)} />
                                        <Row label="Failed" value={<span className={ledgerSummary.taskFailed > 0 ? (meshTheme.isDark ? 'text-rose-300' : 'text-rose-600') : ''}>{ledgerSummary.taskFailed}</span>} />
                                        <Row label="Launched" value={String(ledgerSummary.sessionLaunched)} />
                                        <Row label="Recent failures" value={<span className={ledgerSummary.recentFailures > 0 ? (meshTheme.isDark ? 'text-amber-300' : 'text-amber-600') : ''}>{ledgerSummary.recentFailures}</span>} />
                                    </div>
                                </div>
                                {(() => {
                                    const queueTasks = (canonicalStatus.queue as any)?.tasks ?? (canonicalStatus.queue as any)?.items ?? null
                                    if (!Array.isArray(queueTasks) || queueTasks.length === 0) return null
                                    const nodeTasks = (queueTasks as RepoMeshQueueTask[]).filter(task => getQueueTaskNodeTarget(task) === selectedNodeId).slice(0, 3)
                                    if (nodeTasks.length === 0) return null
                                    return (
                                        <div className="mt-3">
                                            <div className={`mb-1.5 text-[10px] uppercase tracking-wide ${meshTheme.textMuted}`}>Queue tasks</div>
                                            <div className="flex flex-col gap-1.5">
                                                {nodeTasks.map(task => (
                                                    <div key={task.id} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${meshTheme.isDark ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-slate-50/80'}`}>
                                                        <div className="flex items-center justify-between gap-2">
                                                            <span className={`font-mono ${meshTheme.textMuted}`}>{task.id.slice(0, 12)}</span>
                                                            <Badge label={task.status ?? 'unknown'} tone={sessionTone(task.status)} />
                                                        </div>
                                                        {task.message && (
                                                            <div className={`mt-0.5 truncate ${meshTheme.textMuted}`}>{task.message.slice(0, 48)}</div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )
                                })()}
                                {selectedGraphNode.snapshotWarnings.length > 0 && (
                                    <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100' : 'mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800'}>
                                        <div className="font-medium">Key warning</div>
                                        <div className="mt-1">{selectedGraphNode.snapshotWarnings[0]}</div>
                                    </div>
                                )}
                                {selectedGraphNode.branchConvergence?.nextStep && (
                                    <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-sky-400/20 bg-sky-500/10 p-3 text-xs text-sky-100' : 'mt-3 rounded-xl border border-sky-300 bg-sky-50 p-3 text-xs text-sky-800'}>
                                        <div className="font-medium">Follow-up</div>
                                        <div className="mt-1">{selectedGraphNode.branchConvergence.nextStep}</div>
                                    </div>
                                )}
                                {healPreview && (
                                    <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-xs text-emerald-100' : 'mt-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800'}>
                                        <div className="font-medium">{healPreview.phase === 'execute' ? 'Heal result' : 'Heal preview'}</div>
                                        <div className="mt-1">{healPreview.code ?? healPreview.error ?? 'No result code returned.'}</div>
                                    </div>
                                )}
                            </section>
                        </div>
                    )}
                </div>
            </div>
        </div>
        </MeshGraphThemeContext.Provider>
    )
}
