/**
 * MeshTaskDagView — React Flow rendering of the mesh work queue as a dependency
 * DAG (nodes = tasks, edges = dependsOn). The "graph engineering" surface: makes
 * the queue's execution order visible instead of a flat list. Layout is ELK
 * layered (same engine as MeshGraphView), left-to-right so the graph reads as a
 * pipeline: dependencies on the left, dependents on the right.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MarkerType,
    Position,
    ReactFlow,
    type Edge,
    type Node,
    type NodeProps,
    type NodeTypes,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
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
     * Embedded mode (per-mission drill-down inside MeshTasksView): the caller
     * already scoped the task set, so the history cap, stats overlay and
     * load-more chrome are dropped — just the graph + edge legend render.
     */
    compact?: boolean
}

type TaskFlowNodeData = Record<string, unknown> & {
    dagNode: TaskDagNode
    theme: MeshGraphTheme
    selected: boolean
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
    completed: {
        dark: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100',
        light: 'border-emerald-300 bg-emerald-50 text-emerald-800',
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
    const { dagNode, theme, selected } = data
    const task = dagNode.task
    const style = STATUS_STYLES[task.status] ?? STATUS_STYLES.pending
    const statusClass = theme.isDark ? style.dark : style.light
    const chipClass = theme.isDark
        ? 'rounded-full border border-white/10 bg-white/[0.06] px-1.5 py-px text-[9px] text-slate-300'
        : 'rounded-full border border-slate-200 bg-white/80 px-1.5 py-px text-[9px] text-slate-500'
    return (
        <div
            className={`rounded-2xl border px-3 py-2.5 shadow-sm transition-shadow ${statusClass} ${selected ? (theme.isDark ? 'ring-2 ring-cyan-300/60' : 'ring-2 ring-sky-400/70') : ''}`}
            style={{ width: TASK_CARD_WIDTH }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'animate-pulse' : ''}`} aria-hidden />
                    <span className="truncate text-[10px] font-semibold uppercase tracking-wide opacity-80">{task.status}</span>
                </span>
                <span className={`shrink-0 font-mono text-[9px] ${theme.isDark ? 'text-slate-400' : 'text-slate-400'}`} title={task.id}>{task.id.slice(0, 8)}</span>
            </div>
            {/* Markdown-syntax-stripped plain text; a cancelled card mutes rather
                than strikes through — multi-line struck text was unreadable. */}
            <div
                className={`mt-1.5 text-[11px] leading-[15px] ${task.status === 'cancelled' ? 'opacity-60' : ''}`}
                style={messageClampStyle}
                title={queueTaskDisplayText(task.message)}
            >
                {queueTaskDisplayText(task.message)}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {task.difficulty && <span className={chipClass}>{task.difficulty}</span>}
                {task.priority && task.priority !== 'normal' && <span className={chipClass}>{task.priority}</span>}
                {(task.taskMode === 'live_debug_readonly' || task.readonly) && <span className={chipClass}>read-only</span>}
                {task.missionId && (
                    <span className={`${chipClass} inline-flex items-center gap-1`} title={task.missionId}><IconFlag size={8} />{task.missionId.slice(0, 10)}</span>
                )}
                {dagNode.waitingOn.length > 0 && (
                    <span
                        className={theme.isDark
                            ? 'rounded-full border border-amber-400/25 bg-amber-500/10 px-1.5 py-px text-[9px] text-amber-200'
                            : 'rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px text-[9px] text-amber-700'}
                        title={dagNode.waitingOn.join(', ')}
                    >
                        {t('meshGraph.taskDag.waitsOn', { count: dagNode.waitingOn.length })}
                    </span>
                )}
                {dagNode.blocked && (
                    <span
                        className={theme.isDark
                            ? 'rounded-full border border-rose-400/25 bg-rose-500/10 px-1.5 py-px text-[9px] text-rose-200'
                            : 'rounded-full border border-rose-300 bg-rose-50 px-1.5 py-px text-[9px] text-rose-700'}
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

const nodeTypes: NodeTypes = { taskNode: TaskNodeCard }

async function layoutTaskDag(dag: TaskDagData): Promise<Map<string, { x: number; y: number }>> {
    const graph = {
        id: 'task-dag-root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'SPLINES',
            'elk.spacing.nodeNode': '46',
            'elk.layered.spacing.nodeNodeBetweenLayers': '120',
            'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            'elk.layered.cycleBreaking.strategy': 'GREEDY',
            'elk.randomSeed': '1',
        },
        children: dag.nodes.map(node => ({
            id: node.id,
            width: TASK_CARD_WIDTH,
            height: estimateTaskCardHeight(node),
        })),
        edges: dag.edges.map(edge => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
        })),
    }
    const result = await elk.layout(graph)
    const positions = new Map<string, { x: number; y: number }>()
    for (const child of result.children ?? []) {
        positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
    }
    return positions
}

export default function MeshTaskDagView({ tasks, emptyMessage, compact = false }: MeshTaskDagViewProps) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    // Scope the history: active tasks + their dependency ancestry always render;
    // terminal rows are capped and revealed incrementally via "load more". A
    // long-lived mesh accumulates hundreds of terminal rows, and laying ALL of
    // them out took tens of seconds while rendering an unreadable wall.
    // Compact (embedded) mode trusts the caller's scoping and renders everything.
    const [terminalLimit, setTerminalLimit] = useState(TASK_DAG_RECENT_TERMINAL_LIMIT)
    const scoped = useMemo(
        () => scopeTaskDagTasks(tasks, compact ? Number.POSITIVE_INFINITY : terminalLimit),
        [tasks, terminalLimit, compact],
    )
    const dag = useMemo(() => buildTaskDag(scoped.tasks), [scoped.tasks])
    // Layout identity: statuses drive edge state and badge rows (card height), so
    // re-layout when any of them change — not only when the id set changes.
    const dagFingerprint = useMemo(
        () => dag.nodes.map(node => `${node.id}:${node.task.status}:${node.dependsOn.join('+')}:${node.waitingOn.length}:${node.blocked ? 1 : 0}`).join('|'),
        [dag],
    )
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
    const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null)

    useEffect(() => {
        let cancelled = false
        if (dag.nodes.length === 0) {
            setPositions(null)
            return
        }
        void layoutTaskDag(dag)
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
                data: { dagNode: node, theme: meshTheme, selected: selectedTaskId === node.id },
                draggable: false,
                selectable: true,
            }))
    }, [dag, meshTheme, positions, selectedTaskId])

    const flowEdges = useMemo<Edge[]>(() => {
        if (!positions) return []
        return dag.edges.map(edge => {
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
    }, [dag, meshTheme, positions])

    const selectedNode = selectedTaskId ? dag.nodes.find(node => node.id === selectedTaskId) ?? null : null

    const handleNodeClick = useCallback((_event: unknown, node: TaskFlowNode) => {
        setSelectedTaskId(current => (current === node.id ? null : node.id))
    }, [])

    if (dag.nodes.length === 0) {
        return (
            <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm text-slate-400">
                {emptyMessage ?? t('meshGraph.taskDag.empty')}
            </div>
        )
    }

    const statBadge = (label: string, tone: 'default' | 'warn' | 'danger' | 'info' = 'default') => {
        const toneClass = tone === 'warn'
            ? (meshTheme.isDark ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-700')
            : tone === 'danger'
                ? (meshTheme.isDark ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700')
                : tone === 'info'
                    ? (meshTheme.isDark ? 'border-sky-400/25 bg-sky-500/10 text-sky-200' : 'border-sky-300 bg-sky-50 text-sky-700')
                    : (meshTheme.isDark ? 'border-white/10 bg-white/[0.05] text-slate-300' : 'border-slate-200 bg-white/85 text-slate-600')
        return <span className={`rounded-full border px-2 py-0.5 text-[10px] ${toneClass}`}>{label}</span>
    }

    return (
        <div className="relative h-full min-h-[320px] w-full" style={{ minHeight: 320 }}>
            <ReactFlow
                className="h-full w-full"
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onNodeClick={handleNodeClick}
                onPaneClick={() => setSelectedTaskId(null)}
                fitView
                fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
                minZoom={0.2}
                maxZoom={1.6}
                nodesConnectable={false}
                nodesDraggable={false}
                proOptions={{ hideAttribution: true }}
                colorMode={meshTheme.isDark ? 'dark' : 'light'}
            >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>

            {/* Stats overlay — the "this is a graph of your work" headline row. */}
            {!compact && <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap items-center gap-1.5">
                {scoped.hiddenCount > 0 && (
                    <>
                        {statBadge(t('meshGraph.taskDag.hiddenTasks', { count: scoped.hiddenCount }))}
                        <button
                            type="button"
                            onClick={() => setTerminalLimit(limit => limit + TASK_DAG_LOAD_MORE_STEP)}
                            className={`pointer-events-auto rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${meshTheme.isDark
                                ? 'border-sky-400/25 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
                                : 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
                        >
                            {t('meshGraph.taskDag.loadMore', { count: Math.min(TASK_DAG_LOAD_MORE_STEP, scoped.hiddenCount) })}
                        </button>
                    </>
                )}
                {statBadge(t('meshGraph.taskDag.statsTasks', { count: dag.stats.total }))}
                {dag.stats.edges > 0 && statBadge(t('meshGraph.taskDag.statsEdges', { count: dag.stats.edges }), 'info')}
                {dag.stats.missions > 0 && statBadge(t('meshGraph.taskDag.statsMissions', { count: dag.stats.missions }), 'info')}
                {dag.stats.waiting > 0 && statBadge(t('meshGraph.taskDag.statsWaiting', { count: dag.stats.waiting }), 'warn')}
                {dag.stats.blocked > 0 && statBadge(t('meshGraph.taskDag.statsBlocked', { count: dag.stats.blocked }), 'danger')}
            </div>}

            {/* Edge-state legend */}
            <div className={`pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-[10px] ${meshTheme.isDark ? 'border-white/10 bg-slate-950/80 text-slate-300' : 'border-slate-200 bg-white/90 text-slate-600'}`}>
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
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${meshTheme.isDark ? 'text-slate-400' : 'text-slate-400'}`}>{t('meshGraph.taskDag.selectedTask')}</span>
                        <button
                            type="button"
                            onClick={() => setSelectedTaskId(null)}
                            aria-label="Close task detail"
                            className={meshTheme.isDark ? 'rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs text-slate-200 hover:bg-white/[0.08]' : 'rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50'}
                        >
                            ✕
                        </button>
                    </div>
                    <div className="mb-2 font-mono text-[10px] opacity-70" title={selectedNode.task.id}>{selectedNode.task.id.slice(0, 8)}</div>
                    <div className="mb-2 whitespace-pre-wrap text-[11px] leading-4">{queueTaskDisplayText(selectedNode.task.message)}</div>
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                        {statBadge(selectedNode.task.status, selectedNode.task.status === 'failed' ? 'danger' : selectedNode.task.status === 'assigned' ? 'info' : 'default')}
                        {selectedNode.task.difficulty && statBadge(selectedNode.task.difficulty)}
                        {selectedNode.task.missionId && statBadge(selectedNode.task.missionId, 'info')}
                        {selectedNode.task.assignedNodeId && statBadge(`@ ${selectedNode.task.assignedNodeId.slice(0, 14)}`)}
                    </div>
                    {selectedNode.waitingOn.length > 0 && (
                        <div className="mt-2 text-[10px]">
                            <span className="font-semibold">{t('meshGraph.taskDag.waitsOn', { count: selectedNode.waitingOn.length })}:</span>
                            <span className="ml-1 font-mono opacity-80">{selectedNode.waitingOn.map(id => id.slice(0, 8)).join(', ')}</span>
                        </div>
                    )}
                    {selectedNode.task.blockedReason && (
                        <div className={`mt-2 rounded-lg border px-2 py-1.5 text-[10px] ${meshTheme.isDark ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
                            {selectedNode.task.blockedReason}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
