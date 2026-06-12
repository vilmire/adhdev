import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
    GitLogEntry,
    RepoMeshLedgerSummaryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueSummary,
    RepoMeshQueueTask,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import MeshGraphView from './MeshGraphView'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
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
    /** When true, the graph is showing bootstrap inventory data pending live peer truth. */
    bootstrapFallback?: boolean
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

const EMPTY_LEDGER_SUMMARY: RepoMeshLedgerSummaryStatus = {
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

type AsyncRefineJob = {
    jobId: string
    status: 'accepted' | 'running' | 'completed' | 'failed'
    branch?: string
    into?: string
    completedAt?: string
    startedAt?: string
}

function MeshHealthPanel({
    canonicalStatus,
    queueSummary,
    ledgerSummary,
    isBootstrapMode,
    meshTheme,
    sessionEntries,
    inlineMode = false,
}: {
    canonicalStatus: RepoMeshStatus
    queueSummary: RepoMeshQueueSummary | null
    ledgerSummary: RepoMeshLedgerSummaryStatus
    isBootstrapMode: boolean
    meshTheme: MeshGraphTheme
    sessionEntries: SessionListEntry[]
    inlineMode?: boolean
}) {
    const hasQueueActivity = queueSummary && (queueSummary.active > 0 || queueSummary.historical > 0)
    const hasLedgerFailures = ledgerSummary.recentFailures > 0 || ledgerSummary.taskFailed > 0
    const failedQueueTasks = (canonicalStatus.queue as any)?.tasks
        ? ((canonicalStatus.queue as any).tasks as RepoMeshQueueTask[])
            .filter(task => task.status === 'failed' || task.status === 'cancelled')
            .slice(0, 5)
        : []
    const asyncRefineJobs = (canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined
    const activeRefineJobs = asyncRefineJobs?.filter(j => j.status === 'running' || j.status === 'accepted') ?? []
    const failedRefineJobs = asyncRefineJobs?.filter(j => j.status === 'failed') ?? []
    const staleWork = (canonicalStatus as any).staleDirectWorkSummary as { count: number; reasonCounts?: Record<string, number> } | undefined
    const hasStaleWork = staleWork && staleWork.count > 0

    if (!hasQueueActivity && !hasLedgerFailures && canonicalStatus.nodes.length === 0 && !isBootstrapMode
        && activeRefineJobs.length === 0 && failedRefineJobs.length === 0 && !hasStaleWork && sessionEntries.length === 0) {
        return null
    }

    const dk = meshTheme.isDark
    const sepClass = `border-t ${dk ? 'border-white/8' : 'border-slate-200'}`
    const subDetailsClass = `group w-full rounded-lg border text-xs ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`
    const subSummaryClass = `flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 [&::-webkit-details-marker]:hidden ${meshTheme.textSecondary}`

    // stat tile: value + label below
    function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: 'rose' | 'sky' | 'amber' | 'emerald' | 'muted' }) {
        const valClass = tone === 'rose' ? (dk ? 'text-rose-300' : 'text-rose-600')
            : tone === 'sky' ? (dk ? 'text-sky-300' : 'text-sky-600')
            : tone === 'amber' ? (dk ? 'text-amber-300' : 'text-amber-600')
            : tone === 'emerald' ? (dk ? 'text-emerald-300' : 'text-emerald-600')
            : tone === 'muted' ? meshTheme.textMuted
            : meshTheme.textPrimary
        return (
            <div className={`flex flex-col items-center rounded-lg border px-2 py-1.5 ${dk ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-white/70'}`}>
                <span className={`tabular-nums text-sm font-semibold leading-none ${valClass}`}>{value}</span>
                <span className={`mt-0.5 text-[9px] uppercase tracking-wide ${meshTheme.textMuted}`}>{label}</span>
            </div>
        )
    }

    const contentDiv = (
        <div className="flex flex-col gap-3 text-xs">
            {/* Stat tiles grid */}
            <div className="grid grid-cols-4 gap-1.5">
                {queueSummary ? (
                    <>
                        <StatTile label="Pending" value={queueSummary.pending} />
                        <StatTile label="Active" value={queueSummary.active} tone={queueSummary.active > 0 ? 'sky' : undefined} />
                        <StatTile label="Done" value={queueSummary.completed} tone="emerald" />
                        <StatTile label="Failed" value={queueSummary.failed} tone={queueSummary.failed > 0 ? 'rose' : undefined} />
                    </>
                ) : (
                    <>
                        <StatTile label="Done" value={ledgerSummary.taskCompleted} tone="emerald" />
                        <StatTile label="Failed" value={ledgerSummary.taskFailed} tone={ledgerSummary.taskFailed > 0 ? 'rose' : undefined} />
                        <StatTile label="Sessions" value={ledgerSummary.sessionLaunched} />
                        <StatTile label="Recent↯" value={ledgerSummary.recentFailures} tone={ledgerSummary.recentFailures > 0 ? 'amber' : 'muted'} />
                    </>
                )}
            </div>

            {/* Secondary stats row when queue present */}
            {queueSummary && (
                <div className="grid grid-cols-3 gap-1.5">
                    <StatTile label="Ledger done" value={ledgerSummary.taskCompleted} tone="emerald" />
                    <StatTile label="Sessions" value={ledgerSummary.sessionLaunched} />
                    <StatTile label="Recent↯" value={ledgerSummary.recentFailures} tone={ledgerSummary.recentFailures > 0 ? 'amber' : 'muted'} />
                </div>
            )}

            {/* Last activity */}
            {ledgerSummary.lastActivityAt && (
                <div className={`flex items-center justify-between ${meshTheme.textMuted}`}>
                    <span>Last activity</span>
                    <span className="font-mono text-[10px]">{ledgerSummary.lastActivityAt.slice(5, 16)}</span>
                </div>
            )}

            {/* Node connections */}
            {canonicalStatus.nodes.length > 0 && (
                <div className={`pt-2.5 ${sepClass}`}>
                    <div className="flex flex-col gap-1">
                        {canonicalStatus.nodes.map(node => {
                            const connState = node.connection?.state ?? 'unknown'
                            const isConnecting = connState === 'unknown' || connState === 'connecting'
                            const isFailed = connState === 'failed' || connState === 'closed' || connState === 'disconnected'
                            const isConnected = connState === 'connected' || connState === 'self'
                            const dotClass = isConnecting
                                ? (dk ? 'bg-amber-400' : 'bg-amber-400')
                                : isFailed
                                    ? (dk ? 'bg-rose-400' : 'bg-rose-500')
                                    : isConnected
                                        ? (dk ? 'bg-emerald-400' : 'bg-emerald-500')
                                        : (dk ? 'bg-slate-500' : 'bg-slate-400')
                            return (
                                <div key={node.nodeId} className="flex items-center gap-2">
                                    <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} />
                                    <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={node.workspace}>{node.machineLabel}</span>
                                    <span className={`shrink-0 font-mono text-[10px] ${meshTheme.textMuted}`}>{isConnecting ? '…' : connState}</span>
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}

            {/* Refine jobs — collapsible */}
            {asyncRefineJobs && asyncRefineJobs.length > 0 && (
                <div className={`pt-2.5 ${sepClass}`}>
                    <details className={subDetailsClass}>
                        <summary className={subSummaryClass}>
                            <span className="flex-1">Refine jobs</span>
                            <span className={`tabular-nums ${dk ? 'text-slate-400' : 'text-slate-500'}`}>{asyncRefineJobs.length}</span>
                            {failedRefineJobs.length > 0 && <span className={dk ? 'text-rose-300' : 'text-rose-600'}>{failedRefineJobs.length} failed</span>}
                        </summary>
                        <div className="flex flex-col gap-0.5 px-2.5 pb-2">
                            {asyncRefineJobs.slice(0, 8).map(job => (
                                <div key={job.jobId} className="flex items-center gap-2">
                                    <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${meshTheme.textMuted}`}>
                                        {job.branch ?? job.jobId.slice(0, 14)}{job.into ? ` → ${job.into}` : ''}
                                    </span>
                                    <span className={`shrink-0 text-[9px] font-semibold ${
                                        job.status === 'failed' ? (dk ? 'text-rose-300' : 'text-rose-600')
                                        : job.status === 'running' || job.status === 'accepted' ? (dk ? 'text-sky-300' : 'text-sky-600')
                                        : (dk ? 'text-emerald-300' : 'text-emerald-600')
                                    }`}>{job.status}</span>
                                </div>
                            ))}
                        </div>
                    </details>
                </div>
            )}

            {/* Failed queue tasks — collapsible */}
            {failedQueueTasks.length > 0 && (
                <div className={asyncRefineJobs && asyncRefineJobs.length > 0 ? '' : `pt-2.5 ${sepClass}`}>
                    <details className={subDetailsClass}>
                        <summary className={subSummaryClass}>
                            <span className={`flex-1 ${dk ? 'text-rose-300' : 'text-rose-600'}`}>Failed tasks</span>
                            <span className={`tabular-nums ${dk ? 'text-rose-400' : 'text-rose-500'}`}>{failedQueueTasks.length}</span>
                        </summary>
                        <div className="flex flex-col gap-1 px-2.5 pb-2">
                            {failedQueueTasks.map(task => (
                                <div key={task.id} className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                        <span className={`font-mono text-[10px] ${meshTheme.textMuted}`}>{task.id.slice(0, 10)}</span>
                                        {task.message && <span className={`flex-1 truncate ${dk ? 'text-slate-300' : 'text-slate-700'}`}>{task.message.slice(0, 55)}</span>}
                                    </div>
                                    {task.cancelReason && <div className={`truncate text-[10px] ${meshTheme.textMuted}`}>{task.cancelReason.slice(0, 55)}</div>}
                                </div>
                            ))}
                        </div>
                    </details>
                </div>
            )}

            {/* Stale work */}
            {hasStaleWork && (
                <div className={`flex items-center justify-between pt-2.5 ${sepClass}`}>
                    <span className={meshTheme.textMuted}>Stale work</span>
                    <span className={`tabular-nums ${dk ? 'text-amber-300' : 'text-amber-600'}`}>{staleWork!.count}</span>
                </div>
            )}

            {/* Sessions — collapsible */}
            {sessionEntries.length > 0 && (
                <div className={`pt-2.5 ${sepClass}`}>
                    <details className={subDetailsClass}>
                        <summary className={subSummaryClass}>
                            <span className="flex-1">Sessions</span>
                            <span className={`tabular-nums ${dk ? 'text-slate-400' : 'text-slate-500'}`}>{sessionEntries.length}</span>
                        </summary>
                        <div className="flex flex-col gap-0.5 px-2.5 pb-2">
                            {sessionEntries.map(entry => (
                                <div key={entry.session.sessionId} className="flex items-center gap-2">
                                    <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${meshTheme.textMuted}`} title={entry.session.sessionId}>
                                        {shortSessionId(entry.session.sessionId)}
                                    </span>
                                    <span className={`shrink-0 ${meshTheme.textMuted}`}>{entry.session.providerType || '?'}</span>
                                    <span className={`shrink-0 text-[9px] font-semibold ${meshTheme.textMuted}`}>{sessionStatusLabel(entry.session)}</span>
                                </div>
                            ))}
                        </div>
                    </details>
                </div>
            )}
        </div>
    )

    if (inlineMode) return contentDiv

    return (
        <details className={`rounded-2xl border text-xs ${meshTheme.isDark ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
            <summary className={`flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium [&::-webkit-details-marker]:hidden ${meshTheme.textSecondary}`}>
                <span className="flex-1">Mesh Health Panel</span>
                {activeRefineJobs.length > 0 && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-sky-400/25 bg-sky-500/10 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700'}`}>
                        {activeRefineJobs.length} refining
                    </span>
                )}
                {failedRefineJobs.length > 0 && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-rose-400/30 bg-rose-500/12 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
                        {failedRefineJobs.length} refine failed
                    </span>
                )}
                {hasLedgerFailures && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-rose-400/30 bg-rose-500/12 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
                        {ledgerSummary.recentFailures} recent failures
                    </span>
                )}
                {isBootstrapMode && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${meshTheme.isDark ? 'border-amber-400/20 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                        awaiting live data
                    </span>
                )}
            </summary>
            {contentDiv}
        </details>
    )
}

function isBootstrapFallbackStatus(status: RepoMeshStatus): boolean {
    if (status.nodes.length === 0) return false
    return status.nodes.every(
        node => node.health === 'unknown'
            && (!node.connection || node.connection.state === 'unknown'),
    )
}

export default function MeshObservabilitySurface({
    status,
    emptyMessage = 'No live mesh graph is available for this coordinator yet.',
    daemonId = null,
    sendDaemonCommand = null,
    bootstrapFallback,
}: MeshObservabilitySurfaceProps) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const isBootstrapMode = bootstrapFallback ?? isBootstrapFallbackStatus(status)
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
            const dryRunRaw = await sendDaemonCommand(selectedHealDaemonId, 'fast_forward_mesh_node', {
                meshId: canonicalStatus.meshId,
                nodeId: selectedGraphNode.id,
                dryRun: true,
                execute: false,
            })
            // Cloud wraps the daemon response in { success, result }; standalone returns it directly.
            const dryRun = dryRunRaw?.result ?? dryRunRaw
            setHealPreview({
                phase: 'dry_run',
                code: typeof dryRun?.code === 'string' ? dryRun.code : undefined,
                error: typeof dryRun?.operationError === 'string' ? dryRun.operationError : null,
                executed: dryRun?.executed === true,
            })
            if (!dryRun?.success || dryRun.code !== 'fast_forward_available') return
            const ok = window.confirm(`Apply fast-forward for ${selectedGraphNode.label}?`)
            if (!ok) return
            const executedRaw = await sendDaemonCommand(selectedHealDaemonId, 'fast_forward_mesh_node', {
                meshId: canonicalStatus.meshId,
                nodeId: selectedGraphNode.id,
                dryRun: false,
                execute: true,
            })
            const executed = executedRaw?.result ?? executedRaw
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

    const [directionPref, setDirectionPref] = useState<'auto' | 'LR' | 'TB'>('LR')

    const directionToggleButtonClass = (active: boolean) =>
        active
            ? meshTheme.isDark
                ? 'rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2 py-0.5 text-cyan-100'
                : 'rounded-md border border-sky-400 bg-sky-100 px-2 py-0.5 text-sky-800'
            : meshTheme.isDark
                ? 'rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-slate-400 hover:text-slate-200'
                : 'rounded-md border border-slate-300 bg-white/80 px-2 py-0.5 text-slate-500 hover:text-slate-800'

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            {/* ── Card: header + graph + detail panel ── */}
            <div className={`${meshTheme.cardClass} relative flex min-h-0 flex-1 flex-col rounded-[28px]`} style={{ minHeight: 480 }}>

                {/* Header — floats as overlay on mobile, static on sm+ */}
                <div className={`absolute inset-x-4 top-4 z-30 max-h-[42dvh] overflow-y-auto sm:static sm:mb-3 sm:overflow-visible shrink-0 flex flex-wrap items-start justify-between gap-2 px-4 pt-3 pb-2.5 border-b ${meshTheme.isDark ? 'border-white/8' : 'border-slate-200'}`}>
                    <div className={`flex min-w-0 flex-1 flex-wrap gap-2 text-xs ${meshTheme.textSecondary}`}>
                        <Badge label={headlineLabel} tone={headlineTone} />
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
                    <div className="flex shrink-0 items-center gap-2">
                        {/* Direction toggle */}
                        <div
                            className={meshTheme.isDark
                                ? 'flex items-center gap-0.5 rounded-md border border-white/10 bg-slate-950/40 p-0.5 text-[10px]'
                                : 'flex items-center gap-0.5 rounded-md border border-slate-300 bg-white/70 p-0.5 text-[10px]'}
                            role="group"
                            aria-label="Graph layout direction"
                        >
                            <button type="button" onClick={() => setDirectionPref('auto')} className={directionToggleButtonClass(directionPref === 'auto')} title="Auto-detect direction">Auto</button>
                            <button type="button" onClick={() => setDirectionPref('LR')} className={directionToggleButtonClass(directionPref === 'LR')} title="Left to right">LR</button>
                            <button type="button" onClick={() => setDirectionPref('TB')} className={directionToggleButtonClass(directionPref === 'TB')} title="Top to bottom">TB</button>
                        </div>
                        {/* Health panel button */}
                        <div className="relative">
                            <details className={`rounded-xl px-3 py-1.5 text-xs ${meshTheme.isDark ? 'border border-white/10 bg-white/[0.03] text-slate-300' : 'border border-slate-200 bg-slate-50 text-slate-600'}`}>
                                <summary className={`cursor-pointer list-none font-medium ${meshTheme.textSecondary} [&::-webkit-details-marker]:hidden`}>
                                    {(() => {
                                        const failedRefine = ((canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined)?.filter(j => j.status === 'failed').length ?? 0
                                        const recentFail = ledgerSummary.recentFailures
                                        if (failedRefine > 0) return <span className={meshTheme.isDark ? 'text-rose-300' : 'text-rose-600'}>{failedRefine} refine failed</span>
                                        if (recentFail > 0) return <span className={meshTheme.isDark ? 'text-amber-300' : 'text-amber-600'}>{recentFail} failures</span>
                                        return 'Health'
                                    })()}
                                </summary>
                                <div className={`absolute right-0 z-40 mt-2 w-72 max-h-[70vh] overflow-y-auto rounded-xl border p-4 shadow-xl backdrop-blur-xl ${meshTheme.isDark ? 'border-white/10 bg-slate-950/96' : 'border-slate-200 bg-white/98 shadow-slate-900/10'}`}>
                                    <MeshHealthPanel
                                        canonicalStatus={canonicalStatus}
                                        queueSummary={queueSummary}
                                        ledgerSummary={ledgerSummary}
                                        isBootstrapMode={isBootstrapMode}
                                        meshTheme={meshTheme}
                                        sessionEntries={sessionEntries}
                                        inlineMode
                                    />
                                </div>
                            </details>
                        </div>
                        <div className="relative">
                            <details className={`rounded-xl px-3 py-1.5 text-xs ${meshTheme.isDark ? 'border border-white/10 bg-white/[0.03] text-slate-300' : 'border border-slate-200 bg-slate-50 text-slate-600'}`}>
                                <summary className={`cursor-pointer list-none font-medium ${meshTheme.textSecondary} [&::-webkit-details-marker]:hidden`}>
                                    Legend
                                </summary>
                                <div className={`absolute right-0 z-40 mt-2 w-72 rounded-xl border p-3 shadow-xl backdrop-blur-xl ${meshTheme.isDark ? 'border-white/10 bg-slate-950/96' : 'border-slate-200 bg-white/98 shadow-slate-900/10'}`}>
                                    <div className="flex flex-col gap-3">
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
                                </div>
                            </details>
                        </div>
                    </div>
                </div>

                {/* Bootstrap banner */}
                {isBootstrapMode && canonicalGraph.nodes.length > 0 && (
                    <div className={`shrink-0 mx-4 mt-2 flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs ${meshTheme.isDark ? 'border-amber-400/20 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                        <span className={`h-2 w-2 shrink-0 rounded-full animate-pulse ${meshTheme.isDark ? 'bg-amber-400' : 'bg-amber-500'}`} aria-hidden />
                        <span>Awaiting live data — showing setup inventory until peer mesh_status probes succeed.</span>
                    </div>
                )}

                {/* Graph canvas + right detail panel */}
                <div className="relative flex flex-1 min-w-0" style={{ minHeight: 360 }}>
                    {/* Graph */}
                    <div className="flex-1 min-w-0">
                        {canonicalGraph.nodes.length > 0 ? (
                            <MeshGraphView
                                data={canonicalGraph}
                                selectedNodeId={selectedNodeId}
                                directionPref={directionPref}
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
                    </div>

                    {/* Right sidebar — selected node detail */}
                    {selectedGraphNode && detailSelection?.kind === 'node' && (
                        <div role="dialog" className={`absolute inset-x-3 bottom-3 top-20 sm:relative sm:inset-auto sm:w-72 sm:shrink-0 overflow-y-auto border-l p-4 ${meshTheme.isDark ? 'border-white/8' : 'border-slate-200'}`}>
                            <div className={`mb-2 text-[10px] font-semibold uppercase tracking-wide ${meshTheme.textMuted}`}>Selected node</div>
                            <div className="mb-3 flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{selectedGraphNode.label}</div>
                                    <div className={`mt-0.5 font-mono text-[11px] ${meshTheme.textMuted}`}>{selectedGraphNode.id.slice(0, 16)}</div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    {selectedGraphNode.behind > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => { void handleHealSelectedNode() }}
                                            disabled={!canHealSelectedNode || healingNodeId === selectedGraphNode.id}
                                            className={meshTheme.isDark ? 'rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-45' : 'rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-45'}
                                        >
                                            {healingNodeId === selectedGraphNode.id ? 'Checking' : 'Heal'}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={closeGraphDetail}
                                        aria-label="Close detail panel"
                                        className={meshTheme.isDark ? 'rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs text-slate-200 transition hover:bg-white/[0.08]' : 'rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-50'}
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                            <div className="mb-3 flex flex-wrap gap-1.5">
                                {(() => {
                                    const h = selectedNodeStatus?.health ?? selectedGraphNode.health
                                    return h === 'unknown'
                                        ? <Badge label="connecting..." tone="default" />
                                        : <Badge label={h} tone={healthTone(h)} />
                                })()}
                                {selectedGraphNode.branch && <Badge label={selectedGraphNode.branch} tone="default" />}
                                {selectedGraphNode.ahead > 0 && <Badge label={`ahead ${selectedGraphNode.ahead}`} tone="warn" />}
                                {selectedGraphNode.behind > 0 && <Badge label={`behind ${selectedGraphNode.behind}`} tone="warn" />}
                                {selectedGraphNode.dirtyFiles > 0 && <Badge label={`${selectedGraphNode.dirtyFiles} dirty`} tone="warn" />}
                                {selectedNodeStatus?.connection && selectedNodeStatus.connection.state !== 'unknown' && (
                                    <Badge label={describeConnection(selectedNodeStatus)} tone={connectionTone(selectedNodeStatus.connection)} />
                                )}
                                {selectedNodeStatus?.connection?.state === 'unknown' && (
                                    <Badge label="mesh connecting..." tone="warn" />
                                )}
                                {selectedNodeSessionEntries.length > 0 && <Badge label={`${selectedNodeSessionEntries.length} sessions`} tone="info" />}
                            </div>
                            <div className="grid gap-1.5 text-xs">
                                {selectedGraphNode.machineLabel && (
                                    <Row label="Machine" value={selectedGraphNode.machineLabel} />
                                )}
                                {selectedGraphNode.locality && selectedGraphNode.locality !== 'unknown' && (
                                    <Row label="Locality" value={selectedGraphNode.locality} />
                                )}
                                <Row label="Workspace" value={selectedNodeStatus?.workspace ?? selectedGraphNode.workspace} />
                                {selectedHeadSummary && (
                                    <Row label="HEAD" value={selectedHeadSummary} />
                                )}
                                {(selectedGraphNode.dirtyFiles > 0 || selectedGraphNode.ahead > 0 || selectedGraphNode.behind > 0) && (
                                    <Row label="Dirty/ahead/behind" value={`${selectedGraphNode.dirtyFiles}/${selectedGraphNode.ahead}/${selectedGraphNode.behind}`} />
                                )}
                                {selectedNodeSessionEntries.length > 0 && (
                                    <Row label="Sessions" value={String(selectedNodeSessionEntries.length)} />
                                )}
                                {selectedGraphNode.upstream && (
                                    <Row label="Upstream" value={selectedGraphNode.upstream} />
                                )}
                                {(() => {
                                    const src = selectedNodeStatus?.connection?.source ?? describeGraphNodeSource(selectedGraphNode)
                                    return src && src !== 'unknown' ? <Row label="Source" value={String(src)} /> : null
                                })()}
                                {(() => {
                                    const t = selectedNodeStatus?.connection?.transport
                                    return t && t !== 'unknown' ? <Row label="Transport" value={t} /> : null
                                })()}
                                {(() => {
                                    const mid = selectedGraphNode.machineId ?? selectedNodeStatus?.machineId
                                    return mid ? <Row label="Machine id" value={mid} /> : null
                                })()}
                                {(() => {
                                    const did = selectedGraphNode.daemonId ?? selectedNodeStatus?.daemonId
                                    return did ? <Row label="Daemon id" value={did} /> : null
                                })()}
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
                                                    {(entry.session.workspace || entry.workspace).slice(0, 38)}{entry.branch ? ` · ${entry.branch}` : ''}
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
                        </div>
                    )}

                    {/* Hover preview — node (only when no selection) */}
                    {!selectedGraphNode && hoveredGraphNode && (
                        <div className="pointer-events-none absolute bottom-3 right-4 z-20">
                            <section
                                aria-label="Hovered node preview"
                                className={meshTheme.isDark
                                    ? 'w-[22rem] rounded-2xl border border-white/12 bg-slate-950/94 p-4 shadow-2xl shadow-black/35 backdrop-blur-xl'
                                    : 'w-[22rem] rounded-2xl border border-slate-200 bg-white/96 p-4 shadow-2xl shadow-slate-900/12 backdrop-blur-xl'}
                            >
                                <div className="mb-3 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{hoveredGraphNode.label}</div>
                                        <div className={`mt-1 font-mono text-[11px] ${meshTheme.textMuted}`}>{hoveredGraphNode.id.slice(0, 16)}</div>
                                    </div>
                                    <Badge label="hover preview" tone="info" />
                                </div>
                                <div className="mb-3 flex flex-wrap gap-2">
                                    {hoveredGraphNode.health === 'unknown'
                                        ? <Badge label="..." tone="default" />
                                        : <Badge label={hoveredGraphNode.health} tone={healthTone(hoveredGraphNode.health)} />}
                                    {hoveredGraphNode.branch && <Badge label={hoveredGraphNode.branch} tone="default" />}
                                    {hoveredGraphNode.ahead > 0 && <Badge label={`ahead ${hoveredGraphNode.ahead}`} tone="warn" />}
                                    {hoveredGraphNode.behind > 0 && <Badge label={`behind ${hoveredGraphNode.behind}`} tone="warn" />}
                                    {hoveredGraphNode.dirtyFiles > 0 && <Badge label={`${hoveredGraphNode.dirtyFiles} dirty`} tone="warn" />}
                                    {hoveredGraphNode.activeSessionCount > 0 && <Badge label={`${hoveredGraphNode.activeSessionCount} sessions`} tone="info" />}
                                </div>
                                <div className="grid gap-1.5 text-xs">
                                    {hoveredGraphNode.machineLabel && <Row label="Machine" value={hoveredGraphNode.machineLabel} />}
                                    {hoveredGraphNode.locality && hoveredGraphNode.locality !== 'unknown' && <Row label="Locality" value={hoveredGraphNode.locality} />}
                                    <Row label="Workspace" value={hoveredGraphNode.workspace} />
                                    {hoveredGraphNode.upstream && <Row label="Upstream" value={hoveredGraphNode.upstream} />}
                                    {(() => { const s = describeGraphNodeSource(hoveredGraphNode); return s && s !== 'unknown' ? <Row label="Source" value={s} /> : null })()}
                                </div>
                            </section>
                        </div>
                    )}

                    {/* Hover preview — edge */}
                    {!selectedGraphNode && !hoveredGraphNode && hoveredGraphEdge && (
                        <div className="pointer-events-none absolute bottom-3 right-4 z-20">
                            <section
                                aria-label="Hovered edge preview"
                                className={meshTheme.isDark
                                    ? 'w-[20rem] rounded-2xl border border-white/12 bg-slate-950/94 p-4 shadow-2xl shadow-black/35 backdrop-blur-xl'
                                    : 'w-[20rem] rounded-2xl border border-slate-200 bg-white/96 p-4 shadow-2xl shadow-slate-900/12 backdrop-blur-xl'}
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
                </div>
            </div>

        </div>
        </MeshGraphThemeContext.Provider>
    )
}
