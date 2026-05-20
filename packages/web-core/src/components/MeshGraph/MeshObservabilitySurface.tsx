import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
    GitLogEntry,
    RepoMeshLedgerEntryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueTask,
    RepoMeshSessionStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../hooks/useTheme'
import { getDashboardActiveTabHref } from '../../utils/dashboard-route-paths'
import MeshGraphView from './MeshGraphView'
import { getMeshGraphTheme } from './meshGraphTheme'
import type { MeshGraphData } from './types'

type DetailSelection =
    | { kind: 'node'; nodeId: string }
    | { kind: 'session'; nodeId: string; sessionId: string }
    | { kind: 'queue'; taskId: string }

interface MeshObservabilitySurfaceProps {
    graph: MeshGraphData
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

const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'assigned'])
const EMPTY_QUEUE_ACTIVE_COUNTS = { pending: 0, assigned: 0 }
const EMPTY_LEDGER_SUMMARY = { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 }

const MeshGraphThemeContext = createContext(getMeshGraphTheme('dark'))

function Badge({ label, tone = 'default' }: { label: string; tone?: 'default' | 'good' | 'warn' | 'danger' | 'info' }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${meshTheme.badge(tone)}`}>{label}</span>
}

function Card({ title, subtitle, children, className = '' }: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return (
        <section className={`${meshTheme.cardClass} ${className}`}>
            <div className={meshTheme.cardHeaderClass}>
                <div className={meshTheme.cardTitleClass}>{title}</div>
                {subtitle && <div className={meshTheme.cardSubtitleClass}>{subtitle}</div>}
            </div>
            <div className="px-4 py-3">{children}</div>
        </section>
    )
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

function ActionButton({
    label,
    onClick,
    tone = 'default',
}: {
    label: string
    onClick: () => void
    tone?: 'default' | 'info' | 'success'
}) {
    const meshTheme = useContext(MeshGraphThemeContext)
    return (
        <button
            type="button"
            onClick={onClick}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition ${meshTheme.actionButton(tone)}`}
        >
            {label}
        </button>
    )
}

function formatTimestamp(value: string | null | undefined): string | null {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString()
}

function formatCommitTimestamp(value: number | null | undefined): string | null {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleString()
}

function queueTone(status: string): 'default' | 'good' | 'warn' | 'danger' | 'info' {
    switch (status) {
        case 'completed':
            return 'good'
        case 'failed':
        case 'cancelled':
            return 'danger'
        case 'assigned':
            return 'info'
        case 'pending':
            return 'warn'
        default:
            return 'default'
    }
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

function formatYesNo(value: boolean | null | undefined): string {
    if (value === true) return 'yes'
    if (value === false) return 'no'
    return 'unknown'
}

function buildDashboardSessionHref(daemonId: string | null | undefined, sessionId: string | null | undefined): string | null {
    if (!sessionId) return null
    const params = new URLSearchParams()
    if (daemonId) params.set('daemonId', daemonId)
    params.set('targetSessionId', sessionId)
    return `/dashboard?${params.toString()}`
}

function summarizeNodeDrift(node: RepoMeshNodeStatus): string {
    if (node.gitProbePending) return 'Git probe pending'
    const git = node.git
    if (!git) return 'No git probe'
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

function describeBranchConvergenceStatus(status: string | null | undefined): string | null {
    switch (status) {
        case 'merged_to_main':
            return 'merged to default branch'
        case 'pushed_feature_branch_needs_merge':
            return 'feature branch still needs merge'
        case 'cleanup_candidate':
            return 'worktree still needs refine / cleanup'
        case 'blocked_review':
            return 'review blocked before convergence'
        case 'not_mergeable':
            return 'not mergeable yet'
        default:
            return null
    }
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

function describeQueueTask(task: RepoMeshQueueTask): string {
    const target = task.assignedNodeId || task.targetNodeId || 'unbound'
    const session = task.assignedSessionId || task.targetSessionId || 'no session'
    return `${target} · ${session}`
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

function describeProviders(node: RepoMeshNodeStatus): string {
    if ((node.providers ?? []).length > 0) return node.providers.join(', ')
    if ((node.providerPriority ?? []).length > 0) return 'not reported yet'
    return 'not reported yet'
}

function describeConnection(node: RepoMeshNodeStatus): string {
    if (node.gitProbePending && (!node.connection || node.connection.state === 'unknown')) return 'mesh pending'
    return connectionLabel(node.connection)
}

function describeTimestamp(value: string | undefined, pending: boolean): string {
    return formatTimestamp(value) ?? value ?? (pending ? 'pending live refresh' : 'not reported')
}

export default function MeshObservabilitySurface({
    graph,
    status,
    emptyMessage = 'No live mesh graph is available for this coordinator yet.',
    daemonId = null,
    sendDaemonCommand = null,
}: MeshObservabilitySurfaceProps) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const navigate = useNavigate()
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
    const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null)
    const [queueFilter, setQueueFilter] = useState<'active' | 'history' | 'all'>('active')
    const [gitHistoryByWorkspace, setGitHistoryByWorkspace] = useState<Record<string, GitHistoryState>>({})

    const nodeStatusById = useMemo(() => new Map(status.nodes.map(node => [node.nodeId, node])), [status.nodes])
    const graphNodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
    const queueTasks = status.queue?.tasks ?? []
    const queueSummary = status.queue?.summary ?? null
    const queueActiveCounts = queueSummary?.activeCounts ?? EMPTY_QUEUE_ACTIVE_COUNTS
    const ledgerSummary = status.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const sessionEntries = useMemo(() => collectSessionEntries(status), [status])
    const stateCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const entry of sessionEntries) {
            const label = entry.session.state || entry.session.lifecycle || 'unknown'
            counts.set(label, (counts.get(label) ?? 0) + 1)
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])
    }, [sessionEntries])
    const visibleQueueTasks = useMemo(() => {
        if (queueFilter === 'all') return queueTasks
        if (queueFilter === 'active') return queueTasks.filter(task => ACTIVE_QUEUE_STATUSES.has(task.status))
        return queueTasks.filter(task => !ACTIVE_QUEUE_STATUSES.has(task.status))
    }, [queueFilter, queueTasks])

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

    const selectedGraphNode = selectedNodeId ? graphNodeById.get(selectedNodeId) ?? null : null
    const selectedNodeStatus = selectedNodeId ? nodeStatusById.get(selectedNodeId) ?? null : null
    const selectedQueueTask = detailSelection?.kind === 'queue'
        ? queueTasks.find(task => task.id === detailSelection.taskId) ?? null
        : null
    const selectedSessionEntry = detailSelection?.kind === 'session'
        ? sessionEntries.find(entry => entry.nodeId === detailSelection.nodeId && entry.session.sessionId === detailSelection.sessionId) ?? null
        : null
    const selectedNodeSessionEntries = useMemo(
        () => sessionEntries.filter(entry => entry.nodeId === selectedNodeId),
        [selectedNodeId, sessionEntries],
    )
    const selectedNodeQueueTasks = useMemo(
        () => queueTasks.filter(task => getQueueTaskNodeTarget(task) === selectedNodeId),
        [queueTasks, selectedNodeId],
    )

    const selectedGitRequest = resolveGitLogRequest({
        coordinatorDaemonId: daemonId,
        selectedNodeStatus,
        selectedSessionEntry,
        selectedGraphNode,
    })
    const selectedGitWorkspace = selectedGitRequest?.workspace ?? null
    const selectedGitHistory = selectedGitWorkspace ? gitHistoryByWorkspace[selectedGitWorkspace] ?? null : null
    const selectedHeadSummary = selectedNodeStatus?.gitProbePending && !selectedGitHistory?.entries?.length
        ? 'Pending live git probe'
        : summarizeHead(selectedNodeStatus, selectedGitHistory?.entries ?? [])

    const openSessionChat = useCallback((sessionId: string | null | undefined) => {
        if (!sessionId) return
        navigate(getDashboardActiveTabHref(sessionId), {
            state: { openRemoteForTabKey: sessionId },
        })
    }, [navigate])

    const selectSessionDetail = useCallback((nodeId: string, sessionId: string) => {
        setSelectedNodeId(nodeId)
        setDetailSelection({ kind: 'session', nodeId, sessionId })
    }, [])

    const focusNodeDetail = useCallback((nodeId: string) => {
        setSelectedNodeId(nodeId)
        setDetailSelection({ kind: 'node', nodeId })
    }, [])

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
        ...(graph.warnings ?? []),
        ...(status.nodes.filter(node => node.machineStatus && node.machineStatus !== 'online').map(node => `${node.machineLabel}: ${node.machineStatus}`)),
    ]
    const hasSnapshotGaps = graph.stats.incompleteSnapshotNodes > 0
    const headlineLabel = graph.stats.followUpNodes > 0
        ? `${graph.stats.followUpNodes} need follow-up`
        : hasSnapshotGaps
            ? 'mesh visibility incomplete'
            : 'mesh converged'
    const headlineTone = graph.stats.followUpNodes > 0 ? 'danger' : hasSnapshotGaps ? 'warn' : 'good'
    const hasDetailPane = Boolean(selectedQueueTask || selectedSessionEntry || selectedGraphNode)

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <div className="flex min-h-0 flex-col gap-4 xl:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                <div className={`${meshTheme.cardClass} min-h-0 flex-1 rounded-[28px] p-3 sm:p-4`} style={{ minHeight: 420 }}>
                    <div className={`mb-3 flex flex-wrap items-start justify-between gap-3 rounded-2xl px-3.5 py-3 ${meshTheme.isDark ? 'border border-white/10 bg-slate-950/45' : 'border border-slate-200 bg-white/95 shadow-sm'}`}>
                        <div className={`flex min-w-0 flex-1 flex-wrap gap-2 text-xs ${meshTheme.textSecondary}`}>
                            <Badge
                                label={headlineLabel}
                                tone={headlineTone}
                            />
                            {graph.stats.blockedReviewNodes > 0 && (
                                <Badge label={`${graph.stats.blockedReviewNodes} blocked review`} tone="danger" />
                            )}
                            {graph.stats.notMergeableNodes > 0 && (
                                <Badge label={`${graph.stats.notMergeableNodes} not mergeable`} tone="danger" />
                            )}
                            {graph.stats.mergeReadyNodes > 0 && (
                                <Badge label={`${graph.stats.mergeReadyNodes} need merge`} tone="warn" />
                            )}
                            {graph.stats.cleanupCandidateNodes > 0 && (
                                <Badge label={`${graph.stats.cleanupCandidateNodes} refine/cleanup`} tone="info" />
                            )}
                            {graph.stats.offlineNodes > 0 && (
                                <Badge label={`${graph.stats.offlineNodes} offline`} tone="danger" />
                            )}
                            {graph.stats.incompleteSnapshotNodes > 0 && (
                                <Badge label={`${graph.stats.incompleteSnapshotNodes} incomplete peer snapshot`} tone="warn" />
                            )}
                            {graph.stats.missingGitSnapshotNodes > 0 && (
                                <Badge label={`${graph.stats.missingGitSnapshotNodes} no git snapshot`} tone="warn" />
                            )}
                            {graph.stats.missingSubmoduleSnapshotNodes > 0 && (
                                <Badge label={`${graph.stats.missingSubmoduleSnapshotNodes} missing submodule visibility`} tone="warn" />
                            )}
                            {graph.stats.staleGitSnapshotNodes > 0 && (
                                <Badge label={`${graph.stats.staleGitSnapshotNodes} stale peer snapshot`} tone="warn" />
                            )}
                            {(queueSummary?.active ?? 0) > 0 && (
                                <Badge label={`${queueSummary?.active ?? 0} active queue`} tone="info" />
                            )}
                            <Badge label={`${graph.stats.totalNodes} nodes`} tone="default" />
                            {graph.stats.totalActiveSessions > 0 && (
                                <Badge label={`${graph.stats.totalActiveSessions} active sessions`} tone="info" />
                            )}
                        </div>
                        <details className={`max-w-full rounded-xl px-3 py-2 text-xs ${meshTheme.isDark ? 'border border-white/10 bg-white/[0.03] text-slate-300' : 'border border-slate-200 bg-slate-50 text-slate-600'}`}>
                            <summary className={`cursor-pointer list-none font-medium ${meshTheme.textSecondary} [&::-webkit-details-marker]:hidden`}>
                                Legend & secondary details
                            </summary>
                            <div className="mt-3 flex flex-col gap-3">
                                <div className="flex flex-wrap gap-2">
                                    <Badge label={`${graph.stats.dirtyNodes} dirty`} tone={graph.stats.dirtyNodes > 0 ? 'warn' : 'good'} />
                                    <Badge label={`${graph.stats.orphanNodes} orphan`} tone={graph.stats.orphanNodes > 0 ? 'warn' : 'good'} />
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
                    {graph.nodes.length > 0 ? (
                        <MeshGraphView
                            data={graph}
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
                </div>
            </div>

            {hasDetailPane && (
                <div className="flex w-full shrink-0 flex-col gap-4 xl:w-[420px]">
                <Card title="Selected detail" subtitle="Node, session, or queue item drill-down.">
                    <div className="flex flex-col gap-3">
                        {detailSelection?.kind === 'queue' && selectedQueueTask ? (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge label={selectedQueueTask.status} tone={queueTone(selectedQueueTask.status)} />
                                    <Badge label={selectedQueueTask.id.slice(0, 8)} tone="default" />
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {getQueueTaskNodeTarget(selectedQueueTask) && (
                                        <ActionButton label="View node" onClick={() => focusNodeDetail(getQueueTaskNodeTarget(selectedQueueTask) || '')} />
                                    )}
                                    {(() => {
                                        const sessionId = getQueueTaskSessionTarget(selectedQueueTask)
                                        if (!sessionId) return null
                                        const linkedEntry = sessionEntries.find(entry => entry.session.sessionId === sessionId) ?? null
                                        return (
                                            <>
                                                {linkedEntry && (
                                                    <ActionButton
                                                        label="View session"
                                                        onClick={() => selectSessionDetail(linkedEntry.nodeId, linkedEntry.session.sessionId)}
                                                    />
                                                )}
                                                <ActionButton label="Open chat" tone="info" onClick={() => openSessionChat(sessionId)} />
                                            </>
                                        )
                                    })()}
                                </div>
                                <Row label="Message" value={selectedQueueTask.message} />
                                <Row label="Routing" value={describeQueueTask(selectedQueueTask)} />
                                <Row label="Created" value={formatTimestamp(selectedQueueTask.createdAt) ?? 'unknown'} />
                                <Row label="Updated" value={formatTimestamp(selectedQueueTask.updatedAt) ?? 'unknown'} />
                                <Row label="Requeues" value={selectedQueueTask.requeueCount ?? 0} />
                                <Row label="Auto-launch" value={selectedQueueTask.autoLaunch ? `${selectedQueueTask.autoLaunch.status}${selectedQueueTask.autoLaunch.providerType ? ` · ${selectedQueueTask.autoLaunch.providerType}` : ''}` : 'none'} />
                                {(() => {
                                    const sessionId = selectedQueueTask.assignedSessionId || selectedQueueTask.targetSessionId || selectedQueueTask.autoLaunch?.sessionId || null
                                    const nodeId = selectedQueueTask.assignedNodeId || selectedQueueTask.targetNodeId || selectedQueueTask.autoLaunch?.nodeId || null
                                    const dashboardHref = buildDashboardSessionHref(nodeId ? nodeStatusById.get(nodeId)?.daemonId : null, sessionId)
                                    return dashboardHref ? (
                                        <a
                                            href={dashboardHref}
                                            className={meshTheme.isDark ? 'inline-flex w-fit items-center rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-100 transition hover:bg-sky-500/20' : 'inline-flex w-fit items-center rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-100'}
                                        >
                                            Open linked dashboard chat
                                        </a>
                                    ) : null
                                })()}
                                {selectedQueueTask.cancelReason && <Row label="Cancel reason" value={selectedQueueTask.cancelReason} />}
                                {selectedQueueTask.requeueReason && <Row label="Requeue reason" value={selectedQueueTask.requeueReason} />}
                            </>
                        ) : detailSelection?.kind === 'session' && selectedSessionEntry ? (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge label={selectedSessionEntry.session.state || selectedSessionEntry.session.lifecycle || 'unknown'} tone={sessionTone(selectedSessionEntry.session.state || selectedSessionEntry.session.lifecycle)} />
                                    {selectedSessionEntry.session.providerType && <Badge label={selectedSessionEntry.session.providerType} tone="info" />}
                                    {selectedSessionEntry.session.isCached && <Badge label="cached" tone="default" />}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <ActionButton label="View node" onClick={() => focusNodeDetail(selectedSessionEntry.nodeId)} />
                                    <ActionButton label="Open chat" tone="info" onClick={() => openSessionChat(selectedSessionEntry.session.sessionId)} />
                                </div>
                                <Row label="Session id" value={selectedSessionEntry.session.sessionId} />
                                <Row label="Node" value={selectedSessionEntry.machineLabel} />
                                <Row label="Workspace" value={selectedSessionEntry.workspace} />
                                <Row label="Branch" value={selectedSessionEntry.branch ?? 'unknown'} />
                                <Row label="Node health" value={selectedSessionEntry.nodeHealth} />
                                <Row label="Lifecycle" value={selectedSessionEntry.session.lifecycle ?? 'unknown'} />
                                {selectedSessionEntry.session.surfaceKind && <Row label="Surface" value={selectedSessionEntry.session.surfaceKind} />}
                                {selectedSessionEntry.session.recoveryState && <Row label="Recovery" value={selectedSessionEntry.session.recoveryState} />}
                                {selectedSessionEntry.session.lastActivityAt && <Row label="Last activity" value={formatTimestamp(selectedSessionEntry.session.lastActivityAt) ?? selectedSessionEntry.session.lastActivityAt} />}
                                {(() => {
                                    const dashboardHref = buildDashboardSessionHref(
                                        nodeStatusById.get(selectedSessionEntry.nodeId)?.daemonId,
                                        selectedSessionEntry.session.sessionId,
                                    )
                                    return dashboardHref ? (
                                        <a
                                            href={dashboardHref}
                                            className={meshTheme.isDark ? 'inline-flex w-fit items-center rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-100 transition hover:bg-sky-500/20' : 'inline-flex w-fit items-center rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 transition hover:bg-sky-100'}
                                        >
                                            Open dashboard chat
                                        </a>
                                    ) : null
                                })()}
                                <div className={meshTheme.isDark ? 'rounded-xl border border-white/10 bg-slate-950/40 p-3' : 'rounded-xl border border-slate-200 bg-slate-50 p-3'}>
                                    <div className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Git context</div>
                                    <div className={`flex flex-col gap-2 text-xs ${meshTheme.textSecondary}`}>
                                        <div>{selectedHeadSummary || 'HEAD subject not present in cached mesh_status.'}</div>
                                        {selectedGitHistory?.loading && <div className="text-slate-500">Loading recent commits…</div>}
                                        {selectedGitHistory?.error && <div className="text-amber-200">Recent history unavailable: {selectedGitHistory.error}</div>}
                                        {(selectedGitHistory?.entries ?? []).slice(0, 5).map(entry => (
                                            <div key={entry.commit} className={meshTheme.isDark ? 'rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2' : 'rounded-lg border border-slate-200 bg-white px-2.5 py-2'}>
                                                <div className={`font-medium ${meshTheme.textPrimary}`}>{shortCommit(entry.commit)} · {entry.message}</div>
                                                <div className="mt-1 text-[11px] text-slate-500">
                                                    {entry.authorName || 'unknown author'}
                                                    {formatCommitTimestamp(entry.committedAt) ? ` · ${formatCommitTimestamp(entry.committedAt)}` : ''}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </>
                        ) : selectedGraphNode ? (
                            <>
                                <div className={meshTheme.isDark ? 'rounded-xl border border-white/10 bg-slate-950/40 p-3' : 'rounded-xl border border-slate-200 bg-slate-50 p-3'}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{selectedGraphNode.label}</div>
                                            <div className={`mt-1 break-all text-xs ${meshTheme.textMuted}`}>{selectedNodeStatus?.workspace ?? selectedGraphNode.workspace}</div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSelectedNodeId(null)
                                                setDetailSelection(null)
                                            }}
                                            className={meshTheme.isDark ? 'rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-slate-300 transition hover:bg-white/[0.06] hover:text-white' : 'rounded-full border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-50 hover:text-slate-900'}
                                        >
                                            Close
                                        </button>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {selectedGraphNode.branch && <Badge label={selectedGraphNode.branch} tone="default" />}
                                        {selectedGraphNode.branchConvergence?.status && (
                                            <Badge
                                                label={selectedGraphNode.branchConvergence.status}
                                                tone={selectedGraphNode.branchConvergence.needsConvergence ? 'warn' : 'good'}
                                            />
                                        )}
                                        {selectedGraphNode.snapshotWarnings.length > 0 && (
                                            <Badge label={`snapshot ${selectedGraphNode.snapshotCompleteness}`} tone="warn" />
                                        )}
                                    </div>
                                    <div className="mt-3 flex flex-col gap-0.5">
                                        <Row label="Graph branch" value={selectedGraphNode.branch ?? 'unknown'} />
                                        <Row label="Graph upstream" value={selectedGraphNode.upstream ?? 'none'} />
                                        <Row label="Convergence" value={describeBranchConvergenceStatus(selectedGraphNode.branchConvergence?.status) ?? 'not classified'} />
                                    </div>
                                    {selectedGraphNode.snapshotWarnings.length > 0 && (
                                        <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100' : 'mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800'}>
                                            <div className="font-medium">Peer snapshot warning</div>
                                            <div className="mt-1">{selectedGraphNode.snapshotWarnings[0]}</div>
                                        </div>
                                    )}
                                    {selectedGraphNode.branchConvergence?.nextStep && (
                                        <div className={meshTheme.isDark ? 'mt-3 rounded-xl border border-sky-400/20 bg-sky-500/10 p-3 text-xs text-sky-100' : 'mt-3 rounded-xl border border-sky-300 bg-sky-50 p-3 text-xs text-sky-800'}>
                                            <div className="font-medium">Convergence follow-up</div>
                                            <div className="mt-1">{selectedGraphNode.branchConvergence.nextStep}</div>
                                        </div>
                                    )}
                                </div>
                                {selectedNodeStatus && (
                                    <div className={meshTheme.isDark ? 'rounded-xl border border-white/10 bg-slate-950/40 p-3' : 'rounded-xl border border-slate-200 bg-slate-50 p-3'}>
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <Badge label={selectedNodeStatus.health} tone={healthTone(selectedNodeStatus.health)} />
                                            {selectedNodeStatus.machineStatus && <Badge label={selectedNodeStatus.machineStatus} tone={selectedNodeStatus.machineStatus === 'online' ? 'good' : 'warn'} />}
                                            <Badge label={`launchReady ${formatYesNo(selectedNodeStatus.launchReady)}`} tone={selectedNodeStatus.launchReady ? 'good' : 'warn'} />
                                            <Badge label={describeConnection(selectedNodeStatus)} tone={connectionTone(selectedNodeStatus.connection)} />
                                            {selectedNodeStatus.worktreeBranch && <Badge label={selectedNodeStatus.worktreeBranch} tone="info" />}
                                        </div>
                                        <div className="flex flex-col gap-0.5">
                                            <Row label="Repo root" value={selectedNodeStatus.repoRoot ?? selectedNodeStatus.workspace} />
                                            <Row label="Provider(s)" value={describeProviders(selectedNodeStatus)} />
                                            <Row label="Provider priority" value={(selectedNodeStatus.providerPriority ?? []).join(', ') || 'not configured'} />
                                            <Row label="Drift" value={summarizeNodeDrift(selectedNodeStatus)} />
                                            <Row label="HEAD" value={selectedHeadSummary ?? (selectedNodeStatus.gitProbePending ? 'Pending live git probe' : 'Not available')} />
                                            <Row label="Daemon" value={selectedNodeStatus.daemonId ?? 'unknown'} />
                                            <Row label="Machine" value={selectedNodeStatus.machineId ?? selectedNodeStatus.machineLabel} />
                                            <Row label="Launch ready" value={formatYesNo(selectedNodeStatus.launchReady)} />
                                            <Row label="Mesh connection" value={describeConnection(selectedNodeStatus)} />
                                            <Row label="Transport" value={selectedNodeStatus.connection?.transport ?? 'unknown'} />
                                            <Row label="Connection source" value={selectedNodeStatus.connection?.source ?? 'unknown'} />
                                            <Row label="Last seen" value={describeTimestamp(selectedNodeStatus.lastSeenAt, Boolean(selectedNodeStatus.gitProbePending))} />
                                            <Row label="Updated" value={describeTimestamp(selectedNodeStatus.updatedAt, Boolean(selectedNodeStatus.gitProbePending))} />
                                            {selectedNodeStatus.connection?.lastConnectedAt && <Row label="Last connected" value={formatTimestamp(selectedNodeStatus.connection.lastConnectedAt) ?? selectedNodeStatus.connection.lastConnectedAt} />}
                                            {selectedNodeStatus.connection?.lastCommandAt && <Row label="Last mesh command" value={formatTimestamp(selectedNodeStatus.connection.lastCommandAt) ?? selectedNodeStatus.connection.lastCommandAt} />}
                                            {selectedNodeStatus.connection?.reason && <Row label="Connection reason" value={selectedNodeStatus.connection.reason} />}
                                            <Row label="Sessions" value={selectedNodeStatus.activeSessions.length} />
                                            {selectedNodeStatus.error && <Row label="Error" value={selectedNodeStatus.error} />}
                                        </div>
                                        {selectedNodeSessionEntries.length > 0 && (
                                            <div className="mt-3">
                                                <div className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Active sessions</div>
                                                <div className="flex flex-col gap-2">
                                                    {selectedNodeSessionEntries.map(entry => {
                                                        const state = entry.session.state || entry.session.lifecycle || 'unknown'
                                                        return (
                                                            <div key={`${entry.nodeId}:${entry.session.sessionId}`} className={meshTheme.isDark ? 'rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200' : 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700'}>
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className={`truncate font-medium ${meshTheme.textPrimary}`}>{entry.session.title || entry.session.sessionId}</div>
                                                                        <div className={`mt-1 truncate text-[11px] ${meshTheme.textMuted}`}>{entry.session.providerType || 'unknown provider'} · {state}</div>
                                                                    </div>
                                                                    <Badge label={state} tone={sessionTone(state)} />
                                                                </div>
                                                                <div className="mt-2 flex flex-wrap gap-2">
                                                                    <ActionButton label="View session" onClick={() => selectSessionDetail(entry.nodeId, entry.session.sessionId)} />
                                                                    <ActionButton label="Open chat" tone="info" onClick={() => openSessionChat(entry.session.sessionId)} />
                                                                </div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                        {selectedNodeQueueTasks.length > 0 && (
                                            <div className="mt-3">
                                                <div className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Related queue items</div>
                                                <div className="flex flex-col gap-2">
                                                    {selectedNodeQueueTasks.map(task => {
                                                        const sessionId = getQueueTaskSessionTarget(task)
                                                        const linkedEntry = sessionId ? sessionEntries.find(entry => entry.session.sessionId === sessionId) ?? null : null
                                                        return (
                                                            <div key={task.id} className={meshTheme.isDark ? 'rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200' : 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700'}>
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className={`truncate font-medium ${meshTheme.textPrimary}`}>{task.message}</div>
                                                                        <div className={`mt-1 truncate text-[11px] ${meshTheme.textMuted}`}>{describeQueueTask(task)}</div>
                                                                    </div>
                                                                    <Badge label={task.status} tone={queueTone(task.status)} />
                                                                </div>
                                                                <div className="mt-2 flex flex-wrap gap-2">
                                                                    <ActionButton label="View queue detail" onClick={() => setDetailSelection({ kind: 'queue', taskId: task.id })} />
                                                                    {linkedEntry && (
                                                                        <ActionButton label="View session" onClick={() => selectSessionDetail(linkedEntry.nodeId, linkedEntry.session.sessionId)} />
                                                                    )}
                                                                    {sessionId && <ActionButton label="Open chat" tone="info" onClick={() => openSessionChat(sessionId)} />}
                                                                </div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                        <div className="mt-3">
                                            <div className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Recent commits</div>
                                            <div className="flex flex-col gap-2">
                                                {selectedGitHistory?.loading && <div className={meshTheme.isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-500'}>Loading recent commits…</div>}
                                                {selectedGitHistory?.error && <div className="text-xs text-amber-200">Recent history unavailable: {selectedGitHistory.error}</div>}
                                                {!selectedGitHistory?.loading && !selectedGitHistory?.error && (selectedGitHistory?.entries ?? []).length === 0 && (
                                                    <div className={meshTheme.isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-500'}>Recent commit history not available from the current mesh snapshot yet.</div>
                                                )}
                                                {(selectedGitHistory?.entries ?? []).slice(0, 5).map(entry => (
                                                    <div key={entry.commit} className={meshTheme.isDark ? 'rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200' : 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700'}>
                                                        <div className={`font-medium ${meshTheme.textPrimary}`}>{shortCommit(entry.commit)} · {entry.message}</div>
                                                        <div className="mt-1 text-[11px] text-slate-500">
                                                            {entry.authorName || 'unknown author'}
                                                            {formatCommitTimestamp(entry.committedAt) ? ` · ${formatCommitTimestamp(entry.committedAt)}` : ''}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        {(selectedNodeStatus.git?.submodules?.length ?? 0) > 0 && (
                                            <div className="mt-3">
                                                <div className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Submodules</div>
                                                <div className="flex flex-col gap-2">
                                                    {(selectedNodeStatus.git?.submodules ?? []).map(submodule => (
                                                        <div key={`${selectedNodeStatus.nodeId}:${submodule.path}`} className={meshTheme.isDark ? 'rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200' : 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700'}>
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <span className="font-medium">{submodule.path}</span>
                                                                {submodule.dirty && <Badge label="dirty" tone="warn" />}
                                                                {(submodule.outOfSync || submodule.error) && <Badge label="drift" tone="danger" />}
                                                            </div>
                                                            <div className="mt-1 break-all text-[11px] text-slate-400">{submodule.repoPath}</div>
                                                            <div className="mt-1 text-[11px] text-slate-500">Select the submodule node in the graph for its own HEAD and recent history.</div>
                                                            {submodule.error && <div className="mt-1 text-[11px] text-rose-200">{submodule.error}</div>}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {!selectedNodeStatus && (
                                    <div className={meshTheme.isDark ? 'rounded-xl border border-white/10 bg-slate-950/40 p-3' : 'rounded-xl border border-slate-200 bg-slate-50 p-3'}>
                                        <div className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Git context</div>
                                        <div className="text-xs text-slate-300">{selectedHeadSummary ?? 'No daemon-owned node status is attached to this graph node.'}</div>
                                        <div className="mt-3">
                                            <div className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>Recent commits</div>
                                            <div className="flex flex-col gap-2">
                                                {selectedGitHistory?.loading && <div className={meshTheme.isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-500'}>Loading recent commits…</div>}
                                                {selectedGitHistory?.error && <div className="text-xs text-amber-200">Recent history unavailable: {selectedGitHistory.error}</div>}
                                                {!selectedGitHistory?.loading && !selectedGitHistory?.error && (selectedGitHistory?.entries ?? []).length === 0 && (
                                                    <div className={meshTheme.isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-500'}>Recent commit history not available for this detached graph node yet.</div>
                                                )}
                                                {(selectedGitHistory?.entries ?? []).slice(0, 5).map(entry => (
                                                    <div key={entry.commit} className={meshTheme.isDark ? 'rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200' : 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700'}>
                                                        <div className={`font-medium ${meshTheme.textPrimary}`}>{shortCommit(entry.commit)} · {entry.message}</div>
                                                        <div className="mt-1 text-[11px] text-slate-500">
                                                            {entry.authorName || 'unknown author'}
                                                            {formatCommitTimestamp(entry.committedAt) ? ` · ${formatCommitTimestamp(entry.committedAt)}` : ''}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className={`text-xs ${meshTheme.textMuted}`}>Select a node, session, or queue item.</div>
                        )}
                    </div>
                </Card>

                <Card title="Queue" subtitle="Active work plus recent history from mesh_status.">
                    <div className="mb-3 flex flex-wrap gap-2">
                        {(['active', 'history', 'all'] as const).map(filter => (
                            <button
                                key={filter}
                                type="button"
                                onClick={() => setQueueFilter(filter)}
                                className={`rounded-full border px-3 py-1 text-xs transition ${queueFilter === filter ? (meshTheme.isDark ? 'border-sky-400/30 bg-sky-500/10 text-sky-100' : 'border-sky-300 bg-sky-50 text-sky-700') : (meshTheme.isDark ? 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')}`}
                            >
                                {filter}
                            </button>
                        ))}
                    </div>
                    <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 xl:grid-cols-2">
                        <div className={meshTheme.isDark ? 'rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300' : 'rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-600'}>Active <span className={`ml-1 ${meshTheme.textPrimary}`}>{queueSummary?.active ?? 0}</span></div>
                        <div className={meshTheme.isDark ? 'rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300' : 'rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-600'}>Pending <span className={`ml-1 ${meshTheme.textPrimary}`}>{queueActiveCounts.pending}</span></div>
                        <div className={meshTheme.isDark ? 'rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300' : 'rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-600'}>Assigned <span className={`ml-1 ${meshTheme.textPrimary}`}>{queueActiveCounts.assigned}</span></div>
                        <div className={meshTheme.isDark ? 'rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300' : 'rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-600'}>History <span className={`ml-1 ${meshTheme.textPrimary}`}>{queueSummary?.historical ?? 0}</span></div>
                    </div>
                    <div className="max-h-[24vh] overflow-y-auto pr-1">
                        {visibleQueueTasks.length === 0 ? (
                            <div className={`text-xs ${meshTheme.textMuted}`}>No queue items for this filter.</div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {visibleQueueTasks.map(task => {
                                    const sessionId = getQueueTaskSessionTarget(task)
                                    const linkedEntry = sessionId ? sessionEntries.find(entry => entry.session.sessionId === sessionId) ?? null : null
                                    const nodeId = getQueueTaskNodeTarget(task)
                                    return (
                                        <button
                                            key={task.id}
                                            type="button"
                                            onClick={() => setDetailSelection({ kind: 'queue', taskId: task.id })}
                                            className={`rounded-xl border px-3 py-2 text-left transition ${detailSelection?.kind === 'queue' && detailSelection.taskId === task.id ? (meshTheme.isDark ? 'border-sky-400/30 bg-sky-500/10' : 'border-sky-300 bg-sky-50') : (meshTheme.isDark ? 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]' : 'border-slate-200 bg-white hover:bg-slate-50')}`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className={`truncate text-xs font-medium ${meshTheme.textPrimary}`}>{task.message}</div>
                                                    <div className={`mt-1 truncate text-[11px] ${meshTheme.textMuted}`}>{describeQueueTask(task)}</div>
                                                </div>
                                                <Badge label={task.status} tone={queueTone(task.status)} />
                                            </div>
                                            {(nodeId || linkedEntry || sessionId) && (
                                                <div className="mt-2 flex flex-wrap gap-2">
                                                    {nodeId && (
                                                        <button
                                                            type="button"
                                                            onClick={event => {
                                                                event.stopPropagation()
                                                                focusNodeDetail(nodeId)
                                                            }}
                                                            className={meshTheme.isDark ? 'text-[11px] text-slate-300 underline underline-offset-2 transition hover:text-white' : 'text-[11px] text-slate-600 underline underline-offset-2 transition hover:text-slate-900'}
                                                        >
                                                            View node
                                                        </button>
                                                    )}
                                                    {linkedEntry && (
                                                        <button
                                                            type="button"
                                                            onClick={event => {
                                                                event.stopPropagation()
                                                                selectSessionDetail(linkedEntry.nodeId, linkedEntry.session.sessionId)
                                                            }}
                                                            className={meshTheme.isDark ? 'text-[11px] text-slate-300 underline underline-offset-2 transition hover:text-white' : 'text-[11px] text-slate-600 underline underline-offset-2 transition hover:text-slate-900'}
                                                        >
                                                            View session
                                                        </button>
                                                    )}
                                                    {sessionId && (
                                                        <button
                                                            type="button"
                                                            onClick={event => {
                                                                event.stopPropagation()
                                                                openSessionChat(sessionId)
                                                            }}
                                                            className={meshTheme.isDark ? 'text-[11px] text-sky-200 underline underline-offset-2 transition hover:text-white' : 'text-[11px] text-sky-700 underline underline-offset-2 transition hover:text-sky-900'}
                                                        >
                                                            Open chat
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </Card>

                <Card title="Sessions" subtitle="Node-level active session roster.">
                    <div className="max-h-[22vh] overflow-y-auto pr-1">
                        {sessionEntries.length === 0 ? (
                            <div className={`text-xs ${meshTheme.textMuted}`}>No active session metadata in this mesh snapshot.</div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {sessionEntries.map(entry => {
                                    const state = entry.session.state || entry.session.lifecycle || 'unknown'
                                    return (
                                        <button
                                            key={`${entry.nodeId}:${entry.session.sessionId}`}
                                            type="button"
                                            onClick={() => {
                                                setSelectedNodeId(entry.nodeId)
                                                setDetailSelection({ kind: 'session', nodeId: entry.nodeId, sessionId: entry.session.sessionId })
                                            }}
                                            className={`rounded-xl border px-3 py-2 text-left transition ${detailSelection?.kind === 'session' && detailSelection.nodeId === entry.nodeId && detailSelection.sessionId === entry.session.sessionId ? (meshTheme.isDark ? 'border-sky-400/30 bg-sky-500/10' : 'border-sky-300 bg-sky-50') : (meshTheme.isDark ? 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]' : 'border-slate-200 bg-white hover:bg-slate-50')}`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className={`truncate text-xs font-medium ${meshTheme.textPrimary}`}>{entry.machineLabel}</div>
                                                    <div className={`mt-1 truncate text-[11px] ${meshTheme.textMuted}`}>{entry.session.title || entry.session.providerType || 'unknown provider'} · {entry.branch || 'no branch'}</div>
                                                </div>
                                                <div className="flex flex-col items-end gap-1">
                                                    <Badge label={state} tone={sessionTone(state)} />
                                                    <button
                                                        type="button"
                                                        onClick={event => {
                                                            event.stopPropagation()
                                                            openSessionChat(entry.session.sessionId)
                                                        }}
                                                        className={meshTheme.isDark ? 'text-[11px] text-sky-200 underline underline-offset-2 transition hover:text-white' : 'text-[11px] text-sky-700 underline underline-offset-2 transition hover:text-sky-900'}
                                                    >
                                                        Open chat
                                                    </button>
                                                </div>
                                            </div>
                                        </button>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </Card>

                <Card title="Nodes" subtitle="Health, branch, drift, and provider view per node.">
                    <div className="max-h-[22vh] overflow-y-auto pr-1">
                        <div className="flex flex-col gap-2">
                            {status.nodes.map(node => (
                                <button
                                    key={node.nodeId}
                                    type="button"
                                    onClick={() => {
                                        setSelectedNodeId(node.nodeId)
                                        setDetailSelection({ kind: 'node', nodeId: node.nodeId })
                                    }}
                                    className={`rounded-xl border px-3 py-2 text-left transition ${detailSelection?.kind === 'node' && detailSelection.nodeId === node.nodeId ? (meshTheme.isDark ? 'border-sky-400/30 bg-sky-500/10' : 'border-sky-300 bg-sky-50') : (meshTheme.isDark ? 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]' : 'border-slate-200 bg-white hover:bg-slate-50')}`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className={`truncate text-xs font-medium ${meshTheme.textPrimary}`}>{node.machineLabel}</div>
                                            <div className={`mt-1 truncate text-[11px] ${meshTheme.textMuted}`}>{summarizeNodeDrift(node)}</div>
                                            <div className={meshTheme.isDark ? 'mt-1 truncate text-[11px] text-slate-500' : 'mt-1 truncate text-[11px] text-slate-500'}>{(node.providers ?? []).join(', ') || 'no provider metadata'}</div>
                                            <div className="mt-1 flex flex-wrap gap-1">
                                                <Badge label={`launchReady ${formatYesNo(node.launchReady)}`} tone={node.launchReady ? 'good' : 'warn'} />
                                                <Badge label={connectionLabel(node.connection)} tone={connectionTone(node.connection)} />
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-end gap-1">
                                            <Badge label={node.health} tone={healthTone(node.health)} />
                                            {node.machineStatus && <Badge label={node.machineStatus} tone={node.machineStatus === 'online' ? 'good' : 'warn'} />}
                                            {node.activeSessions.length > 0 && <Badge label={`${node.activeSessions.length} sessions`} tone="info" />}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </Card>

                <Card title="Recent mesh events" subtitle="Read-only ledger tail from mesh_status.">
                    <div className="max-h-[18vh] overflow-y-auto pr-1">
                        {(status.ledger?.entries ?? []).length === 0 ? (
                            <div className={`text-xs ${meshTheme.textMuted}`}>No recent ledger entries.</div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {(status.ledger?.entries ?? []).map((entry: RepoMeshLedgerEntryStatus) => (
                                    <div key={entry.id} className={meshTheme.isDark ? 'rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-200' : 'rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700'}>
                                        <div className="flex items-center justify-between gap-3">
                                            <span className={`font-medium ${meshTheme.textPrimary}`}>{entry.kind}</span>
                                            <span className={meshTheme.isDark ? 'text-[11px] text-slate-500' : 'text-[11px] text-slate-500'}>{formatTimestamp(entry.timestamp) ?? entry.timestamp}</span>
                                        </div>
                                        <div className={`mt-1 truncate text-[11px] ${meshTheme.textMuted}`}>{entry.nodeId || entry.sessionId || entry.providerType || 'mesh-wide event'}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </Card>
                </div>
            )}
        </div>
        </MeshGraphThemeContext.Provider>
    )
}
