import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
    GitLogEntry,
    RepoMeshLedgerEntryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueTask,
    RepoMeshSessionStatus,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { useNavigate } from 'react-router-dom'
import { getDashboardActiveTabHref } from '../../utils/dashboard-route-paths'
import MeshGraphPanel from './MeshGraphPanel'
import MeshGraphView from './MeshGraphView'
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

function Badge({ label, tone = 'default' }: { label: string; tone?: 'default' | 'good' | 'warn' | 'danger' | 'info' }) {
    const tones: Record<string, string> = {
        default: 'border-white/10 bg-white/[0.04] text-slate-200',
        good: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200',
        warn: 'border-amber-400/20 bg-amber-500/10 text-amber-100',
        danger: 'border-rose-400/20 bg-rose-500/10 text-rose-100',
        info: 'border-sky-400/20 bg-sky-500/10 text-sky-100',
    }
    return <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${tones[tone] || tones.default}`}>{label}</span>
}

function Card({ title, subtitle, children, className = '' }: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
    return (
        <section className={`rounded-2xl border border-white/10 bg-white/[0.04] ${className}`}>
            <div className="border-b border-white/10 px-4 py-3">
                <div className="text-sm font-semibold text-white">{title}</div>
                {subtitle && <div className="mt-1 text-xs text-slate-400">{subtitle}</div>}
            </div>
            <div className="px-4 py-3">{children}</div>
        </section>
    )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-3 border-b border-white/5 py-1.5 text-xs last:border-b-0 last:pb-0 first:pt-0">
            <span className="text-slate-400">{label}</span>
            <span className="max-w-[65%] break-all text-right text-slate-100">{value}</span>
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
    const tones: Record<string, string> = {
        default: 'border-white/10 bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]',
        info: 'border-sky-400/25 bg-sky-500/10 text-sky-100 hover:bg-sky-500/16',
        success: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/16',
    }
    return (
        <button
            type="button"
            onClick={onClick}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition ${tones[tone] || tones.default}`}
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
    const git = node.git
    if (!git) return 'No git probe'
    const changes = (git.staged ?? 0) + (git.modified ?? 0) + (git.untracked ?? 0) + (git.deleted ?? 0) + (git.renamed ?? 0)
    const parts: string[] = []
    if (git.branch) parts.push(git.branch)
    if ((git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0) parts.push(`↑${git.ahead ?? 0}/↓${git.behind ?? 0}`)
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

function pickInitialNodeId(graph: MeshGraphData): string | null {
    return graph.nodes.find(node => node.type !== 'submoduleNode')?.id ?? graph.nodes[0]?.id ?? null
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

export default function MeshObservabilitySurface({
    graph,
    status,
    emptyMessage = 'No live mesh graph is available for this coordinator yet.',
    daemonId = null,
    sendDaemonCommand = null,
}: MeshObservabilitySurfaceProps) {
    const navigate = useNavigate()
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => pickInitialNodeId(graph))
    const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(() => {
        const nodeId = pickInitialNodeId(graph)
        return nodeId ? { kind: 'node', nodeId } : null
    })
    const [queueFilter, setQueueFilter] = useState<'active' | 'history' | 'all'>('active')
    const [gitHistoryByWorkspace, setGitHistoryByWorkspace] = useState<Record<string, GitHistoryState>>({})

    const nodeStatusById = useMemo(() => new Map(status.nodes.map(node => [node.nodeId, node])), [status.nodes])
    const graphNodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
    const queueTasks = status.queue?.tasks ?? []
    const queueSummary = status.queue?.summary ?? null
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
        if (!selectedNodeId || !graphNodeById.has(selectedNodeId)) {
            const fallback = pickInitialNodeId(graph)
            setSelectedNodeId(fallback)
            setDetailSelection(fallback ? { kind: 'node', nodeId: fallback } : null)
        }
    }, [graph, graphNodeById, selectedNodeId])

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

    const selectedGitWorkspace = selectedSessionEntry?.session.workspace
        || selectedSessionEntry?.workspace
        || selectedGraphNode?.workspace
        || null
    const selectedGitHistory = selectedGitWorkspace ? gitHistoryByWorkspace[selectedGitWorkspace] ?? null : null
    const selectedHeadSummary = summarizeHead(selectedNodeStatus, selectedGitHistory?.entries ?? [])

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
        if (!selectedGitWorkspace || !daemonId || !sendDaemonCommand) return
        const existing = gitHistoryByWorkspace[selectedGitWorkspace]
        if (existing?.loading || (existing && (existing.entries.length > 0 || existing.error))) return

        let cancelled = false
        setGitHistoryByWorkspace(current => ({
            ...current,
            [selectedGitWorkspace]: {
                loading: true,
                error: null,
                entries: current[selectedGitWorkspace]?.entries ?? [],
            },
        }))

        void sendDaemonCommand(daemonId, 'git_log', { workspace: selectedGitWorkspace, limit: 5 })
            .then(response => {
                if (cancelled) return
                setGitHistoryByWorkspace(current => ({
                    ...current,
                    [selectedGitWorkspace]: {
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
                    [selectedGitWorkspace]: {
                        loading: false,
                        error: error instanceof Error ? error.message : 'git_log failed',
                        entries: [],
                    },
                }))
            })

        return () => {
            cancelled = true
        }
    }, [daemonId, gitHistoryByWorkspace, selectedGitWorkspace, sendDaemonCommand])

    const statusWarnings = [
        ...(graph.warnings ?? []),
        ...(status.nodes.filter(node => node.machineStatus && node.machineStatus !== 'online').map(node => `${node.machineLabel}: ${node.machineStatus}`)),
    ]

    return (
        <div className="flex min-h-0 flex-col gap-4 xl:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Card title={`${graph.stats.totalNodes} nodes`} subtitle="Mesh topology">
                        <div className="flex flex-wrap gap-2">
                            <Badge label={`${graph.stats.totalActiveSessions} active sessions`} tone={graph.stats.totalActiveSessions > 0 ? 'info' : 'default'} />
                            <Badge label={`${graph.stats.dirtyNodes} dirty`} tone={graph.stats.dirtyNodes > 0 ? 'warn' : 'good'} />
                            <Badge label={`${graph.stats.offlineNodes} offline`} tone={graph.stats.offlineNodes > 0 ? 'danger' : 'good'} />
                        </div>
                    </Card>
                    <Card title={`${queueSummary?.active ?? 0} active queue`} subtitle="Pending + assigned tasks">
                        <div className="flex flex-wrap gap-2">
                            <Badge label={`${queueSummary?.activeCounts.pending ?? 0} pending`} tone="warn" />
                            <Badge label={`${queueSummary?.activeCounts.assigned ?? 0} assigned`} tone="info" />
                            <Badge label={`${queueSummary?.historical ?? 0} recent history`} tone="default" />
                        </div>
                    </Card>
                    <Card title={`${sessionEntries.length} sessions`} subtitle="Live and cached session view">
                        <div className="flex flex-wrap gap-2">
                            {stateCounts.length === 0 ? (
                                <Badge label="no session metadata" />
                            ) : stateCounts.slice(0, 3).map(([label, count]) => (
                                <Badge key={label} label={`${count} ${label}`} tone={sessionTone(label)} />
                            ))}
                        </div>
                    </Card>
                    <Card title={`${status.ledger?.summary.recentFailures ?? 0} recent failures`} subtitle="Ledger evidence">
                        <div className="flex flex-wrap gap-2">
                            <Badge label={`${status.ledger?.summary.taskCompleted ?? 0} completed`} tone="good" />
                            <Badge label={`${status.ledger?.summary.taskFailed ?? 0} failed`} tone={(status.ledger?.summary.taskFailed ?? 0) > 0 ? 'danger' : 'good'} />
                            <Badge label={`${status.ledger?.summary.sessionLaunched ?? 0} launched`} tone="info" />
                        </div>
                    </Card>
                </div>

                <Card title="Mesh meaning" subtitle="Read the graph without hidden rules.">
                    <div className="flex flex-wrap gap-2 text-xs text-slate-300">
                        <Badge label="Anchor = inferred default branch" tone="info" />
                        <Badge label="Peer link = same-branch worktree" tone="default" />
                        <Badge label="Submodule link = child checkout under a parent node" tone="warn" />
                        <Badge label="Node badges = health + drift + session activity" tone="default" />
                        <Badge label="Mesh transport = selected-coordinator view only" tone="info" />
                        <Badge label="Unknown / not reported = no live daemon↔daemon telemetry yet" tone="warn" />
                    </div>
                    <div className="mt-3 text-xs text-slate-400">
                        Tap a node to inspect workspace, session, and git details. Launch readiness and mesh transport details stay in the same drill-down. Queue rows and session rows are also selectable for drill-down.
                    </div>
                </Card>

                {statusWarnings.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {statusWarnings.map(warning => (
                            <span key={warning} className="rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-100">{warning}</span>
                        ))}
                    </div>
                )}

                <div className="min-h-0 flex-1 rounded-[28px] border border-white/10 bg-white/[0.03] p-3 sm:p-4" style={{ minHeight: 420 }}>
                    {graph.nodes.length > 0 ? (
                        <MeshGraphView
                            data={graph}
                            selectedNodeId={selectedNodeId}
                            onNodeClick={node => {
                                setSelectedNodeId(node.id)
                                setDetailSelection({ kind: 'node', nodeId: node.id })
                            }}
                        />
                    ) : (
                        <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-slate-400">{emptyMessage}</div>
                    )}
                </div>
            </div>

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
                                            className="inline-flex w-fit items-center rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-100 transition hover:bg-sky-500/20"
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
                                            className="inline-flex w-fit items-center rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-100 transition hover:bg-sky-500/20"
                                        >
                                            Open dashboard chat
                                        </a>
                                    ) : null
                                })()}
                                <div className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
                                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Git context</div>
                                    <div className="flex flex-col gap-2 text-xs text-slate-300">
                                        <div>{selectedHeadSummary || 'HEAD subject not present in cached mesh_status.'}</div>
                                        {selectedGitHistory?.loading && <div className="text-slate-500">Loading recent commits…</div>}
                                        {selectedGitHistory?.error && <div className="text-amber-200">Recent history unavailable: {selectedGitHistory.error}</div>}
                                        {(selectedGitHistory?.entries ?? []).slice(0, 5).map(entry => (
                                            <div key={entry.commit} className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2">
                                                <div className="font-medium text-slate-100">{shortCommit(entry.commit)} · {entry.message}</div>
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
                                <MeshGraphPanel node={selectedGraphNode} />
                                {selectedNodeStatus && (
                                    <div className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <Badge label={selectedNodeStatus.health} tone={healthTone(selectedNodeStatus.health)} />
                                            {selectedNodeStatus.machineStatus && <Badge label={selectedNodeStatus.machineStatus} tone={selectedNodeStatus.machineStatus === 'online' ? 'good' : 'warn'} />}
                                            <Badge label={`launchReady ${formatYesNo(selectedNodeStatus.launchReady)}`} tone={selectedNodeStatus.launchReady ? 'good' : 'warn'} />
                                            <Badge label={connectionLabel(selectedNodeStatus.connection)} tone={connectionTone(selectedNodeStatus.connection)} />
                                            {selectedNodeStatus.worktreeBranch && <Badge label={selectedNodeStatus.worktreeBranch} tone="info" />}
                                        </div>
                                        <div className="flex flex-col gap-0.5">
                                            <Row label="Repo root" value={selectedNodeStatus.repoRoot ?? selectedNodeStatus.workspace} />
                                            <Row label="Provider(s)" value={(selectedNodeStatus.providers ?? []).join(', ') || 'none'} />
                                            <Row label="Provider priority" value={(selectedNodeStatus.providerPriority ?? []).join(', ') || 'not configured'} />
                                            <Row label="Drift" value={summarizeNodeDrift(selectedNodeStatus)} />
                                            <Row label="HEAD" value={selectedHeadSummary ?? 'Not available'} />
                                            <Row label="Daemon" value={selectedNodeStatus.daemonId ?? 'unknown'} />
                                            <Row label="Machine" value={selectedNodeStatus.machineId ?? selectedNodeStatus.machineLabel} />
                                            <Row label="Launch ready" value={formatYesNo(selectedNodeStatus.launchReady)} />
                                            <Row label="Mesh connection" value={connectionLabel(selectedNodeStatus.connection)} />
                                            <Row label="Transport" value={selectedNodeStatus.connection?.transport ?? 'unknown'} />
                                            <Row label="Connection source" value={selectedNodeStatus.connection?.source ?? 'unknown'} />
                                            <Row label="Last seen" value={formatTimestamp(selectedNodeStatus.lastSeenAt) ?? selectedNodeStatus.lastSeenAt ?? 'not reported'} />
                                            <Row label="Updated" value={formatTimestamp(selectedNodeStatus.updatedAt) ?? selectedNodeStatus.updatedAt ?? 'not reported'} />
                                            {selectedNodeStatus.connection?.lastConnectedAt && <Row label="Last connected" value={formatTimestamp(selectedNodeStatus.connection.lastConnectedAt) ?? selectedNodeStatus.connection.lastConnectedAt} />}
                                            {selectedNodeStatus.connection?.lastCommandAt && <Row label="Last mesh command" value={formatTimestamp(selectedNodeStatus.connection.lastCommandAt) ?? selectedNodeStatus.connection.lastCommandAt} />}
                                            {selectedNodeStatus.connection?.reason && <Row label="Connection reason" value={selectedNodeStatus.connection.reason} />}
                                            <Row label="Sessions" value={selectedNodeStatus.activeSessions.length} />
                                            {selectedNodeStatus.error && <Row label="Error" value={selectedNodeStatus.error} />}
                                        </div>
                                        {selectedNodeSessionEntries.length > 0 && (
                                            <div className="mt-3">
                                                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Active sessions</div>
                                                <div className="flex flex-col gap-2">
                                                    {selectedNodeSessionEntries.map(entry => {
                                                        const state = entry.session.state || entry.session.lifecycle || 'unknown'
                                                        return (
                                                            <div key={`${entry.nodeId}:${entry.session.sessionId}`} className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200">
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="truncate font-medium text-slate-100">{entry.session.title || entry.session.sessionId}</div>
                                                                        <div className="mt-1 truncate text-[11px] text-slate-400">{entry.session.providerType || 'unknown provider'} · {state}</div>
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
                                                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Related queue items</div>
                                                <div className="flex flex-col gap-2">
                                                    {selectedNodeQueueTasks.map(task => {
                                                        const sessionId = getQueueTaskSessionTarget(task)
                                                        const linkedEntry = sessionId ? sessionEntries.find(entry => entry.session.sessionId === sessionId) ?? null : null
                                                        return (
                                                            <div key={task.id} className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200">
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="truncate font-medium text-slate-100">{task.message}</div>
                                                                        <div className="mt-1 truncate text-[11px] text-slate-400">{describeQueueTask(task)}</div>
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
                                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Recent commits</div>
                                            <div className="flex flex-col gap-2">
                                                {selectedGitHistory?.loading && <div className="text-xs text-slate-500">Loading recent commits…</div>}
                                                {selectedGitHistory?.error && <div className="text-xs text-amber-200">Recent history unavailable: {selectedGitHistory.error}</div>}
                                                {!selectedGitHistory?.loading && !selectedGitHistory?.error && (selectedGitHistory?.entries ?? []).length === 0 && (
                                                    <div className="text-xs text-slate-500">Recent commit history not available from the current mesh snapshot yet.</div>
                                                )}
                                                {(selectedGitHistory?.entries ?? []).slice(0, 5).map(entry => (
                                                    <div key={entry.commit} className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200">
                                                        <div className="font-medium text-slate-100">{shortCommit(entry.commit)} · {entry.message}</div>
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
                                                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Submodules</div>
                                                <div className="flex flex-col gap-2">
                                                    {(selectedNodeStatus.git?.submodules ?? []).map(submodule => (
                                                        <div key={`${selectedNodeStatus.nodeId}:${submodule.path}`} className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200">
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
                                    <div className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
                                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Git context</div>
                                        <div className="text-xs text-slate-300">{selectedHeadSummary ?? 'No daemon-owned node status is attached to this graph node.'}</div>
                                        <div className="mt-3">
                                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Recent commits</div>
                                            <div className="flex flex-col gap-2">
                                                {selectedGitHistory?.loading && <div className="text-xs text-slate-500">Loading recent commits…</div>}
                                                {selectedGitHistory?.error && <div className="text-xs text-amber-200">Recent history unavailable: {selectedGitHistory.error}</div>}
                                                {!selectedGitHistory?.loading && !selectedGitHistory?.error && (selectedGitHistory?.entries ?? []).length === 0 && (
                                                    <div className="text-xs text-slate-500">Recent commit history not available for this detached graph node yet.</div>
                                                )}
                                                {(selectedGitHistory?.entries ?? []).slice(0, 5).map(entry => (
                                                    <div key={entry.commit} className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-200">
                                                        <div className="font-medium text-slate-100">{shortCommit(entry.commit)} · {entry.message}</div>
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
                            <div className="text-xs text-slate-400">Select a node, session, or queue item.</div>
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
                                className={`rounded-full border px-3 py-1 text-xs transition ${queueFilter === filter ? 'border-sky-400/30 bg-sky-500/10 text-sky-100' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]'}`}
                            >
                                {filter}
                            </button>
                        ))}
                    </div>
                    <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 xl:grid-cols-2">
                        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300">Active <span className="ml-1 text-white">{queueSummary?.active ?? 0}</span></div>
                        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300">Pending <span className="ml-1 text-white">{queueSummary?.activeCounts.pending ?? 0}</span></div>
                        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300">Assigned <span className="ml-1 text-white">{queueSummary?.activeCounts.assigned ?? 0}</span></div>
                        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-slate-300">History <span className="ml-1 text-white">{queueSummary?.historical ?? 0}</span></div>
                    </div>
                    <div className="max-h-[24vh] overflow-y-auto pr-1">
                        {visibleQueueTasks.length === 0 ? (
                            <div className="text-xs text-slate-400">No queue items for this filter.</div>
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
                                            className={`rounded-xl border px-3 py-2 text-left transition ${detailSelection?.kind === 'queue' && detailSelection.taskId === task.id ? 'border-sky-400/30 bg-sky-500/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-xs font-medium text-white">{task.message}</div>
                                                    <div className="mt-1 truncate text-[11px] text-slate-400">{describeQueueTask(task)}</div>
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
                                                            className="text-[11px] text-slate-300 underline underline-offset-2 transition hover:text-white"
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
                                                            className="text-[11px] text-slate-300 underline underline-offset-2 transition hover:text-white"
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
                                                            className="text-[11px] text-sky-200 underline underline-offset-2 transition hover:text-white"
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
                            <div className="text-xs text-slate-400">No active session metadata in this mesh snapshot.</div>
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
                                            className={`rounded-xl border px-3 py-2 text-left transition ${detailSelection?.kind === 'session' && detailSelection.nodeId === entry.nodeId && detailSelection.sessionId === entry.session.sessionId ? 'border-sky-400/30 bg-sky-500/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-xs font-medium text-white">{entry.machineLabel}</div>
                                                    <div className="mt-1 truncate text-[11px] text-slate-400">{entry.session.title || entry.session.providerType || 'unknown provider'} · {entry.branch || 'no branch'}</div>
                                                </div>
                                                <div className="flex flex-col items-end gap-1">
                                                    <Badge label={state} tone={sessionTone(state)} />
                                                    <button
                                                        type="button"
                                                        onClick={event => {
                                                            event.stopPropagation()
                                                            openSessionChat(entry.session.sessionId)
                                                        }}
                                                        className="text-[11px] text-sky-200 underline underline-offset-2 transition hover:text-white"
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
                                    className={`rounded-xl border px-3 py-2 text-left transition ${detailSelection?.kind === 'node' && detailSelection.nodeId === node.nodeId ? 'border-sky-400/30 bg-sky-500/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-xs font-medium text-white">{node.machineLabel}</div>
                                            <div className="mt-1 truncate text-[11px] text-slate-400">{summarizeNodeDrift(node)}</div>
                                            <div className="mt-1 truncate text-[11px] text-slate-500">{(node.providers ?? []).join(', ') || 'no provider metadata'}</div>
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
                            <div className="text-xs text-slate-400">No recent ledger entries.</div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {(status.ledger?.entries ?? []).map((entry: RepoMeshLedgerEntryStatus) => (
                                    <div key={entry.id} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-200">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="font-medium text-white">{entry.kind}</span>
                                            <span className="text-[11px] text-slate-500">{formatTimestamp(entry.timestamp) ?? entry.timestamp}</span>
                                        </div>
                                        <div className="mt-1 truncate text-[11px] text-slate-400">{entry.nodeId || entry.sessionId || entry.providerType || 'mesh-wide event'}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </Card>
            </div>
        </div>
    )
}
