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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeshGraphTheme } from './meshGraphTheme'
import { formatTaskCardTime, taskCardTimeSource } from './taskDagViewModel'
import { queueTaskDisplayText } from '../../utils/queue-task-label'
import { elapsedMsSince, formatBlueprintAge } from './blueprintViewModel'
import type { BlueprintGateRow, BlueprintTaskRow } from './useBlueprintGroups'

/** The three D5 gate verbs a Blocked-section gate row can send. */
export type GateActionKind = 'release' | 'abandon' | 'extend'

export interface GateActionHandlers {
    onRelease: (outcome: 'passed' | 'failed', evidence: string) => Promise<void>
    onAbandon: (reason: string) => Promise<void>
    onExtend: () => Promise<void>
}

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
            {/* "waiting on" one-liner (W24): names the unmet queue deps
                (depends_on chains have no graph rows, so this is the only
                place the row says WHAT it waits for). Each present dep opens
                that task; a dep absent from the snapshot is text only. */}
            {row.waitingOnRefs.length > 0 && (() => {
                const shown = row.waitingOnRefs.slice(0, WAITING_ON_SHOWN)
                const extra = row.waitingOnRefs.length - shown.length
                const tone = meshTheme.isDark ? 'text-amber-300/90' : 'text-amber-700'
                return (
                    <div
                        data-testid="blueprint-waiting-on"
                        className={`truncate pl-4 text-4xs ${tone}`}
                        title={row.waitingOnRefs.map(ref => `${ref.id}${ref.status ? ` [${ref.status}]` : ''}${ref.title ? ` — ${ref.title}` : ''}`).join('\n')}
                    >
                        {t('mesh.blueprint.list.waitingOn')}{' '}
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
            {/* "blocked by" one-liner (D5): names the gate holding this worker
                task and how long, so a blocked task row doesn't just say
                "blocked" — it says what to go release. Age is measured from
                the gate's owning graph creation — the closest "since when has
                this hold existed" the view exposes. */}
            {row.blockedByGate && (() => {
                const age = elapsedMsSince(row.blockedByGate.graph.createdAt, nowMs)
                return (
                    <div className={`truncate pl-4 text-4xs ${meshTheme.isDark ? 'text-amber-300/90' : 'text-amber-700'}`} title={row.blockedByGate.gate.instructions ?? undefined}>
                        {t('mesh.blueprint.list.blockedByGate', {
                            ref: row.blockedByGate.ref,
                            age: age != null ? formatBlueprintAge(age) : '—',
                        })}
                    </div>
                )
            })()}
        </div>
    )
}

/** Small pill button shared by the three gate actions — same visual weight,
 *  distinguished by tone (release=neutral/primary, abandon=danger, extend=info). */
function GateActionButton({ label, tone, onClick, disabled, meshTheme }: {
    label: string
    tone: 'primary' | 'danger' | 'info'
    onClick: () => void
    disabled?: boolean
    meshTheme: MeshGraphTheme
}) {
    const toneClass = tone === 'danger'
        ? (meshTheme.isDark ? 'border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20' : 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100')
        : tone === 'info'
            ? (meshTheme.isDark ? 'border-sky-400/30 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20' : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100')
            : (meshTheme.isDark ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20' : 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100')
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={event => { event.stopPropagation(); onClick() }}
            className={`shrink-0 rounded-full border px-2 py-0.5 text-4xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
        >
            {label}
        </button>
    )
}

/**
 * Inline forms for the gate verbs that need more than a yes/no — Release
 * (outcome + optional evidence) and Abandon (reason). Extend needs no form
 * beyond a confirm, which the caller (MeshBlueprintList) handles with
 * useConfirmDialog before invoking onExtend.
 *
 * Local, uncontrolled-by-parent state: only one of {closed, release, abandon}
 * is open at a time, and closes itself on submit/cancel. Errors from a failed
 * command surface inline here rather than a toast, per D5's "surface command
 * errors inline".
 */
function GateActionsPanel({ row, actions, meshTheme, busy }: {
    row: BlueprintGateRow
    actions: GateActionHandlers
    meshTheme: MeshGraphTheme
    busy: boolean
}) {
    const { t } = useTranslation('common')
    const [openForm, setOpenForm] = useState<'release' | 'abandon' | null>(null)
    const [outcome, setOutcome] = useState<'passed' | 'failed'>('passed')
    const [evidence, setEvidence] = useState('')
    const [reason, setReason] = useState('')
    const [error, setError] = useState<string | null>(null)

    const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

    const submitRelease = async () => {
        setError(null)
        try {
            await actions.onRelease(outcome, evidence)
            setOpenForm(null)
            setEvidence('')
        } catch (e: any) {
            setError(e?.message || String(e))
        }
    }
    const submitAbandon = async () => {
        if (!reason.trim()) { setError(t('mesh.blueprint.gate.abandonReasonRequired')); return }
        setError(null)
        try {
            await actions.onAbandon(reason)
            setOpenForm(null)
            setReason('')
        } catch (e: any) {
            setError(e?.message || String(e))
        }
    }
    const runExtend = async () => {
        setError(null)
        try {
            await actions.onExtend()
        } catch (e: any) {
            setError(e?.message || String(e))
        }
    }

    return (
        <div className="flex flex-col gap-1 pl-4" onClick={stop}>
            <div className="flex flex-wrap items-center gap-1">
                <GateActionButton
                    label={t('mesh.blueprint.gate.release')}
                    tone="primary"
                    disabled={busy}
                    meshTheme={meshTheme}
                    onClick={() => { setError(null); setOpenForm(current => current === 'release' ? null : 'release') }}
                />
                <GateActionButton
                    label={t('mesh.blueprint.gate.abandon')}
                    tone="danger"
                    disabled={busy}
                    meshTheme={meshTheme}
                    onClick={() => { setError(null); setOpenForm(current => current === 'abandon' ? null : 'abandon') }}
                />
                <GateActionButton
                    label={t('mesh.blueprint.gate.extend24h')}
                    tone="info"
                    disabled={busy}
                    meshTheme={meshTheme}
                    onClick={() => void runExtend()}
                />
            </div>
            {openForm === 'release' && (
                <div className={`flex flex-col gap-1.5 rounded-lg border p-2 ${meshTheme.isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-center gap-2 text-4xs">
                        <label className="flex items-center gap-1">
                            <input type="radio" name={`release-outcome-${row.nodeId}`} checked={outcome === 'passed'} onChange={() => setOutcome('passed')} />
                            {t('mesh.blueprint.gate.outcomePassed')}
                        </label>
                        <label className="flex items-center gap-1">
                            <input type="radio" name={`release-outcome-${row.nodeId}`} checked={outcome === 'failed'} onChange={() => setOutcome('failed')} />
                            {t('mesh.blueprint.gate.outcomeFailed')}
                        </label>
                    </div>
                    <input
                        type="text"
                        value={evidence}
                        onChange={event => setEvidence(event.target.value)}
                        placeholder={t('mesh.blueprint.gate.evidencePlaceholder')}
                        className={`w-full rounded-md border px-2 py-1 text-4xs ${meshTheme.isDark ? 'border-white/10 bg-black/30 text-slate-200 placeholder:text-slate-500' : 'border-slate-200 bg-white text-slate-800 placeholder:text-slate-400'}`}
                    />
                    <div className="flex items-center justify-end gap-1.5">
                        <button type="button" className="rounded-full px-2 py-0.5 text-4xs text-text-muted hover:underline" onClick={() => setOpenForm(null)} disabled={busy}>
                            {t('common.cancel')}
                        </button>
                        <GateActionButton label={t('mesh.blueprint.gate.submitRelease')} tone="primary" meshTheme={meshTheme} disabled={busy} onClick={() => void submitRelease()} />
                    </div>
                </div>
            )}
            {openForm === 'abandon' && (
                <div className={`flex flex-col gap-1.5 rounded-lg border p-2 ${meshTheme.isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-white'}`}>
                    <input
                        type="text"
                        value={reason}
                        onChange={event => setReason(event.target.value)}
                        placeholder={t('mesh.blueprint.gate.reasonPlaceholder')}
                        className={`w-full rounded-md border px-2 py-1 text-4xs ${meshTheme.isDark ? 'border-white/10 bg-black/30 text-slate-200 placeholder:text-slate-500' : 'border-slate-200 bg-white text-slate-800 placeholder:text-slate-400'}`}
                    />
                    <div className="flex items-center justify-end gap-1.5">
                        <button type="button" className="rounded-full px-2 py-0.5 text-4xs text-text-muted hover:underline" onClick={() => setOpenForm(null)} disabled={busy}>
                            {t('common.cancel')}
                        </button>
                        <GateActionButton label={t('mesh.blueprint.gate.submitAbandon')} tone="danger" meshTheme={meshTheme} disabled={busy} onClick={() => void submitAbandon()} />
                    </div>
                </div>
            )}
            {error && (
                <div className={`truncate text-4xs ${meshTheme.isDark ? 'text-rose-300' : 'text-rose-600'}`} title={error}>
                    {error}
                </div>
            )}
        </div>
    )
}

export function MeshBlueprintGateRowView({ row, meshTheme, nowMs, onOpen, planExpanded, onTogglePlan, actions, actionsBusy }: {
    row: BlueprintGateRow
    meshTheme: MeshGraphTheme
    /** Shared clock (same one task rows use) — drives the expired-age label. */
    nowMs: number
    onOpen: () => void
    planExpanded: boolean
    onTogglePlan?: () => void
    /** Present only when the caller can send daemon commands (D5 gate verbs). */
    actions?: GateActionHandlers
    /** True while a command for THIS row is in flight — disables all three buttons. */
    actionsBusy?: boolean
}) {
    const { t } = useTranslation('common')
    const dot = GATE_DOT[row.state] ?? { dot: 'bg-amber-400', pulse: true }
    const isExpired = row.state === 'expired'
    const expiredAgeMs = isExpired ? elapsedMsSince(row.gate?.deadlineAt, nowMs) : undefined
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
                {/* Expired gets its own distinct badge (rose, with age) instead
                    of the generic amber "Needs you" — a gate that blew past
                    its deadline is a different, more urgent state than one
                    still comfortably inside it. */}
                {isExpired ? (
                    <span className={roseChip(meshTheme.isDark)} title={row.gate?.deadlineAt}>
                        {t('mesh.blueprint.gate.expiredBadge', { age: expiredAgeMs != null ? formatBlueprintAge(expiredAgeMs) : '—' })}
                    </span>
                ) : (
                    <span className={amberChip(meshTheme.isDark)}>{t('mesh.taskDag.gate.needsYou')}</span>
                )}
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
            {/* Release / Abandon / Extend — D5 lifts the earlier "coordinator
                only" call. Only rendered when the caller can actually send a
                daemon command (cloud=P2P, standalone=REST — both funnel
                through the same sendDaemonCommand prop the rest of this tab
                already uses for fast-forward/route-preview). */}
            {actions && row.gate && (
                <GateActionsPanel row={row} actions={actions} meshTheme={meshTheme} busy={Boolean(actionsBusy)} />
            )}
        </div>
    )
}
