import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { describeQueueTaskMessage } from '../../utils/queue-task-label'
import type {
    MeshMissionStatus,
    MeshMissionSummary,
    MeshMissionSlimSummary,
    RepoMeshLedgerEntryStatus,
    RepoMeshLedgerSummaryStatus,
    RepoMeshNodeStatus,
    RepoMeshQueueSummary,
    RepoMeshQueueTask,
    RepoMeshStatus,
} from '@adhdev/daemon-core'

/**
 * Mission summary as it arrives on the wire: compact status calls send the slim
 * shape (`goalPreview`/`goalTruncated`, no `goal`), verbose sends the full
 * `goal`. Both may carry an optional `stats` rollup. Read `goal ?? goalPreview`.
 */
type MeshMissionDisplay = MeshMissionSummary | MeshMissionSlimSummary
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import type { MeshGraphSessionDetail } from '../../utils/mesh-visualization'
import PendingApprovalsInbox, { type PendingApprovalAction } from './PendingApprovalsInbox'

/**
 * MeshOverviewCards — the text/card "Overview" surface for a mesh. This is the
 * default tab shown by MeshObservabilitySurface; the graph lives behind the
 * "Graph" tab. It renders, top to bottom:
 *   1. Active/paused missions + a collapsible completed/abandoned history.
 *   2. Ledger and Queue stat-tile grids side by side.
 *   3. The node list (health, branch, drift, sessions, convergence/refine badges).
 *   4. Active sessions + refine jobs as a two-up row of small cards.
 *
 * Every overview card follows the same shape: a small stat header, a compact
 * "recent ~5" one-line list, a "+N more" toggle, and a click target on each row
 * that opens a shared detail modal (the same Row/Badge visual language the graph
 * surface's right panel uses). Hover is no longer the primary path to detail —
 * the user found clicking more effective — so rows are buttons that pin a modal.
 *
 * It is intentionally self-contained (no shared mutable state with the graph
 * surface) so the graph component stays untouched. Mission data is optional —
 * older daemons omit `status.missions`, in which case the mission card renders
 * an empty state.
 */

type Tone = 'rose' | 'sky' | 'amber' | 'emerald' | 'muted' | 'default'

/** How many rows each overview card shows before the "+N more" toggle. */
const RECENT_LIMIT = 5

/**
 * Hard cap on how many recent queue rows the expanded view will ever render.
 * The queue can hold thousands of historical tasks; the "+N more" toggle used
 * to dump every one into the DOM. Bound the list before it reaches the UI.
 */
const RECENT_QUEUE_MAX = 40

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

function sessionStatusTone(label: string): Tone {
    if (label.includes('approval')) return 'amber'
    if (label.includes('generating')) return 'sky'
    if (label.includes('idle')) return 'emerald'
    if (label.includes('failed') || label.includes('stopped') || label.includes('interrupted')) return 'rose'
    return 'muted'
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

function queueTaskTone(status: RepoMeshQueueTask['status']): Tone {
    switch (status) {
        case 'completed': return 'emerald'
        case 'failed': return 'rose'
        case 'cancelled': return 'muted'
        case 'assigned': return 'sky'
        case 'pending': return 'amber'
        default: return 'muted'
    }
}

/** Priority for the "recent queue" list: live work first, then newest history. */
function queueTaskSortRank(status: RepoMeshQueueTask['status']): number {
    switch (status) {
        case 'assigned': return 0
        case 'pending': return 1
        // All historical statuses collapse to one rank so they interleave purely
        // by updatedAt desc (the tiebreaker) — a days-old failed task no longer
        // unconditionally pins above newer completed/cancelled rows.
        case 'completed':
        case 'failed':
        case 'cancelled': return 2
        default: return 3
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

/** Human-readable duration from a millisecond span, e.g. 83000 → "1m 23s". */
function formatDuration(ms: number | null | undefined): string | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
    if (ms < 1000) return `${Math.round(ms)}ms`
    const totalSeconds = Math.round(ms / 1000)
    const seconds = totalSeconds % 60
    const totalMinutes = Math.floor(totalSeconds / 60)
    const minutes = totalMinutes % 60
    const hours = Math.floor(totalMinutes / 60)
    const parts: string[] = []
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0) parts.push(`${minutes}m`)
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
    return parts.join(' ')
}

function ledgerKindLabel(kind: string): string {
    return kind.replace(/[_-]+/g, ' ')
}

function ledgerKindTone(kind: string): Tone {
    const k = kind.toLowerCase()
    if (k.includes('fail') || k.includes('stall') || k.includes('error')) return 'rose'
    if (k.includes('complete')) return 'emerald'
    if (k.includes('dispatch') || k.includes('launch') || k.includes('assign')) return 'sky'
    if (k.includes('checkpoint')) return 'amber'
    return 'muted'
}

function payloadSummary(payload: Record<string, unknown> | undefined): string | null {
    if (!payload) return null
    const candidate = payload.message ?? payload.summary ?? payload.reason ?? payload.title
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    return null
}

// ── detail modal selection ───────────────────────────────────────────────────

type DetailSelection =
    | { kind: 'mission'; mission: MeshMissionDisplay }
    | { kind: 'ledger'; entry: RepoMeshLedgerEntryStatus }
    | { kind: 'queue'; task: RepoMeshQueueTask }
    | { kind: 'session'; node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }

/** Command seam used to fetch the verbose (full-goal) mission payload on demand. */
type MeshCommandSeam = {
    daemonId?: string | null
    meshId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}

export default function MeshOverviewCards({
    status: canonicalStatus,
    daemonId = null,
    meshId = null,
    sendDaemonCommand = null,
}: { status: RepoMeshStatus } & MeshCommandSeam) {
    // `status` is already canonicalized once at the data boundary by the parent
    // (MeshObservabilitySurface calls canonicalizeRepoMeshStatus and passes the
    // result in), so nodes/queue/ledger are guaranteed arrays and we do NOT
    // canonicalize a second time here — a canonical status is the SSOT that flows
    // down. Aliased to `canonicalStatus` to make that contract explicit.
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])

    const queueSummary: RepoMeshQueueSummary | null = canonicalStatus.queue?.summary ?? null
    const queueTasks: RepoMeshQueueTask[] = canonicalStatus.queue?.tasks ?? []
    const ledgerSummary = canonicalStatus.ledger?.summary ?? EMPTY_LEDGER_SUMMARY
    const ledgerEntries: RepoMeshLedgerEntryStatus[] = canonicalStatus.ledger?.entries ?? []
    const missions = (canonicalStatus as RepoMeshStatus).missions ?? []
    const liveMissions = missions.filter(m => m.status === 'active' || m.status === 'paused')
    const historyMissions = missions.filter(m => m.status === 'completed' || m.status === 'abandoned')
    const asyncRefineJobs = ((canonicalStatus as any).asyncRefineJobs as AsyncRefineJob[] | undefined) ?? []

    const [detail, setDetail] = useState<DetailSelection | null>(null)
    const closeDetail = useCallback(() => setDetail(null), [])

    // Resolve a mesh-wide pending approval through the daemon command seam. Routes to the
    // coordinator's mesh_approve, which forwards resolve_action to the target node+session.
    // Null seam (no daemon connection) → no-op; the inbox stays read-only in that case.
    const resolveApproval = useCallback(
        async (nodeId: string, sessionId: string, action: PendingApprovalAction) => {
            if (!daemonId || !sendDaemonCommand) return
            await sendDaemonCommand(daemonId, 'mesh_approve', {
                meshId: meshId ?? undefined,
                node_id: nodeId,
                session_id: sessionId,
                action,
            })
        },
        [daemonId, meshId, sendDaemonCommand],
    )

    // nodeId → friendly machine label (nickname → workspace·host·provider), so
    // ledger rows show the human-readable machine instead of a raw node_/daemon_ id.
    // Falls back to the raw id when the node isn't in the current snapshot.
    const resolveNodeLabel = useCallback((nodeId: string | undefined | null): string => {
        if (!nodeId) return ''
        const node = canonicalStatus.nodes.find(n => n.nodeId === nodeId)
        return node?.machineLabel || nodeId
    }, [canonicalStatus.nodes])

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
        // Plain flow content — the scroll container lives one level up in
        // MeshObservabilitySurface (the Overview tab wrapper). Keeping this a
        // non-scrolling, non-flex-1 column lets the wrapper's overflow-y-auto own
        // scrolling so all cards remain reachable in the dashboard full view.
        <div className="flex flex-col gap-3 pb-2">
            <PendingApprovalsInbox nodes={canonicalStatus.nodes} onResolve={resolveApproval} />

            <MissionsCard
                meshTheme={meshTheme}
                liveMissions={liveMissions}
                historyMissions={historyMissions}
                hasMissionField={Array.isArray((canonicalStatus as RepoMeshStatus).missions)}
                onSelect={mission => setDetail({ kind: 'mission', mission })}
            />

            <div className="grid gap-3 sm:grid-cols-2">
                <LedgerCard
                    meshTheme={meshTheme}
                    ledgerSummary={ledgerSummary}
                    entries={ledgerEntries}
                    resolveNodeLabel={resolveNodeLabel}
                    onSelect={entry => setDetail({ kind: 'ledger', entry })}
                />
                <QueueCard
                    meshTheme={meshTheme}
                    queueSummary={queueSummary}
                    tasks={queueTasks}
                    onSelect={task => setDetail({ kind: 'queue', task })}
                />
            </div>

            <NodesCard meshTheme={meshTheme} nodes={canonicalStatus.nodes} />

            <div className="grid gap-3 sm:grid-cols-2">
                <SessionsCard
                    meshTheme={meshTheme}
                    entries={sessionEntries}
                    onSelect={(node, session) => setDetail({ kind: 'session', node, session })}
                />
                <RefineJobsCard meshTheme={meshTheme} jobs={asyncRefineJobs} />
            </div>

            {detail && (
                <DetailModal
                    meshTheme={meshTheme}
                    detail={detail}
                    onClose={closeDetail}
                    daemonId={daemonId}
                    meshId={meshId ?? canonicalStatus.meshId ?? null}
                    sendDaemonCommand={sendDaemonCommand}
                    resolveNodeLabel={resolveNodeLabel}
                />
            )}
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
    // min-w-0 + overflow-hidden so this card can shrink inside a flex/grid parent
    // on narrow (~360px) viewports instead of forcing its track wider than the
    // viewport — the root cause of the mobile horizontal scroll.
    return (
        <div className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border p-4 ${dk ? 'border-white/8 bg-white/[0.03]' : 'border-slate-200 bg-white/80'}`}>
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

/**
 * Clickable one-line row used by every "recent N" list. The whole row is a
 * button so the click target opens the shared detail modal — consistent across
 * Mission / Ledger / Queue / Session cards.
 */
function ListRow({ meshTheme, onClick, children }: {
    meshTheme: MeshGraphTheme
    onClick?: () => void
    children: React.ReactNode
}) {
    const dk = meshTheme.isDark
    const hover = onClick ? (dk ? 'hover:bg-white/[0.05]' : 'hover:bg-slate-100/70') : ''
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            className={`flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-left text-xs transition ${hover} ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
        >
            {children}
        </button>
    )
}

/** "+N more" / "show fewer" toggle shared by the recent lists. */
function MoreToggle({ meshTheme, expanded, hiddenCount, onToggle }: {
    meshTheme: MeshGraphTheme
    expanded: boolean
    hiddenCount: number
    onToggle: () => void
}) {
    if (hiddenCount <= 0) return null
    return (
        <button
            type="button"
            onClick={onToggle}
            className={`mt-1 self-start rounded-md px-1.5 py-0.5 text-[11px] font-medium ${meshTheme.textSecondary} hover:underline`}
        >
            {expanded ? 'Show fewer' : `+${hiddenCount} more`}
        </button>
    )
}

/** Drives the expand/collapse + "+N more" slice for a recent list. */
function useRecentList<T>(items: T[], limit = RECENT_LIMIT) {
    const [expanded, setExpanded] = useState(false)
    const visible = expanded ? items : items.slice(0, limit)
    const hiddenCount = Math.max(0, items.length - limit)
    const toggle = useCallback(() => setExpanded(v => !v), [])
    return { visible, hiddenCount, expanded, toggle }
}

// ── shared detail modal ──────────────────────────────────────────────────────
// Reuses the graph surface's Row/Badge visual language so detail looks identical
// whether opened from the overview cards or the graph node panel.

function ModalRow({ meshTheme, label, value }: { meshTheme: MeshGraphTheme; label: string; value: ReactNode }) {
    return (
        <div className={meshTheme.rowClass}>
            <span className={meshTheme.rowLabelClass}>{label}</span>
            <span className={meshTheme.rowValueClass}>{value}</span>
        </div>
    )
}

function detailTitle(detail: DetailSelection): { kicker: string; title: string } {
    switch (detail.kind) {
        case 'mission': return { kicker: 'Mission', title: detail.mission.title }
        case 'ledger': return { kicker: 'Ledger entry', title: ledgerKindLabel(detail.entry.kind) }
        case 'queue': return { kicker: 'Queue task', title: detail.task.id }
        case 'session': return { kicker: 'Session', title: shortSessionId(detail.session.sessionId) }
    }
}

function DetailModal({ meshTheme, detail, onClose, daemonId, meshId, sendDaemonCommand, resolveNodeLabel }: {
    meshTheme: MeshGraphTheme
    detail: DetailSelection
    onClose: () => void
    resolveNodeLabel: (nodeId: string | undefined | null) => string
} & MeshCommandSeam) {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [onClose])

    const dk = meshTheme.isDark
    const { kicker, title } = detailTitle(detail)
    const overlayClass = dk ? 'bg-[#030617]/[0.92]' : 'bg-[rgba(15,23,42,0.82)]'
    const shellClass = dk
        ? 'border-white/10 bg-slate-950 md:bg-slate-950/98 shadow-[0_28px_120px_rgba(2,6,23,0.5)]'
        : 'border-slate-200 bg-white md:bg-white/98 shadow-[0_28px_120px_rgba(148,163,184,0.3)]'

    return (
        <div
            className={`fixed inset-0 z-[var(--z-modal)] flex items-stretch justify-center p-0 md:items-center md:p-4 ${overlayClass}`}
            role="dialog"
            aria-modal="true"
            onClick={onClose}
        >
            <div
                className={`flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden border ${shellClass} md:h-auto md:max-h-[88dvh] md:max-w-[min(640px,calc(100vw-32px))] md:rounded-2xl`}
                onClick={event => event.stopPropagation()}
            >
                <div className={`sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 ${dk ? 'border-white/8' : 'border-slate-200'}`}>
                    <div className="min-w-0">
                        <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>{kicker}</div>
                        <div className={`mt-0.5 break-all text-sm font-semibold ${meshTheme.textPrimary}`}>{title}</div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close detail"
                        className={dk ? 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.08] hover:text-white' : 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900'}
                    >
                        ✕
                    </button>
                </div>
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">
                    {detail.kind === 'mission' && (
                        <MissionDetail
                            meshTheme={meshTheme}
                            mission={detail.mission}
                            daemonId={daemonId}
                            meshId={meshId}
                            sendDaemonCommand={sendDaemonCommand}
                        />
                    )}
                    {detail.kind === 'ledger' && <LedgerDetail meshTheme={meshTheme} entry={detail.entry} resolveNodeLabel={resolveNodeLabel} />}
                    {detail.kind === 'queue' && <QueueDetail meshTheme={meshTheme} task={detail.task} />}
                    {detail.kind === 'session' && <SessionDetail meshTheme={meshTheme} node={detail.node} session={detail.session} />}
                </div>
            </div>
        </div>
    )
}

const unwrapResult = (raw: any): any => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

/** Pull RepoMeshStatus out of a mesh_status response (cloud/P2P wraps under result / result.status). */
function extractMeshStatus(raw: any): any {
    const body = unwrapResult(raw)
    if (body && typeof body === 'object' && body.status && typeof body.status === 'object' && Array.isArray(body.status.missions)) return body.status
    return body
}

function MissionDetail({ meshTheme, mission, daemonId, meshId, sendDaemonCommand }: {
    meshTheme: MeshGraphTheme
    mission: MeshMissionDisplay
} & MeshCommandSeam) {
    const t = mission.tasks
    // Compact (slim) status payloads send `goalPreview`/`goalTruncated` instead of
    // the full `goal`, so the previous `mission.goal`-only read rendered blank.
    const slimGoal = ('goal' in mission && typeof mission.goal === 'string' && mission.goal)
        ? mission.goal
        : ('goalPreview' in mission ? mission.goalPreview : '')
    const goalTruncated = 'goalTruncated' in mission ? mission.goalTruncated === true : false

    // Full goal fetched on demand via the verbose mesh_status seam — mirrors the
    // /mesh page's MeshMissionsSection so the dialog detail can also reveal the
    // complete goal instead of stopping at the truncated preview.
    const [fullGoal, setFullGoal] = useState<string | null>(null)
    const [fetching, setFetching] = useState(false)
    const [fetchError, setFetchError] = useState<string | null>(null)
    const canFetchGoal = goalTruncated && !fullGoal && !!daemonId && !!sendDaemonCommand

    const fetchFullGoal = useCallback(async () => {
        if (!daemonId || !sendDaemonCommand) return
        setFetching(true)
        setFetchError(null)
        try {
            const raw = await sendDaemonCommand(daemonId, 'mesh_status', { meshId: meshId ?? undefined, verbose: true })
            const verbose = extractMeshStatus(raw)
            const verboseMissions: any[] = Array.isArray(verbose?.missions) ? verbose.missions : []
            const match = verboseMissions.find(m => m?.id === mission.id)
            const goal = typeof match?.goal === 'string' && match.goal ? match.goal : null
            if (goal) setFullGoal(goal)
            else setFetchError('Full goal unavailable')
        } catch (err) {
            setFetchError(err instanceof Error ? err.message : 'Failed to fetch full mission goal')
        } finally {
            setFetching(false)
        }
    }, [daemonId, meshId, sendDaemonCommand, mission.id])

    const goalText = fullGoal ?? slimGoal
    const showTruncatedLabel = goalTruncated && !fullGoal
    const stats = mission.stats ?? null
    const incompleteCount = stats?.incompleteTaskIds?.length ?? 0
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={mission.status} tone={missionStatusTone(mission.status)} />
                <StatusBadge meshTheme={meshTheme} label={`${t.total} tasks`} tone="muted" />
            </div>
            {goalText && (
                <div className={`max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>
                    {goalText}
                    {showTruncatedLabel && !canFetchGoal && <span className={meshTheme.textMuted}> … (truncated)</span>}
                </div>
            )}
            {fetchError && <div className="text-[11px] text-amber-400">{fetchError}</div>}
            {canFetchGoal && (
                <button
                    type="button"
                    className="self-start text-[12px] text-accent-primary hover:underline disabled:opacity-50"
                    onClick={fetchFullGoal}
                    disabled={fetching}
                >
                    {fetching ? 'Loading…' : 'Show full goal'}
                </button>
            )}
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                <StatTile meshTheme={meshTheme} label="Completed" value={t.completed} tone="emerald" />
                <StatTile meshTheme={meshTheme} label="Assigned" value={t.assigned} tone={t.assigned > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label="Pending" value={t.pending} />
                <StatTile meshTheme={meshTheme} label="Failed" value={t.failed} tone={t.failed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label="Blocked" value={t.blocked} tone={t.blocked > 0 ? 'amber' : undefined} />
                <StatTile meshTheme={meshTheme} label="Cancelled" value={t.cancelled} tone="muted" />
            </div>
            {stats && (
                <div className="grid grid-cols-3 gap-1.5">
                    <StatTile meshTheme={meshTheme} label="Wall clock" value={formatDuration(stats.wallClockMs) ?? '—'} />
                    <StatTile meshTheme={meshTheme} label="Total runtime" value={formatDuration(stats.totalDurationMs) ?? '—'} />
                    <StatTile meshTheme={meshTheme} label="Retries" value={stats.retries} tone={stats.retries > 0 ? 'amber' : undefined} />
                </div>
            )}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label="Mission id" value={mission.id} />
                <ModalRow meshTheme={meshTheme} label="Created" value={relativeTime(mission.createdAt) ?? mission.createdAt} />
                <ModalRow meshTheme={meshTheme} label="Updated" value={relativeTime(mission.updatedAt) ?? mission.updatedAt} />
                {t.lastActivityAt && <ModalRow meshTheme={meshTheme} label="Last task activity" value={relativeTime(t.lastActivityAt) ?? t.lastActivityAt} />}
                {incompleteCount > 0 && stats && (
                    <ModalRow
                        meshTheme={meshTheme}
                        label="Incomplete evidence"
                        value={
                            <details>
                                <summary className="cursor-pointer select-none">{incompleteCount} task{incompleteCount === 1 ? '' : 's'}</summary>
                                <div className="mt-1 flex flex-col gap-0.5 break-all">
                                    {stats.incompleteTaskIds.map(id => (
                                        <span key={id} className={`font-mono text-[10px] ${meshTheme.textMuted}`}>{id}</span>
                                    ))}
                                </div>
                            </details>
                        }
                    />
                )}
            </div>
        </div>
    )
}

function LedgerDetail({ meshTheme, entry, resolveNodeLabel }: { meshTheme: MeshGraphTheme; entry: RepoMeshLedgerEntryStatus; resolveNodeLabel: (nodeId: string | undefined | null) => string }) {
    const summary = payloadSummary(entry.payload)
    let payloadJson = ''
    try {
        payloadJson = JSON.stringify(entry.payload ?? {}, null, 2)
    } catch {
        payloadJson = String(entry.payload)
    }
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={ledgerKindLabel(entry.kind)} tone={ledgerKindTone(entry.kind)} />
            </div>
            {summary && <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{summary}</div>}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label="Entry id" value={entry.id} />
                <ModalRow meshTheme={meshTheme} label="When" value={relativeTime(entry.timestamp) ?? entry.timestamp} />
                {entry.nodeId && <ModalRow meshTheme={meshTheme} label="Node" value={resolveNodeLabel(entry.nodeId)} />}
                {entry.sessionId && <ModalRow meshTheme={meshTheme} label="Session" value={shortSessionId(entry.sessionId)} />}
                {entry.providerType && <ModalRow meshTheme={meshTheme} label="Provider" value={entry.providerType} />}
            </div>
            {payloadJson && payloadJson !== '{}' && (
                <div>
                    <div className={`mb-1 text-[10px] uppercase tracking-wide ${meshTheme.textMuted}`}>Payload</div>
                    <pre className={`max-h-60 max-w-full overflow-auto rounded-lg border p-2 text-[10px] leading-4 ${meshTheme.isDark ? 'border-white/8 bg-black/30 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>{payloadJson}</pre>
                </div>
            )}
        </div>
    )
}

function QueueDetail({ meshTheme, task }: { meshTheme: MeshGraphTheme; task: RepoMeshQueueTask }) {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={task.status} tone={queueTaskTone(task.status)} />
                {(task.requeueCount ?? 0) > 0 && <StatusBadge meshTheme={meshTheme} label={`requeued ${task.requeueCount}`} tone="amber" />}
            </div>
            {task.message && <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{task.message}</div>}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label="Task id" value={task.id} />
                <ModalRow meshTheme={meshTheme} label="Created" value={relativeTime(task.createdAt) ?? task.createdAt} />
                <ModalRow meshTheme={meshTheme} label="Updated" value={relativeTime(task.updatedAt) ?? task.updatedAt} />
                {(task.assignedNodeId || task.targetNodeId) && (
                    <ModalRow meshTheme={meshTheme} label="Node" value={task.assignedNodeId || task.targetNodeId!} />
                )}
                {(task.assignedSessionId || task.targetSessionId) && (
                    <ModalRow meshTheme={meshTheme} label="Session" value={shortSessionId(task.assignedSessionId || task.targetSessionId!)} />
                )}
                {task.cancelReason && <ModalRow meshTheme={meshTheme} label="Cancel reason" value={task.cancelReason} />}
                {task.requeueReason && <ModalRow meshTheme={meshTheme} label="Requeue reason" value={task.requeueReason} />}
                {task.autoLaunch && <ModalRow meshTheme={meshTheme} label="Auto launch" value={`${task.autoLaunch.status}${task.autoLaunch.reason ? ` · ${task.autoLaunch.reason}` : ''}`} />}
            </div>
        </div>
    )
}

function SessionDetail({ meshTheme, node, session }: { meshTheme: MeshGraphTheme; node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }) {
    const label = sessionStatusLabel(session)
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={label} tone={sessionStatusTone(label)} />
                <StatusBadge meshTheme={meshTheme} label={session.providerType || 'provider unknown'} tone="muted" />
            </div>
            {session.statusNote && <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{session.statusNote}</div>}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label="Session id" value={session.sessionId} />
                <ModalRow meshTheme={meshTheme} label="Node" value={node.machineLabel} />
                <ModalRow meshTheme={meshTheme} label="Workspace" value={session.workspace || node.workspace} />
                {(node.git?.branch ?? node.worktreeBranch) && (
                    <ModalRow meshTheme={meshTheme} label="Branch" value={node.git?.branch ?? node.worktreeBranch!} />
                )}
                {typeof session.role === 'string' && session.role && <ModalRow meshTheme={meshTheme} label="Role" value={session.role} />}
                {(session.startedAt || session.createdAt) && (
                    <ModalRow meshTheme={meshTheme} label="Started" value={relativeTime(session.startedAt || session.createdAt) ?? (session.startedAt || session.createdAt)!} />
                )}
            </div>
        </div>
    )
}

// ── missions ──────────────────────────────────────────────────────────────

function MissionRow({ meshTheme, mission, onSelect }: {
    meshTheme: MeshGraphTheme
    mission: MeshMissionDisplay
    onSelect: () => void
}) {
    const t = mission.tasks
    const lastActivity = relativeTime(t.lastActivityAt)
    return (
        <ListRow meshTheme={meshTheme} onClick={onSelect}>
            <StatusBadge meshTheme={meshTheme} label={mission.status} tone={missionStatusTone(mission.status)} />
            <span className={`min-w-0 flex-1 truncate font-medium ${meshTheme.textPrimary}`}>{mission.title}</span>
            <span className={`shrink-0 tabular-nums text-[11px] ${meshTheme.textMuted}`}>✓{t.completed}/{t.total}</span>
            {lastActivity && <span className={`shrink-0 text-[10px] ${meshTheme.textMuted}`}>{lastActivity}</span>}
        </ListRow>
    )
}

function MissionsCard({ meshTheme, liveMissions, historyMissions, hasMissionField, onSelect }: {
    meshTheme: MeshGraphTheme
    liveMissions: MeshMissionDisplay[]
    historyMissions: MeshMissionDisplay[]
    hasMissionField: boolean
    onSelect: (mission: MeshMissionDisplay) => void
}) {
    const [showHistory, setShowHistory] = useState(false)
    const dk = meshTheme.isDark
    const live = useRecentList(liveMissions)
    return (
        <Card
            meshTheme={meshTheme}
            title="Missions"
            count={liveMissions.length || undefined}
        >
            {liveMissions.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                    {live.visible.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} onSelect={() => onSelect(m)} />)}
                    <MoreToggle meshTheme={meshTheme} expanded={live.expanded} hiddenCount={live.hiddenCount} onToggle={live.toggle} />
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
                        <div className="mt-2 flex flex-col gap-0.5">
                            {historyMissions.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} onSelect={() => onSelect(m)} />)}
                        </div>
                    )}
                </div>
            )}
        </Card>
    )
}

// ── ledger / queue ──────────────────────────────────────────────────────────

function LedgerCard({ meshTheme, ledgerSummary, entries, resolveNodeLabel, onSelect }: {
    meshTheme: MeshGraphTheme
    ledgerSummary: RepoMeshLedgerSummaryStatus
    entries: RepoMeshLedgerEntryStatus[]
    resolveNodeLabel: (nodeId: string | undefined | null) => string
    onSelect: (entry: RepoMeshLedgerEntryStatus) => void
}) {
    const lastActivity = relativeTime(ledgerSummary.lastActivityAt)
    // Newest-first; ledger entries arrive oldest→newest from the daemon.
    const recent = useMemo(() => [...entries].reverse(), [entries])
    const list = useRecentList(recent)
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
            {recent.length > 0 && (
                <div className={`mt-3 border-t pt-2 ${meshTheme.isDark ? 'border-white/8' : 'border-slate-200'}`}>
                    <div className={`mb-1 text-[10px] uppercase tracking-wide ${meshTheme.textMuted}`}>Recent activity</div>
                    <div className="flex flex-col gap-0.5">
                        {list.visible.map(entry => {
                            const summary = payloadSummary(entry.payload)
                            return (
                                <ListRow key={entry.id} meshTheme={meshTheme} onClick={() => onSelect(entry)}>
                                    <StatusBadge meshTheme={meshTheme} label={ledgerKindLabel(entry.kind)} tone={ledgerKindTone(entry.kind)} />
                                    <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={entry.nodeId || undefined}>{summary || resolveNodeLabel(entry.nodeId) || entry.sessionId || '—'}</span>
                                    <span className={`shrink-0 text-[10px] ${meshTheme.textMuted}`}>{relativeTime(entry.timestamp) ?? ''}</span>
                                </ListRow>
                            )
                        })}
                        <MoreToggle meshTheme={meshTheme} expanded={list.expanded} hiddenCount={list.hiddenCount} onToggle={list.toggle} />
                    </div>
                </div>
            )}
            {(ledgerSummary.recentFailures > 0 || (lastActivity && recent.length === 0)) && (
                <div className={`mt-2 flex items-center justify-between text-[11px] ${meshTheme.textMuted}`}>
                    {ledgerSummary.recentFailures > 0
                        ? <span className={meshTheme.isDark ? 'text-amber-300' : 'text-amber-600'}>{ledgerSummary.recentFailures} recent failures</span>
                        : <span />}
                    {lastActivity && recent.length === 0 && <span>{lastActivity}</span>}
                </div>
            )}
        </Card>
    )
}

function QueueCard({ meshTheme, queueSummary, tasks, onSelect }: {
    meshTheme: MeshGraphTheme
    queueSummary: RepoMeshQueueSummary | null
    tasks: RepoMeshQueueTask[]
    onSelect: (task: RepoMeshQueueTask) => void
}) {
    // Live work (assigned/pending) first, then newest-updated history. Bound the
    // list to RECENT_QUEUE_MAX so both the "+N more" count and the expanded view
    // stay capped — the queue can hold thousands of historical rows.
    const recent = useMemo(() => {
        return [...tasks].sort((a, b) => {
            const rank = queueTaskSortRank(a.status) - queueTaskSortRank(b.status)
            if (rank !== 0) return rank
            return (b.updatedAt || '').localeCompare(a.updatedAt || '')
        }).slice(0, RECENT_QUEUE_MAX)
    }, [tasks])
    const list = useRecentList(recent)

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
            {recent.length > 0 && (
                <div className={`mt-3 border-t pt-2 ${meshTheme.isDark ? 'border-white/8' : 'border-slate-200'}`}>
                    <div className={`mb-1 text-[10px] uppercase tracking-wide ${meshTheme.textMuted}`}>Recent tasks</div>
                    <div className="flex flex-col gap-0.5">
                        {list.visible.map(task => (
                            <ListRow key={task.id} meshTheme={meshTheme} onClick={() => onSelect(task)}>
                                <StatusBadge meshTheme={meshTheme} label={task.status} tone={queueTaskTone(task.status)} />
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={task.message || undefined}>{describeQueueTaskMessage(task.message) || task.id}</span>
                                <span className={`shrink-0 text-[10px] ${meshTheme.textMuted}`}>{relativeTime(task.updatedAt) ?? ''}</span>
                            </ListRow>
                        ))}
                        <MoreToggle meshTheme={meshTheme} expanded={list.expanded} hiddenCount={list.hiddenCount} onToggle={list.toggle} />
                    </div>
                </div>
            )}
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
                            <div key={node.nodeId} className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden rounded-xl border px-3 py-2 ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
                                <StatusBadge meshTheme={meshTheme} label={node.health} tone={healthTone(node.health)} />
                                <span className={`min-w-0 max-w-full flex-1 truncate text-sm font-medium ${meshTheme.textPrimary}`} title={node.workspace}>{node.machineLabel}</span>
                                {branch && <span className={`max-w-full truncate font-mono text-[11px] ${meshTheme.textSecondary}`} title={branch}>{branch}</span>}
                                <span className={`max-w-full truncate font-mono text-[10px] ${meshTheme.textMuted}`}>{nodeDriftSummary(node)}</span>
                                {sessionCount > 0 && <span className={`shrink-0 text-[10px] ${meshTheme.textMuted}`}>{sessionCount} session{sessionCount > 1 ? 's' : ''}</span>}
                                {typeof node.daemonBuildVersion === 'string' && node.daemonBuildVersion && (
                                    <span className={`shrink-0 font-mono text-[10px] ${meshTheme.textMuted}`} title="Daemon build version reported by this node">v{node.daemonBuildVersion}</span>
                                )}
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

function SessionsCard({ meshTheme, entries, onSelect }: {
    meshTheme: MeshGraphTheme
    entries: { node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }[]
    onSelect: (node: RepoMeshNodeStatus, session: MeshGraphSessionDetail) => void
}) {
    const list = useRecentList(entries)
    return (
        <Card meshTheme={meshTheme} title="Active sessions" count={entries.length || undefined}>
            {entries.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>No active sessions.</EmptyHint>
            ) : (
                <div className="flex flex-col gap-0.5">
                    {list.visible.map(({ node, session }) => {
                        const label = sessionStatusLabel(session)
                        return (
                            <ListRow key={session.sessionId} meshTheme={meshTheme} onClick={() => onSelect(node, session)}>
                                <span className={`min-w-0 flex-1 truncate font-mono text-[10px] ${meshTheme.textMuted}`}>{shortSessionId(session.sessionId)}</span>
                                <span className={`shrink-0 ${meshTheme.textMuted}`}>{session.providerType || '?'}</span>
                                <StatusBadge meshTheme={meshTheme} label={label} tone={sessionStatusTone(label)} />
                            </ListRow>
                        )
                    })}
                    <MoreToggle meshTheme={meshTheme} expanded={list.expanded} hiddenCount={list.hiddenCount} onToggle={list.toggle} />
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
