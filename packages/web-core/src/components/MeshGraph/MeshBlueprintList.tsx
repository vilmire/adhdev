/**
 * MeshBlueprintList — the blueprint tab's main surface after the canvas →
 * list redesign (P1, owner-approved 2026-09-16). A vertically scrolling
 * section list replaces the fused ELK canvas:
 *
 *   [ BlueprintStatusBar + caller extras ]   Active 3 | Blocked 2 | …
 *   Running   — full-colour rows, pinned on top
 *   Blocked   — amber/rose rows (human holds, dependency waits/failures)
 *   Recent    — newest 10 terminal rows, muted (History scope)
 *   History   — older terminal rows behind load-more (History scope)
 *
 * Rows open the caller's shared detail modal; a row with queue dependency
 * edges exposes an on-demand mini-DAG (MeshMiniDag) instead of the always-on
 * canvas. Mobile is plain
 * vertical scroll — rows are full width, the header rows wrap.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { meshToggleChipClass, type MeshGraphTheme } from './meshGraphTheme'
import { buildTaskDag } from './taskDagViewModel'
import { buildQueueMiniDag, type MiniDagModel } from './miniDagViewModel'
import MeshMiniDag from './MeshMiniDag'
import BlueprintStatusBar from './BlueprintStatusBar'
import { DEFAULT_BLUEPRINT_SCOPE, type BlueprintScope } from './BlueprintScopeChips'
import { MeshBlueprintTaskRowView } from './MeshBlueprintRow'
import {
    BLUEPRINT_HISTORY_LOAD_STEP,
    buildBlueprintMissionGroups,
    useBlueprintGroups,
    type BlueprintRow,
    type BlueprintSection,
} from './useBlueprintGroups'

export default function MeshBlueprintList({ tasks, status, meshTheme, nodeLabels, missionTitles, pinnedSlots, emptyMessage, onTaskOpen, onMissionOpen, headerExtras }: {
    tasks: RepoMeshQueueTask[]
    status: RepoMeshStatus
    meshTheme: MeshGraphTheme
    /** nodeId → `checkout · machine` for the row's "ran on" chip. */
    nodeLabels?: Record<string, string>
    missionTitles?: Record<string, string>
    /** taskId → predicted slot on the task's PINNED node (📌 chip). */
    pinnedSlots?: Record<string, string>
    emptyMessage?: string
    onTaskOpen: (task: RepoMeshQueueTask) => void
    onMissionOpen?: (missionId: string) => void
    /** Caller chrome (scheduling chip, refresh) sharing the status-bar row
     *  instead of floating over the list. */
    headerExtras?: React.ReactNode
}) {
    const { t } = useTranslation('common')
    const [scope, setScope] = useState<BlueprintScope>(DEFAULT_BLUEPRINT_SCOPE)
    const [historyLimit, setHistoryLimit] = useState(BLUEPRINT_HISTORY_LOAD_STEP)
    /** Row whose mini plan is open (one at a time — it is a drawing, not a tree). */
    const [expandedPlanKey, setExpandedPlanKey] = useState<string | null>(null)

    /* Shared relative-time clock: coarse (30s) and paused while hidden, so
     * "3m ago" ages while the tab sits open without a data refetch. */
    const [nowMs, setNowMs] = useState(() => Date.now())
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (document.hidden) return
            setNowMs(Date.now())
        }, 30_000)
        return () => window.clearInterval(timer)
    }, [])

    const groups = useBlueprintGroups(tasks, status, historyLimit)
    const toggleScope = (key: keyof BlueprintScope) => setScope(current => ({ ...current, [key]: !current[key] }))

    const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks])

    /* The expanded row's mini-DAG model — built lazily, only for the one open
     * plan: the queue DAG projection is only computed when a plan is open. */
    const expandedMiniDag = useMemo<MiniDagModel | null>(() => {
        if (!expandedPlanKey) return null
        return buildQueueMiniDag(expandedPlanKey, buildTaskDag(tasks))
    }, [expandedPlanKey, tasks])

    const openTaskById = (taskId: string) => {
        const task = taskById.get(taskId)
        if (task) onTaskOpen(task)
    }
    const renderRow = (row: BlueprintRow) => {
        const key = row.task.id
        const planExpanded = expandedPlanKey === key
        const togglePlan = row.hasPlan
            ? () => setExpandedPlanKey(current => (current === key ? null : key))
            : undefined
        return (
            <div key={key} className="flex flex-col gap-1">
                <MeshBlueprintTaskRowView
                    row={row}
                    meshTheme={meshTheme}
                    nowMs={nowMs}
                    nodeLabel={row.task.assignedNodeId ? nodeLabels?.[row.task.assignedNodeId] ?? row.task.assignedNodeId.slice(0, 12) : undefined}
                    pinnedSlot={pinnedSlots?.[row.task.id]}
                    missionTitle={row.task.missionId ? missionTitles?.[row.task.missionId] : undefined}
                    onOpen={() => onTaskOpen(row.task)}
                    onOpenTaskId={openTaskById}
                    onMissionOpen={onMissionOpen}
                    planExpanded={planExpanded}
                    onTogglePlan={togglePlan}
                />
                {planExpanded && expandedMiniDag && (
                    // Mini DAG scrolls horizontally inside its own container on
                    // narrow viewports — the page itself never scrolls sideways.
                    <div className="overflow-x-auto pl-4">
                        <MeshMiniDag
                            model={expandedMiniDag}
                            meshTheme={meshTheme}
                            onOpenTask={openTaskById}
                        />
                    </div>
                )}
            </div>
        )
    }

    const sectionHeader = (section: BlueprintSection, count: number) => (
        <div className="flex items-center gap-2 pt-1 text-3xs font-medium text-text-muted">
            <span>{t(`mesh.blueprint.list.section${section.charAt(0).toUpperCase()}${section.slice(1)}`)}</span>
            <span className="opacity-70">{count}</span>
            <span className="h-px flex-1 bg-border-subtle" aria-hidden />
        </div>
    )

    const visibleSectionRows: BlueprintRow[] = [
        ...(scope.running ? groups.running : []),
        ...(scope.blocked ? groups.blocked : []),
        ...(scope.history ? [...groups.recent, ...groups.history] : []),
    ]
    const missionGroups = scope.byMission ? buildBlueprintMissionGroups(visibleSectionRows, missionTitles, groups.chainByTaskId) : null
    const nothingVisible = visibleSectionRows.length === 0

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <BlueprintStatusBar counts={groups.counts} scope={scope} onToggle={toggleScope} meshTheme={meshTheme} />
                {headerExtras && <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">{headerExtras}</div>}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {tasks.length === 0 ? (
                    <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-text-muted">
                        {emptyMessage ?? t('mesh.taskDag.empty')}
                    </div>
                ) : nothingVisible ? (
                    <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-text-muted">
                        {t('mesh.blueprint.list.emptyActive')}
                    </div>
                ) : missionGroups ? (
                    <div className="flex flex-col gap-1.5 pb-2">
                        {missionGroups.map(group => {
                            // Chain groups (W24) open their anchor task; mission groups the mission.
                            const anchor = group.kind === 'chain' && group.anchorTaskId ? taskById.get(group.anchorTaskId) : undefined
                            const openGroup = group.kind === 'mission' && group.missionId && onMissionOpen
                                ? () => onMissionOpen(group.missionId!)
                                : anchor ? () => onTaskOpen(anchor) : undefined
                            return (
                            <div key={`${group.kind}:${group.key}`} className="flex flex-col gap-1">
                                <button
                                    type="button"
                                    onClick={openGroup}
                                    className={`flex items-center gap-2 pt-1 text-left text-3xs font-semibold text-text-primary ${openGroup ? 'cursor-pointer hover:text-accent hover:underline' : 'cursor-default'}`}
                                    title={group.kind === 'chain' ? group.anchorTaskId : group.missionId ?? undefined}
                                >
                                    <span>{group.kind === 'chain'
                                        ? `⛓ ${t('mesh.blueprint.list.chainGroup', { title: group.title })}`
                                        : `⚑ ${group.title || group.missionId?.slice(0, 10) || t('mesh.blueprint.list.noMission')}`}</span>
                                    <span className="opacity-60">{group.rows.length}</span>
                                    <span className="h-px flex-1 bg-border-subtle" aria-hidden />
                                </button>
                                {group.rows.map(renderRow)}
                            </div>
                            )
                        })}
                    </div>
                ) : (
                    <div className="flex flex-col gap-1.5 pb-2">
                        {scope.running && groups.running.length > 0 && (
                            <>
                                {sectionHeader('running', groups.counts.running)}
                                {groups.running.map(renderRow)}
                            </>
                        )}
                        {scope.blocked && groups.blocked.length > 0 && (
                            <>
                                {sectionHeader('blocked', groups.counts.blocked)}
                                {groups.blocked.map(renderRow)}
                            </>
                        )}
                        {scope.history && groups.recent.length > 0 && (
                            <>
                                {sectionHeader('recent', groups.counts.recent)}
                                {groups.recent.map(renderRow)}
                            </>
                        )}
                        {scope.history && (groups.history.length > 0 || groups.historyHiddenCount > 0) && (
                            <>
                                {sectionHeader('history', groups.counts.history)}
                                {groups.history.map(renderRow)}
                                {groups.historyHiddenCount > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setHistoryLimit(limit => limit + BLUEPRINT_HISTORY_LOAD_STEP)}
                                        className={`self-start ${meshToggleChipClass(false)}`}
                                    >
                                        {t('mesh.blueprint.list.loadMore', {
                                            count: Math.min(BLUEPRINT_HISTORY_LOAD_STEP, groups.historyHiddenCount),
                                        })}
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
