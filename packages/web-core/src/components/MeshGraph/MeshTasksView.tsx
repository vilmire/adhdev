/**
 * MeshTasksView — mission-centric Tasks tab for the mesh observability surface.
 *
 * Replaces the always-on dependency-DAG canvas (MeshTaskDagView as the primary
 * view): live queue data is ~99% edge-free, so a DAG layout degenerated into a
 * flat wall of terminal cards. The structure end users actually track is
 * "what is running now / what needs me / how far along is each mission", so
 * that is the top-level layout. The DAG stays available as a per-mission
 * drill-down, offered only when that mission's tasks really carry edges.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import { buildMeshTasksView, type MissionTaskGroup } from './meshTasksViewModel'
import { buildTaskRoutingIndex, formatExecutionProfile, type TaskRoutingSummary } from './taskRoutingIndex'
import { TASK_DAG_LOAD_MORE_STEP, TASK_DAG_RECENT_TERMINAL_LIMIT } from './taskDagViewModel'
import MeshTaskDagView from './MeshTaskDagView'
import { queueTaskDisplayText } from '../../utils/queue-task-label'
import { formatRelativeTime } from '../../utils/time'
import { IconFlag } from '../Icons'
import { nodeDisplayName } from './MeshObservabilitySurface/meshSurfaceHelpers'

interface MeshTasksViewProps {
    tasks: RepoMeshQueueTask[]
    status: RepoMeshStatus
    emptyMessage?: string
    /** Enables the requeue/cancel row actions when the command channel exists. */
    daemonId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    /** Called after a queue mutation succeeds so the host can refresh the status. */
    onQueueMutated?: () => void
    /** Jump to a node's detail (graph tab) — used by running tasks' "view node". */
    onFocusNode?: (nodeId: string) => void
}

const STATUS_DOT: Record<string, string> = {
    assigned: 'bg-sky-400 animate-pulse',
    pending: 'bg-slate-400',
    completed: 'bg-emerald-400',
    failed: 'bg-rose-400',
    cancelled: 'bg-slate-500',
}

const MISSION_STATUS_TONE: Record<string, { dark: string; light: string }> = {
    active: { dark: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200', light: 'border-emerald-300 bg-emerald-50 text-emerald-700' },
    paused: { dark: 'border-amber-400/30 bg-amber-500/10 text-amber-200', light: 'border-amber-300 bg-amber-50 text-amber-700' },
    completed: { dark: 'border-white/10 bg-white/[0.05] text-slate-300', light: 'border-slate-200 bg-slate-50 text-slate-500' },
    abandoned: { dark: 'border-white/10 bg-white/[0.04] text-slate-400', light: 'border-slate-200 bg-slate-50 text-slate-400' },
}

function taskTimestampMs(task: RepoMeshQueueTask): number {
    const value = Date.parse(task.updatedAt || task.createdAt || '')
    return Number.isFinite(value) ? value : 0
}

/** Status label i18n key — end-user vocabulary (running/queued/done/…). */
function statusKey(status: string): string {
    switch (status) {
        case 'assigned': return 'meshGraph.tasksView.status.running'
        case 'pending': return 'meshGraph.tasksView.status.queued'
        case 'completed': return 'meshGraph.tasksView.status.done'
        case 'failed': return 'meshGraph.tasksView.status.failed'
        case 'cancelled': return 'meshGraph.tasksView.status.cancelled'
        default: return 'meshGraph.tasksView.status.queued'
    }
}

function buildNodeLabels(status: RepoMeshStatus): Map<string, string> {
    const out = new Map<string, string>()
    for (const node of status.nodes ?? []) {
        if (!node?.nodeId) continue
        out.set(node.nodeId, nodeDisplayName(node))
    }
    return out
}

function Chip({ theme, children, tone = 'default', title }: {
    theme: MeshGraphTheme
    children: React.ReactNode
    tone?: 'default' | 'info' | 'warn' | 'danger' | 'good'
    title?: string
}) {
    const toneClass = tone === 'info'
        ? (theme.isDark ? 'border-sky-400/25 bg-sky-500/10 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700')
        : tone === 'warn'
            ? (theme.isDark ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700')
            : tone === 'danger'
                ? (theme.isDark ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700')
                : tone === 'good'
                    ? (theme.isDark ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-emerald-300 bg-emerald-50 text-emerald-700')
                    : (theme.isDark ? 'border-white/10 bg-white/[0.05] text-slate-300' : 'border-slate-200 bg-white/85 text-slate-600')
    // leading-none: text-3xs sets font-size only (arbitrary value), so without this the
    // chip inherits the row's line-height (leading-5 here) and renders taller than the same
    // chip elsewhere, pushing its border off-center against sibling text. See Badge in
    // meshSurfacePrimitives.tsx for the full rationale.
    return <span title={title} className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-3xs leading-none ${toneClass}`}>{children}</span>
}

function MissionProgressBar({ theme, group }: { theme: MeshGraphTheme; group: MissionTaskGroup }) {
    const { counts } = group
    if (counts.total === 0) return null
    const pct = (n: number) => `${(n / counts.total) * 100}%`
    return (
        <div className={`h-1.5 w-full overflow-hidden rounded-full ${theme.isDark ? 'bg-white/[0.07]' : 'bg-slate-200/80'}`}>
            <div className="flex h-full">
                <div className="h-full bg-emerald-400/85" style={{ width: pct(counts.completed) }} />
                <div className="h-full bg-rose-400/85" style={{ width: pct(counts.failed) }} />
                <div className={`h-full ${theme.isDark ? 'bg-slate-500/50' : 'bg-slate-400/50'}`} style={{ width: pct(counts.cancelled) }} />
                <div className="h-full animate-pulse bg-sky-400/80" style={{ width: pct(counts.assigned) }} />
            </div>
        </div>
    )
}

/** Queue mutation channel handed down from the surface (absent → read-only rows). */
export interface TaskRowActions {
    /** 'cancel' | 'requeue' against a task id; resolves after the daemon confirms. */
    run: (action: 'cancel' | 'requeue', taskId: string) => Promise<void>
    busyTaskId: string | null
    error: string | null
}

function TaskRow({ task, theme, nodeLabels, routing, expanded, onToggle, actions, onFocusNode }: {
    task: RepoMeshQueueTask
    theme: MeshGraphTheme
    nodeLabels: Map<string, string>
    /** Dispatch-time routing (model/origin) joined from the ledger; absent for older tasks. */
    routing?: TaskRoutingSummary
    expanded: boolean
    onToggle: () => void
    actions?: TaskRowActions | null
    onFocusNode?: (nodeId: string) => void
}) {
    const { t } = useTranslation('common')
    // Destructive-ish actions arm on first click and execute on the second, so a
    // stray click on a running task's cancel cannot interrupt a worker.
    const [armedAction, setArmedAction] = useState<'cancel' | 'requeue' | null>(null)
    const text = queueTaskDisplayText(task.message)
    const blocked = typeof task.blockedReason === 'string' && task.blockedReason.length > 0
    const nodeLabel = task.assignedNodeId ? nodeLabels.get(task.assignedNodeId) ?? task.assignedNodeId.slice(0, 12) : null
    const muted = task.status === 'cancelled' || task.status === 'completed'
    return (
        <div className={`rounded-xl transition-colors ${expanded ? (theme.isDark ? 'bg-white/[0.04]' : 'bg-slate-100/70') : ''}`}>
            <button
                type="button"
                onClick={onToggle}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${theme.isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-slate-100/70'}`}
            >
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[task.status] ?? STATUS_DOT.pending}`} aria-hidden />
                <span
                    className={`min-w-0 flex-1 truncate text-[12px] leading-5 ${muted ? theme.textSecondary : theme.textPrimary}`}
                    title={text}
                >
                    {text || task.id}
                </span>
                {task.status === 'failed' && <Chip theme={theme} tone="danger">{t(statusKey(task.status))}</Chip>}
                {blocked && <Chip theme={theme} tone="warn">{t('meshGraph.tasksView.status.blocked')}</Chip>}
                {/* Which model ran this — the single most-asked question about a finished
                    task, and previously only reachable via Overview → Ledger → entry modal.
                    Model alone on the collapsed row (provider/thinking would crowd it); the
                    full profile is in the expanded body. Hidden below sm so the mobile row
                    keeps its text column instead of collapsing it to nothing. */}
                {routing?.model && (
                    <span className="hidden sm:contents">
                        <Chip theme={theme} title={formatExecutionProfile(routing)}>{routing.model}</Chip>
                    </span>
                )}
                {task.status === 'assigned' && nodeLabel && <Chip theme={theme} tone="info" title={task.assignedNodeId ?? undefined}>{nodeLabel}</Chip>}
                <span className={`shrink-0 text-3xs tabular-nums ${theme.textSecondary}`}>
                    {formatRelativeTime(taskTimestampMs(task))}
                </span>
            </button>
            {expanded && (
                <div className="px-2.5 pb-2.5 pt-0.5">
                    <div className={`whitespace-pre-wrap text-2xs leading-4.5 ${theme.textSecondary}`}>{text}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Chip theme={theme} tone={task.status === 'failed' ? 'danger' : task.status === 'assigned' ? 'info' : task.status === 'completed' ? 'good' : 'default'}>{t(statusKey(task.status))}</Chip>
                        {task.difficulty && <Chip theme={theme}>{task.difficulty}</Chip>}
                        {task.priority && task.priority !== 'normal' && <Chip theme={theme}>{task.priority}</Chip>}
                        {(task.taskMode === 'live_debug_readonly' || task.readonly) && <Chip theme={theme}>{t('meshGraph.tasksView.readOnly')}</Chip>}
                        {nodeLabel && <Chip theme={theme} title={task.assignedNodeId ?? undefined}>@ {nodeLabel}</Chip>}
                        <span className={`font-mono text-4xs ${theme.textSecondary} opacity-70`} title={task.id}>{task.id.slice(0, 8)}</span>
                    </div>
                    {/* Execution + origin, from the dispatch ledger entry. Only the two things
                        the owner asked for are inline (what ran it / where it came from);
                        selection internals stay folded below so the row does not get noisy. */}
                    {routing && (
                        <div className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs ${theme.textSecondary}`}>
                            {formatExecutionProfile(routing) && (
                                <span>
                                    <span className={theme.textMuted}>{t('meshGraph.tasksView.routingRan')} </span>
                                    {formatExecutionProfile(routing)}
                                </span>
                            )}
                            {(routing.source || routing.transport) && (
                                <span>
                                    <span className={theme.textMuted}>{t('meshGraph.tasksView.routingFrom')} </span>
                                    {[routing.source, routing.transport].filter(Boolean).join(' · ')}
                                </span>
                            )}
                        </div>
                    )}
                    {routing && (typeof routing.fitnessScore === 'number' || routing.reason || routing.intraNodeLoserCount || routing.skippedCount) && (
                        <details className="mt-1.5">
                            <summary className={`cursor-pointer list-none text-3xs ${theme.textMuted} [&::-webkit-details-marker]:hidden`}>
                                {t('meshGraph.tasksView.routingWhy')}
                            </summary>
                            <div className={`mt-1 flex flex-col gap-0.5 text-3xs leading-4 ${theme.textSecondary}`}>
                                {typeof routing.fitnessScore === 'number' && (
                                    <div><span className={theme.textMuted}>{t('meshGraph.tasksView.routingFitness')} </span>{routing.fitnessScore}</div>
                                )}
                                {routing.reason && (
                                    <div><span className={theme.textMuted}>{t('meshGraph.tasksView.routingReason')} </span>{routing.reason}</div>
                                )}
                                {!!routing.intraNodeLoserCount && (
                                    <div>{t('meshGraph.tasksView.routingLosers', { count: routing.intraNodeLoserCount })}</div>
                                )}
                                {!!routing.skippedCount && (
                                    <div>{t('meshGraph.tasksView.routingSkipped', { count: routing.skippedCount })}</div>
                                )}
                            </div>
                        </details>
                    )}
                    {blocked && (
                        <div className={`mt-2 rounded-lg border px-2 py-1.5 text-3xs ${theme.isDark ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                            {task.blockedReason}
                        </div>
                    )}
                    {(actions || (onFocusNode && task.assignedNodeId)) && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {actions && (task.status === 'failed' || task.status === 'cancelled') && (
                                <ActionButton
                                    theme={theme}
                                    tone="info"
                                    busy={actions.busyTaskId === task.id}
                                    armed={armedAction === 'requeue'}
                                    label={t('meshGraph.tasksView.actionRequeue')}
                                    confirmLabel={t('meshGraph.tasksView.actionConfirm')}
                                    onClick={() => {
                                        if (armedAction !== 'requeue') { setArmedAction('requeue'); return }
                                        setArmedAction(null)
                                        void actions.run('requeue', task.id)
                                    }}
                                />
                            )}
                            {actions && (task.status === 'pending' || task.status === 'assigned') && (
                                <ActionButton
                                    theme={theme}
                                    tone="danger"
                                    busy={actions.busyTaskId === task.id}
                                    armed={armedAction === 'cancel'}
                                    label={t('meshGraph.tasksView.actionCancel')}
                                    confirmLabel={t('meshGraph.tasksView.actionConfirm')}
                                    onClick={() => {
                                        if (armedAction !== 'cancel') { setArmedAction('cancel'); return }
                                        setArmedAction(null)
                                        void actions.run('cancel', task.id)
                                    }}
                                />
                            )}
                            {onFocusNode && task.assignedNodeId && (
                                <ActionButton
                                    theme={theme}
                                    tone="default"
                                    label={t('meshGraph.tasksView.actionViewNode')}
                                    onClick={() => onFocusNode(task.assignedNodeId!)}
                                />
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

function ActionButton({ theme, tone, label, confirmLabel, armed, busy, onClick }: {
    theme: MeshGraphTheme
    tone: 'info' | 'danger' | 'default'
    label: string
    confirmLabel?: string
    armed?: boolean
    busy?: boolean
    onClick: () => void
}) {
    const toneClass = tone === 'danger'
        ? (theme.isDark ? 'border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20' : 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100')
        : tone === 'info'
            ? (theme.isDark ? 'border-sky-400/30 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20' : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100')
            : (theme.isDark ? 'border-white/10 bg-white/[0.05] text-slate-300 hover:bg-white/[0.1]' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100')
    return (
        <button
            type="button"
            disabled={busy}
            onClick={onClick}
            className={`rounded-full border px-2.5 py-1 text-3xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${toneClass} ${armed ? 'ring-1 ring-current' : ''}`}
        >
            {armed && confirmLabel ? confirmLabel : label}
        </button>
    )
}

function MissionGroupCard({ group, theme, nodeLabels, routingIndex, expandedTaskId, onToggleTask, actions, onFocusNode, daemonId, meshId, sendDaemonCommand }: {
    group: MissionTaskGroup
    theme: MeshGraphTheme
    nodeLabels: Map<string, string>
    routingIndex: Map<string, TaskRoutingSummary>
    expandedTaskId: string | null
    onToggleTask: (id: string) => void
    actions?: TaskRowActions | null
    onFocusNode?: (nodeId: string) => void
    daemonId?: string | null
    meshId?: string | null
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
}) {
    const { t } = useTranslation('common')
    const hasLiveWork = group.counts.assigned > 0 || group.counts.pending > 0 || group.counts.failed > 0
    const [openOverride, setOpenOverride] = useState<boolean | null>(null)
    const [showGraph, setShowGraph] = useState(false)
    const [showGoal, setShowGoal] = useState(false)
    const open = openOverride ?? hasLiveWork
    const title = group.title
        || (group.missionId ? group.missionId.slice(0, 24) : t('meshGraph.tasksView.adhocTitle'))
    const missionTone = group.missionStatus ? MISSION_STATUS_TONE[group.missionStatus] : null
    const goalText = group.goal ? queueTaskDisplayText(group.goal) : ''
    return (
        <section className={`rounded-2xl border ${theme.isDark ? 'border-white/10 bg-slate-950/40' : 'border-slate-200 bg-white/90'}`}>
            <button
                type="button"
                onClick={() => setOpenOverride(prev => (prev === null ? !hasLiveWork : !prev))}
                aria-expanded={open}
                className="flex w-full flex-col gap-2 rounded-2xl px-3.5 py-3 text-left"
            >
                <div className="flex items-center gap-2">
                    <span className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''} ${theme.textSecondary}`} aria-hidden>›</span>
                    {group.missionId && <IconFlag size={11} className={`shrink-0 ${theme.isDark ? 'text-slate-400' : 'text-slate-400'}`} />}
                    <span className={`min-w-0 flex-1 truncate text-[12.5px] font-semibold ${theme.textPrimary}`} title={group.missionId ?? undefined}>{title}</span>
                    {group.missionStatus && missionTone && (
                        <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-4xs leading-none font-medium uppercase tracking-wide ${theme.isDark ? missionTone.dark : missionTone.light}`}>
                            {t(`meshGraph.tasksView.missionStatus.${group.missionStatus}`, { defaultValue: group.missionStatus })}
                        </span>
                    )}
                    {group.counts.assigned > 0 && <Chip theme={theme} tone="info">{t('meshGraph.tasksView.chipRunning', { count: group.counts.assigned })}</Chip>}
                    {group.counts.failed > 0 && <Chip theme={theme} tone="danger">{t('meshGraph.tasksView.chipFailed', { count: group.counts.failed })}</Chip>}
                    {group.counts.blocked > 0 && <Chip theme={theme} tone="warn">{t('meshGraph.tasksView.chipBlocked', { count: group.counts.blocked })}</Chip>}
                    <span className={`shrink-0 text-3xs tabular-nums ${theme.textSecondary}`}>
                        {t('meshGraph.tasksView.progress', { done: group.counts.completed, total: group.counts.total })}
                    </span>
                </div>
                <MissionProgressBar theme={theme} group={group} />
            </button>
            {open && (
                <div className="flex flex-col gap-0.5 px-1.5 pb-2">
                    {(group.hasDependencies || goalText) && (
                        <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
                            {goalText && (
                                <button
                                    type="button"
                                    onClick={() => setShowGoal(prev => !prev)}
                                    className={`rounded-full border px-2.5 py-1 text-3xs font-medium transition-colors ${theme.isDark
                                        ? 'border-white/10 bg-white/[0.05] text-slate-300 hover:bg-white/[0.1]'
                                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'}`}
                                >
                                    {showGoal ? t('meshGraph.tasksView.hideGoal') : t('meshGraph.tasksView.showGoal')}
                                </button>
                            )}
                            {group.hasDependencies && (
                                <button
                                    type="button"
                                    onClick={() => setShowGraph(prev => !prev)}
                                    className={`rounded-full border px-2.5 py-1 text-3xs font-medium transition-colors ${theme.isDark
                                        ? 'border-sky-400/25 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                                        : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
                                >
                                    {showGraph ? t('meshGraph.tasksView.hideGraph') : t('meshGraph.tasksView.showGraph')}
                                </button>
                            )}
                        </div>
                    )}
                    {showGoal && goalText && (
                        <div className={`mx-1 mb-1 whitespace-pre-wrap rounded-xl border px-3 py-2 text-2xs leading-4.5 ${theme.isDark ? 'border-white/10 bg-white/[0.03] text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                            {goalText}
                        </div>
                    )}
                    {showGraph && group.hasDependencies ? (
                        <div className={`mx-1 mb-1 h-[300px] overflow-hidden rounded-xl border ${theme.isDark ? 'border-white/10' : 'border-slate-200'}`}>
                            <MeshTaskDagView tasks={group.tasks} compact daemonId={daemonId} meshId={meshId} sendDaemonCommand={sendDaemonCommand} />
                        </div>
                    ) : (
                        group.tasks.map(task => (
                            <TaskRow
                                key={task.id}
                                task={task}
                                theme={theme}
                                nodeLabels={nodeLabels}
                                routing={routingIndex.get(task.id)}
                                expanded={expandedTaskId === task.id}
                                onToggle={() => onToggleTask(task.id)}
                                actions={actions}
                                onFocusNode={onFocusNode}
                            />
                        ))
                    )}
                </div>
            )}
        </section>
    )
}

export default function MeshTasksView({ tasks, status, emptyMessage, daemonId, sendDaemonCommand, onQueueMutated, onFocusNode }: MeshTasksViewProps) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const [terminalLimit, setTerminalLimit] = useState(TASK_DAG_RECENT_TERMINAL_LIMIT)
    const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const view = useMemo(() => buildMeshTasksView(tasks, status, terminalLimit), [tasks, status, terminalLimit])
    const nodeLabels = useMemo(() => buildNodeLabels(status), [status])
    // taskId -> dispatch-time routing (model / origin), joined from the ledger tail that
    // mesh_status already returns. Best-effort: the tail is capped daemon-side, so older
    // tasks simply render without a model chip.
    const routingIndex = useMemo(() => buildTaskRoutingIndex(status), [status])
    const toggleTask = (id: string) => setExpandedTaskId(current => (current === id ? null : id))

    const canMutate = !!(sendDaemonCommand && daemonId && status.meshId)
    const actions = useMemo<TaskRowActions | null>(() => {
        if (!canMutate) return null
        return {
            busyTaskId,
            error: actionError,
            run: async (action, taskId) => {
                if (!sendDaemonCommand || !daemonId) return
                setBusyTaskId(taskId)
                setActionError(null)
                try {
                    const command = action === 'cancel' ? 'cancel_mesh_queue_task' : 'requeue_mesh_queue_task'
                    const raw = await sendDaemonCommand(daemonId, command, { meshId: status.meshId, taskId })
                    // Cloud wraps daemon responses in { success, result }; standalone returns directly.
                    const res = raw?.result ?? raw
                    if (res && res.success === false) {
                        setActionError(typeof res.error === 'string' ? res.error : t('meshGraph.tasksView.actionFailed'))
                        return
                    }
                    onQueueMutated?.()
                } catch (e) {
                    setActionError(e instanceof Error ? e.message : t('meshGraph.tasksView.actionFailed'))
                } finally {
                    setBusyTaskId(null)
                }
            },
        }
    }, [canMutate, busyTaskId, actionError, sendDaemonCommand, daemonId, status.meshId, onQueueMutated, t])

    if (view.counts.total === 0) {
        return (
            <div className={`flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm ${meshTheme.textSecondary}`}>
                {emptyMessage ?? t('meshGraph.taskDag.empty')}
            </div>
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-1 pr-1.5">
            {/* Summary strip */}
            <div className="flex flex-wrap items-center gap-1.5 px-0.5">
                {view.counts.assigned > 0 && <Chip theme={meshTheme} tone="info">{t('meshGraph.tasksView.chipRunning', { count: view.counts.assigned })}</Chip>}
                {view.counts.pending > 0 && <Chip theme={meshTheme}>{t('meshGraph.tasksView.chipQueued', { count: view.counts.pending })}</Chip>}
                {view.counts.failed > 0 && <Chip theme={meshTheme} tone="danger">{t('meshGraph.tasksView.chipFailed', { count: view.counts.failed })}</Chip>}
                <Chip theme={meshTheme} tone="good">{t('meshGraph.tasksView.chipDone', { count: view.counts.completed })}</Chip>
                <span className={`text-3xs ${meshTheme.textSecondary}`}>
                    {t('meshGraph.taskDag.statsMissions', { count: view.groups.filter(g => g.missionId).length })}
                </span>
                <span className="flex-1" />
                {view.hiddenCount > 0 && (
                    <>
                        <span className={`text-3xs ${meshTheme.textSecondary}`}>{t('meshGraph.taskDag.hiddenTasks', { count: view.hiddenCount })}</span>
                        <button
                            type="button"
                            onClick={() => setTerminalLimit(limit => limit + TASK_DAG_LOAD_MORE_STEP)}
                            className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-3xs font-medium transition-colors ${meshTheme.isDark
                                ? 'border-sky-400/25 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                                : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
                        >
                            {t('meshGraph.taskDag.loadMore', { count: Math.min(TASK_DAG_LOAD_MORE_STEP, view.hiddenCount) })}
                        </button>
                    </>
                )}
            </div>

            {/* Running now */}
            {view.running.length > 0 && (
                <section className={`rounded-2xl border p-3 ${meshTheme.isDark ? 'border-sky-400/20 bg-sky-500/[0.06]' : 'border-sky-200 bg-sky-50/60'}`}>
                    <div className={`mb-1.5 px-0.5 text-3xs font-semibold uppercase tracking-[0.14em] ${meshTheme.isDark ? 'text-sky-200/90' : 'text-sky-700'}`}>
                        {t('meshGraph.tasksView.runningTitle')}
                    </div>
                    <div className="flex flex-col gap-0.5">
                        {view.running.map(task => (
                            <TaskRow
                                key={task.id}
                                task={task}
                                theme={meshTheme}
                                nodeLabels={nodeLabels}
                                routing={routingIndex.get(task.id)}
                                expanded={expandedTaskId === task.id}
                                onToggle={() => toggleTask(task.id)}
                                actions={actions}
                                onFocusNode={onFocusNode}
                            />
                        ))}
                    </div>
                </section>
            )}

            {/* Needs attention */}
            {view.attention.length > 0 && (
                <section className={`rounded-2xl border p-3 ${meshTheme.isDark ? 'border-rose-400/20 bg-rose-500/[0.05]' : 'border-rose-200 bg-rose-50/60'}`}>
                    <div className={`mb-1.5 px-0.5 text-3xs font-semibold uppercase tracking-[0.14em] ${meshTheme.isDark ? 'text-rose-200/90' : 'text-rose-700'}`}>
                        {t('meshGraph.tasksView.attentionTitle')}
                    </div>
                    <div className="flex flex-col gap-0.5">
                        {view.attention.map(task => (
                            <TaskRow
                                key={`attention-${task.id}`}
                                task={task}
                                theme={meshTheme}
                                nodeLabels={nodeLabels}
                                routing={routingIndex.get(task.id)}
                                expanded={expandedTaskId === task.id}
                                onToggle={() => toggleTask(task.id)}
                                actions={actions}
                                onFocusNode={onFocusNode}
                            />
                        ))}
                    </div>
                </section>
            )}

            {/* Action failure banner (cancel/requeue) */}
            {actionError && (
                <div className={`rounded-xl border px-3 py-2 text-2xs ${meshTheme.isDark ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
                    {actionError}
                </div>
            )}

            {/* Mission groups */}
            {view.groups.map(group => (
                <MissionGroupCard
                    key={group.missionId ?? '__adhoc__'}
                    group={group}
                    theme={meshTheme}
                    nodeLabels={nodeLabels}
                    routingIndex={routingIndex}
                    expandedTaskId={expandedTaskId}
                    onToggleTask={toggleTask}
                    actions={actions}
                    onFocusNode={onFocusNode}
                    daemonId={daemonId}
                    meshId={status.meshId}
                    sendDaemonCommand={sendDaemonCommand}
                />
            ))}
        </div>
    )
}
