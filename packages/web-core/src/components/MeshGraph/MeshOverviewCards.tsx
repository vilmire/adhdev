import { useMemo, useState } from 'react'
import type {
    MeshMissionStatus,
    MeshMissionSummary,
    RepoMeshLedgerSummaryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueSummary,
    RepoMeshStatus,
} from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import { canonicalizeRepoMeshStatus } from '../../utils/repo-mesh-status'
import type { MeshGraphSessionDetail } from '../../utils/mesh-visualization'

/**
 * MeshOverviewCards — the text/card "Overview" surface for a mesh. This is the
 * default tab shown by MeshObservabilitySurface; the graph lives behind the
 * "Graph" tab. It renders, top to bottom:
 *   1. Active/paused missions + a collapsible completed/abandoned history.
 *   2. Ledger and Queue stat-tile grids side by side.
 *   3. The node list (health, branch, drift, sessions, convergence/refine badges).
 *   4. Active sessions + refine jobs as a two-up row of small cards.
 *
 * It is intentionally self-contained (no shared mutable state with the graph
 * surface) so the graph component stays untouched. Mission data is optional —
 * older daemons omit `status.missions`, in which case the mission card renders
 * an empty state.
 */

type Tone = 'rose' | 'sky' | 'amber' | 'emerald' | 'muted' | 'default'

type AsyncRefineJob = {
    jobId: string
    status: 'accepted' | 'running' | 'completed' | 'failed'
    branch?: string
    into?: string
    completedAt?: string
    startedAt?: string
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

function shortSessionId(sessionId: string): string {
    if (sessionId.length <= 18) return sessionId
    return `${sessionId.slice(0, 10)}...${sessionId.slice(-4)}`
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

function nodeDriftSummary(node: RepoMeshNodeStatus): string {
    const git = node.git
    if (!git) return node.gitProbePending ? 'git probe pending' : 'no git probe'
    const changes = (git.staged ?? 0) + (git.modified ?? 0) + (git.untracked ?? 0) + (git.deleted ?? 0) + (git.renamed ?? 0)
    const parts: string[] = []
    if (git.upstreamStatus === 'fresh' && ((git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0)) parts.push(`↑${git.ahead ?? 0}/↓${git.behind ?? 0}`)
    if (changes > 0) parts.push(`✎${changes}`)
    if (git.hasConflicts) parts.push('conflicts')
    return parts.join(' · ') || 'clean'
}

function missionStatusTone(status: MeshMissionStatus): Tone {
    switch (status) {
        case 'active': return 'emerald'
        case 'paused': return 'amber'
        case 'completed': return 'sky'
        case 'abandoned': return 'rose'
        default: return 'muted'
    }
}

function healthTone(health: string): Tone {
    switch (health) {
        case 'online': return 'emerald'
        case 'dirty': return 'amber'
        case 'degraded':
        case 'offline': return 'rose'
        case 'wrong_branch': return 'sky'
        default: return 'muted'
    }
}

function relativeTime(iso: string | null | undefined): string | null {
    if (!iso) return null
    const parsed = Date.parse(iso)
    if (!Number.isFinite(parsed)) return null
    const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000))
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
}

export default function MeshOverviewCards({ status }: { status: RepoMeshStatus }) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const canonicalStatus = useMemo(() => canonicalizeRepoMeshStatus(status), [status])

    const queueSummary: RepoMeshQueueSummary | null = canonicalStatus.queue?.summary ?? null
    const ledgerSummary = canonicalStatus.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const missions = (canonicalStatus as RepoMeshStatus).missions ?? []
    const liveMissions = missions.filter(m => m.status === 'active' || m.status === 'paused')
    const historyMissions = missions.filter(m => m.status === 'completed' || m.status === 'abandoned')
    const asyncRefineJobs = ((canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined) ?? []

    const sessionEntries = useMemo(() => {
        const entries: { node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }[] = []
        for (const node of canonicalStatus.nodes) {
            const sessions: MeshGraphSessionDetail[] = (node.activeSessionDetails && node.activeSessionDetails.length > 0)
                ? node.activeSessionDetails as MeshGraphSessionDetail[]
                : (node.activeSessions ?? []).map(sessionId => ({ sessionId, workspace: node.workspace, isCached: true }))
            for (const session of sessions) entries.push({ node, session })
        }
        return entries
    }, [canonicalStatus.nodes])

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2">
            <MissionsCard
                meshTheme={meshTheme}
                liveMissions={liveMissions}
                historyMissions={historyMissions}
                hasMissionField={Array.isArray((canonicalStatus as RepoMeshStatus).missions)}
            />

            <div className="grid gap-3 sm:grid-cols-2">
                <LedgerCard meshTheme={meshTheme} ledgerSummary={ledgerSummary} />
                <QueueCard meshTheme={meshTheme} queueSummary={queueSummary} />
            </div>

            <NodesCard meshTheme={meshTheme} nodes={canonicalStatus.nodes} />

            <div className="grid gap-3 sm:grid-cols-2">
                <SessionsCard meshTheme={meshTheme} entries={sessionEntries} />
                <RefineJobsCard meshTheme={meshTheme} jobs={asyncRefineJobs} />
            </div>
        </div>
    )
}

// ── shared card primitives ───────────────────────────────────────────────

function Card({ meshTheme, title, count, children, action }: {
    meshTheme: MeshGraphTheme
    title: string
    count?: number | string
    children: React.ReactNode
    action?: React.ReactNode
}) {
    const dk = meshTheme.isDark
    return (
        <div className={`flex flex-col rounded-2xl border p-4 ${dk ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-white/80'}`}>
            <div className="mb-3 flex items-center gap-2">
                <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>{title}</span>
                {count !== undefined && (
                    <span className={`tabular-nums text-[11px] ${meshTheme.textMuted}`}>{count}</span>
                )}
                {action && <span className="ml-auto">{action}</span>}
            </div>
            {children}
        </div>
    )
}

function StatusBadge({ meshTheme, label, tone }: { meshTheme: MeshGraphTheme; label: string; tone: Tone }) {
    const dk = meshTheme.isDark
    const cls = tone === 'rose' ? (dk ? 'border-rose-400/30 bg-rose-500/12 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700')
        : tone === 'sky' ? (dk ? 'border-sky-400/25 bg-sky-500/10 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700')
        : tone === 'amber' ? (dk ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700')
        : tone === 'emerald' ? (dk ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-emerald-300 bg-emerald-50 text-emerald-700')
        : (dk ? 'border-white/10 bg-white/[0.04] text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600')
    return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${cls}`}>{label}</span>
}

function StatTile({ meshTheme, label, value, tone }: { meshTheme: MeshGraphTheme; label: string; value: number | string; tone?: Tone }) {
    const dk = meshTheme.isDark
    const valClass = tone === 'rose' ? (dk ? 'text-rose-300' : 'text-rose-600')
        : tone === 'sky' ? (dk ? 'text-sky-300' : 'text-sky-600')
        : tone === 'amber' ? (dk ? 'text-amber-300' : 'text-amber-600')
        : tone === 'emerald' ? (dk ? 'text-emerald-300' : 'text-emerald-600')
        : tone === 'muted' ? meshTheme.textMuted
        : meshTheme.textPrimary
    return (
        <div className={`flex flex-col items-center rounded-lg border px-2 py-2 ${dk ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-white/70'}`}>
            <span className={`tabular-nums text-base font-semibold leading-none ${valClass}`}>{value}</span>
            <span className={`mt-1 text-[9px] uppercase tracking-wide ${meshTheme.textMuted}`}>{label}</span>
        </div>
    )
}

function EmptyHint({ meshTheme, children }: { meshTheme: MeshGraphTheme; children: React.ReactNode }) {
    return <div className={`text-xs ${meshTheme.textMuted}`}>{children}</div>
}

// ── missions ──────────────────────────────────────────────────────────────

function MissionRow({ meshTheme, mission }: { meshTheme: MeshGraphTheme; mission: MeshMissionSummary }) {
    const dk = meshTheme.isDark
    const t = mission.tasks
    const lastActivity = relativeTime(t.lastActivityAt)
    return (
        <div className={`flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
            <div className="flex items-center gap-2">
                <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${meshTheme.textPrimary}`} title={mission.title}>{mission.title}</span>
                <StatusBadge meshTheme={meshTheme} label={mission.status} tone={missionStatusTone(mission.status)} />
            </div>
            {mission.goal && (
                <div className={`line-clamp-2 text-xs ${meshTheme.textSecondary}`} title={mission.goal}>{mission.goal}</div>
            )}
            <div className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] ${meshTheme.textMuted}`}>
                <span className="tabular-nums">{t.total} tasks</span>
                <span className={`tabular-nums ${t.completed > 0 ? (dk ? 'text-emerald-300' : 'text-emerald-600') : ''}`}>✓{t.completed}</span>
                <span className={`tabular-nums ${t.assigned > 0 ? (dk ? 'text-sky-300' : 'text-sky-600') : ''}`}>▶{t.assigned}</span>
                <span className="tabular-nums">⏳{t.pending}{t.blocked > 0 ? ` (${t.blocked} blocked)` : ''}</span>
                <span className={`tabular-nums ${t.failed > 0 ? (dk ? 'text-rose-300' : 'text-rose-600') : ''}`}>✗{t.failed}</span>
                {lastActivity && <span className="ml-auto">{lastActivity}</span>}
            </div>
        </div>
    )
}

function MissionsCard({ meshTheme, liveMissions, historyMissions, hasMissionField }: {
    meshTheme: MeshGraphTheme
    liveMissions: MeshMissionSummary[]
    historyMissions: MeshMissionSummary[]
    hasMissionField: boolean
}) {
    const [showHistory, setShowHistory] = useState(false)
    const dk = meshTheme.isDark
    return (
        <Card meshTheme={meshTheme} title="Missions" count={liveMissions.length || undefined}>
            {liveMissions.length > 0 ? (
                <div className="flex flex-col gap-2">
                    {liveMissions.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} />)}
                </div>
            ) : (
                <EmptyHint meshTheme={meshTheme}>
                    {hasMissionField
                        ? 'No active missions. The coordinator creates a mission for multi-task work.'
                        : 'Mission data unavailable from this daemon — update the daemon to see missions.'}
                </EmptyHint>
            )}

            {historyMissions.length > 0 && (
                <div className={`mt-3 border-t pt-2 ${dk ? 'border-white/8' : 'border-slate-200'}`}>
                    <button
                        type="button"
                        onClick={() => setShowHistory(v => !v)}
                        className={`flex w-full items-center gap-1.5 text-[11px] font-medium ${meshTheme.textSecondary}`}
                    >
                        <span className={`inline-block transition-transform ${showHistory ? 'rotate-90' : ''}`}>▸</span>
                        <span>Completed / abandoned history</span>
                        <span className={`tabular-nums ${meshTheme.textMuted}`}>{historyMissions.length}</span>
                    </button>
                    {showHistory && (
                        <div className="mt-2 flex flex-col gap-2">
                            {historyMissions.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} />)}
                        </div>
                    )}
                </div>
            )}
        </Card>
    )
}

// ── ledger / queue ──────────────────────────────────────────────────────────

function LedgerCard({ meshTheme, ledgerSummary }: { meshTheme: MeshGraphTheme; ledgerSummary: RepoMeshLedgerSummaryStatus }) {
    const lastActivity = relativeTime(ledgerSummary.lastActivityAt)
    return (
        <Card meshTheme={meshTheme} title="Ledger">
            <div className="grid grid-cols-3 gap-1.5">
                <StatTile meshTheme={meshTheme} label="Dispatched" value={ledgerSummary.taskDispatched} />
                <StatTile meshTheme={meshTheme} label="Completed" value={ledgerSummary.taskCompleted} tone="emerald" />
                <StatTile meshTheme={meshTheme} label="Failed" value={ledgerSummary.taskFailed} tone={ledgerSummary.taskFailed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label="Stalled" value={ledgerSummary.taskStalled} tone={ledgerSummary.taskStalled > 0 ? 'amber' : undefined} />
                <StatTile meshTheme={meshTheme} label="Sessions" value={ledgerSummary.sessionLaunched} />
                <StatTile meshTheme={meshTheme} label="Checkpoints" value={ledgerSummary.checkpointCreated} />
            </div>
            {(ledgerSummary.recentFailures > 0 || lastActivity) && (
                <div className={`mt-2 flex items-center justify-between text-[11px] ${meshTheme.textMuted}`}>
                    {ledgerSummary.recentFailures > 0
                        ? <span className={meshTheme.isDark ? 'text-amber-300' : 'text-amber-600'}>{ledgerSummary.recentFailures} recent failures</span>
                        : <span />}
                    {lastActivity && <span>{lastActivity}</span>}
                </div>
            )}
        </Card>
    )
}

function QueueCard({ meshTheme, queueSummary }: { meshTheme: MeshGraphTheme; queueSummary: RepoMeshQueueSummary | null }) {
    if (!queueSummary) {
        return (
            <Card meshTheme={meshTheme} title="Queue">
                <EmptyHint meshTheme={meshTheme}>No queue activity.</EmptyHint>
            </Card>
        )
    }
    return (
        <Card meshTheme={meshTheme} title="Queue" count={queueSummary.active > 0 ? `${queueSummary.active} active` : undefined}>
            <div className="grid grid-cols-3 gap-1.5">
                <StatTile meshTheme={meshTheme} label="Pending" value={queueSummary.pending} />
                <StatTile meshTheme={meshTheme} label="Assigned" value={queueSummary.assigned} tone={queueSummary.assigned > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label="Active" value={queueSummary.active} tone={queueSummary.active > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label="Completed" value={queueSummary.completed} tone="emerald" />
                <StatTile meshTheme={meshTheme} label="Failed" value={queueSummary.failed} tone={queueSummary.failed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label="Cancelled" value={queueSummary.cancelled} tone="muted" />
            </div>
        </Card>
    )
}

// ── nodes ───────────────────────────────────────────────────────────────────

function convergenceBadge(node: RepoMeshNodeStatus): { label: string; tone: Tone } | null {
    if (node.autoFastForwardEligible || node.suggestedAction === 'auto_fast_forward') return { label: 'fast-forward', tone: 'sky' }
    if (node.launchBlockedReason) return { label: 'blocked', tone: 'rose' }
    return null
}

function NodesCard({ meshTheme, nodes }: { meshTheme: MeshGraphTheme; nodes: RepoMeshNodeStatus[] }) {
    const dk = meshTheme.isDark
    return (
        <Card meshTheme={meshTheme} title="Nodes" count={nodes.length}>
            {nodes.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>No nodes in this mesh yet.</EmptyHint>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {nodes.map(node => {
                        const sessionCount = (node.activeSessionDetails?.length ?? 0) || (node.activeSessions?.length ?? 0)
                        const conv = convergenceBadge(node)
                        const branch = node.git?.branch ?? node.worktreeBranch ?? null
                        return (
                            <div key={node.nodeId} className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2 ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
                                <StatusBadge meshTheme={meshTheme} label={node.health} tone={healthTone(node.health)} />
                                <span className={`min-w-0 max-w-full flex-1 truncate text-sm font-medium ${meshTheme.textPrimary}`} title={node.workspace}>{node.machineLabel}</span>
                                {branch && <span className={`shrink-0 font-mono text-[11px] ${meshTheme.textSecondary}`}>{branch}</span>}
                                <span className={`shrink-0 font-mono text-[10px] ${meshTheme.textMuted}`}>{nodeDriftSummary(node)}</span>
                                {sessionCount > 0 && <span className={`shrink-0 text-[10px] ${meshTheme.textMuted}`}>{sessionCount} session{sessionCount > 1 ? 's' : ''}</span>}
                                {conv && <StatusBadge meshTheme={meshTheme} label={conv.label} tone={conv.tone} />}
                            </div>
                        )
                    })}
                </div>
            )}
        </Card>
    )
}

// ── sessions / refine jobs ──────────────────────────────────────────────────

function SessionsCard({ meshTheme, entries }: {
    meshTheme: MeshGraphTheme
    entries: { node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }[]
}) {
    return (
        <Card meshTheme={meshTheme} title="Active sessions" count={entries.length || undefined}>
            {entries.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>No active sessions.</EmptyHint>
            ) : (
                <div className="flex flex-col gap-1">
                    {entries.map(({ session }) => (
                        <div key={session.sessionId} className="flex items-center gap-2 text-xs">
                            <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${meshTheme.textMuted}`} title={session.sessionId}>{shortSessionId(session.sessionId)}</span>
                            <span className={`shrink-0 ${meshTheme.textMuted}`}>{session.providerType || '?'}</span>
                            <span className={`shrink-0 text-[10px] font-semibold ${meshTheme.textSecondary}`}>{sessionStatusLabel(session)}</span>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    )
}

function RefineJobsCard({ meshTheme, jobs }: { meshTheme: MeshGraphTheme; jobs: AsyncRefineJob[] }) {
    const dk = meshTheme.isDark
    const failed = jobs.filter(j => j.status === 'failed').length
    return (
        <Card
            meshTheme={meshTheme}
            title="Refine jobs"
            count={jobs.length || undefined}
            action={failed > 0 ? <StatusBadge meshTheme={meshTheme} label={`${failed} failed`} tone="rose" /> : undefined}
        >
            {jobs.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>No refine jobs.</EmptyHint>
            ) : (
                <div className="flex flex-col gap-1">
                    {jobs.slice(0, 8).map(job => (
                        <div key={job.jobId} className="flex items-center gap-2 text-xs">
                            <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${meshTheme.textMuted}`}>
                                {job.branch ?? job.jobId.slice(0, 14)}{job.into ? ` → ${job.into}` : ''}
                            </span>
                            <span className={`shrink-0 text-[10px] font-semibold ${
                                job.status === 'failed' ? (dk ? 'text-rose-300' : 'text-rose-600')
                                : job.status === 'running' || job.status === 'accepted' ? (dk ? 'text-sky-300' : 'text-sky-600')
                                : (dk ? 'text-emerald-300' : 'text-emerald-600')
                            }`}>{job.status}</span>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    )
}
