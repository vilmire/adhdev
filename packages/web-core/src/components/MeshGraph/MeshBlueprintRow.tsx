/**
 * MeshBlueprintRow — one line of the blueprint list. Information hierarchy
 * (owner-approved wireframe, 2026-09-16), in reading order:
 *
 *   1. status dot + status word    — the 0.1-second read
 *   2. one-line title              — what the task is (truncated)
 *   3. time                        — small monospace, absolute + relative
 *   4. block/gate badges           — amber (human hold / dep wait), rose (failure hold)
 *   5. node · provider chips       — where and with what it ran
 *
 * Long bodies and final summaries stay OUT of the row — clicking it opens the
 * shared detail modal (MeshOverviewDetailModal), which already renders both
 * through splitTaskMessage / splitFinalSummary. The predicted-slot chip
 * renders ONLY for pinned tasks (📌): the generic unpinned forecast lives in
 * the scheduling popover, never on a row where it reads as an assignment.
 *
 * The "plan" disclosure appears only when the row can actually draw a plan
 * (a graph with edges, or queue dependency edges) — see useBlueprintGroups.
 */
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'
import { formatTaskCardTime, taskCardTimeSource } from './taskDagViewModel'
import { queueTaskDisplayText } from '../../utils/queue-task-label'
import type { BlueprintGateRow, BlueprintTaskRow } from './useBlueprintGroups'

/** Status word → dot tone + text tone, per section emphasis. */
const ROW_DOT: Record<string, { dot: string; pulse?: boolean }> = {
    generating: { dot: 'bg-sky-400', pulse: true },
    assigned: { dot: 'bg-sky-400', pulse: true },
    pending: { dot: 'bg-slate-400' },
    completed: { dot: 'bg-emerald-400' },
    failed: { dot: 'bg-rose-400' },
    cancelled: { dot: 'bg-slate-500' },
}

const GATE_DOT: Record<string, { dot: string; pulse?: boolean }> = {
    awaiting_coordinator: { dot: 'bg-amber-400', pulse: true },
    claimed: { dot: 'bg-sky-400', pulse: true },
    expired: { dot: 'bg-rose-400', pulse: true },
}

function amberChip(isDark: boolean): string {
    return isDark
        ? 'rounded-full border border-amber-400/25 bg-amber-500/10 px-1.5 py-px text-4xs text-amber-200'
        : 'rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px text-4xs text-amber-700'
}

function roseChip(isDark: boolean): string {
    return isDark
        ? 'rounded-full border border-rose-400/25 bg-rose-500/10 px-1.5 py-px text-4xs text-rose-200'
        : 'rounded-full border border-rose-300 bg-rose-50 px-1.5 py-px text-4xs text-rose-700'
}

function neutralChip(isDark: boolean): string {
    return isDark
        ? 'rounded-full border border-white/10 bg-white/[0.06] px-1.5 py-px text-4xs text-slate-300'
        : 'rounded-full border border-slate-200 bg-white/80 px-1.5 py-px text-4xs text-slate-500'
}

function PlanToggle({ expanded, onToggle, meshTheme }: { expanded: boolean; onToggle: () => void; meshTheme: MeshGraphTheme }) {
    const { t } = useTranslation('common')
    return (
        <button
            type="button"
            onClick={event => { event.stopPropagation(); onToggle() }}
            aria-expanded={expanded}
            title={t('mesh.blueprint.list.planTitle')}
            className={`shrink-0 rounded-md border px-1.5 py-0.5 text-4xs font-medium transition-colors ${meshTheme.isDark
                ? 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.09]'
                : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
        >
            {expanded ? t('mesh.blueprint.list.planHide') : t('mesh.blueprint.list.planShow')} {expanded ? '▲' : '▼'}
        </button>
    )
}

export function MeshBlueprintTaskRowView({ row, meshTheme, nowMs, nodeLabel, pinnedSlot, missionTitle, onOpen, onMissionOpen, planExpanded, onTogglePlan }: {
    row: BlueprintTaskRow
    meshTheme: MeshGraphTheme
    nowMs: number
    /** `checkout · machine` for the node this task ran on, when assigned. */
    nodeLabel?: string
    /** Predicted slot on the task's PINNED node — the only forecast a row shows. */
    pinnedSlot?: string
    missionTitle?: string
    onOpen: () => void
    onMissionOpen?: (missionId: string) => void
    planExpanded: boolean
    /** Present only when the row has a plan to draw. */
    onTogglePlan?: () => void
}) {
    const { t } = useTranslation('common')
    const task = row.task
    const dot = ROW_DOT[row.statusToken] ?? ROW_DOT.pending
    const time = formatTaskCardTime(taskCardTimeSource(task), nowMs, t)
    // Visual weight by section: Running full colour, Blocked full colour with
    // its badges carrying the alarm, Recent muted, History grayscale.
    const emphasis = row.section === 'recent'
        ? 'opacity-70 hover:opacity-100'
        : row.section === 'history'
            ? 'opacity-50 grayscale hover:opacity-90 hover:grayscale-0'
            : ''
    const statusTone = row.statusToken === 'failed'
        ? (meshTheme.isDark ? 'text-rose-300' : 'text-rose-600')
        : row.statusToken === 'generating' || row.statusToken === 'assigned'
            ? (meshTheme.isDark ? 'text-sky-300' : 'text-sky-600')
            : ''
    const provider = task.assignedProviderType || task.autoLaunch?.providerType
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}
            className={`group flex w-full cursor-pointer flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors ${meshTheme.isDark
                ? 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06]'
                : 'border-slate-200 bg-white/85 hover:bg-white'} ${emphasis}`}
        >
            <div className="flex min-w-0 items-center gap-2">
                {/* motion-safe: the pulse is a never-ending CSS animation. */}
                <span className={`h-2 w-2 shrink-0 rounded-full ${dot.dot} ${dot.pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden />
                <span className={`shrink-0 text-3xs font-semibold uppercase tracking-wide ${statusTone || 'opacity-80'}`}>
                    {row.statusToken === 'generating' ? t('mesh.blueprint.list.generating') : task.status}
                </span>
                <span className={`min-w-0 flex-1 truncate text-2xs ${meshTheme.isDark ? 'text-slate-200' : 'text-slate-700'}`} title={queueTaskDisplayText(task.message)}>
                    {queueTaskDisplayText(task.message)}
                </span>
                {time && (
                    <span className={`shrink-0 font-mono text-4xs tabular-nums ${meshTheme.isDark ? 'text-slate-400' : 'text-slate-500'}`} title={`${time.iso}\n${task.id}`}>
                        {time.absolute} <span className="opacity-70">({time.relative})</span>
                    </span>
                )}
                {onTogglePlan && <PlanToggle expanded={planExpanded} onToggle={onTogglePlan} meshTheme={meshTheme} />}
            </div>
            {/* Badge row — only rendered when it has something to say. */}
            {(row.awaitingApproval || row.awaitingChoice || row.blockedReason || row.dependencyFailureCount > 0
                || row.waitingOn.length > 0 || row.missingDeps.length > 0 || pinnedSlot || task.difficulty
                || (task.priority && task.priority !== 'normal') || task.readonly || task.taskMode === 'live_debug_readonly'
                || missionTitle || provider || nodeLabel) && (
                <div className="flex min-w-0 flex-wrap items-center gap-1 pl-4">
                    {row.awaitingApproval && (
                        <span className={amberChip(meshTheme.isDark)} title={row.sessionNote ?? undefined}>
                            {t('mesh.blueprint.list.approvalNeeded')}
                        </span>
                    )}
                    {row.awaitingChoice && (
                        <span className={amberChip(meshTheme.isDark)} title={row.sessionNote ?? undefined}>
                            {t('mesh.blueprint.list.choiceNeeded')}
                        </span>
                    )}
                    {row.blockedReason && (
                        <span className={roseChip(meshTheme.isDark)} title={row.blockedReason}>
                            {t('mesh.taskDag.blocked')}
                        </span>
                    )}
                    {row.dependencyFailureCount > 0 && (
                        <span className={roseChip(meshTheme.isDark)}>
                            {t('mesh.taskDag.plan.depsFailed', { count: row.dependencyFailureCount })}
                        </span>
                    )}
                    {row.waitingOn.length > 0 && (
                        <span className={amberChip(meshTheme.isDark)} title={row.waitingOn.join(', ')}>
                            {t('mesh.taskDag.waitsOn', { count: row.waitingOn.length })}
                        </span>
                    )}
                    {row.missingDeps.length > 0 && (
                        <span className={neutralChip(meshTheme.isDark)} title={row.missingDeps.join(', ')}>
                            {t('mesh.taskDag.missingDeps', { count: row.missingDeps.length })}
                        </span>
                    )}
                    {/* Pinned-route forecast ONLY — never the generic one. */}
                    {pinnedSlot && task.status === 'pending' && (
                        <span
                            className={meshTheme.isDark
                                ? 'rounded-full border border-sky-400/25 bg-sky-500/10 px-1.5 py-px text-4xs text-sky-200'
                                : 'rounded-full border border-sky-300 bg-sky-50 px-1.5 py-px text-4xs text-sky-700'}
                            title={t('mesh.taskDag.predictedSlotPinned')}
                        >
                            📌 {pinnedSlot}
                        </span>
                    )}
                    {task.difficulty && <span className={neutralChip(meshTheme.isDark)}>{task.difficulty}</span>}
                    {task.priority && task.priority !== 'normal' && <span className={neutralChip(meshTheme.isDark)}>{task.priority}</span>}
                    {(task.taskMode === 'live_debug_readonly' || task.readonly) && <span className={neutralChip(meshTheme.isDark)}>read-only</span>}
                    {missionTitle && task.missionId && (
                        <button
                            type="button"
                            onClick={event => { event.stopPropagation(); onMissionOpen?.(task.missionId!) }}
                            className={meshTheme.isDark
                                ? 'max-w-[180px] truncate rounded-full border border-indigo-400/25 bg-indigo-500/10 px-1.5 py-px text-4xs text-indigo-200 hover:bg-indigo-500/20'
                                : 'max-w-[180px] truncate rounded-full border border-indigo-200 bg-indigo-50/80 px-1.5 py-px text-4xs text-indigo-700 hover:bg-indigo-100'}
                            title={`${missionTitle} (${task.missionId})`}
                        >
                            ⚑ {missionTitle}
                        </button>
                    )}
                    {(provider || nodeLabel) && (
                        <span className={`flex min-w-0 items-center gap-1 text-4xs ${meshTheme.isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            <span className="shrink-0 opacity-70">▶</span>
                            {provider && <span className="shrink-0 font-medium">{provider}</span>}
                            {nodeLabel && <span className="min-w-0 truncate" title={nodeLabel}>{provider ? '@ ' : ''}{nodeLabel}</span>}
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}

export function MeshBlueprintGateRowView({ row, meshTheme, onOpen, planExpanded, onTogglePlan }: {
    row: BlueprintGateRow
    meshTheme: MeshGraphTheme
    onOpen: () => void
    planExpanded: boolean
    onTogglePlan?: () => void
}) {
    const { t } = useTranslation('common')
    const dot = GATE_DOT[row.state] ?? { dot: 'bg-amber-400', pulse: true }
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}
            className={`group flex w-full cursor-pointer flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors ${meshTheme.isDark
                ? 'border-amber-400/25 bg-amber-500/[0.06] hover:bg-amber-500/[0.12]'
                : 'border-amber-300 bg-amber-50/70 hover:bg-amber-50'}`}
        >
            <div className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${dot.dot} ${dot.pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden />
                <span className={`shrink-0 text-3xs font-semibold uppercase tracking-wide ${meshTheme.isDark ? 'text-amber-200' : 'text-amber-700'}`}>
                    ⛩ {row.gate?.action ?? 'gate'} · {row.state}{row.gate?.leaseExpired ? ` · ${t('mesh.blueprint.leaseExpired')}` : ''}
                </span>
                <span className={`min-w-0 flex-1 truncate text-2xs ${meshTheme.isDark ? 'text-slate-200' : 'text-slate-700'}`} title={row.ref}>
                    {row.ref}
                </span>
                {onTogglePlan && <PlanToggle expanded={planExpanded} onToggle={onTogglePlan} meshTheme={meshTheme} />}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1 pl-4">
                <span className={amberChip(meshTheme.isDark)}>{t('mesh.taskDag.gate.needsYou')}</span>
                {row.gate?.blocking?.length ? (
                    <span className={amberChip(meshTheme.isDark)}>{t('mesh.taskDag.gate.holding', { count: row.gate.blocking.length })}</span>
                ) : null}
                {row.gate?.deadlineAt && (
                    <span className={neutralChip(meshTheme.isDark)} title={row.gate.deadlineAt}>
                        {t('mesh.taskDag.gate.deadline', {
                            time: new Date(row.gate.deadlineAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                            onTimeout: row.gate.onTimeout,
                        })}
                    </span>
                )}
                {row.gate?.instructions && (
                    <span className={`min-w-0 truncate text-4xs opacity-80 ${meshTheme.isDark ? 'text-slate-300' : 'text-slate-600'}`} title={row.gate.instructions}>
                        {row.gate.instructions}
                    </span>
                )}
            </div>
        </div>
    )
}
