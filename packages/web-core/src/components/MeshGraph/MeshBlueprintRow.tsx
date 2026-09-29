/**
 * MeshBlueprintRow — one line of the blueprint list. Information hierarchy
 * (owner-approved wireframe, 2026-09-16), in reading order:
 *
 *   1. status dot + status word    — the 0.1-second read
 *   2. one-line title              — what the task is (truncated)
 *   3. time                        — small monospace, absolute + relative
 *   4. block badges                — amber (human hold / dep wait), rose (failure hold)
 *   5. node · provider chips       — where and with what it ran
 *
 * Long bodies and final summaries stay OUT of the row — clicking it opens the
 * shared detail modal (MeshOverviewDetailModal), which already renders both
 * through splitTaskMessage / splitFinalSummary. The predicted-slot chip
 * renders ONLY for pinned tasks (📌): the generic unpinned forecast lives in
 * the scheduling popover, never on a row where it reads as an assignment.
 *
 * The "plan" disclosure appears only when the row can actually draw a plan
 * (queue dependency edges) — see useBlueprintGroups.
 */
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'
import { formatTaskCardTime, taskCardTimeSource } from './taskDagViewModel'
import { queueTaskDisplayText } from '../../utils/queue-task-label'
import type { BlueprintTaskRow } from './useBlueprintGroups'

/** Status word → dot tone + text tone, per section emphasis. */
const ROW_DOT: Record<string, { dot: string; pulse?: boolean }> = {
    generating: { dot: 'bg-accent', pulse: true },
    assigned: { dot: 'bg-accent', pulse: true },
    pending: { dot: 'bg-text-muted' },
    completed: { dot: 'bg-status-online' },
    failed: { dot: 'bg-status-error' },
    cancelled: { dot: 'bg-status-offline' },
}

// Row chips share one geometry (h-5, centred) so a mixed row stays on one
// centre line; tone colours only the text and the thin border.
const ROW_CHIP = 'inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full border px-1.5 text-4xs leading-none'

function amberChip(): string {
    return `${ROW_CHIP} border-status-warning/35 text-status-warning`
}

function roseChip(): string {
    return `${ROW_CHIP} border-status-error/35 text-status-error`
}

function neutralChip(): string {
    return `${ROW_CHIP} border-border-default text-text-secondary`
}

function PlanToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void; meshTheme: MeshGraphTheme }) {
    const { t } = useTranslation('common')
    return (
        <button
            type="button"
            onClick={event => { event.stopPropagation(); onToggle() }}
            aria-expanded={expanded}
            title={t('mesh.blueprint.list.planTitle')}
            className="inline-flex h-5 shrink-0 items-center rounded-md border border-border-default px-1.5 text-4xs font-medium leading-none text-text-secondary transition-colors hover:bg-bg-glass-hover hover:text-text-primary"
        >
            {expanded ? t('mesh.blueprint.list.planHide') : t('mesh.blueprint.list.planShow')} {expanded ? '▲' : '▼'}
        </button>
    )
}

/** How many named deps the "waiting on:" line spells out before "+N more". */
const WAITING_ON_SHOWN = 2

export function MeshBlueprintTaskRowView({ row, meshTheme, nowMs, nodeLabel, pinnedSlot, missionTitle, onOpen, onOpenTaskId, onMissionOpen, planExpanded, onTogglePlan }: {
    row: BlueprintTaskRow
    meshTheme: MeshGraphTheme
    nowMs: number
    /** `checkout · machine` for the node this task ran on, when assigned. */
    nodeLabel?: string
    /** Predicted slot on the task's PINNED node — the only forecast a row shows. */
    pinnedSlot?: string
    missionTitle?: string
    onOpen: () => void
    /** Opens another queue task by id — makes "waiting on" entries clickable. */
    onOpenTaskId?: (taskId: string) => void
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
        ? 'text-status-error'
        : row.statusToken === 'generating' || row.statusToken === 'assigned'
            ? 'text-accent'
            : 'text-text-muted'
    const provider = task.assignedProviderType || task.autoLaunch?.providerType
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}
            className={`group flex w-full cursor-pointer flex-col gap-1 rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-left transition-colors hover:border-border-default hover:bg-bg-glass-hover ${emphasis}`}
        >
            <div className="flex min-w-0 items-center gap-2">
                {/* motion-safe: the pulse is a never-ending CSS animation. */}
                <span className={`h-2 w-2 shrink-0 rounded-full ${dot.dot} ${dot.pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden />
                <span className={`shrink-0 text-3xs font-medium ${statusTone}`}>
                    {row.statusToken === 'generating' ? t('mesh.blueprint.list.generating') : task.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-text-primary" title={queueTaskDisplayText(task.message)}>
                    {queueTaskDisplayText(task.message)}
                </span>
                {time && (
                    <span className="shrink-0 font-mono text-4xs tabular-nums text-text-muted" title={`${time.iso}\n${task.id}`}>
                        {time.absolute} <span className="opacity-70">({time.relative})</span>
                    </span>
                )}
                {onTogglePlan && <PlanToggle expanded={planExpanded} onToggle={onTogglePlan} meshTheme={meshTheme} />}
            </div>
            {/* Badge row — only rendered when it has something to say. */}
            {(row.awaitingApproval || row.awaitingChoice || row.dependencyFailureCount > 0
                || row.waitingOn.length > 0 || row.missingDeps.length > 0 || pinnedSlot || task.difficulty
                || (task.priority && task.priority !== 'normal') || task.readonly || task.taskMode === 'live_debug_readonly'
                || missionTitle || provider || nodeLabel) && (
                <div className="flex min-w-0 flex-wrap items-center gap-1 pl-4">
                    {row.awaitingApproval && (
                        <span className={amberChip()} title={row.sessionNote ?? undefined}>
                            {t('mesh.blueprint.list.approvalNeeded')}
                        </span>
                    )}
                    {row.awaitingChoice && (
                        <span className={amberChip()} title={row.sessionNote ?? undefined}>
                            {t('mesh.blueprint.list.choiceNeeded')}
                        </span>
                    )}
                    {row.dependencyFailureCount > 0 && (
                        <span className={roseChip()}>
                            {t('mesh.taskDag.plan.depsFailed', { count: row.dependencyFailureCount })}
                        </span>
                    )}
                    {row.waitingOn.length > 0 && (
                        <span className={amberChip()} title={row.waitingOn.join(', ')}>
                            {t('mesh.taskDag.waitsOn', { count: row.waitingOn.length })}
                        </span>
                    )}
                    {row.missingDeps.length > 0 && (
                        <span className={neutralChip()} title={row.missingDeps.join(', ')}>
                            {t('mesh.taskDag.missingDeps', { count: row.missingDeps.length })}
                        </span>
                    )}
                    {/* Pinned-route forecast ONLY — never the generic one. */}
                    {pinnedSlot && task.status === 'pending' && (
                        <span
                            className={neutralChip()}
                            title={t('mesh.taskDag.predictedSlotPinned')}
                        >
                            📌 {pinnedSlot}
                        </span>
                    )}
                    {task.difficulty && <span className={neutralChip()}>{task.difficulty}</span>}
                    {task.priority && task.priority !== 'normal' && <span className={neutralChip()}>{task.priority}</span>}
                    {(task.taskMode === 'live_debug_readonly' || task.readonly) && <span className={neutralChip()}>{t('mesh.blueprint.readonlyBadge')}</span>}
                    {missionTitle && task.missionId && (
                        <button
                            type="button"
                            onClick={event => { event.stopPropagation(); onMissionOpen?.(task.missionId!) }}
                            className={`${neutralChip()} max-w-[180px] truncate hover:bg-bg-glass-hover hover:text-text-primary`}
                            title={`${missionTitle} (${task.missionId})`}
                        >
                            ⚑ {missionTitle}
                        </button>
                    )}
                    {(provider || nodeLabel) && (
                        <span className="flex min-w-0 items-center gap-1 text-4xs text-text-muted">
                            <span className="shrink-0 opacity-70">▶</span>
                            {provider && <span className="shrink-0 font-medium">{provider}</span>}
                            {nodeLabel && <span className="min-w-0 truncate" title={nodeLabel}>{provider ? '@ ' : ''}{nodeLabel}</span>}
                        </span>
                    )}
                </div>
            )}
            {/* "waiting on" one-liner (W24): names the unmet queue deps
                (depends_on chains have no graph rows, so this is the only
                place the row says WHAT it waits for). Each present dep opens
                that task; a dep absent from the snapshot is text only. */}
            {row.waitingOnRefs.length > 0 && (() => {
                const shown = row.waitingOnRefs.slice(0, WAITING_ON_SHOWN)
                const extra = row.waitingOnRefs.length - shown.length
                // A failed/cancelled dependency is not "waiting" — the task will
                // not start on its own (block policy), so say so, in red.
                const dead = row.blockedByDeadDependency
                const tone = dead ? 'text-status-error' : 'text-status-warning'
                return (
                    <div
                        data-testid="blueprint-waiting-on"
                        className={`truncate pl-4 text-4xs ${tone}`}
                        title={row.waitingOnRefs.map(ref => `${ref.id}${ref.status ? ` [${ref.status}]` : ''}${ref.title ? ` — ${ref.title}` : ''}`).join('\n')}
                    >
                        {t(dead ? 'mesh.blueprint.list.blockedByDeadDependency' : 'mesh.blueprint.list.waitingOn')}{' '}
                        {shown.map((ref, index) => {
                            const label = ref.title ? `${ref.shortId} · ${ref.title}` : ref.shortId
                            return (
                                <span key={ref.id}>
                                    {index > 0 ? ', ' : ''}
                                    {ref.present && onOpenTaskId ? (
                                        <button
                                            type="button"
                                            data-testid="blueprint-waiting-on-dep"
                                            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                                            onClick={event => { event.stopPropagation(); onOpenTaskId(ref.id) }}
                                        >
                                            {label}
                                        </button>
                                    ) : label}
                                </span>
                            )
                        })}
                        {extra > 0 ? ` ${t('mesh.blueprint.list.waitingOnMore', { count: extra })}` : ''}
                    </div>
                )
            })()}
        </div>
    )
}
