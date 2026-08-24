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
import { buildNodeIdByEndpoint, buildStateByNodeId, deriveBlueprintEdgeState } from './blueprintViewModel'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import { buildTaskDag, scopeTaskDagTasks, TASK_DAG_LOAD_MORE_STEP, TASK_DAG_RECENT_TERMINAL_LIMIT, type TaskDagData, type TaskDagEdgeState, type TaskDagNode } from './taskDagViewModel'
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
     */
    predictedSlots?: Record<string, string>
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
    missionTitle?: string
}

type TaskFlowNode = Node<TaskFlowNodeData, 'taskNode'>

/** Estimate the rendered card height so ELK sees roughly what humans see. */
function estimateTaskCardHeight(node: TaskDagNode): number {
    const messageLength = (node.task.message ?? '').length
    const messageLines = Math.max(1, Math.min(3, Math.ceil(messageLength / 34)))
    const extraBadgeRow = node.waitingOn.length > 0 || node.blocked || node.missingDeps.length > 0 ? 22 : 0
    return TASK_CARD_MIN_HEIGHT + (messageLines - 1) * 15 + extraBadgeRow
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
    const { dagNode, theme, selected, predictedSlot, missionTitle } = data
    const task = dagNode.task
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
            className={`rounded-2xl border px-3 py-2.5 shadow-sm transition-[opacity,box-shadow] ${statusClass} ${selected ? (theme.isDark ? 'ring-2 ring-cyan-300/60' : 'ring-2 ring-sky-400/70') : ''} ${receded ? 'opacity-60 hover:opacity-100' : ''}`}
            style={{ width: TASK_CARD_WIDTH }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'animate-pulse' : ''}`} aria-hidden />
                    <span className="truncate text-3xs font-semibold uppercase tracking-wide opacity-80">{task.status}</span>
                </span>
                <span className={`shrink-0 font-mono text-4xs ${theme.isDark ? 'text-slate-400' : 'text-slate-400'}`} title={task.id}>{task.id.slice(0, 8)}</span>
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
                        className={theme.isDark
                            ? 'rounded-full border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-px text-4xs text-emerald-200'
                            : 'rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-4xs text-emerald-700'}
                        title={t('meshGraph.taskDag.predictedSlot')}
                    >
                        → {predictedSlot}
                    </span>
                )}
                {task.priority && task.priority !== 'normal' && <span className={chipClass}>{task.priority}</span>}
                {(task.taskMode === 'live_debug_readonly' || task.readonly) && <span className={chipClass}>read-only</span>}
                {task.missionId && (
                    <span
                        className={`${chipClass} inline-flex max-w-[150px] items-center gap-1`}
                        title={missionTitle ? `${missionTitle} (${task.missionId})` : task.missionId}
                    >
                        <IconFlag size={8} />
                        <span className="truncate">{missionTitle || task.missionId.slice(0, 10)}</span>
                    </span>
                )}
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
const GATE_NODE_HEIGHT = 64
const PLAN_NODE_WIDTH = 208
const PLAN_NODE_HEIGHT = 58

interface FusedOverlays {
    gates: Array<{ id: string; graph: MeshGraphView; nodeId: string; gate?: MeshGraphGateView; ref: string; state: string }>
    planned: Array<{ id: string; ref: string; state: string }>
    edges: Array<{ id: string; source: string; target: string; state: import('./blueprintViewModel').BlueprintEdgeState; kind?: string }>
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
            overlays.planned.push({ id, ref: node.ref || node.nodeId.slice(0, 8), state: node.state })
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
    const { overlay, theme } = data
    const style = GATE_STATE_STYLES[overlay.state] ?? GATE_STATE_STYLES.declared
    return (
        <div
            className={`rounded-xl border border-dashed px-3 py-2 shadow-sm ${theme.isDark ? style.dark : style.light}`}
            style={{ width: GATE_NODE_WIDTH, minHeight: GATE_NODE_HEIGHT }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'animate-pulse' : ''}`} aria-hidden />
                <span className="truncate text-3xs font-semibold uppercase tracking-wide opacity-85">⛩ {overlay.gate?.action ?? 'gate'}</span>
            </div>
            <div className="mt-1 truncate text-2xs font-medium" title={overlay.ref}>{overlay.ref}</div>
            <div className="mt-0.5 text-4xs opacity-70">{overlay.state}{overlay.gate?.leaseExpired ? ' · lease expired' : ''}</div>
        </div>
    )
}

type PlanFlowNode = Node<Record<string, unknown> & { overlay: FusedOverlays['planned'][number]; theme: MeshGraphTheme }, 'planNode'>

function PlanNodeCard({ data }: NodeProps<PlanFlowNode>) {
    const { overlay, theme } = data
    const settled = overlay.state === 'completed' || overlay.state === 'skipped' || overlay.state === 'cancelled'
    return (
        <div
            className={`rounded-xl border border-dashed px-3 py-2 ${settled ? 'opacity-50' : ''} ${theme.isDark ? 'border-slate-400/30 bg-white/[0.02] text-slate-300' : 'border-slate-300 bg-white/70 text-slate-600'}`}
            style={{ width: PLAN_NODE_WIDTH, minHeight: PLAN_NODE_HEIGHT }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <div className="truncate text-3xs font-semibold uppercase tracking-wide opacity-70">{overlay.state}</div>
            <div className="mt-1 truncate text-2xs font-medium" title={overlay.ref}>{overlay.ref}</div>
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

const nodeTypes: NodeTypes = { taskNode: TaskNodeCard, gateNode: GateNodeCard, planNode: PlanNodeCard, clusterHull: ClusterHullNode }

const UNLINKED_STACK_GAP_X = 170
const UNLINKED_STACK_GAP_Y = 24

/**
 * Two-phase layout. ELK only sees the CONNECTED material — tasks touching any
 * edge, plus every graph member (gates, ghosts, fused cards). Tasks with no
 * edges and no graph membership used to be scattered by ELK as arbitrary
 * disconnected components mixed into the chains; they now stack in ONE
 * vertical column to the right of the chains, newest first (owner call
 * 2026-08-25: time order beats a separate zone), so the loose queue reads as
 * a timeline next to the plans instead of noise inside them.
 */
/** How the canvas partitions: chains (ELK material) vs the loose stack, with
 *  the loose stack's mission groupings — computed once so the layout and the
 *  hull renderer agree on membership. */
interface CanvasComposition {
    connectedTasks: TaskDagNode[]
    /** Loose-stack units, newest activity first. A mission unit groups every
     *  loose task of that mission (hulled); singles are mission-less tasks. */
    stackUnits: Array<{ kind: 'mission'; missionId: string; nodes: TaskDagNode[] } | { kind: 'single'; node: TaskDagNode }>
    missionClusters: Array<{ id: string; missionId: string; memberIds: string[] }>
}

function taskTimeKey(node: TaskDagNode): string {
    return String(node.task.updatedAt || node.task.createdAt || '')
}

function buildCanvasComposition(dag: TaskDagData, overlays: FusedOverlays): CanvasComposition {
    const clusterMemberIds = new Set(overlays.clusters.flatMap(cluster => cluster.memberIds))
    const edgeTouchedIds = new Set<string>()
    for (const edge of dag.edges) { edgeTouchedIds.add(edge.source); edgeTouchedIds.add(edge.target) }
    for (const edge of overlays.edges) { edgeTouchedIds.add(edge.source); edgeTouchedIds.add(edge.target) }
    const isConnected = (id: string) => edgeTouchedIds.has(id) || clusterMemberIds.has(id)
    const connectedTasks = dag.nodes.filter(node => isConnected(node.id))
    const unlinkedTasks = dag.nodes.filter(node => !isConnected(node.id))

    // Missions are the second grouping axis (owner catch 2026-08-25: graphs
    // were the only hulls, so same-mission loose tasks scattered through the
    // time stack). Loose tasks sharing a missionId form one contiguous,
    // hulled unit; mission-less tasks stay singles. Units order by their
    // newest member so the stack stays a timeline.
    const byMission = new Map<string, TaskDagNode[]>()
    const singles: TaskDagNode[] = []
    for (const node of unlinkedTasks) {
        const missionId = typeof node.task.missionId === 'string' && node.task.missionId ? node.task.missionId : ''
        if (!missionId) { singles.push(node); continue }
        const bucket = byMission.get(missionId) ?? []
        bucket.push(node)
        byMission.set(missionId, bucket)
    }
    const stackUnits: CanvasComposition['stackUnits'] = [
        ...[...byMission.entries()].map(([missionId, nodes]) => ({
            kind: 'mission' as const,
            missionId,
            nodes: [...nodes].sort((a, b) => taskTimeKey(b).localeCompare(taskTimeKey(a))),
        })),
        ...singles.map(node => ({ kind: 'single' as const, node })),
    ].sort((a, b) => {
        const newest = (unit: CanvasComposition['stackUnits'][number]) =>
            unit.kind === 'mission' ? taskTimeKey(unit.nodes[0]) : taskTimeKey(unit.node)
        return newest(b).localeCompare(newest(a))
    })
    const missionClusters = stackUnits.flatMap(unit => unit.kind === 'mission' && unit.nodes.length > 1
        ? [{ id: `mission:${unit.missionId}`, missionId: unit.missionId, memberIds: unit.nodes.map(n => n.id) }]
        : [])
    return { connectedTasks, stackUnits, missionClusters }
}

/** Extra vertical room before a hulled mission unit so its label clears the
 *  previous unit. */
const MISSION_UNIT_CLEARANCE = 44

async function layoutTaskDag(dag: TaskDagData, overlays: FusedOverlays, composition: CanvasComposition): Promise<Map<string, { x: number; y: number }>> {
    const { connectedTasks, stackUnits } = composition
    const positions = new Map<string, { x: number; y: number }>()
    let chainsMaxX = 0
    if (connectedTasks.length > 0 || overlays.gates.length > 0 || overlays.planned.length > 0) {
        const elkPositions = await layoutConnectedElements(connectedTasks, dag.edges, overlays)
        for (const [id, position] of elkPositions) {
            positions.set(id, position)
            const width = id.startsWith('gate:') ? GATE_NODE_WIDTH : id.startsWith('plan:') ? PLAN_NODE_WIDTH : TASK_CARD_WIDTH
            chainsMaxX = Math.max(chainsMaxX, position.x + width)
        }
    }
    if (stackUnits.length > 0) {
        const stackX = chainsMaxX > 0 ? chainsMaxX + UNLINKED_STACK_GAP_X : 0
        let y = 0
        for (const unit of stackUnits) {
            if (unit.kind === 'mission') {
                if (unit.nodes.length > 1) y += MISSION_UNIT_CLEARANCE
                for (const node of unit.nodes) {
                    positions.set(node.id, { x: stackX, y })
                    y += estimateTaskCardHeight(node) + UNLINKED_STACK_GAP_Y
                }
                if (unit.nodes.length > 1) y += UNLINKED_STACK_GAP_Y
            } else {
                positions.set(unit.node.id, { x: stackX, y })
                y += estimateTaskCardHeight(unit.node) + UNLINKED_STACK_GAP_Y
            }
        }
    }
    return positions
}

async function layoutConnectedElements(connectedTasks: TaskDagNode[], taskEdges: TaskDagData['edges'], overlays: FusedOverlays): Promise<Map<string, { x: number; y: number }>> {
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
            ...connectedTasks.map(node => ({
                id: node.id,
                width: TASK_CARD_WIDTH,
                height: estimateTaskCardHeight(node),
            })),
            ...overlays.gates.map(gate => ({ id: gate.id, width: GATE_NODE_WIDTH, height: GATE_NODE_HEIGHT })),
            ...overlays.planned.map(plan => ({ id: plan.id, width: PLAN_NODE_WIDTH, height: PLAN_NODE_HEIGHT })),
        ],
        edges: [
            // Task dependsOn edges: both endpoints are edge-touched, hence in
            // connectedTasks by construction.
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

export default function MeshTaskDagView({ tasks, emptyMessage, compact = false, predictedSlots, initialTerminalLimit, onTaskOpen, statsContainer, graphs, onGateOpen, missionTitles }: MeshTaskDagViewProps) {
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
    const fused = useMemo(() => {
        const visible = new Set(dag.nodes.map(node => node.id))
        return buildFusedOverlays(graphs ?? [], visible)
    }, [graphs, dag])
    const dagFingerprint = useMemo(
        () => dag.nodes.map(node => `${node.id}:${node.task.status}:${node.dependsOn.join('+')}:${node.waitingOn.length}:${node.blocked ? 1 : 0}`).join('|')
            + '||' + fused.gates.map(gate => `${gate.id}:${gate.state}`).join('|')
            + '||' + fused.planned.map(plan => `${plan.id}:${plan.state}`).join('|')
            + '||' + fused.edges.map(edge => `${edge.id}:${edge.state}`).join('|'),
        [dag, fused],
    )
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
    // Focus highlight driven by the stat-chip jump — separate from selection so
    // jumping never opens the detail surface, it only rings + centers the card.
    const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
    /** Mission whose thread is lit up because the pointer rests on one of its cards. */
    const [hoveredMissionId, setHoveredMissionId] = useState<string | null>(null)
    const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null)
    // State (not a ref) so the live-fit effect reruns once the canvas mounts.
    const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<TaskFlowNode, Edge> | null>(null)
    const jumpCycleRef = useRef<Record<string, number>>({})
    const fittedFingerprintRef = useRef('')

    const composition = useMemo(() => buildCanvasComposition(dag, fused), [dag, fused])

    useEffect(() => {
        let cancelled = false
        if (dag.nodes.length === 0 && fused.gates.length === 0 && fused.planned.length === 0) {
            setPositions(null)
            return
        }
        void layoutTaskDag(dag, fused, composition)
            .then(next => { if (!cancelled) setPositions(next) })
            .catch(() => { if (!cancelled) setPositions(null) })
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
                    selected: selectedTaskId === node.id || focusTaskId === node.id,
                    ...(predictedSlots ? { predictedSlot: predictedSlots[node.task.difficulty ?? 'medium'] } : {}),
                    ...(node.task.missionId && missionTitles?.[node.task.missionId] ? { missionTitle: missionTitles[node.task.missionId] } : {}),
                },
                draggable: false,
                selectable: true,
            }))
    }, [dag, meshTheme, positions, selectedTaskId, focusTaskId, predictedSlots, missionTitles])

    const overlayFlowNodes = useMemo<Node[]>(() => {
        if (!positions) return []
        const sizeOf = (id: string): { w: number; h: number } => {
            if (id.startsWith('gate:')) return { w: GATE_NODE_WIDTH, h: GATE_NODE_HEIGHT }
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
        ]
    }, [fused, meshTheme, positions])

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
                ...(edge.kind ? { label: edge.kind, labelStyle: { fontSize: 9 } } : {}),
            }
        })
        // Mission threads (owner ask 2026-08-25): a barely-there dotted line
        // chaining same-mission cards in time order, so the mission reads as
        // one thread across chains and the loose stack. Purely decorative —
        // it never feeds ELK, so the layout is untouched; no arrowheads, no
        // animation, indigo echoing the mission flag chip.
        const missionThreads: Edge[] = (() => {
            const byMission = new Map<string, TaskDagNode[]>()
            for (const node of dag.nodes) {
                const missionId = typeof node.task.missionId === 'string' && node.task.missionId ? node.task.missionId : ''
                if (!missionId) continue
                const bucket = byMission.get(missionId) ?? []
                bucket.push(node)
                byMission.set(missionId, bucket)
            }
            // Resting vs lit: always-on threads at full strength made the board
            // read as clutter (owner 2026-08-25), while barely-there ones were
            // invisible. So the thread idles as a whisper and lights up only
            // while the pointer rests on one of the mission's cards.
            const threads: Edge[] = []
            for (const [missionId, nodes] of byMission) {
                if (nodes.length < 2) continue
                const lit = hoveredMissionId === missionId
                const stroke = meshTheme.isDark
                    ? `rgba(139, 148, 255, ${lit ? 0.9 : 0.22})`
                    : `rgba(88, 92, 235, ${lit ? 0.85 : 0.25})`
                const ordered = [...nodes].sort((a, b) => taskTimeKey(a).localeCompare(taskTimeKey(b)))
                for (let i = 0; i < ordered.length - 1; i += 1) {
                    threads.push({
                        id: `mt:${missionId}:${i}`,
                        source: ordered[i].id,
                        target: ordered[i + 1].id,
                        // Straight, not smoothstep: the thread must read as a
                        // loose string laid across the board, visually distinct
                        // from the orthogonal dependency wiring it crosses.
                        type: 'straight' as const,
                        animated: false,
                        selectable: false,
                        focusable: false,
                        zIndex: 0,
                        style: { stroke, strokeWidth: lit ? 2.2 : 1.3, strokeDasharray: '7 7', transition: 'stroke 150ms ease' },
                    })
                }
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
        if (!flowInstance || !positions || liveTaskIds.length === 0) return
        if (fittedFingerprintRef.current === dagFingerprint) return
        fittedFingerprintRef.current = dagFingerprint
        void flowInstance.fitView({ nodes: liveTaskIds.map(id => ({ id })), padding: 0.3, maxZoom: 1 })
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

    const handleNodeHover = useCallback((_event: unknown, node: TaskFlowNode) => {
        const missionId = node.type === 'taskNode' ? node.data.dagNode.task.missionId : undefined
        setHoveredMissionId(typeof missionId === 'string' && missionId ? missionId : null)
    }, [])
    const handleNodeHoverEnd = useCallback(() => { setHoveredMissionId(null) }, [])

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

    return (
        <div className="flex h-full min-h-[320px] w-full flex-col" style={{ minHeight: 320 }}>
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
                fitView
                fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
                minZoom={0.18}
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
