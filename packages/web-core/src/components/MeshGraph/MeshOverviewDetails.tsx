/**
 * The mesh Overview detail modal: one pinned detail view per overview row kind —
 * mission, ledger entry, queue task (with its routing decision) and session —
 * opened from any card and navigable as a stack.
 */
import type { DetailSelection, MeshCommandSeam } from './MeshOverviewCards';
import { ledgerKindLabel, queueTaskSortRank, useRecentList, StatusBadge, missionStatusLabel, missionStatusTone, StatTile, formatDuration, ListRow, queueTaskStatusLabel, queueTaskTone, difficultyLabel, difficultyTone, relativeTime, MoreToggle, ModalRow, payloadSummary, ledgerKindTone, sessionStatusTone, type MeshMissionDisplay } from './meshOverviewPrimitives';
import { splitTaskMessage, splitFinalSummary } from './blueprintViewModel';
import { queueTaskDisplayText, stripMarkdownSyntax } from '../../utils/queue-task-label';
import { nodeDisplayName, sessionStatusLabel, sessionStatusText, sessionRoleText } from './MeshObservabilitySurface/meshSurfaceHelpers';
import type { MeshGraphTheme } from './meshGraphTheme';
import type { RepoMeshQueueTask, RepoMeshLedgerEntryStatus, RepoMeshNodeStatus } from '@adhdev/daemon-core';
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { installTopModalEscapeHandler } from '../../utils/modal-escape';
import ModalPortal from '../ui/ModalPortal';
import { TechnicalDetails } from '../ui/TechnicalDetails';
import { requestOpenSessionChat } from '../../utils/session-nav';
import type { MeshGraphSessionDetail } from '../../utils/mesh-visualization';

function detailTitle(detail: DetailSelection, t: (key: string) => string): { kicker: string; title: string } {
    switch (detail.kind) {
        case 'mission': return { kicker: t('mesh.overview.detailKickerMission'), title: detail.mission.title }
        case 'ledger': return { kicker: t('mesh.overview.detailKickerLedger'), title: ledgerKindLabel(detail.entry.kind, t) }
        case 'queue': return { kicker: t('mesh.overview.detailKickerQueue'), title: splitTaskMessage(queueTaskDisplayText(detail.task.message))?.lead.slice(0, 120) || t('mesh.overview.detailKickerQueue') }
        case 'session': return { kicker: t('mesh.overview.detailKickerSession'), title: [detail.session.providerType, nodeDisplayName(detail.node)].filter(Boolean).join(' · ') }
    }
}

// Exported (named) so the safe-area / close-path regression tests can render the
// modal directly without driving the whole overview card grid.
export function MeshOverviewDetailModal({ meshTheme, detail, onClose, onBack, daemonId, meshId, sendDaemonCommand, resolveNodeLabel, queueTasks, onOpenTask, missionTitles, onOpenMission, onShowMission }: {
    meshTheme: MeshGraphTheme
    detail: DetailSelection
    onClose: () => void
    /** Present when a previous detail is on the stack — renders a Back button. */
    onBack?: () => void
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
    const overlayClass = dk ? 'bg-[rgba(0,0,0,0.72)]' : 'bg-[rgba(15,23,42,0.55)]'
    const shellClass = 'border-border-default bg-bg-primary shadow-lg'

    return (
        <ModalPortal>
        <div
            // Side drawer from md up (the list it came from stays visible to
            // its left); fullscreen sheet on phones.
            className={`fixed inset-0 z-[var(--z-modal)] flex items-stretch justify-center p-0 md:justify-end ${overlayClass}`}
            role="dialog"
            aria-modal="true"
            onClick={onClose}
        >
            <div
                className={`flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden border ${shellClass} md:max-w-[min(520px,calc(100vw-32px))] md:border-y-0 md:border-r-0`}
                onClick={event => event.stopPropagation()}
            >
                {/* Safe-area-aware sticky header: in the iOS installed PWA
                    (viewport-fit=cover) the fullscreen 100dvh shell extends under
                    the status bar, so the header must pad below
                    env(safe-area-inset-top) or the close control lands inside the
                    system clock/battery area and becomes untappable. */}
                <div className={`sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 border-b px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top,0px))] border-border-subtle`}>
                    <div className="flex min-w-0 items-start gap-2">
                        {onBack && (
                            <button
                                type="button"
                                onClick={onBack}
                                aria-label={t('common.back')}
                                className="-m-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center"
                            >
                                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-default bg-bg-glass text-text-secondary transition hover:bg-bg-glass-hover hover:text-text-primary">
                                    ‹
                                </span>
                            </button>
                        )}
                        <div className="min-w-0">
                            <div className={`text-3xs font-medium ${meshTheme.textMuted}`}>{kicker}</div>
                            <div className={`mt-0.5 break-words text-sm font-semibold ${meshTheme.textPrimary}`}>{title}</div>
                        </div>
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
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-default bg-bg-glass text-text-secondary transition hover:bg-bg-glass-hover hover:text-text-primary">
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
                            daemonId={daemonId}
                            meshId={meshId}
                            sendDaemonCommand={sendDaemonCommand}
                        />
                    )}
                    {detail.kind === 'session' && <SessionDetail meshTheme={meshTheme} node={detail.node} session={detail.session} queueTasks={queueTasks} onOpenTask={onOpenTask} />}
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
                <StatusBadge meshTheme={meshTheme} label={missionStatusLabel(mission.status, t)} tone={missionStatusTone(mission.status)} />
                <StatusBadge meshTheme={meshTheme} label={t('mesh.overview.tasksCount', { count: t_tasks.total })} tone="muted" />
            </div>
            {goalText && (
                <div className={`max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>
                    {stripMarkdownSyntax(goalText)}
                    {showTruncatedLabel && !canFetchGoal && <span className={meshTheme.textMuted}> … {t('mesh.overview.truncated')}</span>}
                </div>
            )}
            {fetchError && <div className="text-2xs text-status-warning">{fetchError}</div>}
            {canFetchGoal && (
                <button
                    type="button"
                    className="self-start text-xs text-accent-primary hover:underline disabled:opacity-50"
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
                        className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
                        onClick={onShowOnCanvas}
                    >
                        {t('mesh.overview.showOnCanvas')}
                    </button>
                </div>
            )}
            {missionTasks.length > 0 && (
                <div>
                    <div className={`mb-1 text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.missionTasksHeading')}</div>
                    <div className="flex flex-col gap-0.5">
                        {taskList.visible.map(task => (
                            <ListRow key={task.id} meshTheme={meshTheme} onClick={onOpenTask ? () => onOpenTask(task) : undefined}>
                                <StatusBadge meshTheme={meshTheme} label={queueTaskStatusLabel(task.status, t)} tone={queueTaskTone(task.status)} />
                                {task.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(task.difficulty, t)} tone={difficultyTone()} />}
                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textSecondary}`} title={task.message || undefined}>{queueTaskDisplayText(task.message) || task.id}</span>
                                <span className={`shrink-0 text-3xs ${meshTheme.textMuted}`}>{relativeTime(task.updatedAt) ?? ''}</span>
                            </ListRow>
                        ))}
                        <MoreToggle meshTheme={meshTheme} expanded={taskList.expanded} hiddenCount={taskList.hiddenCount} onToggle={taskList.toggle} />
                    </div>
                </div>
            )}
            <div className="grid gap-1.5 text-xs">
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
            <TechnicalDetails summaryClassName={meshTheme.textMuted} rows={[{ label: t('mesh.overview.detailLabelMissionId'), value: mission.id }]} />
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
            <div className={`text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.routingHeading')}</div>
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
                    <div className={`text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.routingSkipped')}</div>
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
    // G5-2: JSON.stringify can throw on a circular payload; there is nothing
    // useful to disclose in that case (String(obj) would just print
    // "[object Object]"), so payloadJson stays empty and the raw-payload
    // disclosure below doesn't render at all rather than showing that.
    let payloadJson = ''
    try {
        payloadJson = JSON.stringify(entry.payload ?? {}, null, 2)
    } catch {
        payloadJson = ''
    }
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={ledgerKindLabel(entry.kind, t)} tone={ledgerKindTone(entry.kind)} />
            </div>
            {summary && <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{summary}</div>}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelWhen')} value={relativeTime(entry.timestamp) ?? entry.timestamp} />
                {entry.nodeId && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelNode')} value={resolveNodeLabel(entry.nodeId)} />}
                {entry.providerType && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelProvider')} value={entry.providerType} />}
                {entry.sessionId && (
                    <ModalRow
                        meshTheme={meshTheme}
                        label={t('mesh.overview.detailLabelSession')}
                        value={
                            <button type="button" className={`text-left underline-offset-2 hover:underline ${meshTheme.textSecondary}`} onClick={() => requestOpenSessionChat({ sessionId: entry.sessionId!, source: 'mesh-overview-task-modal' })}>
                                {t('sessionNav.openChat')}
                            </button>
                        }
                    />
                )}
            </div>
            {/* Ids, the raw record kind, the routing rationale and the raw
                payload are debugging material — one disclosure away. */}
            <TechnicalDetails
                summaryClassName={meshTheme.textMuted}
                rows={[
                    { label: t('mesh.overview.detailLabelEntryId'), value: entry.id },
                    { label: t('mesh.overview.detailKickerLedger'), value: entry.kind, copyable: false },
                    { label: t('mesh.overview.detailLabelSession'), value: entry.sessionId ?? null },
                ]}
            >
                {routing && <RoutingDecisionDetail meshTheme={meshTheme} routing={routing} resolveNodeLabel={resolveNodeLabel} />}
                {payloadJson && payloadJson !== '{}' && (
                    <details data-raw-payload="">
                        <summary className={`cursor-pointer select-none text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.detailLabelPayload')}</summary>
                        <pre className={`mt-1 max-h-60 max-w-full overflow-auto rounded-lg border p-2 text-3xs leading-4 border-border-subtle bg-bg-secondary text-text-secondary`}>{payloadJson}</pre>
                    </details>
                )}
            </TechnicalDetails>
        </div>
    )
}

function QueueDetail({ meshTheme, task, resolveNodeLabel, missionTitles, onOpenMission, onOpenTask, queueTasks, daemonId, meshId, sendDaemonCommand }: {
    meshTheme: MeshGraphTheme
    task: RepoMeshQueueTask
    resolveNodeLabel?: (nodeId: string | undefined | null) => string
    /** Reverse wiring (owner audit 2026-08-25): a task detail used to be a dead
     *  end — no way back to its mission, its dependencies, or its session chat. */
    missionTitles?: Record<string, string>
    onOpenMission?: (missionId: string) => void
    onOpenTask?: (task: RepoMeshQueueTask) => void
    queueTasks?: RepoMeshQueueTask[]
} & MeshCommandSeam) {
    const { t } = useTranslation('common')
    const sessionId = task.assignedSessionId || task.targetSessionId
    const linkClass = `text-left underline-offset-2 hover:underline ${meshTheme.textSecondary}`
    const depTasks = (task.dependsOn ?? []).map(id => ({
        id,
        task: (queueTasks ?? []).find(candidate => candidate.id === id) ?? null,
        failure: (task.dependencyFailures ?? []).find(failure => failure.taskId === id) ?? null,
    }))

    // finalSummary lives in the append-only mesh_task_outputs ledger, not on the
    // queue row (docs/design/2026-09-02-blueprint-followups.md §1) — fetched on
    // demand over P2P, same seam as MissionDetail's full-goal fetch below.
    const isTerminal = task.status === 'completed' || task.status === 'failed'
    const [output, setOutput] = useState<{ finalSummary?: string; providerType?: string } | null>(null)
    const [fetchingOutput, setFetchingOutput] = useState(false)
    const [outputError, setOutputError] = useState<string | null>(null)

    useEffect(() => {
        setOutput(null)
        setOutputError(null)
        if (!isTerminal || !daemonId || !sendDaemonCommand) return
        let cancelled = false
        setFetchingOutput(true)
        sendDaemonCommand(daemonId, 'mesh_task_output', { meshId: meshId ?? undefined, taskId: task.id })
            .then(raw => {
                if (cancelled) return
                const body = unwrapResult(raw)
                if (body?.output) setOutput(body.output)
                else if (body?.success === false) setOutputError(body.error || 'failed')
            })
            .catch(err => {
                if (!cancelled) setOutputError(err instanceof Error ? err.message : 'failed to fetch task output')
            })
            .finally(() => {
                if (!cancelled) setFetchingOutput(false)
            })
        return () => { cancelled = true }
    }, [isTerminal, daemonId, meshId, sendDaemonCommand, task.id])

    const completingProvider = task.assignedProviderType || output?.providerType
    // Summary-first reading of the instruction — see the render block below.
    const taskMessageParts = useMemo(
        () => splitTaskMessage(queueTaskDisplayText(task.message)),
        [task.message],
    )
    // Same summary-first reading for the worker's report — see the render block.
    const finalSummaryParts = useMemo(
        () => splitFinalSummary(output?.finalSummary),
        [output?.finalSummary],
    )
    /* Elapsed time. The queue row carries only createdAt/updatedAt, so for a
     * SETTLED task the span between them is its lifetime; for one still moving
     * it would just be "time since the last update", which is already the
     * Updated row, so it is shown for terminal tasks only. */
    const elapsedLabel = useMemo(() => {
        if (!isTerminal) return null
        const started = Date.parse(task.createdAt)
        const ended = Date.parse(task.updatedAt)
        if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null
        return formatDuration(ended - started)
    }, [isTerminal, task.createdAt, task.updatedAt])

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={queueTaskStatusLabel(task.status, t)} tone={queueTaskTone(task.status)} />
                {task.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(task.difficulty, t)} tone={difficultyTone()} />}
                {completingProvider && <StatusBadge meshTheme={meshTheme} label={completingProvider} tone="muted" />}
                {(task.requeueCount ?? 0) > 0 && <StatusBadge meshTheme={meshTheme} label={t('mesh.overview.detailLabelRequeued', { count: task.requeueCount })} tone="amber" />}
            </div>
            {/* ── The task's own text: SUMMARY first, full instruction folded.
                A dispatched task's message is the whole briefing — measured on
                the live mesh, queue task 0dd248f0 carried several thousand
                characters. Rendering it in full at the TOP of the detail meant
                the things a reader actually opens this panel for (status,
                provider, difficulty, elapsed, why it failed) were pushed below
                a wall of text and its scrollbar.

                The first line is the one a reader scans, so it stays visible;
                the rest goes behind the same <details> idiom the payload block
                below already uses. A short message has no second part and is
                shown whole, so nothing is hidden that would have fit. ── */}
            {taskMessageParts && (
                <div className="flex flex-col gap-1">
                    <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{taskMessageParts.lead}</div>
                    {taskMessageParts.rest && (
                        <details>
                            <summary className={`cursor-pointer select-none text-3xs font-medium ${meshTheme.textMuted}`}>
                                {t('mesh.overview.detailLabelFullInstruction')}
                            </summary>
                            <div className={`mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border px-2.5 py-2 text-xs leading-5 border-border-subtle bg-bg-secondary text-text-secondary`}>
                                {taskMessageParts.rest}
                            </div>
                        </details>
                    )}
                </div>
            )}
            {isTerminal && (
                <div>
                    <div className={`mb-1 text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.detailLabelFinalSummary')}</div>
                    {/* ── Summary FIRST, report folded — the other half of the
                        same defect `babbc4ad` fixed for the instruction block.
                        A worker's final summary is its whole report, usually a
                        JSON body (measured: queue task 85adc645 on the preview
                        mesh), and rendering it whole put a second wall of text
                        directly above the task's own fields. `splitFinalSummary`
                        leads with the report's own summary field when it parses
                        as JSON, since a character cut through JSON yields a
                        meaningless lead. ── */}
                    {finalSummaryParts
                        ? (
                            <div className="flex flex-col gap-1">
                                <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{finalSummaryParts.lead}</div>
                                {finalSummaryParts.rest && (
                                    <details>
                                        <summary className={`cursor-pointer select-none text-3xs font-medium ${meshTheme.textMuted}`}>
                                            {t('mesh.overview.detailLabelFullFinalSummary')}
                                        </summary>
                                        <div className={`mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border px-2.5 py-2 text-xs leading-5 border-border-subtle bg-bg-secondary text-text-primary`}>
                                            {finalSummaryParts.rest}
                                        </div>
                                    </details>
                                )}
                            </div>
                        )
                        : fetchingOutput
                            ? <div className={`text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.detailFinalSummaryLoading')}</div>
                            : outputError
                                ? <div className={`text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.detailFinalSummaryUnavailable')}</div>
                                : !daemonId || !sendDaemonCommand
                                    ? <div className={`text-3xs ${meshTheme.textMuted}`}>{t('mesh.overview.detailFinalSummaryUnavailable')}</div>
                                    : null}
                </div>
            )}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelCreated')} value={relativeTime(task.createdAt) ?? task.createdAt} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelUpdated')} value={relativeTime(task.updatedAt) ?? task.updatedAt} />
                {elapsedLabel && <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelElapsed')} value={elapsedLabel} />}
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
                                {t('sessionNav.openChat')}
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
            </div>
            <TechnicalDetails
                summaryClassName={meshTheme.textMuted}
                rows={[
                    { label: t('mesh.overview.detailLabelTaskId'), value: task.id },
                    { label: t('mesh.overview.detailLabelSession'), value: sessionId || null },
                    { label: t('mesh.overview.detailLabelAutoLaunch'), value: task.autoLaunch ? `${task.autoLaunch.status}${task.autoLaunch.reason ? ` · ${task.autoLaunch.reason}` : ''}` : null, copyable: false },
                ]}
            />
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
    const statusText = sessionStatusText(session, t)
    const sessionTasks = (queueTasks ?? []).filter(task =>
        task.assignedSessionId === session.sessionId || task.targetSessionId === session.sessionId)
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge meshTheme={meshTheme} label={statusText} tone={sessionStatusTone(label)} />
                <StatusBadge meshTheme={meshTheme} label={session.providerType || t('mesh.overview.providerUnknown')} tone="muted" />
                {session.difficulty && <StatusBadge meshTheme={meshTheme} label={difficultyLabel(session.difficulty, t)} tone={difficultyTone()} />}
            </div>
            {session.statusNote && <div className={`whitespace-pre-wrap text-xs leading-5 ${meshTheme.textSecondary}`}>{session.statusNote}</div>}
            <div className="grid gap-1.5 text-xs">
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelNode')} value={nodeDisplayName(node)} />
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelWorkspace')} value={session.workspace || node.workspace} />
                {(node.git?.branch ?? node.worktreeBranch) && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelBranch')} value={node.git?.branch ?? node.worktreeBranch!} />
                )}
                <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelRole')} value={sessionRoleText(session, t)} />
                {(session.startedAt || session.createdAt) && (
                    <ModalRow meshTheme={meshTheme} label={t('mesh.overview.detailLabelStarted')} value={relativeTime(session.startedAt || session.createdAt) ?? (session.startedAt || session.createdAt)!} />
                )}
            </div>
            {sessionTasks.length > 0 && (
                <div>
                    <div className={`mb-1 text-3xs font-medium ${meshTheme.textMuted}`}>{t('mesh.overview.sessionTasksHeading')}</div>
                    <div className="flex flex-col gap-0.5">
                        {sessionTasks.map(task => (
                            <ListRow key={task.id} meshTheme={meshTheme} onClick={onOpenTask ? () => onOpenTask(task) : undefined}>
                                <StatusBadge meshTheme={meshTheme} label={queueTaskStatusLabel(task.status, t)} tone={queueTaskTone(task.status)} />
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
                    className="rounded-lg border border-border-default bg-bg-glass px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-bg-glass-hover"
                    onClick={() => requestOpenSessionChat({ sessionId: session.sessionId, source: 'mesh-overview-session-modal' })}
                >
                    {t('sessionNav.openChat')}
                </button>
            </div>
            <TechnicalDetails summaryClassName={meshTheme.textMuted} rows={[{ label: t('mesh.overview.detailLabelSessionId'), value: session.sessionId }]} />
        </div>
    )
}
