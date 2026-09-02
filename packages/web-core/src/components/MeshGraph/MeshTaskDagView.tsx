/**
 * MeshTaskDagView — React Flow rendering of the mesh work queue as a dependency
 * DAG (nodes = tasks, edges = dependsOn). The "graph engineering" surface: makes
 * the queue's execution order visible instead of a flat list. Layout is ELK
 * layered (same engine as MeshGraphView), left-to-right so the graph reads as a
 * pipeline: dependencies on the left, dependents on the right.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
    Controls,
    Handle,
    MarkerType,
    Position,
    ReactFlow,
    type Edge,
    type Node,
    type NodeProps,
    type NodeTypes,
    type ReactFlowInstance,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import type { MeshGraphGateView, MeshGraphView, RepoMeshQueueTask } from '@adhdev/daemon-core'
import { buildBlueprintGraphTimeline, buildNodeIdByEndpoint, buildStateByNodeId, deriveBlueprintEdgeState, orderTasksForElk, resolveCollapsedGraphIds, resolveTaskPredictedSlot, summarizeCollapsedGraph } from './blueprintViewModel'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import { buildTaskDag, formatTaskCardTime, scopeTaskDagTasks, taskCardTimeSource, TASK_DAG_LOAD_MORE_STEP, TASK_DAG_RECENT_TERMINAL_LIMIT, type TaskDagData, type TaskDagEdgeState, type TaskDagNode } from './taskDagViewModel'
import { queueTaskDisplayText } from '../../utils/queue-task-label'
import { IconFlag } from '../Icons'

const elk = new ELK()

const TASK_CARD_WIDTH = 236
const TASK_CARD_MIN_HEIGHT = 96

interface MeshTaskDagViewProps {
    tasks: RepoMeshQueueTask[]
    emptyMessage?: string
    /**
     * Scheduling forecast (mesh_route_preview): difficulty → label of the slot
     * that would take the NEXT task of that difficulty. Rendered as a "→ slot"
     * chip on pending cards so routing is visible on the blueprint itself.
     * This is the GENERIC, explicitly-unpinned reading — a hypothetical
     * dispatch with no target pin.
     */
    predictedSlots?: Record<string, string>
    /**
     * taskId → predicted slot on the task's PINNED node (mesh_route_preview
     * with targetNodeId). A pinned task routes to its pin, so its card shows
     * this forecast — as a distinct 📌 chip — instead of the generic one.
     */
    pinnedSlots?: Record<string, string>
    /** Initial cap on terminal (completed/failed/cancelled) cards — the blueprint
     *  tab passes a tight cap so history doesn't drown the active plan. */
    initialTerminalLimit?: number
    /** When provided, clicking a task opens the caller's detail surface (the
     *  shared MeshOverviewDetailModal) instead of the built-in side panel. */
    onTaskOpen?: (task: RepoMeshQueueTask) => void
    /**
     * Embedded mode (per-mission drill-down inside MeshTasksView): the caller
     * already scoped the task set, so the history cap, stats overlay and
     * load-more chrome are dropped — just the graph + edge legend render.
     */
    compact?: boolean
    /**
     * Persistent orchestration graphs FUSED into this canvas (owner call
     * 2026-08-25: gates and planned steps are part of THE blueprint, not a
     * separate per-graph view). A graph task-node that materialized into a
     * visible queue task fuses onto that card; coordinator gates render as ⛩
     * nodes; unmaterialized steps render as ghost "planned" cards; the
     * graph's edges wire them all together.
     */
    graphs?: MeshGraphView[]
    /** Clicking a fused gate node opens the caller's read-only gate panel. */
    onGateOpen?: (graph: MeshGraphView, nodeId: string, gate?: MeshGraphGateView) => void
    /** missionId → human title, so the card's mission chip can name the
     *  mission instead of flashing a raw id (owner polish 2026-08-25). */
    missionTitles?: Record<string, string>
    /** Open the mission detail (same modal as the overview page) when a card's mission bar is clicked. */
    onMissionOpen?: (missionId: string) => void
    /** Mission modal's "show on canvas": light the mission's thread and frame its
     *  cards. Token distinguishes repeat requests for the same mission. */
    focusMission?: { missionId: string; token: number } | null
    /**
     * When set, the stats/load-more chips render into this element (via
     * portal) instead of in-flow above the canvas — the blueprint tab hosts
     * them on its picker row so the canvas top edge stays clean (the floating
     * chip strip over empty canvas read as clutter).
     */
    statsContainer?: HTMLElement | null
}

type TaskFlowNodeData = Record<string, unknown> & {
    dagNode: TaskDagNode
    theme: MeshGraphTheme
    selected: boolean
    predictedSlot?: string
    /** True when predictedSlot comes from the task's PINNED-node preview. */
    predictedSlotPinned?: boolean
    missionTitle?: string
    /** Pointer rests on a same-mission card — echo the lit thread with a ring. */
    missionHighlighted?: boolean
    onMissionOpen?: (missionId: string) => void
    /** Shared clock for every card's relative time label. */
    nowMs: number
}

type TaskFlowNode = Node<TaskFlowNodeData, 'taskNode'>

/** Estimate the rendered card height so ELK sees roughly what humans see. */
function estimateTaskCardHeight(node: TaskDagNode): number {
    const messageLength = (node.task.message ?? '').length
    const messageLines = Math.max(1, Math.min(3, Math.ceil(messageLength / 34)))
    const extraBadgeRow = node.waitingOn.length > 0 || node.blocked || node.missingDeps.length > 0 ? 22 : 0
    const missionBar = node.task.missionId ? 28 : 0
    return TASK_CARD_MIN_HEIGHT + (messageLines - 1) * 15 + extraBadgeRow + missionBar
}

const STATUS_STYLES: Record<string, { dark: string; light: string; dot: string; pulse?: boolean }> = {
    pending: {
        dark: 'border-slate-400/30 bg-slate-500/10 text-slate-200',
        light: 'border-slate-300 bg-slate-50 text-slate-700',
        dot: 'bg-slate-400',
    },
    assigned: {
        dark: 'border-sky-400/40 bg-sky-500/10 text-sky-100',
        light: 'border-sky-300 bg-sky-50 text-sky-800',
        dot: 'bg-sky-400',
        pulse: true,
    },
    // Terminal-success recedes: a long-lived queue is mostly completed cards,
    // and when they all glow emerald the live plan (pending/assigned/blocked)
    // has no contrast left. Keep the emerald dot as the success cue, mute the
    // surface itself.
    completed: {
        dark: 'border-emerald-400/15 bg-white/[0.03] text-slate-300',
        light: 'border-emerald-200 bg-white text-slate-500',
        dot: 'bg-emerald-400',
    },
    failed: {
        dark: 'border-rose-400/40 bg-rose-500/10 text-rose-100',
        light: 'border-rose-300 bg-rose-50 text-rose-800',
        dot: 'bg-rose-400',
    },
    cancelled: {
        dark: 'border-slate-500/25 bg-slate-600/10 text-slate-400',
        light: 'border-slate-200 bg-slate-100 text-slate-400',
        dot: 'bg-slate-500',
    },
}

const EDGE_COLORS: Record<TaskDagEdgeState, { dark: string; light: string; dash?: string; animated: boolean }> = {
    satisfied: { dark: '#34d399', light: '#059669', animated: false },
    waiting: { dark: '#fbbf24', light: '#d97706', dash: '6 4', animated: true },
    failed: { dark: '#fb7185', light: '#e11d48', dash: '3 4', animated: false },
}

const messageClampStyle: CSSProperties = {
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
    overflow: 'hidden',
}

function TaskNodeCard({ data }: NodeProps<TaskFlowNode>) {
    const { t } = useTranslation('common')
    const { dagNode, theme, selected, predictedSlot, predictedSlotPinned, missionTitle, missionHighlighted, onMissionOpen, nowMs } = data
    const task = dagNode.task
    // One `nowMs` for every card on the canvas, so two cards a second apart
    // never disagree about "3분 전".
    const cardTime = useMemo(() => formatTaskCardTime(taskCardTimeSource(task), nowMs, t), [task, nowMs, t])
    const style = STATUS_STYLES[task.status] ?? STATUS_STYLES.pending
    const statusClass = theme.isDark ? style.dark : style.light
    // History fades, the live plan pops: terminal-success/cancelled cards render
    // at reduced opacity (full on hover/selection so they stay inspectable).
    const receded = (task.status === 'completed' || task.status === 'cancelled') && !selected
    const chipClass = theme.isDark
        ? 'rounded-full border border-white/10 bg-white/[0.06] px-1.5 py-px text-4xs text-slate-300'
        : 'rounded-full border border-slate-200 bg-white/80 px-1.5 py-px text-4xs text-slate-500'
    return (
        <div
            className={`rounded-2xl border px-3 py-2.5 shadow-sm transition-[opacity,box-shadow] ${statusClass} ${selected ? (theme.isDark ? 'ring-2 ring-cyan-300/60' : 'ring-2 ring-sky-400/70') : ''} ${!selected && missionHighlighted ? (theme.isDark ? 'outline outline-1 -outline-offset-1 outline-indigo-300/70' : 'outline outline-1 -outline-offset-1 outline-indigo-400/80') : ''} ${receded ? 'opacity-60 hover:opacity-100' : ''}`}
            style={{ width: TASK_CARD_WIDTH }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            {task.missionId && (
                <button
                    type="button"
                    onClick={onMissionOpen && missionTitle ? event => { event.stopPropagation(); onMissionOpen(task.missionId!) } : undefined}
                    className={`mb-1.5 flex w-full min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-2xs font-medium ${theme.isDark
                        ? 'border-indigo-400/25 bg-indigo-500/10 text-indigo-200'
                        : 'border-indigo-200 bg-indigo-50/80 text-indigo-700'} ${onMissionOpen && missionTitle
                        ? (theme.isDark ? 'cursor-pointer hover:bg-indigo-500/20' : 'cursor-pointer hover:bg-indigo-100')
                        : 'cursor-default'}`}
                    title={missionTitle ? `${missionTitle} (${task.missionId})` : task.missionId}
                >
                    <IconFlag size={10} />
                    <span className="truncate">{missionTitle || task.missionId.slice(0, 10)}</span>
                </button>
            )}
            <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'animate-pulse' : ''}`} aria-hidden />
                    <span className="truncate text-3xs font-semibold uppercase tracking-wide opacity-80">{task.status}</span>
                </span>
                {/* Time label (owner call 2026-09-02): B-plan makes dependency
                    depth the one canvas axis, so time is no longer readable
                    from position — the card carries it. Absolute to match
                    logs, relative to judge staleness. */}
                {/* The id keeps only its tooltip — it is in the detail modal
                    too, and the 236px header has room for exactly one of the
                    two. Staleness beats an identifier nobody reads at a glance. */}
                {cardTime ? (
                    <span
                        className={`shrink-0 font-mono text-4xs tabular-nums ${theme.isDark ? 'text-slate-400' : 'text-slate-500'}`}
                        title={`${cardTime.iso}\n${task.id}`}
                    >
                        {cardTime.absolute} <span className="opacity-70">({cardTime.relative})</span>
                    </span>
                ) : (
                    <span className={`shrink-0 font-mono text-4xs ${theme.isDark ? 'text-slate-400' : 'text-slate-400'}`} title={task.id}>{task.id.slice(0, 8)}</span>
                )}
            </div>
            {/* Markdown-syntax-stripped plain text; a cancelled card mutes rather
                than strikes through — multi-line struck text was unreadable. */}
            <div
                className={`mt-1.5 text-2xs leading-[15px] ${task.status === 'cancelled' ? 'opacity-60' : ''}`}
                style={messageClampStyle}
                title={queueTaskDisplayText(task.message)}
            >
                {queueTaskDisplayText(task.message)}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {task.difficulty && <span className={chipClass}>{task.difficulty}</span>}
                {predictedSlot && task.status === 'pending' && (
                    <span
                        className={predictedSlotPinned
                            ? (theme.isDark
                                ? 'rounded-full border border-sky-400/25 bg-sky-500/10 px-1.5 py-px text-4xs text-sky-200'
                                : 'rounded-full border border-sky-300 bg-sky-50 px-1.5 py-px text-4xs text-sky-700')
                            : (theme.isDark
                                ? 'rounded-full border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-px text-4xs text-emerald-200'
                                : 'rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-4xs text-emerald-700')}
                        title={t(predictedSlotPinned ? 'meshGraph.taskDag.predictedSlotPinned' : 'meshGraph.taskDag.predictedSlot')}
                    >
                        {predictedSlotPinned ? '📌 ' : '→ '}{predictedSlot}
                    </span>
                )}
                {task.priority && task.priority !== 'normal' && <span className={chipClass}>{task.priority}</span>}
                {(task.taskMode === 'live_debug_readonly' || task.readonly) && <span className={chipClass}>read-only</span>}
                {dagNode.waitingOn.length > 0 && (
                    <span
                        className={theme.isDark
                            ? 'rounded-full border border-amber-400/25 bg-amber-500/10 px-1.5 py-px text-4xs text-amber-200'
                            : 'rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px text-4xs text-amber-700'}
                        title={dagNode.waitingOn.join(', ')}
                    >
                        {t('meshGraph.taskDag.waitsOn', { count: dagNode.waitingOn.length })}
                    </span>
                )}
                {dagNode.blocked && (
                    <span
                        className={theme.isDark
                            ? 'rounded-full border border-rose-400/25 bg-rose-500/10 px-1.5 py-px text-4xs text-rose-200'
                            : 'rounded-full border border-rose-300 bg-rose-50 px-1.5 py-px text-4xs text-rose-700'}
                        title={task.blockedReason}
                    >
                        {t('meshGraph.taskDag.blocked')}
                    </span>
                )}
                {dagNode.missingDeps.length > 0 && (
                    <span className={chipClass} title={dagNode.missingDeps.join(', ')}>
                        {t('meshGraph.taskDag.missingDeps', { count: dagNode.missingDeps.length })}
                    </span>
                )}
            </div>
        </div>
    )
}

// ─── Graph fusion overlays (gates + planned steps) ──────────────────────────

const GATE_NODE_WIDTH = 208

/** True for a gate that is holding the graph and needs a human to act. */
function isBlockingGateState(state: string): boolean {
    return state === 'awaiting_coordinator' || state === 'claimed' || state === 'expired'
}

/**
 * Rendered width of a gate node. A BLOCKING gate is drawn at full task-card
 * width so it reads as the most important node on the canvas — which means
 * ELK and the hull maths must use the same number, or the widened card
 * overlaps its neighbour. Single source for all three call sites.
 */
function gateNodeWidth(state: string): number {
    return isBlockingGateState(state) ? TASK_CARD_WIDTH : GATE_NODE_WIDTH
}

/** Rendered height of a gate node — same single-source rule as the width. */
function gateNodeHeight(state: string): number {
    return isBlockingGateState(state) ? BLOCKING_GATE_HEIGHT : GATE_NODE_HEIGHT
}
const GATE_NODE_HEIGHT = 64
/** A blocking gate also renders its instructions, so it needs more room. */
const BLOCKING_GATE_HEIGHT = 104
const PLAN_NODE_WIDTH = 208
const PLAN_NODE_HEIGHT = 58

interface FusedOverlays {
    gates: Array<{ id: string; graph: MeshGraphView; nodeId: string; gate?: MeshGraphGateView; ref: string; state: string }>
    /** Ghost (not-yet-materialized) steps. `skipReason` and `features` come
     *  straight off MeshGraphNodeView and were previously dropped on the
     *  floor — they are what explains a step that never ran. */
    planned: Array<{ id: string; ref: string; state: string; skipReason?: string; failureReason?: string; blockedByDeps?: number; conditional?: boolean }>
    edges: Array<{ id: string; source: string; target: string; state: import('./blueprintViewModel').BlueprintEdgeState; kind?: string; condition?: string }>
    /** One entry per graph: which canvas ids belong to it, for the cluster hull. */
    clusters: Array<{ id: string; graphId: string; batchId?: string; status: string; memberIds: string[] }>
}

/** Gate state → visual, mirrored from the retired per-graph view. */
const GATE_STATE_STYLES: Record<string, { dark: string; light: string; dot: string; pulse?: boolean }> = {
    declared: { dark: 'border-slate-400/40 bg-slate-500/10 text-slate-200', light: 'border-slate-300 bg-slate-50 text-slate-700', dot: 'bg-slate-400' },
    awaiting_coordinator: { dark: 'border-amber-400/60 bg-amber-500/15 text-amber-100', light: 'border-amber-400 bg-amber-50 text-amber-800', dot: 'bg-amber-400', pulse: true },
    claimed: { dark: 'border-sky-400/60 bg-sky-500/15 text-sky-100', light: 'border-sky-400 bg-sky-50 text-sky-800', dot: 'bg-sky-400', pulse: true },
    released: { dark: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100', light: 'border-emerald-300 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-400' },
    cancelled: { dark: 'border-slate-500/25 bg-slate-600/10 text-slate-400', light: 'border-slate-200 bg-slate-100 text-slate-400', dot: 'bg-slate-500' },
    expired: { dark: 'border-rose-400/40 bg-rose-500/10 text-rose-100', light: 'border-rose-300 bg-rose-50 text-rose-800', dot: 'bg-rose-400', pulse: true },
}

/**
 * Fuse every graph into overlay nodes/edges against the VISIBLE queue cards.
 * A graph task-node whose task is on the canvas contributes no node of its
 * own — its edges attach straight to the live card, which is what makes the
 * gate read as part of the plan instead of a parallel diagram.
 */
function buildFusedOverlays(graphs: MeshGraphView[], visibleTaskIds: Set<string>): FusedOverlays {
    const overlays: FusedOverlays = { gates: [], planned: [], edges: [], clusters: [] }
    for (const graph of graphs) {
        const endpointMap = buildNodeIdByEndpoint(graph)
        const stateByNodeId = buildStateByNodeId(graph)
        const canvasIdByGraphNode = new Map<string, string>()
        for (const node of graph.nodes) {
            if (node.kind === 'coordinator_gate') {
                const id = `gate:${graph.graphId}:${node.nodeId}`
                const gate = graph.gates.find(candidate => candidate.nodeId === node.nodeId)
                overlays.gates.push({ id, graph, nodeId: node.nodeId, gate, ref: node.ref || node.nodeId.slice(0, 8), state: gate?.state ?? node.state })
                canvasIdByGraphNode.set(node.nodeId, id)
                continue
            }
            if (node.taskId && visibleTaskIds.has(node.taskId)) {
                canvasIdByGraphNode.set(node.nodeId, node.taskId)
                continue
            }
            const id = `plan:${graph.graphId}:${node.nodeId}`
            overlays.planned.push({
                id,
                ref: node.ref || node.nodeId.slice(0, 8),
                state: node.state,
                ...(node.skipReason ? { skipReason: node.skipReason } : {}),
                ...(node.failureReason ? { failureReason: node.failureReason } : {}),
                // C3-derived: which predecessors failed, so this step can never
                // run. Present on the view, drawn nowhere until now.
                ...(node.dependencyFailures?.length ? { blockedByDeps: node.dependencyFailures.length } : {}),
                // `features` is the daemon's declared-feature list; 'run_if'
                // in it means this step runs only when its condition holds.
                ...(node.features?.includes('run_if') ? { conditional: true } : {}),
            })
            canvasIdByGraphNode.set(node.nodeId, id)
        }
        graph.edges.forEach((edge, index) => {
            const source = canvasIdByGraphNode.get(endpointMap.get(edge.from) ?? edge.from)
            const target = canvasIdByGraphNode.get(endpointMap.get(edge.to) ?? edge.to)
            if (!source || !target) return
            overlays.edges.push({
                id: `ge:${graph.graphId}:${index}`,
                source,
                target,
                state: deriveBlueprintEdgeState(edge, stateByNodeId, endpointMap),
                ...(edge.kind && edge.kind !== 'dependency' ? { kind: edge.kind } : {}),
                ...(edge.condition ? { condition: edge.condition } : {}),
            })
        })
        overlays.clusters.push({
            id: `cluster:${graph.graphId}`,
            graphId: graph.graphId,
            ...(typeof (graph as { batchId?: string }).batchId === 'string' && (graph as { batchId?: string }).batchId ? { batchId: (graph as { batchId?: string }).batchId } : {}),
            status: graph.status,
            memberIds: [...canvasIdByGraphNode.values()],
        })
    }
    return overlays
}

type GateFlowNode = Node<Record<string, unknown> & { overlay: FusedOverlays['gates'][number]; theme: MeshGraphTheme }, 'gateNode'>

function GateNodeCard({ data }: NodeProps<GateFlowNode>) {
    const { t } = useTranslation('common')
    const { overlay, theme } = data
    const style = GATE_STATE_STYLES[overlay.state] ?? GATE_STATE_STYLES.declared
    /* A gate that is WAITING ON A HUMAN is the one thing this tab exists to
     * surface, yet it used to render smaller (208px) and lighter (dashed,
     * muted) than the ordinary 236px task cards around it — the most urgent
     * node was the most recessive. Blocking gates now take the full card
     * width, a solid border and a ring; settled ones keep the quiet dashed
     * treatment, so the loud styling means "act on me", not "I am a gate". */
    const blocking = isBlockingGateState(overlay.state)
    return (
        <div
            className={`rounded-xl border px-3 py-2 shadow-sm ${blocking ? 'border-solid shadow-md' : 'border-dashed'} ${theme.isDark ? style.dark : style.light} ${blocking ? (theme.isDark ? 'ring-1 ring-amber-300/40' : 'ring-1 ring-amber-400/50') : ''}`}
            style={{ width: gateNodeWidth(overlay.state), minHeight: gateNodeHeight(overlay.state) }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'animate-pulse' : ''}`} aria-hidden />
                <span className="truncate text-3xs font-semibold uppercase tracking-wide opacity-85">⛩ {overlay.gate?.action ?? 'gate'}</span>
            </div>
            <div className="mt-1 truncate text-2xs font-medium" title={overlay.ref}>{overlay.ref}</div>
            <div className="mt-0.5 text-4xs opacity-70">
                {overlay.state}{overlay.gate?.leaseExpired ? ' · lease expired' : ''}
                {/* A SETTLED gate showed only the word "released", which says
                    nothing about what was decided — the outcome is the entire
                    content of a gate after the fact. */}
                {overlay.gate?.releaseOutcome ? ` → ${overlay.gate.releaseOutcome}` : ''}
            </div>
            {/* Deadline + what happens if it lapses. Both reached the view and
                were rendered nowhere, so a gate with a deadline looked exactly
                like one without — the reader could not tell an approval that
                expires tonight from one that waits forever. */}
            {/* How many worker steps this gate is holding. `blocking` reached
                the view and was never drawn, so a gate that had stalled five
                tasks looked identical to one holding nothing. */}
            {blocking && overlay.gate?.blocking?.length ? (
                <div className="mt-0.5 truncate text-4xs opacity-75">
                    {t('meshGraph.taskDag.gate.holding', { count: overlay.gate.blocking.length })}
                </div>
            ) : null}
            {/* Convergence probe: are this gate's commits already on main?
                `hint` is explicitly the actionable half of the evidence. */}
            {overlay.gate?.convergenceEvidence && (
                <div
                    className={`mt-0.5 truncate text-4xs ${overlay.gate.convergenceEvidence.allReachedMain
                        ? (theme.isDark ? 'text-emerald-300' : 'text-emerald-600')
                        : 'opacity-75'}`}
                    title={overlay.gate.convergenceEvidence.hint ?? overlay.gate.convergenceEvidence.probedAgainst}
                >
                    {overlay.gate.convergenceEvidence.allReachedMain
                        ? t('meshGraph.taskDag.gate.converged')
                        : t('meshGraph.taskDag.gate.notConverged', { count: overlay.gate.convergenceEvidence.commits.length })}
                </div>
            )}
            {blocking && overlay.gate?.deadlineAt && (
                <div className="mt-0.5 truncate text-4xs opacity-75" title={overlay.gate.deadlineAt}>
                    {t('meshGraph.taskDag.gate.deadline', {
                        time: new Date(overlay.gate.deadlineAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                        onTimeout: overlay.gate.onTimeout,
                    })}
                </div>
            )}
            {/* The raw state token is a machine word; a blocking gate also says
                what it is waiting for, so the canvas answers "why is nothing
                moving?" without opening the detail panel. */}
            {blocking && (
                <div className="mt-1 text-4xs font-medium opacity-90">
                    <div>{t('meshGraph.taskDag.gate.needsYou')}</div>
                    {/* What the coordinator is actually being asked to decide.
                        Without it a waiting gate is just a coloured box. */}
                    {overlay.gate?.instructions && (
                        <div className="mt-0.5 line-clamp-2 font-normal opacity-80" title={overlay.gate.instructions}>
                            {overlay.gate.instructions}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

type PlanFlowNode = Node<Record<string, unknown> & { overlay: FusedOverlays['planned'][number]; theme: MeshGraphTheme }, 'planNode'>

function PlanNodeCard({ data }: NodeProps<PlanFlowNode>) {
    const { t } = useTranslation('common')
    const { overlay, theme } = data
    const settled = overlay.state === 'completed' || overlay.state === 'skipped' || overlay.state === 'cancelled'
    return (
        <div
            className={`rounded-xl border border-dashed px-3 py-2 ${settled ? 'opacity-50' : ''} ${theme.isDark ? 'border-slate-400/30 bg-white/[0.02] text-slate-300' : 'border-slate-300 bg-white/70 text-slate-600'}`}
            style={{ width: PLAN_NODE_WIDTH, minHeight: PLAN_NODE_HEIGHT }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <div className="flex items-center gap-1 text-3xs font-semibold uppercase tracking-wide opacity-70">
                <span className="truncate">{overlay.state}</span>
                {/* A conditional step is not simply "not started" — it runs
                    only if its run_if holds. Without this marker a planned
                    branch and a skipped one look identical. */}
                {overlay.conditional && <span className="shrink-0 normal-case opacity-90" title={t('meshGraph.taskDag.edge.conditional')}>· if</span>}
            </div>
            <div className="mt-1 truncate text-2xs font-medium" title={overlay.ref}>{overlay.ref}</div>
            {overlay.skipReason && (
                <div className="mt-0.5 truncate text-4xs opacity-70" title={overlay.skipReason}>{overlay.skipReason}</div>
            )}
            {/* Why the step failed. Carried on the view, never drawn — a failed
                planned step read as an ordinary grey ghost. */}
            {overlay.failureReason && (
                <div className={`mt-0.5 truncate text-4xs ${theme.isDark ? 'text-rose-300' : 'text-rose-600'}`} title={overlay.failureReason}>
                    {overlay.failureReason}
                </div>
            )}
            {/* "It can never run because upstream failed" — distinct from a
                step that is merely waiting its turn. */}
            {!overlay.failureReason && overlay.blockedByDeps ? (
                <div className={`mt-0.5 truncate text-4xs ${theme.isDark ? 'text-rose-300' : 'text-rose-600'}`}>
                    {t('meshGraph.taskDag.plan.depsFailed', { count: overlay.blockedByDeps })}
                </div>
            ) : null}
        </div>
    )
}

const HULL_PADDING = 26
const HULL_LABEL_CLEARANCE = 24

type HullFlowNode = Node<Record<string, unknown> & { label: string; status: string; width: number; height: number; theme: MeshGraphTheme }, 'clusterHull'>

/** Faint bounding frame + label naming which orchestration graph/batch a chain
 *  belongs to — without it, chains from different plans float indistinguishably
 *  on one plane. Non-interactive; sits behind every card (zIndex). */
function ClusterHullNode({ data }: NodeProps<HullFlowNode>) {
    const { label, status, width, height, theme } = data
    const tone = status === 'completed'
        ? (theme.isDark ? 'border-emerald-400/15 bg-emerald-500/[0.03]' : 'border-emerald-300/60 bg-emerald-50/40')
        : status === 'failed' || status === 'compensation_required'
            ? (theme.isDark ? 'border-rose-400/20 bg-rose-500/[0.03]' : 'border-rose-300/60 bg-rose-50/40')
            : status === 'waiting_gate'
                ? (theme.isDark ? 'border-amber-400/25 bg-amber-500/[0.04]' : 'border-amber-300/70 bg-amber-50/40')
                : status === 'cancelled'
                    ? (theme.isDark ? 'border-white/8 bg-white/[0.015]' : 'border-slate-200 bg-slate-50/40')
                    : (theme.isDark ? 'border-sky-400/20 bg-sky-500/[0.03]' : 'border-sky-300/60 bg-sky-50/40')
    return (
        <div className={`pointer-events-none rounded-2xl border border-dashed ${tone}`} style={{ width, height }}>
            <div className={`absolute -top-0.5 left-3 -translate-y-full pb-1 text-4xs font-semibold uppercase tracking-[0.18em] ${theme.isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {label} · {status}
            </div>
        </div>
    )
}


/* Zoom floor for the canvas. The blueprint used to OPEN near this value
 * because the built-in fitView framed the whole archive, at which a 236px
 * card is ~42px wide — a rectangle, not information. That is fixed by
 * framing only the live work (see the fit effect), not by raising the floor:
 * the floor still has to allow a bird's-eye pinch-out, and clamping the
 * automatic frame instead pushed its own targets off a short canvas. */
const CANVAS_MIN_ZOOM = 0.18

const COLLAPSED_GRAPH_WIDTH = 236
const COLLAPSED_GRAPH_HEIGHT = 52
/** Gap between stacked collapsed chips, and clearance below the live drawing. */
const COLLAPSED_STACK_GAP_Y = 10
const COLLAPSED_STACK_LEAD_Y = 72
/** Clearance between the live drawing and the first expanded graph below it. */
const EXPANDED_GRAPH_LEAD_Y = 96
/** Horizontal gap between the two expanded-graph columns. */
const EXPANDED_GRAPH_COLUMN_GAP_X = 64
/** Vertical gap between two graphs stacked in the same column. */
const EXPANDED_GRAPH_STACK_GAP_Y = 72

type CollapsedGraphFlowNode = Node<Record<string, unknown> & {
    summary: import('./blueprintViewModel').CollapsedGraphSummary
    timeLabel: string
    theme: MeshGraphTheme
    onToggle: (graphId: string) => void
}, 'collapsedGraph'>

/**
 * A settled graph, folded to one line. It stays IN the ELK flow rather than
 * moving to a separate zone — that separation was the thing that made the old
 * canvas unreadable. Click expands it back into gates and ghosts.
 */
function CollapsedGraphNode({ data }: NodeProps<CollapsedGraphFlowNode>) {
    const { t } = useTranslation('common')
    const { summary, timeLabel, theme, onToggle } = data
    const tone = summary.status === 'failed'
        ? (theme.isDark ? 'border-rose-400/30 bg-rose-500/[0.07] text-rose-200' : 'border-rose-200 bg-rose-50/70 text-rose-700')
        : (theme.isDark ? 'border-white/10 bg-white/[0.03] text-slate-300' : 'border-slate-200 bg-slate-50/80 text-slate-600')
    return (
        <button
            type="button"
            onClick={event => { event.stopPropagation(); onToggle(summary.graphId) }}
            className={`flex flex-col justify-center gap-0.5 rounded-xl border border-dashed px-3 py-1.5 text-left transition-colors hover:border-solid ${tone}`}
            style={{ width: COLLAPSED_GRAPH_WIDTH, minHeight: COLLAPSED_GRAPH_HEIGHT }}
            title={t('meshGraph.taskDag.collapsed.expand')}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <span className="flex items-center gap-1.5 truncate text-2xs font-medium">
                <span className="opacity-60">▸</span>
                <span className="truncate">{summary.batchId || summary.graphId.slice(0, 8)}</span>
                <span className="shrink-0 opacity-70">· {summary.status}</span>
            </span>
            <span className="flex items-center gap-2 text-4xs opacity-70">
                <span>{t('meshGraph.taskDag.collapsed.counts', { nodes: summary.nodeCount, gates: summary.gateCount })}</span>
                {timeLabel && <span className="font-mono tabular-nums">{timeLabel}</span>}
            </span>
        </button>
    )
}

const nodeTypes: NodeTypes = { taskNode: TaskNodeCard, gateNode: GateNodeCard, planNode: PlanNodeCard, clusterHull: ClusterHullNode, collapsedGraph: CollapsedGraphNode }



/* The timeline-lane re-stack was REMOVED (owner call 2026-09-02, B-plan).
 * It was the second of three placement systems: it hoisted detached graph
 * clusters into a hand-built vertical time lane and slid the ELK chains right
 * by `laneMaxX + gap`. The zones were joined by arithmetic, not meaning — Y
 * meant time on the left and crossing-minimization in the middle — which is
 * exactly why the canvas would not read as one picture. Settled graphs now
 * collapse to a chip inside the single ELK flow (resolveCollapsedGraphIds),
 * and time lives on the cards (formatTaskCardTime). */

/**
 * Two-phase layout. ELK only sees the CONNECTED material — tasks touching any
 * edge, plus every graph member (gates, ghosts, fused cards). Tasks with no
 * edges and no graph membership used to be scattered by ELK as arbitrary
 * disconnected components mixed into the chains; they now stack in ONE
 * vertical column to the right of the chains, newest first (owner call
 * 2026-08-25: time order beats a separate zone), so the loose queue reads as
 * a timeline next to the plans instead of noise inside them.
 */
/** What the canvas lays out: every task in ELK model order, plus the mission
 *  hulls. B-plan retired the chains/loose-stack partition — there is one zone
 *  now, so composition no longer decides WHERE things go, only in what order
 *  ELK sees them and which cards share a hull. */
interface CanvasComposition {
    /** Every renderable task; ELK model order is applied at layout time. */
    orderedTasks: TaskDagNode[]
    missionClusters: Array<{ id: string; missionId: string; memberIds: string[] }>
}

function taskTimeKey(node: TaskDagNode): string {
    return String(node.task.updatedAt || node.task.createdAt || '')
}

function buildCanvasComposition(dag: TaskDagData, overlays: FusedOverlays): CanvasComposition {
    // Mission hulls used to cover only LOOSE same-mission tasks, because the
    // loose stack was the only place they could be made contiguous. With one
    // ELK zone the hull is a pure grouping again: every multi-task mission
    // gets one, whether or not its tasks carry dependency edges.
    const graphMemberIds = new Set(overlays.clusters.flatMap(cluster => cluster.memberIds))
    const byMission = new Map<string, TaskDagNode[]>()
    for (const node of dag.nodes) {
        const missionId = typeof node.task.missionId === 'string' && node.task.missionId ? node.task.missionId : ''
        if (!missionId) continue
        // A card already framed by its graph hull must not take a second frame.
        if (graphMemberIds.has(node.id)) continue
        const bucket = byMission.get(missionId) ?? []
        bucket.push(node)
        byMission.set(missionId, bucket)
    }
    const missionClusters = [...byMission.entries()]
        .filter(([, nodes]) => nodes.length > 1)
        .map(([missionId, nodes]) => ({
            id: `mission:${missionId}`,
            missionId,
            memberIds: nodes.map(node => node.id),
        }))
    return { orderedTasks: dag.nodes, missionClusters }
}


async function layoutTaskDag(
    dag: TaskDagData,
    overlays: FusedOverlays,
    composition: CanvasComposition,
    collapsed: ReadonlyArray<import('./blueprintViewModel').CollapsedGraphSummary>,
): Promise<{ positions: Map<string, { x: number; y: number }> }> {
    // B-plan (owner call 2026-09-02): ONE placement system. Every task —
    // dependency-linked or loose — goes through the same ELK pass, so the
    // canvas has a single axis (dependency depth, left to right) instead of
    // three zones joined by arithmetic. Loose tasks simply have no edges, and
    // ELK places them as their own components; their relative order is fixed
    // by the model order below rather than by a hand-built stack.
    const positions = new Map<string, { x: number; y: number }>()
    const hasMaterial = dag.nodes.length > 0 || overlays.gates.length > 0 || overlays.planned.length > 0 || collapsed.length > 0
    if (!hasMaterial) return { positions }
    // Roots newest-first (owner call: unlinked/entry tasks stay chronological);
    // ELK's considerModelOrder=NODES_AND_EDGES turns this array order into
    // within-layer placement, so no second coordinate pass is needed.
    const ordered = orderTasksForElk(composition.orderedTasks, taskTimeKey)
    const elkPositions = await layoutElkElements(ordered, dag.edges, overlays)
    for (const [id, position] of elkPositions) positions.set(id, position)
    /* Collapsed graphs are laid out HERE, not by ELK. Handing them to ELK made
     * each one its own disconnected component, so 19 chips scattered into a
     * 3-column grid above the live work — and since the viewport frames the
     * live work, that grid sat off the top edge as a band of half-cut
     * rectangles. They are an archive index, not part of the dependency
     * drawing: one tidy column under the graph, newest first, reads as
     * exactly that and stays inside the frame. */
    /* Keep the LIVE work at the top. ELK lays each expanded graph out as its
     * own disconnected component and is free to order them however it likes —
     * measured, expanding three chips pushed the live tasks from y=174 down to
     * y=852 while the freshly expanded plans took the top. Since the viewport
     * frames the live work, that reads as the whole canvas lurching. ELK's
     * component-order options did not hold, so the invariant is enforced here
     * instead: anything belonging to an expanded graph is shifted below the
     * live drawing, preserving ELK's internal layout of each. */
    lowerExpandedGraphs(positions, dag, overlays)
    stackCollapsedGraphs(positions, collapsed)
    return { positions }
}

/**
 * Place every free-floating expanded graph BELOW the live task drawing, in two
 * columns.
 *
 * Three revisions, each fixing the previous one's defect:
 *  1. shift each graph to the same baseline → all landed at one y (15 overlaps)
 *  2. one column tracking a running cursor → correct, but the canvas grew very
 *     tall and left the right half of a wide viewport empty
 *  3. two columns, shortest-column-first → same correctness, half the height
 *
 * Each graph keeps its own ELK shape; only the whole cluster translates.
 */
function lowerExpandedGraphs(
    positions: Map<string, { x: number; y: number }>,
    dag: TaskDagData,
    overlays: FusedOverlays,
): void {
    const liveIds = new Set(dag.nodes.map(node => node.id))
    let liveBottom = -Infinity
    let liveLeft = Infinity
    for (const node of dag.nodes) {
        const position = positions.get(node.id)
        if (!position) continue
        liveBottom = Math.max(liveBottom, position.y + estimateTaskCardHeight(node))
        liveLeft = Math.min(liveLeft, position.x)
    }
    if (!Number.isFinite(liveBottom)) return
    const sizeOf = (id: string): number => {
        if (id.startsWith('gate:')) {
            const gate = overlays.gates.find(candidate => candidate.id === id)
            return gateNodeHeight(gate?.state ?? 'declared')
        }
        if (id.startsWith('plan:')) return PLAN_NODE_HEIGHT
        const node = dag.nodes.find(candidate => candidate.id === id)
        return node ? estimateTaskCardHeight(node) : TASK_CARD_MIN_HEIGHT
    }
    const widthOf = (id: string): number => {
        if (id.startsWith('gate:')) {
            const gate = overlays.gates.find(candidate => candidate.id === id)
            return gateNodeWidth(gate?.state ?? 'declared')
        }
        if (id.startsWith('plan:')) return PLAN_NODE_WIDTH
        return TASK_CARD_WIDTH
    }
    const startY = liveBottom + EXPANDED_GRAPH_LEAD_Y
    const originX = Number.isFinite(liveLeft) ? liveLeft : 0
    /* Two columns. The gutter is set from the graphs that actually land in
     * column 1, not from the widest graph overall: sizing it to the widest
     * (1214px here) pushed column 2 off-screen and saved no height at all,
     * while a fixed midpoint let a wide graph run through its neighbour
     * (7 overlaps). So column 2's x is decided AFTER placement, by measuring
     * column 1 — see the second pass below. */
    const columnX = [originX, originX]
    const columnBottom = [startY, startY]
    let column1Right = originX
    const placed: Array<{ ids: string[]; column: number }> = []
    for (const cluster of overlays.clusters) {
        // A cluster containing a live card is FUSED into the drawing; moving it
        // would tear the fusion apart, so only fully free-floating graphs move.
        const ownIds = cluster.memberIds.filter(id => positions.has(id))
        if (ownIds.length === 0) continue
        if (ownIds.length !== cluster.memberIds.length) continue
        if (cluster.memberIds.some(id => liveIds.has(id))) continue
        let top = Infinity
        let left = Infinity
        let bottom = -Infinity
        for (const id of ownIds) {
            const position = positions.get(id)!
            top = Math.min(top, position.y)
            left = Math.min(left, position.x)
            bottom = Math.max(bottom, position.y + sizeOf(id))
        }
        // Shortest column first keeps the two sides even.
        const column = columnBottom[0] <= columnBottom[1] ? 0 : 1
        const shiftY = columnBottom[column] - top
        const shiftX = columnX[column] - left
        for (const id of ownIds) {
            const position = positions.get(id)!
            positions.set(id, { x: position.x + shiftX, y: position.y + shiftY })
        }
        columnBottom[column] = bottom + shiftY + EXPANDED_GRAPH_STACK_GAP_Y
        placed.push({ ids: ownIds, column })
        if (column === 0) {
            let right = -Infinity
            for (const id of ownIds) right = Math.max(right, positions.get(id)!.x + widthOf(id))
            column1Right = Math.max(column1Right, right)
        }
    }
    // Second pass: now that column 1's true extent is known, slide column 2
    // just clear of it — no wider, so the pair stays inside one screenful.
    const column2X = column1Right + EXPANDED_GRAPH_COLUMN_GAP_X
    for (const entry of placed) {
        if (entry.column !== 1) continue
        let left = Infinity
        for (const id of entry.ids) left = Math.min(left, positions.get(id)!.x)
        const shiftX = column2X - left
        for (const id of entry.ids) {
            const position = positions.get(id)!
            positions.set(id, { x: position.x + shiftX, y: position.y })
        }
    }
}

/** Newest-first single column of collapsed-graph chips, below the live drawing. */
function stackCollapsedGraphs(
    positions: Map<string, { x: number; y: number }>,
    collapsed: ReadonlyArray<import('./blueprintViewModel').CollapsedGraphSummary>,
): void {
    if (collapsed.length === 0) return
    let minX = Infinity
    let maxY = -Infinity
    for (const position of positions.values()) {
        minX = Math.min(minX, position.x)
        maxY = Math.max(maxY, position.y)
    }
    if (!Number.isFinite(minX)) { minX = 0; maxY = -COLLAPSED_STACK_GAP_Y }
    const startY = maxY + TASK_CARD_MIN_HEIGHT + COLLAPSED_STACK_LEAD_Y
    const ordered = [...collapsed].sort((a, b) => b.timestamp - a.timestamp)
    ordered.forEach((summary, index) => {
        positions.set(`graph:${summary.graphId}`, {
            x: minX,
            y: startY + index * (COLLAPSED_GRAPH_HEIGHT + COLLAPSED_STACK_GAP_Y),
        })
    })
}

async function layoutElkElements(tasks: TaskDagNode[], taskEdges: TaskDagData['edges'], overlays: FusedOverlays): Promise<Map<string, { x: number; y: number }>> {
    const graph = {
        id: 'task-dag-root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'SPLINES',
            'elk.spacing.nodeNode': '46',
            // Disconnected chains each get a hull + a label ABOVE their frame —
            // separate the components far enough that a hull's label never
            // rides the previous hull's bottom edge.
            'elk.spacing.componentComponent': '110',
            'elk.layered.spacing.nodeNodeBetweenLayers': '120',
            'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            'elk.layered.cycleBreaking.strategy': 'GREEDY',
            'elk.randomSeed': '1',
        },
        children: [
            ...tasks.map(node => ({
                id: node.id,
                width: TASK_CARD_WIDTH,
                height: estimateTaskCardHeight(node),
            })),
            ...overlays.gates.map(gate => ({ id: gate.id, width: gateNodeWidth(gate.state), height: gateNodeHeight(gate.state) })),
            ...overlays.planned.map(plan => ({ id: plan.id, width: PLAN_NODE_WIDTH, height: PLAN_NODE_HEIGHT })),
        ],
        edges: [
            // Task dependsOn edges: both endpoints are edge-touched, hence in
            // the task set by construction.
            ...taskEdges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
            ...overlays.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
        ],
    }
    const result = await elk.layout(graph)
    const positions = new Map<string, { x: number; y: number }>()
    for (const child of result.children ?? []) {
        positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
    }
    return positions
}

export default function MeshTaskDagView({ tasks, emptyMessage, compact = false, predictedSlots, pinnedSlots, initialTerminalLimit, onTaskOpen, statsContainer, graphs, onGateOpen, missionTitles, onMissionOpen, focusMission }: MeshTaskDagViewProps) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    // Scope the history: active tasks + their dependency ancestry always render;
    // terminal rows are capped and revealed incrementally via "load more". A
    // long-lived mesh accumulates hundreds of terminal rows, and laying ALL of
    // them out took tens of seconds while rendering an unreadable wall.
    // Compact (embedded) mode trusts the caller's scoping and renders everything.
    const [terminalLimit, setTerminalLimit] = useState(initialTerminalLimit ?? TASK_DAG_RECENT_TERMINAL_LIMIT)
    const scoped = useMemo(
        () => scopeTaskDagTasks(tasks, compact ? Number.POSITIVE_INFINITY : terminalLimit),
        [tasks, terminalLimit, compact],
    )
    const dag = useMemo(() => buildTaskDag(scoped.tasks), [scoped.tasks])
    // Layout identity: statuses drive edge state and badge rows (card height), so
    // re-layout when any of them change — not only when the id set changes.
    // Graph fusion: gates/planned steps of every provided graph, wired against
    // the VISIBLE cards (a hidden terminal task degrades to a ghost node).
    /* Collapse (owner call 2026-09-02): a SETTLED graph renders as one chip
     * inside the same ELK flow instead of a full expanse of gates and ghosts.
     * This is what lets 'Include finished' stay on without the canvas zooming
     * out to unreadability — the context (what finished, next to what is live)
     * survives, the pixel cost does not. Expanding is per-graph and sticky for
     * the life of the tab. */
    const [expandedGraphIds, setExpandedGraphIds] = useState<ReadonlySet<string>>(() => new Set())
    const collapsedGraphIds = useMemo(
        () => resolveCollapsedGraphIds(graphs ?? [], expandedGraphIds),
        [graphs, expandedGraphIds],
    )
    const toggleGraphExpanded = useCallback((graphId: string) => {
        setExpandedGraphIds(current => {
            const next = new Set(current)
            if (next.has(graphId)) next.delete(graphId)
            else next.add(graphId)
            return next
        })
    }, [])
    /** The collapsed graphs, summarised for their chips. */
    const collapsedGraphs = useMemo(
        () => (graphs ?? []).filter(graph => collapsedGraphIds.has(graph.graphId)).map(summarizeCollapsedGraph),
        [graphs, collapsedGraphIds],
    )
    const fused = useMemo(() => {
        const visible = new Set(dag.nodes.map(node => node.id))
        // A collapsed graph contributes no gates, ghosts, edges or hull — its
        // chip stands in for all of it.
        const expandedGraphs = (graphs ?? []).filter(graph => !collapsedGraphIds.has(graph.graphId))
        return buildFusedOverlays(expandedGraphs, visible)
    }, [graphs, collapsedGraphIds, dag])
    const dagFingerprint = useMemo(
        () => dag.nodes.map(node => `${node.id}:${node.task.status}:${node.dependsOn.join('+')}:${node.waitingOn.length}:${node.blocked ? 1 : 0}`).join('|')
            + '||' + fused.gates.map(gate => `${gate.id}:${gate.state}`).join('|')
            + '||' + fused.planned.map(plan => `${plan.id}:${plan.state}`).join('|')
            + '||' + fused.edges.map(edge => `${edge.id}:${edge.state}`).join('|')
            // Collapse state is a LAYOUT input: expanding a graph adds its gates
            // and ghosts back. Leave it out and the click changes nothing on
            // screen, because the layout effect keys off this fingerprint.
            + '||' + collapsedGraphs.map(summary => summary.graphId).join('|'),
        [dag, fused, collapsedGraphs],
    )
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
    // Focus highlight driven by the stat-chip jump — separate from selection so
    // jumping never opens the detail surface, it only rings + centers the card.
    const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
    /** Mission whose thread is lit up because the pointer rests on one of its cards. */
    const [hoveredMissionId, setHoveredMissionId] = useState<string | null>(null)
    const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null)
    /** Axis marks for the vertical time rail — one per graph cluster, keyed to its stacked y. */
    // State (not a ref) so the live-fit effect reruns once the canvas mounts.
    const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<TaskFlowNode, Edge> | null>(null)
    /* Relative-time clock. Ticks on its own so "3분 전" ages while the tab sits
     * open, independent of the 45s data poll — a card must never look fresher
     * than it is just because nothing refetched. Coarse (30s) because the label
     * itself is coarse. */
    const [nowMs, setNowMs] = useState(() => Date.now())
    useEffect(() => {
        const timer = window.setInterval(() => {
            if (document.hidden) return
            setNowMs(Date.now())
        }, 30_000)
        return () => window.clearInterval(timer)
    }, [])
    const jumpCycleRef = useRef<Record<string, number>>({})
    const fittedFingerprintRef = useRef('')

    const composition = useMemo(() => buildCanvasComposition(dag, fused), [dag, fused])

    /**
     * Per-graph time labels. The rail they used to annotate is gone (B-plan);
     * they now label a COLLAPSED graph's chip, which is the only place a graph
     * still needs a moment of its own. Locale-aware — never a hardcoded pattern.
     */
    const timelineLabels = useMemo(() => {
        const map = new Map<string, { dateLabel: string; timeLabel: string }>()
        for (const entry of buildBlueprintGraphTimeline(graphs ?? [])) {
            if (!entry.timestamp) continue
            const at = new Date(entry.timestamp)
            map.set(entry.graphId, {
                dateLabel: entry.showDate ? at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '',
                timeLabel: at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
            })
        }
        return map
    }, [graphs])

    useEffect(() => {
        let cancelled = false
        if (dag.nodes.length === 0 && fused.gates.length === 0 && fused.planned.length === 0 && collapsedGraphs.length === 0) {
            setPositions(null)
            return
        }
        void layoutTaskDag(dag, fused, composition, collapsedGraphs)
            .then(next => {
                if (cancelled) return
                setPositions(next.positions)
            })
            .catch(() => {
                if (cancelled) return
                setPositions(null)
            })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dagFingerprint])

    const flowNodes = useMemo<TaskFlowNode[]>(() => {
        if (!positions) return []
        return dag.nodes
            .filter(node => positions.has(node.id))
            .map(node => ({
                id: node.id,
                type: 'taskNode' as const,
                position: positions.get(node.id)!,
                data: {
                    dagNode: node,
                    theme: meshTheme,
                    nowMs,
                    selected: selectedTaskId === node.id || focusTaskId === node.id,
                    ...(() => {
                        const predicted = resolveTaskPredictedSlot(node.task, predictedSlots, pinnedSlots)
                        return predicted ? { predictedSlot: predicted.label, predictedSlotPinned: predicted.pinned } : {}
                    })(),
                    ...(node.task.missionId && missionTitles?.[node.task.missionId] ? { missionTitle: missionTitles[node.task.missionId] } : {}),
                    ...(hoveredMissionId && node.task.missionId === hoveredMissionId ? { missionHighlighted: true } : {}),
                    ...(onMissionOpen ? { onMissionOpen } : {}),
                },
                draggable: false,
                selectable: true,
            }))
    }, [dag, meshTheme, nowMs, positions, selectedTaskId, focusTaskId, predictedSlots, pinnedSlots, missionTitles, hoveredMissionId, onMissionOpen])

    const overlayFlowNodes = useMemo<Node[]>(() => {
        if (!positions) return []
        const sizeOf = (id: string): { w: number; h: number } => {
            if (id.startsWith('gate:')) {
                const gate = fused.gates.find(candidate => candidate.id === id)
                return { w: gateNodeWidth(gate?.state ?? 'declared'), h: gateNodeHeight(gate?.state ?? 'declared') }
            }
            if (id.startsWith('plan:')) return { w: PLAN_NODE_WIDTH, h: PLAN_NODE_HEIGHT }
            const node = dag.nodes.find(candidate => candidate.id === id)
            return { w: TASK_CARD_WIDTH, h: node ? estimateTaskCardHeight(node) : TASK_CARD_MIN_HEIGHT }
        }
        const hulls = fused.clusters.flatMap(cluster => {
            const members = cluster.memberIds.filter(id => positions.has(id))
            if (members.length === 0) return []
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
            for (const id of members) {
                const position = positions.get(id)!
                const size = sizeOf(id)
                minX = Math.min(minX, position.x)
                minY = Math.min(minY, position.y)
                maxX = Math.max(maxX, position.x + size.w)
                maxY = Math.max(maxY, position.y + size.h)
            }
            return [{
                id: cluster.id,
                type: 'clusterHull' as const,
                position: { x: minX - HULL_PADDING, y: minY - HULL_PADDING - HULL_LABEL_CLEARANCE },
                data: {
                    label: cluster.batchId || cluster.graphId.slice(0, 8),
                    status: cluster.status,
                    width: (maxX - minX) + HULL_PADDING * 2,
                    height: (maxY - minY) + HULL_PADDING * 2 + HULL_LABEL_CLEARANCE,
                    theme: meshTheme,
                },
                draggable: false,
                selectable: false,
                zIndex: -1,
                // The WRAPPER must be pointer-transparent too: the inner div's
                // pointer-events-none doesn't cover it, and an interactive hull
                // wrapper swallows card hovers across the whole graph area.
                style: { pointerEvents: 'none' as const },
            }]
        })
        return [
            ...hulls,
            ...fused.gates
                .filter(gate => positions.has(gate.id))
                .map(gate => ({
                    id: gate.id,
                    type: 'gateNode' as const,
                    position: positions.get(gate.id)!,
                    data: { overlay: gate, theme: meshTheme },
                    draggable: false,
                    selectable: true,
                })),
            ...fused.planned
                .filter(plan => positions.has(plan.id))
                .map(plan => ({
                    id: plan.id,
                    type: 'planNode' as const,
                    position: positions.get(plan.id)!,
                    data: { overlay: plan, theme: meshTheme },
                    draggable: false,
                    selectable: false,
                })),
            ...collapsedGraphs
                .filter(summary => positions.has(`graph:${summary.graphId}`))
                .map(summary => ({
                    id: `graph:${summary.graphId}`,
                    type: 'collapsedGraph' as const,
                    position: positions.get(`graph:${summary.graphId}`)!,
                    data: {
                        summary,
                        timeLabel: timelineLabels.get(summary.graphId)?.timeLabel ?? '',
                        theme: meshTheme,
                        onToggle: toggleGraphExpanded,
                    },
                    draggable: false,
                    selectable: false,
                })),
        ]
    }, [fused, meshTheme, positions, collapsedGraphs, timelineLabels, toggleGraphExpanded])

    const flowEdges = useMemo<Edge[]>(() => {
        if (!positions) return []
        const taskEdges = dag.edges.map(edge => {
            const palette = EDGE_COLORS[edge.state]
            const stroke = meshTheme.isDark ? palette.dark : palette.light
            return {
                id: edge.id,
                source: edge.source,
                target: edge.target,
                type: 'smoothstep' as const,
                animated: palette.animated,
                style: { stroke, strokeWidth: 1.6, ...(palette.dash ? { strokeDasharray: palette.dash } : {}) },
                markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
            }
        })
        const graphEdges = fused.edges.map(edge => {
            const stroke = edge.state === 'inactive' || edge.state === 'idle'
                ? (meshTheme.isDark ? '#475569' : '#94a3b8')
                : (meshTheme.isDark ? EDGE_COLORS[edge.state].dark : EDGE_COLORS[edge.state].light)
            return {
                id: edge.id,
                source: edge.source,
                target: edge.target,
                type: 'smoothstep' as const,
                animated: edge.state === 'waiting',
                style: {
                    stroke,
                    strokeWidth: 1.6,
                    ...(edge.state === 'inactive'
                        ? { strokeDasharray: '2 5', opacity: 0.5 }
                        : edge.state === 'waiting' ? { strokeDasharray: '6 4' } : {}),
                },
                markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
                /* Edge kind label. It used to render at 9px — smaller than any
                 * other text on the canvas and effectively unreadable, which
                 * matters most for exactly the edge it labels: a `conditional`
                 * edge is the visible half of a `run_if`, i.e. the answer to
                 * "why did this branch not run?". Bumped to 10px with a
                 * background chip so it survives crossing a card or a hull. */
                /* Prefer the PREDICATE over the category word. "조건부" alone
                 * told the reader a branch was conditional but not on what,
                 * which reads as an unexplained label sitting mid-canvas;
                 * `review.outcome == "rejected"` answers the actual question. */
                ...(edge.kind || edge.condition ? {
                    label: edge.condition
                        ? `if ${edge.condition}`
                        : edge.kind === 'conditional' ? t('meshGraph.taskDag.edge.conditional') : edge.kind,
                    labelStyle: { fontSize: 10, fontWeight: 600, fill: meshTheme.edgeLabelTextColor },
                    labelBgStyle: { fill: meshTheme.edgeLabelBackgroundColor },
                    labelBgPadding: [4, 2] as [number, number],
                    labelBgBorderRadius: 4,
                } : {}),
            }
        })
        // Mission threads (owner ask 2026-08-25): a dotted line chaining
        // same-mission cards in time order. Purely decorative — never fed to
        // ELK, no arrowheads, no animation, indigo echoing the mission chip.
        const missionThreads: Edge[] = (() => {
            const byMission = new Map<string, TaskDagNode[]>()
            for (const node of dag.nodes) {
                const missionId = typeof node.task.missionId === 'string' && node.task.missionId ? node.task.missionId : ''
                if (!missionId) continue
                const bucket = byMission.get(missionId) ?? []
                bucket.push(node)
                byMission.set(missionId, bucket)
            }
            // Owner-tuned through three rounds (2026-08-25): always-on threads
            // were clutter, faint ones invisible, straight ones sliced across
            // card bodies. Final shape — NO resting lines at all; hovering a
            // mission's card draws that mission's thread as smoothstep wiring
            // (routes around cards like every other edge) and rings its cards.
            if (!hoveredMissionId) return []
            const nodes = byMission.get(hoveredMissionId) ?? []
            if (nodes.length < 2) return []
            const stroke = meshTheme.isDark ? 'rgba(139, 148, 255, 0.85)' : 'rgba(88, 92, 235, 0.8)'
            const threads: Edge[] = []
            const ordered = [...nodes].sort((a, b) => taskTimeKey(a).localeCompare(taskTimeKey(b)))
            for (let i = 0; i < ordered.length - 1; i += 1) {
                threads.push({
                    id: `mt:${hoveredMissionId}:${i}`,
                    source: ordered[i].id,
                    target: ordered[i + 1].id,
                    type: 'smoothstep' as const,
                    animated: false,
                    selectable: false,
                    focusable: false,
                    zIndex: 0,
                    // Fully pointer-transparent: an edge's invisible ~20px
                    // interaction path would otherwise steal the pointer from
                    // the hovered card, ending the hover that drew the thread —
                    // an appear/disappear flicker loop.
                    interactionWidth: 0,
                    style: { stroke, strokeWidth: 2, strokeDasharray: '6 6', pointerEvents: 'none' as const },
                })
            }
            return threads
        })()
        return [...missionThreads, ...taskEdges, ...graphEdges]
    }, [dag, fused, hoveredMissionId, meshTheme, positions])

    const selectedNode = selectedTaskId ? dag.nodes.find(node => node.id === selectedTaskId) ?? null : null

    // Non-terminal tasks are what the blueprint is FOR — when any exist, the
    // initial viewport frames them instead of the whole history sprawl. Runs
    // once per layout identity so it never fights the user's panning.
    const liveTaskIds = useMemo(
        () => [
            ...dag.nodes.filter(node => !['completed', 'failed', 'cancelled'].includes(node.task.status)).map(node => node.id),
            // Gates awaiting a human are exactly what the blueprint exists to
            // surface — keep them inside the initial frame.
            ...fused.gates.filter(gate => gate.state === 'awaiting_coordinator' || gate.state === 'claimed').map(gate => gate.id),
        ],
        [dag, fused],
    )
    useEffect(() => {
        if (!flowInstance || !positions) return
        if (fittedFingerprintRef.current === dagFingerprint) return
        fittedFingerprintRef.current = dagFingerprint
        /* The ONLY framing authority now that the built-in fitView is gone.
         * It frames the LIVE work — in-flight tasks plus gates awaiting a
         * human — instead of the whole archive, which is what kept the old
         * canvas at ~0.2 zoom.
         *
         * `minZoom` is deliberately NOT clamped to the readable floor here.
         * A floor does not make a short canvas taller; it just makes fitView
         * give up and leave the targets outside the clip box — measured on a
         * 320px-tall dialog, the awaiting gate landed exactly on the bottom
         * edge at scale 1, i.e. the one node this frame exists to show was
         * off screen. Showing the target slightly small beats not showing it,
         * so the floor stays on AUTO-framing of a roomy canvas only (maxZoom
         * caps the other direction) and the canvas keeps its own hand-zoom
         * floor for the user. */
        const frame = liveTaskIds.length > 0 ? { nodes: liveTaskIds.map(id => ({ id })) } : {}
        void flowInstance.fitView({ ...frame, padding: 0.2, maxZoom: 1, minZoom: CANVAS_MIN_ZOOM })
    }, [dagFingerprint, flowInstance, liveTaskIds, positions])

    /** Stat-chip jump: cycle through the tasks in that bucket, centering each. */
    const jumpToState = useCallback((bucket: 'pending' | 'assigned' | 'waiting' | 'blocked') => {
        const instance = flowInstance
        if (!instance || !positions) return
        const ids = dag.nodes.filter(node => {
            switch (bucket) {
                case 'waiting': return node.waitingOn.length > 0
                case 'blocked': return node.blocked
                default: return node.task.status === bucket
            }
        }).map(node => node.id)
        if (ids.length === 0) return
        const index = ((jumpCycleRef.current[bucket] ?? -1) + 1) % ids.length
        jumpCycleRef.current[bucket] = index
        const id = ids[index]
        const position = positions.get(id)
        const node = dag.nodes.find(candidate => candidate.id === id)
        if (!position || !node) return
        setFocusTaskId(id)
        void instance.setCenter(
            position.x + TASK_CARD_WIDTH / 2,
            position.y + estimateTaskCardHeight(node) / 2,
            { zoom: Math.max(instance.getZoom(), 0.85), duration: 350 },
        )
    }, [dag, flowInstance, positions])

    // Mission modal's "show on canvas": light the thread (it uses the same
    // hovered-mission state, so the next real hover naturally takes over) and
    // frame the mission's cards.
    useEffect(() => {
        if (!focusMission || !flowInstance || !positions) return
        setHoveredMissionId(focusMission.missionId)
        const ids = dag.nodes.filter(node => node.task.missionId === focusMission.missionId).map(node => node.id)
        if (ids.length > 0) void flowInstance.fitView({ nodes: ids.map(id => ({ id })), padding: 0.25, maxZoom: 1, duration: 350 })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusMission?.token])

    // The un-hover is DELAYED: crossing the gap between two cards of the same
    // mission must not blink the thread off and on (owner: flicker, 2026-08-25).
    // The card highlight is an outline, not a ring — ring is box-shadow, which
    // the card transitions, so it faded in/out on every hover change (flicker).
    const hoverClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (hoverClearTimer.current) clearTimeout(hoverClearTimer.current) }, [])
    const handleNodeHover = useCallback((_event: unknown, node: TaskFlowNode) => {
        // Entering a NON-task node (gate, ghost) must not snuff the thread
        // instantly — treat it like leaving, so the delayed clear decides.
        if (node.type !== 'taskNode') return
        if (hoverClearTimer.current) { clearTimeout(hoverClearTimer.current); hoverClearTimer.current = null }
        const missionId = node.data.dagNode.task.missionId
        setHoveredMissionId(typeof missionId === 'string' && missionId ? missionId : null)
    }, [])
    const handleNodeHoverEnd = useCallback(() => {
        if (hoverClearTimer.current) clearTimeout(hoverClearTimer.current)
        hoverClearTimer.current = setTimeout(() => { setHoveredMissionId(null) }, 300)
    }, [])

    const handleNodeClick = useCallback((_event: unknown, node: TaskFlowNode) => {
        if (node.type === 'gateNode') {
            const overlay = (node.data as unknown as { overlay: FusedOverlays['gates'][number] }).overlay
            onGateOpen?.(overlay.graph, overlay.nodeId, overlay.gate)
            return
        }
        if (node.type !== 'taskNode') return
        if (onTaskOpen) {
            onTaskOpen(node.data.dagNode.task)
            return
        }
        setSelectedTaskId(current => (current === node.id ? null : node.id))
    }, [onGateOpen, onTaskOpen])

    if (dag.nodes.length === 0 && fused.gates.length === 0 && fused.planned.length === 0) {
        return (
            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-slate-400">
                {emptyMessage ?? t('meshGraph.taskDag.empty')}
            </div>
        )
    }

    const statBadge = (label: string, tone: 'default' | 'warn' | 'danger' | 'info' = 'default', onJump?: () => void) => {
        const toneClass = tone === 'warn'
            ? (meshTheme.isDark ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700')
            : tone === 'danger'
                ? (meshTheme.isDark ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700')
                : tone === 'info'
                    ? (meshTheme.isDark ? 'border-sky-400/25 bg-sky-500/10 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700')
                    : (meshTheme.isDark ? 'border-white/10 bg-white/[0.05] text-slate-300' : 'border-slate-200 bg-white/85 text-slate-600')
        if (!onJump) return <span className={`rounded-full border px-2 py-0.5 text-3xs ${toneClass}`}>{label}</span>
        // State chips double as navigation: each click centers the next card in
        // that bucket, so "1 blocked" is an entry point, not just a count.
        return (
            <button type="button" onClick={onJump} title={t('meshGraph.taskDag.jumpToState')}
                className={`rounded-full border px-2 py-0.5 text-3xs transition-transform hover:scale-105 ${toneClass}`}>
                {label}
            </button>
        )
    }

    /* Root box. No height floor here (2026-09-02): `h-full` already takes the
     * whole parent, and a 320px floor on top of it made this element taller
     * than a padded parent that was itself only 320px — the ancestor's
     * `overflow-hidden` then turned the excess into a hard bottom cut through
     * the graph rather than a scroll. The floor belongs to whoever owns the
     * dialog's layout, not to the canvas that fills it. */
    return (
        <div className="flex h-full w-full min-h-0 flex-col">
            {/* Stats row — in normal flow ABOVE the canvas so it never covers cards. */}
            {/* Stats row — deliberately terse: total, live states worth acting
                on (pending/assigned/waiting/blocked), and ONE combined chip for
                hidden history that is itself the load-more action. */}
            {!compact && (() => {
                const statsRow = <div className={statsContainer ? 'flex min-w-0 items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'flex flex-wrap items-center gap-1.5 px-1 pb-1'}>
                {statBadge(t('meshGraph.taskDag.statsTasks', { count: dag.stats.total }))}
                {dag.stats.pending > 0 && statBadge(t('meshGraph.taskDag.statsPending', { count: dag.stats.pending }), 'default', () => jumpToState('pending'))}
                {dag.stats.assigned > 0 && statBadge(t('meshGraph.taskDag.statsAssigned', { count: dag.stats.assigned }), 'info', () => jumpToState('assigned'))}
                {dag.stats.waiting > 0 && statBadge(t('meshGraph.taskDag.statsWaiting', { count: dag.stats.waiting }), 'warn', () => jumpToState('waiting'))}
                {dag.stats.blocked > 0 && statBadge(t('meshGraph.taskDag.statsBlocked', { count: dag.stats.blocked }), 'danger', () => jumpToState('blocked'))}
                {scoped.hiddenCount > 0 && (
                    <button
                        type="button"
                        onClick={() => setTerminalLimit(limit => limit + TASK_DAG_LOAD_MORE_STEP)}
                        title={t('meshGraph.taskDag.hiddenTasks', { count: scoped.hiddenCount })}
                        className={`rounded-full border px-2 py-0.5 text-3xs font-medium transition-colors ${meshTheme.isDark
                            ? 'border-sky-400/25 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                            : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
                    >
                        {t('meshGraph.taskDag.hiddenLoadMore', { count: scoped.hiddenCount })}
                    </button>
                )}
            </div>
                return statsContainer ? createPortal(statsRow, statsContainer) : statsRow
            })()}
            <div className="relative min-h-0 flex-1">
            <ReactFlow
                className="h-full w-full"
                nodes={[...flowNodes, ...overlayFlowNodes] as TaskFlowNode[]}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onInit={setFlowInstance}
                onNodeClick={handleNodeClick}
                onNodeMouseEnter={handleNodeHover}
                onNodeMouseLeave={handleNodeHoverEnd}
                onPaneClick={() => { setSelectedTaskId(null); setFocusTaskId(null) }}
                // NO built-in fitView (owner call 2026-09-02): it framed EVERY
                // node — 20 settled graphs included — so the canvas opened at
                // ~0.2 zoom and every card was an unreadable rectangle. The
                // live-work fit effect is now the only framing authority.
                minZoom={CANVAS_MIN_ZOOM}
                maxZoom={1.35}
                nodesConnectable={false}
                nodesDraggable={false}
                // Interaction contract mirrors the topology tab (MeshGraphView):
                // wheel/trackpad pans, pinch zooms, wheel-zoom and double-click
                // zoom stay off, drag pans — one mouse vocabulary across tabs.
                panOnDrag
                panOnScroll
                zoomOnScroll={false}
                zoomOnPinch
                zoomOnDoubleClick={false}
                selectionOnDrag={false}
                proOptions={{ hideAttribution: true }}
                colorMode={meshTheme.isDark ? 'dark' : 'light'}
            >
                {/* No background pattern: the drafting-shell surface alone carries the
                    blueprint identity (owner call 2026-08-25 — no grid, no dots). */}
                <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>


            {/* Edge-state legend */}
            <div className={`pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-3xs ${meshTheme.isDark ? 'border-white/10 bg-slate-950/80 text-slate-300' : 'border-slate-200 bg-white/90 text-slate-600'}`}>
                {(['satisfied', 'waiting', 'failed'] as const).map(state => (
                    <span key={state} className="flex items-center gap-1">
                        <span
                            className="inline-block h-0.5 w-4 rounded"
                            style={{ backgroundColor: meshTheme.isDark ? EDGE_COLORS[state].dark : EDGE_COLORS[state].light }}
                            aria-hidden
                        />
                        {t(`meshGraph.taskDag.legend.${state}`)}
                    </span>
                ))}
            </div>

            {/* Selected task detail */}
            {selectedNode && (
                <div className={`absolute right-3 top-3 z-20 w-72 max-w-[calc(100%-24px)] overflow-y-auto rounded-2xl border p-3.5 shadow-xl backdrop-blur ${meshTheme.isDark ? 'border-white/10 bg-slate-950/95 text-slate-200' : 'border-slate-200 bg-white/95 text-slate-700'}`} style={{ maxHeight: 'calc(100% - 24px)' }}>
                    <div className="mb-2 flex items-start justify-between gap-2">
                        <span className={`text-3xs font-semibold uppercase tracking-wide ${meshTheme.isDark ? 'text-slate-400' : 'text-slate-400'}`}>{t('meshGraph.taskDag.selectedTask')}</span>
                        <button
                            type="button"
                            onClick={() => setSelectedTaskId(null)}
                            aria-label="Close task detail"
                            className={meshTheme.isDark ? 'rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs text-slate-200 hover:bg-white/[0.08]' : 'rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50'}
                        >
                            ✕
                        </button>
                    </div>
                    <div className="mb-2 font-mono text-3xs opacity-70" title={selectedNode.task.id}>{selectedNode.task.id.slice(0, 8)}</div>
                    <div className="mb-2 whitespace-pre-wrap text-2xs leading-4">{queueTaskDisplayText(selectedNode.task.message)}</div>
                    <div className="flex flex-wrap gap-1.5 text-3xs">
                        {statBadge(selectedNode.task.status, selectedNode.task.status === 'failed' ? 'danger' : selectedNode.task.status === 'assigned' ? 'info' : 'default')}
                        {selectedNode.task.difficulty && statBadge(selectedNode.task.difficulty)}
                        {selectedNode.task.missionId && statBadge(selectedNode.task.missionId, 'info')}
                        {selectedNode.task.assignedNodeId && statBadge(`@ ${selectedNode.task.assignedNodeId.slice(0, 14)}`)}
                    </div>
                    {selectedNode.waitingOn.length > 0 && (
                        <div className="mt-2 text-3xs">
                            <span className="font-semibold">{t('meshGraph.taskDag.waitsOn', { count: selectedNode.waitingOn.length })}:</span>
                            <span className="ml-1 font-mono opacity-80">{selectedNode.waitingOn.map(id => id.slice(0, 8)).join(', ')}</span>
                        </div>
                    )}
                    {selectedNode.task.blockedReason && (
                        <div className={`mt-2 rounded-lg border px-2 py-1.5 text-3xs ${meshTheme.isDark ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
                            {selectedNode.task.blockedReason}
                        </div>
                    )}
                </div>
            )}
            </div>
        </div>
    )
}
