import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
    GitLogEntry,
    RepoMeshNodeStatus,
    RepoMeshQueueTask,
    RepoMeshSessionStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import MeshGraphView from './MeshGraphView'
import { getMeshGraphTheme } from './meshGraphTheme'
import type { MeshGraphData, MeshGraphNode } from './types'
import { buildMeshGraph } from '../../utils/mesh-visualization'
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
    session: RepoMeshSessionStatus
}

type GitHistoryState = {
    loading: boolean
    error: string | null
    entries: GitLogEntry[]
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
        const sessions = (node.activeSessionDetails && node.activeSessionDetails.length > 0)
            ? node.activeSessionDetails
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

export function resolveSelectedGraphNodeForDetail(graph: MeshGraphData, selectedNodeId: string | null | undefined): MeshGraphNode | null {
    if (!selectedNodeId) return null
    return graph.nodes.find(node => node.id === selectedNodeId) ?? null
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
    const canonicalGraph = useMemo(() => buildMeshGraph(canonicalStatus), [canonicalStatus]) as MeshGraphData
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
    const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null)
    const [gitHistoryByWorkspace, setGitHistoryByWorkspace] = useState<Record<string, GitHistoryState>>({})

    const nodeStatusById = useMemo(() => new Map(canonicalStatus.nodes.map(node => [node.nodeId, node])), [canonicalStatus.nodes])
    const graphNodeById = useMemo(() => new Map(canonicalGraph.nodes.map(node => [node.id, node])), [canonicalGraph.nodes])
    const queueSummary = canonicalStatus.queue?.summary ?? null
    const ledgerSummary = canonicalStatus.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const sessionEntries = useMemo(() => collectSessionEntries(canonicalStatus), [canonicalStatus])
    const stateCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const entry of sessionEntries) {
            const label = entry.session.state || entry.session.lifecycle || 'unknown'
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

    const closeGraphDetail = useCallback(() => {
        setSelectedNodeId(null)
        setDetailSelection(null)
    }, [])

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
        <div className="flex min-h-0 flex-col gap-4">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                <div className={`${meshTheme.cardClass} relative min-h-0 flex-1 rounded-[28px] p-3 sm:p-4`} style={{ minHeight: 420 }}>
                    <div className={`mb-3 flex flex-wrap items-start justify-between gap-3 rounded-2xl px-3.5 py-3 ${meshTheme.isDark ? 'border border-white/10 bg-slate-950/45' : 'border border-slate-200 bg-white/95 shadow-sm'}`}>
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
                                <Badge label={`${canonicalGraph.stats.totalActiveSessions} active sessions`} tone="info" />
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
                                    Click a node only when you want drill-down details. The graph itself now carries the convergence state.
                                </div>
                            </div>
                        </details>
                    </div>
                    {canonicalGraph.nodes.length > 0 ? (
                        <MeshGraphView
                            data={canonicalGraph}
                            selectedNodeId={selectedNodeId}
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
                    {selectedGraphNode && detailSelection?.kind === 'node' && (
                        <div className="absolute inset-3 z-20 flex items-center justify-center rounded-[24px] bg-slate-950/35 p-3 backdrop-blur-sm" onClick={closeGraphDetail} role="presentation">
                            <section
                                role="dialog"
                                aria-modal="false"
                                aria-label="Selected node"
                                className={meshTheme.isDark
                                    ? 'max-h-[min(78vh,520px)] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/12 bg-slate-950/95 p-4 shadow-2xl shadow-black/40'
                                    : 'max-h-[min(78vh,520px)] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-2xl shadow-slate-900/15'}
                                onClick={event => event.stopPropagation()}
                            >
                                <div className="mb-3 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{selectedGraphNode.label}</div>
                                        <div className={`mt-1 font-mono text-[11px] ${meshTheme.textMuted}`}>{selectedGraphNode.id.slice(0, 16)}</div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeGraphDetail}
                                        className={meshTheme.isDark ? 'rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-200 transition hover:bg-white/[0.08]' : 'rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50'}
                                    >
                                        Close
                                    </button>
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
                                    <Row label="Workspace" value={selectedNodeStatus?.workspace ?? selectedGraphNode.workspace} />
                                    <Row label="Branch" value={selectedGraphNode.branch ?? 'unknown'} />
                                    <Row label="HEAD" value={selectedHeadSummary ?? (selectedNodeStatus?.gitProbePending ? 'Pending live git probe' : 'not reported')} />
                                    <Row label="Upstream" value={selectedGraphNode.upstream ?? 'none'} />
                                    <Row label="Dirty/ahead/behind" value={`${selectedGraphNode.dirtyFiles} dirty · ↑${selectedGraphNode.ahead}/↓${selectedGraphNode.behind}`} />
                                    <Row label="Source" value={String(selectedNodeStatus?.connection?.source ?? describeGraphNodeSource(selectedGraphNode))} />
                                    <Row label="Transport" value={selectedNodeStatus?.connection?.transport ?? 'unknown'} />
                                    <Row label="Sessions" value={selectedNodeSessionEntries.length > 0 ? selectedNodeSessionEntries.map(entry => entry.session.state || entry.session.lifecycle || 'unknown').join(', ') : 'none active'} />
                                </div>
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
                            </section>
                        </div>
                    )}
                </div>
            </div>
        </div>
        </MeshGraphThemeContext.Provider>
    )
}
