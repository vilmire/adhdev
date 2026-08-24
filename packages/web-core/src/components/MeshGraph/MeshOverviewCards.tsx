import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { queueTaskDisplayText, stripMarkdownSyntax } from '../../utils/queue-task-label'
import { installTopModalEscapeHandler } from '../../utils/modal-escape'
import ModalPortal from '../ui/ModalPortal'
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
import { nodeCheckoutLabel, nodeDisplayName, sessionElapsedLabel, sessionRoleLabel } from './MeshObservabilitySurface/meshSurfaceHelpers'
import { requestOpenSessionChat } from '../../utils/session-nav'

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
    /** Last refine lifecycle event/ledger kind — the failure code on failed jobs. */
    lastEvent?: string
    lastLedgerKind?: string
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

/**
 * SHOW-TASK-DIFFICULTY: reuses the same severity vocabulary as StatusBadge's
 * other Tone mappings (emerald=cheap/safe → rose=expensive/hard) so a task's
 * cost/effort tier reads consistently with the rest of the overview cards.
 * 'freeform' isn't a severity level (no fixed shape), so it stays neutral.
 */
function difficultyTone(difficulty: string): Tone {
    switch (difficulty) {
        case 'easy': return 'emerald'
        case 'medium': return 'amber'
        case 'difficult': return 'rose'
        default: return 'muted'
    }
}

/** Label for a task's difficulty badge — falls back to the raw value for forward-compat with an unrecognized future difficulty. */
function difficultyLabel(difficulty: string, t: (key: string) => string): string {
    switch (difficulty) {
        case 'easy': return t('meshGraph.difficulty.easy')
        case 'medium': return t('meshGraph.difficulty.medium')
        case 'difficult': return t('meshGraph.difficulty.difficult')
        case 'freeform': return t('meshGraph.difficulty.freeform')
        default: return difficulty
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

export type DetailSelection =
    | { kind: 'mission'; mission: MeshMissionDisplay }
    | { kind: 'ledger'; entry: RepoMeshLedgerEntryStatus }
    | { kind: 'queue'; task: RepoMeshQueueTask }
    | { kind: 'session'; node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }
    // Coordinator gate on the fused blueprint canvas. READ-ONLY by design
    // (owner decision 2026-08-24): acting on a gate is done by instructing
    // the coordinator, never by clicking.
    | { kind: 'gate'; graph: import('@adhdev/daemon-core').MeshGraphView; nodeId: string; gate: import('@adhdev/daemon-core').MeshGraphGateView | null }

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
    const missionTitleById = useMemo(() => {
        const map: Record<string, string> = {}
        for (const mission of missions) { if (mission.id && mission.title) map[mission.id] = mission.title }
        return map
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canonicalStatus])
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
        return node ? nodeDisplayName(node) : nodeId
    }, [canonicalStatus.nodes])

    // SHOW-TASK-DIFFICULTY: sessionId -> difficulty, from queue tasks currently
    // claimed by that session. The session axis itself carries no difficulty.
    const difficultyBySessionId = useMemo(() => {
        const map = new Map<string, string>()
        for (const task of queueTasks) {
            if (task.assignedSessionId && task.difficulty) map.set(task.assignedSessionId, task.difficulty)
        }
        return map
    }, [queueTasks])

    const sessionEntries = useMemo(() => {
        const entries: { node: RepoMeshNodeStatus; session: MeshGraphSessionDetail }[] = []
        for (const node of canonicalStatus.nodes) {
            const sessions: MeshGraphSessionDetail[] = (node.activeSessionDetails && node.activeSessionDetails.length > 0)
                ? node.activeSessionDetails as MeshGraphSessionDetail[]
                : (node.activeSessions ?? []).map(sessionId => ({ sessionId, workspace: node.workspace, isCached: true }))
            for (const session of sessions) {
                const difficulty = difficultyBySessionId.get(session.sessionId)
                entries.push({ node, session: difficulty ? { ...session, difficulty } : session })
            }
        }
        return entries
    }, [canonicalStatus.nodes, difficultyBySessionId])

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
                <MeshOverviewDetailModal
                    meshTheme={meshTheme}
                    detail={detail}
                    onClose={closeDetail}
                    daemonId={daemonId}
                    meshId={meshId ?? canonicalStatus.meshId ?? null}
                    sendDaemonCommand={sendDaemonCommand}
                    resolveNodeLabel={resolveNodeLabel}
                    queueTasks={queueTasks}
                    onOpenTask={task => setDetail({ kind: 'queue', task })}
                    missionTitles={missionTitleById}
                    onOpenMission={missionId => {
                        const mission = missions.find(candidate => candidate.id === missionId)
                        if (mission) setDetail({ kind: 'mission', mission })
                    }}
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
                <span className={`text-2xs font-semibold uppercase tracking-[0.14em] ${meshTheme.textSecondary}`}>{title}</span>
                {count !== undefined && (
                    <span className={`tabular-nums text-2xs ${meshTheme.textMuted}`}>{count}</span>
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
    // leading-none + align-middle + tracking-compensated right padding — same rationale as
    // Badge in meshSurfacePrimitives.tsx (arbitrary text-3xs carries no line-height, so
    // the chip inherited the row's and its border drifted against neighbouring text).
    return <span className={`shrink-0 rounded-full border pl-2 pr-[calc(0.5rem-0.14em)] py-0.5 text-3xs leading-none align-middle font-semibold uppercase tracking-[0.14em] ${cls}`}>{label}</span>
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
            <span className={`mt-1 text-4xs uppercase tracking-wide ${meshTheme.textMuted}`}>{label}</span>
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
function ListRow({ meshTheme, onClick, dimmed, children }: {
    meshTheme: MeshGraphTheme
    onClick?: () => void
    /** Visually mute the whole row (e.g. a mission with no tasks attached). */
    dimmed?: boolean
    children: React.ReactNode
}) {
    const dk = meshTheme.isDark
    const hover = onClick ? (dk ? 'hover:bg-white/[0.05]' : 'hover:bg-slate-100/70') : ''
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            className={`flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-left text-xs transition ${hover} ${onClick ? 'cursor-pointer' : 'cursor-default'} ${dimmed ? 'opacity-55' : ''}`}
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
    const { t } = useTranslation('common')
    if (hiddenCount <= 0) return null
    return (
        <button
            type="button"
            onClick={onToggle}
            className={`mt-1 self-start rounded-md px-1.5 py-0.5 text-2xs font-medium ${meshTheme.textSecondary} hover:underline`}
        >
            {expanded ? t('mesh.overview.showFewer') : t('mesh.overview.showMore', { count: hiddenCount })}
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

function detailTitle(detail: DetailSelection, t: (key: string) => string): { kicker: string; title: string } {
    switch (detail.kind) {
        case 'mission': return { kicker: t('mesh.overview.detailKickerMission'), title: detail.mission.title }
        case 'ledger': return { kicker: t('mesh.overview.detailKickerLedger'), title: ledgerKindLabel(detail.entry.kind) }
        case 'queue': return { kicker: t('mesh.overview.detailKickerQueue'), title: detail.task.id }
        case 'session': return { kicker: t('mesh.overview.detailKickerSession'), title: shortSessionId(detail.session.sessionId) }
        case 'gate': {
            const gateNode = detail.graph.nodes.find(n => n.nodeId === detail.nodeId)
            return { kicker: t('mesh.overview.detailKickerGate'), title: `⛩ ${gateNode?.ref || detail.nodeId.slice(0, 8)}` }
        }
    }
}

// Exported (named) so the safe-area / close-path regression tests can render the
// modal directly without driving the whole overview card grid.
export function MeshOverviewDetailModal({ meshTheme, detail, onClose, daemonId, meshId, sendDaemonCommand, resolveNodeLabel, queueTasks, onOpenTask, missionTitles, onOpenMission, onShowMission }: {
    meshTheme: MeshGraphTheme
    detail: DetailSelection
    onClose: () => void
    resolveNodeLabel: (nodeId: string | undefined | null) => string
    /** Mission detail's reverse wiring: the queue to list mission tasks from, and
     *  the handler that swaps this modal to a clicked task's detail. */
    queueTasks?: RepoMeshQueueTask[]
    onOpenTask?: (task: RepoMeshQueueTask) => void
    /** Task detail's reverse wiring back to its mission. */
    missionTitles?: Record<string, string>
    onOpenMission?: (missionId: string) => void
    /** Blueprint only: mission detail's "show on canvas" jump. */
    onShowMission?: (missionId: string) => void
} & MeshCommandSeam) {
    const { t } = useTranslation('common')
    // This modal stacks ABOVE DashboardMeshGraphDialog, which has its own
    // window-level Escape listener. The capture-phase handler guarantees one
    // Escape closes only this level (no double-close of the parent dialog).
    useEffect(() => installTopModalEscapeHandler(window, onClose), [onClose])

    const dk = meshTheme.isDark
    const { kicker, title } = detailTitle(detail, t)
    const overlayClass = dk ? 'bg-[#030617]/[0.92]' : 'bg-[rgba(15,23,42,0.82)]'
    const shellClass = dk
        ? 'border-white/10 bg-slate-950 md:bg-slate-950/98 shadow-[0_28px_120px_rgba(2,6,23,0.5)]'
        : 'border-slate-200 bg-white md:bg-white/98 shadow-[0_28px_120px_rgba(148,163,184,0.3)]'

    return (
        <ModalPortal>
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
                {/* Safe-area-aware sticky header: in the iOS installed PWA
                    (viewport-fit=cover) the fullscreen 100dvh shell extends under
                    the status bar, so the header must pad below
                    env(safe-area-inset-top) or the close control lands inside the
                    system clock/battery area and becomes untappable. */}
                <div className={`sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 border-b px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top,0px))] ${dk ? 'border-white/8' : 'border-slate-200'}`}>
                    <div className="min-w-0">
                        <div className={`text-3xs font-semibold uppercase tracking-[0.16em] ${meshTheme.textMuted}`}>{kicker}</div>
                        <div className={`mt-0.5 break-all text-sm font-semibold ${meshTheme.textPrimary}`}>{title}</div>
                    </div>
                    {/* >=44px tap target (Apple HIG) while preserving the 32px
                        visual scale: the outer button carries the hit area, the
                        inner span carries the visible chrome; -m-1.5 keeps the
                        header layout footprint unchanged. */}
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('mesh.overview.closeDetail')}
                        className="-m-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center"
                    >
                        <span className={dk ? 'inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.08] hover:text-white' : 'inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900'}>
                            ✕
                        </span>
                    </button>
                </div>
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">
                    {detail.kind === 'mission' && (
                        <MissionDetail
                            meshTheme={meshTheme}
                            mission={detail.mission}
                            queueTasks={queueTasks}
                            onOpenTask={onOpenTask}
                            onShowOnCanvas={onShowMission ? () => onShowMission(detail.mission.id) : undefined}
                            daemonId={daemonId}
                            meshId={meshId}
                            sendDaemonCommand={sendDaemonCommand}
                        />
                    )}
                    {detail.kind === 'ledger' && <LedgerDetail meshTheme={meshTheme} entry={detail.entry} resolveNodeLabel={resolveNodeLabel} />}
                    {detail.kind === 'queue' && (
                        <QueueDetail
                            meshTheme={meshTheme}
                            task={detail.task}
                            resolveNodeLabel={resolveNodeLabel}
                            missionTitles={missionTitles}
                            onOpenMission={onOpenMission}
                            onOpenTask={onOpenTask}
                            queueTasks={queueTasks}
                        />
                    )}
                    {detail.kind === 'session' && <SessionDetail meshTheme={meshTheme} node={detail.node} session={detail.session} queueTasks={queueTasks} onOpenTask={onOpenTask} />}
                    {detail.kind === 'gate' && <GateDetail meshTheme={meshTheme} graph={detail.graph} nodeId={detail.nodeId} gate={detail.gate} queueTasks={queueTasks} onOpenTask={onOpenTask} />}
                </div>
            </div>
        </div>
        </ModalPortal>
    )
}

const unwrapResult = (raw: any): any => (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)

/** Pull RepoMeshStatus out of a mesh_status response (cloud/P2P wraps under result / result.status). */
function extractMeshStatus(raw: any): any {
    const body = unwrapResult(raw)
    if (body && typeof body === 'object' && body.status && typeof body.status === 'object' && Array.isArray(body.status.missions)) return body.status
    return body
}

function MissionDetail({ meshTheme, mission, daemonId, meshId, sendDaemonCommand, queueTasks, onOpenTask, onShowOnCanvas }: {
    meshTheme: MeshGraphTheme
    mission: MeshMissionDisplay
    /** Full queue, so the mission can list ITS tasks — the reverse wiring of the
     *  card's mission chip (owner ask 2026-08-25): mission → member tasks. */
    queueTasks?: RepoMeshQueueTask[]
    /** Swap this modal to the clicked task's queue detail. */
    onOpenTask?: (task: RepoMeshQueueTask) => void
    /** Blueprint only: close the modal and light this mission up on the canvas. */
    onShowOnCanvas?: () => void
} & MeshCommandSeam) {
    const { t } = useTranslation('common')
    const t_tasks = mission.tasks
    const missionTasks = useMemo(() => {
        return (queueTasks ?? [])
            .filter(task => task.missionId === mission.id)
            .sort((a, b) => {
                const rank = queueTaskSortRank(a.status) - queueTaskSortRank(b.status)
                if (rank !== 0) return rank
                return (b.updatedAt || '').localeCompare(a.updatedAt || '')
            })
    }, [queueTasks, mission.id])
    const missionTaskById = useMemo(() => new Map(missionTasks.map(task => [task.id, task])), [missionTasks])
    const taskList = useRecentList(missionTasks)
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
                <StatusBadge meshTheme={meshTheme} label={`${t_tasks.total} tasks`} tone="muted" />
            </div>
            {goalText && (
                <div className={`max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>
                    {stripMarkdownSyntax(goalText)}
                    {showTruncatedLabel && !canFetchGoal && <span className={meshTheme.textMuted}> … (truncated)</span>}
                </div>
            )}
            {fetchError && <div className="text-2xs text-amber-400">{fetchError}</div>}
            {canFetchGoal && (
                <button
                    type="button"
                    className="self-start text-[12px] text-accent-primary hover:underline disabled:opacity-50"
                    onClick={fetchFullGoal}
                    disabled={fetching}
                >
                    {fetching ? t('mesh.overview.loadingGoal') : t('mesh.overview.showFullGoal')}
                </button>
            )}
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCompleted')} value={t_tasks.completed} tone="emerald" />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statAssigned')} value={t_tasks.assigned} tone={t_tasks.assigned > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statPending')} value={t_tasks.pending} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statFailed')} value={t_tasks.failed} tone={t_tasks.failed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statBlocked')} value={t_tasks.blocked} tone={t_tasks.blocked > 0 ? 'amber' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCancelled')} value={t_tasks.cancelled} tone="muted" />
            </div>
            {stats && (
                <div className="grid grid-cols-3 gap-1.5">
                    <StatTile meshTheme={meshTheme} label={t('mesh.overview.statWallClock')} value={formatDuration(stats.wallClockMs) ?? '—'} />
                    <StatTile meshTheme={meshTheme} label={t('mesh.overview.statTotalRuntime')} value={formatDuration(stats.totalDurationMs) ?? '—'} />
                    <StatTile meshTheme={meshTheme} label={t('mesh.overview.statRetries')} value={stats.retries} tone={stats.retries > 0 ? 'amber' : undefined} />
                </div>
            )}
            {onShowOnCanvas && (
                <div>
                    <button
                        type="button"
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${meshTheme.isDark
                            ? 'border-indigo-400/30 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20'
                            : 'border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}
                        onClick={onShowOnCanvas}
                    >
                        {t('mesh.overview.showOnCanvas')}
                    </button>
                </div>
            )}
            {missionTasks.length > 0 && (
                <div>
                    <div className={`mb-1 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('mesh.overview.missionTasksHeading')}</div>
                    <div className="flex flex-col gap-0.5">
                        {taskList.visible.map(task => (
                            <ListRow key={task.id} meshTheme={meshTheme} onClick={onOpenTask ? () => onOpenTask(task) : undefined}>
                                <StatusBadge meshTheme={meshTheme} label={task.status} tone={queueTaskTone(task.status)} />
                                {task.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(task.difficulty, t)} tone={difficultyTone(task.difficulty)} />}
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={task.message || undefined}>{queueTaskDisplayText(task.message) || task.id}</span>
                                <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{relativeTime(task.updatedAt) ?? ''}</span>
                            </ListRow>
                        ))}
                        <MoreToggle meshTheme={meshTheme} expanded={taskList.expanded} hiddenCount={taskList.hiddenCount} onToggle={taskList.toggle} />
                    </div>
                </div>
            )}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelMissionId')} value={mission.id} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelCreated')} value={relativeTime(mission.createdAt) ?? mission.createdAt} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelUpdated')} value={relativeTime(mission.updatedAt) ?? mission.updatedAt} />
                {t_tasks.lastActivityAt && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelLastActivity')} value={relativeTime(t_tasks.lastActivityAt) ?? t_tasks.lastActivityAt} />}
                {incompleteCount > 0 && stats && (
                    <ModalRow
                        meshTheme={meshTheme}
                        label={t('mesh.overview.detailLabelIncompleteEvidence')}
                        value={
                            <details>
                                <summary className="cursor-pointer select-none">{t('mesh.overview.incompleteTaskCount_other', { count: incompleteCount })}</summary>
                                <div className="mt-1 flex flex-col gap-0.5 break-all">
                                    {stats.incompleteTaskIds.map(id => {
                                        const task = missionTaskById.get(id)
                                        return task && onOpenTask
                                            ? (
                                                <button key={id} type="button" onClick={() => onOpenTask(task)} className={`text-left font-mono text-3xs underline-offset-2 hover:underline ${meshTheme.textSecondary}`}>
                                                    {id.slice(0, 8)} · {queueTaskDisplayText(task.message).slice(0, 60) || task.status}
                                                </button>
                                            )
                                            : <span key={id} className={`font-mono text-3xs ${meshTheme.textMuted}`}>{id}</span>
                                    })}
                                </div>
                            </details>
                        }
                    />
                )}
            </div>
        </div>
    )
}

// LEDGER-TASK-TRACEABILITY (E2): the routing rationale a task_dispatched / task_claimed
// entry carries in payload.routingDecision — who ran it (device/daemon/provider/model/
// thinking), by what path (via), and why (fitness score, skipped candidates, tag gating).
interface RoutingDecisionView {
    source?: string
    selectedNodeId?: string
    daemonId?: string
    transport?: string
    resolvedProviderType?: string
    resolvedModel?: string
    resolvedThinkingLevel?: string
    resolvedDifficulty?: string
    fitnessScore?: number
    reason?: string
    skippedCandidates?: Array<{ nodeId?: string; reason?: string }>
    /** Daemon writes `skippedCandidatesOmitted` (mesh-queue-assignment.ts). The old
     *  `skippedCandidatesDropped` name never matched the wire, so the "+N more" line
     *  below was unreachable; both are read now so pre-fix daemons still render. */
    skippedCandidatesOmitted?: number
    skippedCandidatesDropped?: number
    requiredTagsResult?: { required?: string[]; satisfied?: boolean; missing?: string[] }
}

function readRoutingDecision(payload: Record<string, unknown> | undefined): RoutingDecisionView | null {
    const rd = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).routingDecision : undefined
    if (!rd || typeof rd !== 'object' || Array.isArray(rd)) return null
    return rd as RoutingDecisionView
}

function RoutingDecisionDetail({ meshTheme, routing, resolveNodeLabel }: { meshTheme: MeshGraphTheme; routing: RoutingDecisionView; resolveNodeLabel: (nodeId: string | undefined | null) => string }) {
    const { t } = useTranslation('common')
    // "who ran it" — provider · model · thinking, joined compactly.
    const execProfile = [routing.resolvedProviderType, routing.resolvedModel, routing.resolvedThinkingLevel]
        .filter((v): v is string => typeof v === 'string' && !!v)
        .join(' · ')
    const tags = routing.requiredTagsResult
    return (
        <div className="flex flex-col gap-1.5">
            <div className={`text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('mesh.overview.routingHeading')}</div>
            <div className="grid gap-1.5 text-xs">
                {routing.selectedNodeId && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.routingDevice')} value={resolveNodeLabel(routing.selectedNodeId)} />}
                {routing.daemonId && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.routingDaemon')} value={routing.daemonId} />}
                {execProfile && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.routingExecution')} value={execProfile} />}
                {(routing.source || routing.transport) && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.routingVia')} value={[routing.source, routing.transport].filter(Boolean).join(' · ')} />
                )}
                {routing.resolvedDifficulty && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.routingDifficulty')} value={routing.resolvedDifficulty} />}
                {typeof routing.fitnessScore === 'number' && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.routingFitness')} value={String(routing.fitnessScore)} />}
                {routing.reason && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.routingReason')} value={routing.reason} />}
                {tags && Array.isArray(tags.required) && tags.required.length > 0 && (
                    <ModalRow
                        meshTheme={meshTheme}
                        label={t('mesh.overview.routingRequiredTags')}
                        value={`${tags.required.join(', ')}${tags.satisfied === false ? ` · ${t('mesh.overview.routingTagsUnsatisfied')}${tags.missing?.length ? `: ${tags.missing.join(', ')}` : ''}` : ''}`}
                    />
                )}
            </div>
            {Array.isArray(routing.skippedCandidates) && routing.skippedCandidates.length > 0 && (
                <div className="flex flex-col gap-1">
                    <div className={`text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('mesh.overview.routingSkipped')}</div>
                    <div className={`flex flex-col gap-0.5 text-2xs leading-4 ${meshTheme.textSecondary}`}>
                        {routing.skippedCandidates.map((c, i) => (
                            <div key={`${c.nodeId ?? 'node'}-${i}`}>
                                <span>{resolveNodeLabel(c.nodeId)}</span>
                                {c.reason && <span className={meshTheme.textMuted}> — {c.reason}</span>}
                            </div>
                        ))}
                        {(() => {
                            const more = routing.skippedCandidatesOmitted ?? routing.skippedCandidatesDropped
                            return typeof more === 'number' && more > 0
                                ? <div className={meshTheme.textMuted}>{t('mesh.overview.routingSkippedMore', { count: more })}</div>
                                : null
                        })()}
                    </div>
                </div>
            )}
        </div>
    )
}

function LedgerDetail({ meshTheme, entry, resolveNodeLabel }: { meshTheme: MeshGraphTheme; entry: RepoMeshLedgerEntryStatus; resolveNodeLabel: (nodeId: string | undefined | null) => string }) {
    const { t } = useTranslation('common')
    const summary = payloadSummary(entry.payload)
    const routing = readRoutingDecision(entry.payload as Record<string, unknown> | undefined)
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
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelEntryId')} value={entry.id} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelWhen')} value={relativeTime(entry.timestamp) ?? entry.timestamp} />
                {entry.nodeId && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelNode')} value={resolveNodeLabel(entry.nodeId)} />}
                {entry.sessionId && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelSession')} value={shortSessionId(entry.sessionId)} />}
                {entry.providerType && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelProvider')} value={entry.providerType} />}
            </div>
            {/* LEDGER-TASK-TRACEABILITY (E2): human-readable routing rationale (who/via/why). */}
            {routing && <RoutingDecisionDetail meshTheme={meshTheme} routing={routing} resolveNodeLabel={resolveNodeLabel} />}
            {payloadJson && payloadJson !== '{}' && (
                <div>
                    <div className={`mb-1 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('mesh.overview.detailLabelPayload')}</div>
                    <pre className={`max-h-60 max-w-full overflow-auto rounded-lg border p-2 text-3xs leading-4 ${meshTheme.isDark ? 'border-white/8 bg-black/30 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>{payloadJson}</pre>
                </div>
            )}
        </div>
    )
}

function QueueDetail({ meshTheme, task, resolveNodeLabel, missionTitles, onOpenMission, onOpenTask, queueTasks }: {
    meshTheme: MeshGraphTheme
    task: RepoMeshQueueTask
    resolveNodeLabel?: (nodeId: string | undefined | null) => string
    /** Reverse wiring (owner audit 2026-08-25): a task detail used to be a dead
     *  end — no way back to its mission, its dependencies, or its session chat. */
    missionTitles?: Record<string, string>
    onOpenMission?: (missionId: string) => void
    onOpenTask?: (task: RepoMeshQueueTask) => void
    queueTasks?: RepoMeshQueueTask[]
}) {
    const { t } = useTranslation('common')
    const sessionId = task.assignedSessionId || task.targetSessionId
    const linkClass = `text-left underline-offset-2 hover:underline ${meshTheme.textSecondary}`
    const depTasks = (task.dependsOn ?? []).map(id => ({
        id,
        task: (queueTasks ?? []).find(candidate => candidate.id === id) ?? null,
        failure: (task.dependencyFailures ?? []).find(failure => failure.taskId === id) ?? null,
    }))
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={task.status} tone={queueTaskTone(task.status)} />
                {task.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(task.difficulty, t)} tone={difficultyTone(task.difficulty)} />}
                {(task.requeueCount ?? 0) > 0 && <StatusBadge meshTheme={meshTheme} label={t('mesh.overview.detailLabelRequeued', { count: task.requeueCount })} tone="amber" />}
            </div>
            {task.message && <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{queueTaskDisplayText(task.message)}</div>}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelTaskId')} value={task.id} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelCreated')} value={relativeTime(task.createdAt) ?? task.createdAt} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelUpdated')} value={relativeTime(task.updatedAt) ?? task.updatedAt} />
                {task.missionId && (
                    <ModalRow
                        meshTheme={meshTheme}
                        label={t('mesh.overview.detailKickerMission')}
                        value={onOpenMission
                            ? (
                                <button type="button" className={linkClass} onClick={() => onOpenMission(task.missionId!)}>
                                    {missionTitles?.[task.missionId] || task.missionId.slice(0, 10)}
                                </button>
                            )
                            : (missionTitles?.[task.missionId] || task.missionId.slice(0, 10))}
                    />
                )}
                {(task.assignedNodeId || task.targetNodeId) && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelNode')} value={resolveNodeLabel ? resolveNodeLabel(task.assignedNodeId || task.targetNodeId) : (task.assignedNodeId || task.targetNodeId!)} />
                )}
                {sessionId && (
                    <ModalRow
                        meshTheme={meshTheme}
                        label={t('mesh.overview.detailLabelSession')}
                        value={
                            <button type="button" className={linkClass} onClick={() => requestOpenSessionChat({ sessionId, source: 'mesh-overview-task-modal' })}>
                                {shortSessionId(sessionId)} · {t('sessionNav.openChat')}
                            </button>
                        }
                    />
                )}
                {depTasks.length > 0 && (
                    <ModalRow
                        meshTheme={meshTheme}
                        label={t('mesh.overview.detailLabelDependsOn')}
                        value={
                            <div className="flex flex-col items-end gap-0.5">
                                {depTasks.map(dep => dep.task && onOpenTask
                                    ? (
                                        <button key={dep.id} type="button" className={`${linkClass} font-mono text-3xs`} onClick={() => onOpenTask(dep.task!)}>
                                            {dep.id.slice(0, 8)} · {dep.failure ? dep.failure.status : dep.task.status}
                                        </button>
                                    )
                                    : <span key={dep.id} className={`font-mono text-3xs ${meshTheme.textMuted}`}>{dep.id.slice(0, 8)}{dep.failure ? ` · ${dep.failure.status}` : ''}</span>)}
                            </div>
                        }
                    />
                )}
                {task.cancelReason && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelCancelReason')} value={task.cancelReason} />}
                {task.requeueReason && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelRequeueReason')} value={task.requeueReason} />}
                {task.autoLaunch && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelAutoLaunch')} value={`${task.autoLaunch.status}${task.autoLaunch.reason ? ` · ${task.autoLaunch.reason}` : ''}`} />}
            </div>
        </div>
    )
}

function SessionDetail({ meshTheme, node, session, queueTasks, onOpenTask }: {
    meshTheme: MeshGraphTheme
    node: RepoMeshNodeStatus
    session: MeshGraphSessionDetail
    queueTasks?: RepoMeshQueueTask[]
    onOpenTask?: (task: RepoMeshQueueTask) => void
}) {
    const { t } = useTranslation('common')
    const label = sessionStatusLabel(session)
    const sessionTasks = (queueTasks ?? []).filter(task =>
        task.assignedSessionId === session.sessionId || task.targetSessionId === session.sessionId)
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={label} tone={sessionStatusTone(label)} />
                <StatusBadge meshTheme={meshTheme} label={session.providerType || 'provider unknown'} tone="muted" />
                {session.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(session.difficulty, t)} tone={difficultyTone(session.difficulty)} />}
            </div>
            {session.statusNote && <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{session.statusNote}</div>}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelSessionId')} value={session.sessionId} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelNode')} value={nodeDisplayName(node)} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelWorkspace')} value={session.workspace || node.workspace} />
                {(node.git?.branch ?? node.worktreeBranch) && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelBranch')} value={node.git?.branch ?? node.worktreeBranch!} />
                )}
                {typeof session.role === 'string' && session.role && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelRole')} value={session.role} />}
                {(session.startedAt || session.createdAt) && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelStarted')} value={relativeTime(session.startedAt || session.createdAt) ?? (session.startedAt || session.createdAt)!} />
                )}
            </div>
            {sessionTasks.length > 0 && (
                <div>
                    <div className={`mb-1 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('mesh.overview.sessionTasksHeading')}</div>
                    <div className="flex flex-col gap-0.5">
                        {sessionTasks.map(task => (
                            <ListRow key={task.id} meshTheme={meshTheme} onClick={onOpenTask ? () => onOpenTask(task) : undefined}>
                                <StatusBadge meshTheme={meshTheme} label={task.status} tone={queueTaskTone(task.status)} />
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={task.message || undefined}>{queueTaskDisplayText(task.message) || task.id}</span>
                                <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{relativeTime(task.updatedAt) ?? ''}</span>
                            </ListRow>
                        ))}
                    </div>
                </div>
            )}
            {/* Jump straight into this session's conversation — the session-nav
                bus resolves the chat tab and closes this dialog on its way
                (misses toast "no local chat tab", e.g. remote-machine sessions). */}
            <div>
                <button
                    type="button"
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${meshTheme.isDark
                        ? 'border-white/15 bg-white/[0.05] text-slate-200 hover:bg-white/[0.1]'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
                    onClick={() => requestOpenSessionChat({ sessionId: session.sessionId, source: 'mesh-overview-session-modal' })}
                >
                    {t('sessionNav.openChat')}
                </button>
            </div>
        </div>
    )
}

function GateDetail({ meshTheme, graph, nodeId, gate, queueTasks, onOpenTask }: {
    meshTheme: MeshGraphTheme
    graph: import('@adhdev/daemon-core').MeshGraphView
    nodeId: string
    gate: import('@adhdev/daemon-core').MeshGraphGateView | null
    /** Reverse wiring (owner audit 2026-08-25): the steps around the gate,
     *  clickable through to their queue-task details. */
    queueTasks?: RepoMeshQueueTask[]
    onOpenTask?: (task: RepoMeshQueueTask) => void
}) {
    const { t } = useTranslation('common')
    const gateNode = graph.nodes.find(n => n.nodeId === nodeId)
    const state = gate?.state ?? gateNode?.state ?? 'declared'
    const tone: Tone = state === 'released' ? 'emerald' : state === 'awaiting_coordinator' || state === 'claimed' ? 'amber' : state === 'expired' ? 'rose' : 'muted'
    // Edge endpoints may be refs OR nodeIds (same duality the canvas resolves
    // via buildNodeIdByEndpoint) — match both here or the lists come up empty.
    const findNode = (endpoint: string) => graph.nodes.find(n => n.nodeId === endpoint || (!!n.ref && n.ref === endpoint))
    const isGateEndpoint = (endpoint: string) => endpoint === nodeId || (!!gateNode?.ref && endpoint === gateNode.ref)
    const neighborRows = (endpoints: string[]) => endpoints
        .map(findNode)
        .filter((n): n is NonNullable<ReturnType<typeof findNode>> => !!n && n.kind === 'worker_task')
        .filter((n, index, nodes) => nodes.findIndex(candidate => candidate.nodeId === n.nodeId) === index)
        .map(n => {
            const task = n.taskId ? (queueTasks ?? []).find(candidate => candidate.id === n.taskId) ?? null : null
            const label = `${n.ref || n.nodeId.slice(0, 8)} · ${n.taskStatus || n.state}`
            return task && onOpenTask
                ? (
                    <button key={n.nodeId} type="button" className={`text-left font-mono text-3xs underline-offset-2 hover:underline ${meshTheme.textSecondary}`} onClick={() => onOpenTask(task)}>
                        {label}
                    </button>
                )
                : <span key={n.nodeId} className={`font-mono text-3xs ${meshTheme.textMuted}`}>{label}</span>
        })
    const upstream = neighborRows(graph.edges.filter(edge => isGateEndpoint(edge.to)).map(edge => edge.from))
    const unlocks = neighborRows([
        ...graph.edges.filter(edge => isGateEndpoint(edge.from)).map(edge => edge.to),
        ...(gate?.blocking ?? []),
    ])
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={state} tone={tone} />
                {gate?.action && <StatusBadge meshTheme={meshTheme} label={gate.action} tone="muted" />}
                {gate?.leaseExpired && <StatusBadge meshTheme={meshTheme} label="lease expired" tone="rose" />}
            </div>
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelGraph')} value={`${(graph as { batchId?: string }).batchId || graph.graphId.slice(0, 8)} · ${graph.status}`} />
                {gateNode?.ref && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelRef')} value={gateNode.ref} />}
                {gate?.releaseOutcome && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelOutcome')} value={gate.releaseOutcome} />}
                {upstream.length > 0 && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelGateAfter')} value={<div className="flex flex-col items-end gap-0.5">{upstream}</div>} />
                )}
                {unlocks.length > 0 && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelGateUnlocks')} value={<div className="flex flex-col items-end gap-0.5">{unlocks}</div>} />
                )}
            </div>
            {gate?.instructions && (
                <div className={`whitespace-pre-wrap rounded-lg border px-2.5 py-2 text-xs leading-5 ${meshTheme.isDark ? 'border-white/10 bg-white/[0.03] text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                    {gate.instructions}
                </div>
            )}
            {(state === 'awaiting_coordinator' || state === 'claimed') && (
                <div className={`text-2xs ${meshTheme.textSecondary}`}>{t('meshGraph.blueprint.gateActsViaCoordinator')}</div>
            )}
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
    // A mission with zero attached tasks carries no progress signal — mute the
    // whole row so the ones with real work stand out.
    const muted = t.total === 0
    return (
        <ListRow meshTheme={meshTheme} onClick={onSelect} dimmed={muted}>
            <StatusBadge meshTheme={meshTheme} label={mission.status} tone={missionStatusTone(mission.status)} />
            <span className={`min-w-0 flex-1 truncate font-medium ${muted ? meshTheme.textSecondary : meshTheme.textPrimary}`}>{mission.title}</span>
            {t.total > 0 && <span className={`shrink-0 tabular-nums text-2xs ${meshTheme.textMuted}`}>✓{t.completed}/{t.total}</span>}
            {lastActivity && <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{lastActivity}</span>}
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
    const { t } = useTranslation('common')
    const [showHistory, setShowHistory] = useState(false)
    const [showPaused, setShowPaused] = useState(false)
    const dk = meshTheme.isDark
    // Active missions are the working set; paused ones fold behind a disclosure
    // (mirroring the completed/abandoned history) so a long paused backlog does
    // not bury the live work. When NOTHING is active, paused missions show
    // inline — an all-paused mesh would otherwise render as deceptively empty.
    const activeMissions = useMemo(() => liveMissions.filter(m => m.status === 'active'), [liveMissions])
    const pausedMissions = useMemo(() => liveMissions.filter(m => m.status !== 'active'), [liveMissions])
    const inlineMissions = activeMissions.length > 0 ? activeMissions : pausedMissions
    const foldedPaused = activeMissions.length > 0 ? pausedMissions : []
    const live = useRecentList(inlineMissions)
    return (
        <Card
            meshTheme={meshTheme}
            title={t('mesh.overview.missionCard')}
            count={liveMissions.length || undefined}
        >
            {inlineMissions.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                    {live.visible.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} onSelect={() => onSelect(m)} />)}
                    <MoreToggle meshTheme={meshTheme} expanded={live.expanded} hiddenCount={live.hiddenCount} onToggle={live.toggle} />
                </div>
            ) : (
                <EmptyHint meshTheme={meshTheme}>
                    {hasMissionField
                        ? t('mesh.overview.noActiveMissions')
                        : t('mesh.overview.missionDataUnavailable')}
                </EmptyHint>
            )}

            {foldedPaused.length > 0 && (
                <div className={`mt-3 border-t pt-2 ${dk ? 'border-white/8' : 'border-slate-200'}`}>
                    <button
                        type="button"
                        onClick={() => setShowPaused(v => !v)}
                        className={`flex w-full items-center gap-1.5 text-2xs font-medium ${meshTheme.textSecondary}`}
                    >
                        <span className={`inline-block transition-transform ${showPaused ? 'rotate-90' : ''}`}>▸</span>
                        <span>{t('mesh.overview.pausedMissions')}</span>
                        <span className={`tabular-nums ${meshTheme.textMuted}`}>{foldedPaused.length}</span>
                    </button>
                    {showPaused && (
                        <div className="mt-2 flex flex-col gap-0.5">
                            {foldedPaused.map(m => <MissionRow key={m.id} meshTheme={meshTheme} mission={m} onSelect={() => onSelect(m)} />)}
                        </div>
                    )}
                </div>
            )}

            {historyMissions.length > 0 && (
                <div className={`mt-3 border-t pt-2 ${dk ? 'border-white/8' : 'border-slate-200'}`}>
                    <button
                        type="button"
                        onClick={() => setShowHistory(v => !v)}
                        className={`flex w-full items-center gap-1.5 text-2xs font-medium ${meshTheme.textSecondary}`}
                    >
                        <span className={`inline-block transition-transform ${showHistory ? 'rotate-90' : ''}`}>▸</span>
                        <span>{t('mesh.overview.completedHistory')}</span>
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
    const { t } = useTranslation('common')
    const lastActivity = relativeTime(ledgerSummary.lastActivityAt)
    // Newest-first; ledger entries arrive oldest→newest from the daemon.
    const recent = useMemo(() => [...entries].reverse(), [entries])
    const list = useRecentList(recent)
    return (
        <Card
            meshTheme={meshTheme}
            title={t('mesh.overview.ledgerCard')}
            // The tiles are ALL-TIME ledger totals, not current state — without
            // this caption "78 stalled" reads as 78 tasks stuck right now.
            action={<span className={`text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.ledgerAllTime')}</span>}
        >
            <div className="grid grid-cols-3 gap-1.5">
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statDispatched')} value={ledgerSummary.taskDispatched} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCompleted')} value={ledgerSummary.taskCompleted} tone="emerald" />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statFailed')} value={ledgerSummary.taskFailed} tone={ledgerSummary.taskFailed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statStalled')} value={ledgerSummary.taskStalled} tone={ledgerSummary.taskStalled > 0 ? 'amber' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statSessions')} value={ledgerSummary.sessionLaunched} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCheckpoints')} value={ledgerSummary.checkpointCreated} />
            </div>
            {recent.length > 0 && (
                <div className={`mt-3 border-t pt-2 ${meshTheme.isDark ? 'border-white/8' : 'border-slate-200'}`}>
                    <div className={`mb-1 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('mesh.overview.recentActivity')}</div>
                    <div className="flex flex-col gap-0.5">
                        {list.visible.map(entry => {
                            const summary = payloadSummary(entry.payload)
                            return (
                                <ListRow key={entry.id} meshTheme={meshTheme} onClick={() => onSelect(entry)}>
                                    <StatusBadge meshTheme={meshTheme} label={ledgerKindLabel(entry.kind)} tone={ledgerKindTone(entry.kind)} />
                                    <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={entry.nodeId || undefined}>{summary || resolveNodeLabel(entry.nodeId) || entry.sessionId || '—'}</span>
                                    <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{relativeTime(entry.timestamp) ?? ''}</span>
                                </ListRow>
                            )
                        })}
                        <MoreToggle meshTheme={meshTheme} expanded={list.expanded} hiddenCount={list.hiddenCount} onToggle={list.toggle} />
                    </div>
                </div>
            )}
            {(ledgerSummary.recentFailures > 0 || (lastActivity && recent.length === 0)) && (
                <div className={`mt-2 flex items-center justify-between text-2xs ${meshTheme.textMuted}`}>
                    {ledgerSummary.recentFailures > 0
                        ? <span className={meshTheme.isDark ? 'text-amber-300' : 'text-amber-600'}>{t('mesh.overview.recentFailures', { count: ledgerSummary.recentFailures })}</span>
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

    const { t } = useTranslation('common')
    if (!queueSummary) {
        return (
            <Card meshTheme={meshTheme} title={t('mesh.overview.queueCard')}>
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noQueueActivity')}</EmptyHint>
            </Card>
        )
    }
    return (
        <Card meshTheme={meshTheme} title={t('mesh.overview.queueCard')} count={queueSummary.active > 0 ? t('mesh.overview.activeCount', { count: queueSummary.active }) : undefined}>
            <div className="grid grid-cols-3 gap-1.5">
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statPending')} value={queueSummary.pending} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statAssigned')} value={queueSummary.assigned} tone={queueSummary.assigned > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statActive')} value={queueSummary.active} tone={queueSummary.active > 0 ? 'sky' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCompleted')} value={queueSummary.completed} tone="emerald" />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statFailed')} value={queueSummary.failed} tone={queueSummary.failed > 0 ? 'rose' : undefined} />
                <StatTile meshTheme={meshTheme} label={t('mesh.overview.statCancelled')} value={queueSummary.cancelled} tone="muted" />
            </div>
            {recent.length > 0 && (
                <div className={`mt-3 border-t pt-2 ${meshTheme.isDark ? 'border-white/8' : 'border-slate-200'}`}>
                    <div className={`mb-1 text-3xs uppercase tracking-wide ${meshTheme.textMuted}`}>{t('mesh.overview.recentTasks')}</div>
                    <div className="flex flex-col gap-0.5">
                        {list.visible.map(task => (
                            <ListRow key={task.id} meshTheme={meshTheme} onClick={() => onSelect(task)}>
                                <StatusBadge meshTheme={meshTheme} label={task.status} tone={queueTaskTone(task.status)} />
                                {task.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(task.difficulty, t)} tone={difficultyTone(task.difficulty)} />}
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={task.message || undefined}>{queueTaskDisplayText(task.message) || task.id}</span>
                                <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{relativeTime(task.updatedAt) ?? ''}</span>
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
    const { t } = useTranslation('common')
    const dk = meshTheme.isDark
    return (
        <Card meshTheme={meshTheme} title={t('mesh.overview.nodesCard')} count={nodes.length}>
            {nodes.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noNodes')}</EmptyHint>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {nodes.map(node => {
                        const sessionCount = (node.activeSessionDetails?.length ?? 0) || (node.activeSessions?.length ?? 0)
                        const conv = convergenceBadge(node)
                        const branch = node.git?.branch ?? node.worktreeBranch ?? null
                        return (
                            <div key={node.nodeId} className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden rounded-xl border px-3 py-2 ${dk ? 'border-white/8 bg-white/[0.02]' : 'border-slate-200 bg-slate-50/60'}`}>
                                <StatusBadge meshTheme={meshTheme} label={node.health} tone={healthTone(node.health)} />
                                <span className={`min-w-0 max-w-full flex-1 truncate text-sm font-medium ${meshTheme.textPrimary}`} title={node.workspace}>{nodeCheckoutLabel(node)}</span>
                                {branch && <span className={`max-w-full truncate font-mono text-2xs ${meshTheme.textSecondary}`} title={branch}>{branch}</span>}
                                <span className={`max-w-full truncate font-mono text-3xs ${meshTheme.textMuted}`}>{nodeDriftSummary(node)}</span>
                                {sessionCount > 0 && <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{sessionCount} session{sessionCount > 1 ? 's' : ''}</span>}
                                {typeof node.daemonBuildVersion === 'string' && node.daemonBuildVersion && (
                                    <span className={`shrink-0 font-mono text-3xs ${meshTheme.textMuted}`} title="Daemon build version reported by this node">v{node.daemonBuildVersion}</span>
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
    const { t } = useTranslation('common')
    const list = useRecentList(entries)
    return (
        <Card meshTheme={meshTheme} title={t('mesh.overview.sessionsCard')} count={entries.length || undefined}>
            {entries.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noActiveSessions')}</EmptyHint>
            ) : (
                <div className="flex flex-col gap-0.5">
                    {list.visible.map(({ node, session }) => {
                        const label = sessionStatusLabel(session)
                        // Where + who, not a raw session id: the machine (with worktree
                        // branch when applicable), the session's mesh role, provider and
                        // age. The raw id stays available in the row tooltip / detail.
                        const where = nodeDisplayName(node)
                        const elapsed = sessionElapsedLabel(session)
                        return (
                            <ListRow key={session.sessionId} meshTheme={meshTheme} onClick={() => onSelect(node, session)}>
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={session.sessionId}>
                                    {where}
                                </span>
                                <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{sessionRoleLabel(session)}</span>
                                <span className={`shrink-0 ${meshTheme.textMuted}`}>{session.providerType || '?'}</span>
                                {!elapsed.includes('not reported') && <span className={`shrink-0 text-3xs tabular-nums ${meshTheme.textMuted}`}>{elapsed}</span>}
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
    const { t } = useTranslation('common')
    const dk = meshTheme.isDark
    const failed = jobs.filter(j => j.status === 'failed').length
    return (
        <Card
            meshTheme={meshTheme}
            title={t('mesh.overview.refineCard')}
            count={jobs.length || undefined}
            action={failed > 0 ? <StatusBadge meshTheme={meshTheme} label={t('mesh.overview.failedCount', { count: failed })} tone="rose" /> : undefined}
        >
            {jobs.length === 0 ? (
                <EmptyHint meshTheme={meshTheme}>{t('mesh.overview.noRefineJobs')}</EmptyHint>
            ) : (
                <div className="flex flex-col gap-1">
                    {jobs.slice(0, 8).map(job => {
                        // Failed jobs surface WHY inline — the last lifecycle event carries
                        // the failure code (e.g. patch_equivalence_failed) that otherwise
                        // required digging through mesh_task_history.
                        const failureReason = job.status === 'failed' ? (job.lastEvent || job.lastLedgerKind || '') : ''
                        return (
                            <div key={job.jobId} className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2 text-xs">
                                    <span className={`min-w-0 flex-1 truncate font-mono text-3xs ${meshTheme.textMuted}`}>
                                        {job.branch ?? job.jobId.slice(0, 14)}{job.into ? ` → ${job.into}` : ''}
                                    </span>
                                    <span className={`shrink-0 text-3xs font-semibold ${
                                        job.status === 'failed' ? (dk ? 'text-rose-300' : 'text-rose-600')
                                        : job.status === 'running' || job.status === 'accepted' ? (dk ? 'text-sky-300' : 'text-sky-600')
                                        : (dk ? 'text-emerald-300' : 'text-emerald-600')
                                    }`}>{job.status}</span>
                                </div>
                                {failureReason && (
                                    <div className={`truncate pl-1 text-3xs ${dk ? 'text-rose-200/80' : 'text-rose-600/90'}`} title={failureReason}>
                                        {failureReason}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </Card>
    )
}
