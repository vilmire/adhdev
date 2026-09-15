/**
 * MeshBlueprintList — the blueprint tab's main surface after the canvas →
 * list redesign (P1, owner-approved 2026-09-16). A vertically scrolling
 * section list replaces the fused ELK canvas:
 *
 *   [ BlueprintStatusBar + caller extras ]   Active 3 | Blocked 2 | …
 *   [ BlueprintScopeChips ]                  Running / Blocked / By mission / History
 *   Running   — full-colour rows, pinned on top
 *   Blocked   — amber/rose rows (tasks + coordinator gates)
 *   Recent    — newest 10 terminal rows, muted (History scope)
 *   History   — older terminal rows behind load-more (History scope)
 *
 * Rows open the caller's shared detail modal; a row that belongs to a graph
 * WITH edges (or carries queue dependency edges) exposes an on-demand
 * mini-DAG (MeshMiniDag) instead of the always-on canvas. Mobile is plain
 * vertical scroll — rows are full width, the header rows wrap.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeshGraphGateView, MeshGraphView, RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import type { MeshGraphTheme } from './meshGraphTheme'
import { buildTaskDag } from './taskDagViewModel'
import { buildGraphMiniDag, buildQueueMiniDag, type MiniDagModel } from './miniDagViewModel'
import MeshMiniDag from './MeshMiniDag'
import BlueprintStatusBar from './BlueprintStatusBar'
import BlueprintScopeChips, { DEFAULT_BLUEPRINT_SCOPE, type BlueprintScope } from './BlueprintScopeChips'
import { MeshBlueprintGateRowView, MeshBlueprintTaskRowView } from './MeshBlueprintRow'
import {
    BLUEPRINT_HISTORY_LOAD_STEP,
    buildBlueprintMissionGroups,
    useBlueprintGroups,
    type BlueprintRow,
    type BlueprintSection,
} from './useBlueprintGroups'

function rowKey(row: BlueprintRow): string {
    return row.kind === 'task' ? row.task.id : `gate:${row.graph.graphId}:${row.nodeId}`
}

export default function MeshBlueprintList({ tasks, status, graphs, meshTheme, nodeLabels, missionTitles, pinnedSlots, emptyMessage, onTaskOpen, onGateOpen, onMissionOpen, headerExtras }: {
    tasks: RepoMeshQueueTask[]
    status: RepoMeshStatus
    graphs: MeshGraphView[]
    meshTheme: MeshGraphTheme
    /** nodeId → `checkout · machine` for the row's "ran on" chip. */
    nodeLabels?: Record<string, string>
    missionTitles?: Record<string, string>
    /** taskId → predicted slot on the task's PINNED node (📌 chip). */
    pinnedSlots?: Record<string, string>
    emptyMessage?: string
    onTaskOpen: (task: RepoMeshQueueTask) => void
    onGateOpen: (graph: MeshGraphView, nodeId: string, gate?: MeshGraphGateView) => void
    onMissionOpen?: (missionId: string) => void
    /** Caller chrome (scheduling chip, graph pagination, refresh) sharing the
     *  status-bar row instead of floating over the list. */
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

    const groups = useBlueprintGroups(tasks, status, graphs, historyLimit)
    const toggleScope = (key: keyof BlueprintScope) => setScope(current => ({ ...current, [key]: !current[key] }))

    const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks])
    const graphById = useMemo(() => new Map(graphs.map(graph => [graph.graphId, graph])), [graphs])

    /* The expanded row's mini-DAG model — built lazily, only for the one open
     * plan. The queue DAG projection is only computed when a queue-sourced
     * plan is actually open. */
    const expandedRow = useMemo<BlueprintRow | undefined>(() => {
        if (!expandedPlanKey) return undefined
        const all = [...groups.running, ...groups.blocked, ...groups.recent, ...groups.history]
        return all.find(row => rowKey(row) === expandedPlanKey)
    }, [expandedPlanKey, groups])
    const expandedMiniDag = useMemo<MiniDagModel | null>(() => {
        if (!expandedRow || !expandedRow.planSource) return null
        if (expandedRow.planSource === 'graph' && expandedRow.planGraphId) {
            const graph = graphById.get(expandedRow.planGraphId)
            return graph ? buildGraphMiniDag(graph, taskById) : null
        }
        if (expandedRow.kind === 'task') {
            return buildQueueMiniDag(expandedRow.task.id, buildTaskDag(tasks))
        }
        return null
    }, [expandedRow, graphById, taskById, tasks])

    const openMiniDagTask = (taskId: string) => {
        const task = taskById.get(taskId)
        if (task) onTaskOpen(task)
    }
    const openMiniDagGate = (graphId: string, gateNodeId: string) => {
        const graph = graphById.get(graphId)
        if (!graph) return
        onGateOpen(graph, gateNodeId, graph.gates.find(gate => gate.nodeId === gateNodeId))
    }

    const renderRow = (row: BlueprintRow) => {
        const key = rowKey(row)
        const planExpanded = expandedPlanKey === key
        const togglePlan = row.planSource
            ? () => setExpandedPlanKey(current => (current === key ? null : key))
            : undefined
        return (
            <div key={key} className="flex flex-col gap-1">
                {row.kind === 'gate' ? (
                    <MeshBlueprintGateRowView
                        row={row}
                        meshTheme={meshTheme}
                        onOpen={() => onGateOpen(row.graph, row.nodeId, row.gate)}
                        planExpanded={planExpanded}
                        onTogglePlan={togglePlan}
                    />
                ) : (
                    <MeshBlueprintTaskRowView
                        row={row}
                        meshTheme={meshTheme}
                        nowMs={nowMs}
                        nodeLabel={row.task.assignedNodeId ? nodeLabels?.[row.task.assignedNodeId] ?? row.task.assignedNodeId.slice(0, 12) : undefined}
                        pinnedSlot={pinnedSlots?.[row.task.id]}
                        missionTitle={row.task.missionId ? missionTitles?.[row.task.missionId] : undefined}
                        onOpen={() => onTaskOpen(row.task)}
                        onMissionOpen={onMissionOpen}
                        planExpanded={planExpanded}
                        onTogglePlan={togglePlan}
                    />
                )}
                {planExpanded && expandedMiniDag && (
                    // Mini DAG scrolls horizontally inside its own container on
                    // narrow viewports — the page itself never scrolls sideways.
                    <div className="overflow-x-auto pl-4">
                        <MeshMiniDag
                            model={expandedMiniDag}
                            meshTheme={meshTheme}
                            onOpenTask={openMiniDagTask}
                            onOpenGate={openMiniDagGate}
                        />
                    </div>
                )}
            </div>
        )
    }

    const sectionHeader = (section: BlueprintSection, count: number) => (
        <div className={`flex items-center gap-2 pt-1 text-4xs font-semibold uppercase tracking-[0.14em] ${meshTheme.isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <span>{t(`mesh.blueprint.list.section${section.charAt(0).toUpperCase()}${section.slice(1)}`)}</span>
            <span className="opacity-70">{count}</span>
            <span className={`h-px flex-1 ${meshTheme.isDark ? 'bg-white/8' : 'bg-slate-200'}`} aria-hidden />
        </div>
    )

    const visibleSectionRows: BlueprintRow[] = [
        ...(scope.running ? groups.running : []),
        ...(scope.blocked ? groups.blocked : []),
        ...(scope.history ? [...groups.recent, ...groups.history] : []),
    ]
    const missionGroups = scope.byMission ? buildBlueprintMissionGroups(visibleSectionRows, missionTitles) : null
    const nothingVisible = visibleSectionRows.length === 0

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <BlueprintStatusBar counts={groups.counts} scope={scope} onToggle={toggleScope} meshTheme={meshTheme} />
                {headerExtras && <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">{headerExtras}</div>}
            </div>
            <BlueprintScopeChips scope={scope} onToggle={toggleScope} meshTheme={meshTheme} />

            <div className="min-h-0 flex-1 overflow-y-auto">
                {tasks.length === 0 && groups.blocked.length === 0 ? (
                    <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-slate-400">
                        {emptyMessage ?? t('mesh.taskDag.empty')}
                    </div>
                ) : nothingVisible ? (
                    <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-center text-sm text-slate-400">
                        {t('mesh.blueprint.list.emptyActive')}
                    </div>
                ) : missionGroups ? (
                    <div className="flex flex-col gap-1.5 pb-2">
                        {missionGroups.map(group => (
                            <div key={group.missionId ?? '(ad-hoc)'} className="flex flex-col gap-1">
                                <button
                                    type="button"
                                    onClick={group.missionId && onMissionOpen ? () => onMissionOpen(group.missionId!) : undefined}
                                    className={`flex items-center gap-2 pt-1 text-left text-3xs font-semibold ${meshTheme.isDark ? 'text-indigo-300' : 'text-indigo-700'} ${group.missionId && onMissionOpen ? 'cursor-pointer hover:underline' : 'cursor-default'}`}
                                    title={group.missionId ?? undefined}
                                >
                                    <span>⚑ {group.title || group.missionId?.slice(0, 10) || t('mesh.blueprint.list.noMission')}</span>
                                    <span className="opacity-60">{group.rows.length}</span>
                                    <span className={`h-px flex-1 ${meshTheme.isDark ? 'bg-indigo-400/20' : 'bg-indigo-200'}`} aria-hidden />
                                </button>
                                {group.rows.map(renderRow)}
                            </div>
                        ))}
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
                                        className={`self-start rounded-full border px-2.5 py-0.5 text-3xs font-medium transition-colors ${meshTheme.isDark
                                            ? 'border-sky-400/25 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                                            : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
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
