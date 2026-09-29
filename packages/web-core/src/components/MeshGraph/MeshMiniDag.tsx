/**
 * MeshMiniDag — the on-demand small plan drawing behind a blueprint list
 * row's "plan" disclosure. The only React Flow surface left on the blueprint
 * tab after the canvas → list redesign.
 *
 * Ported from the retired MeshTaskDagView: the edge-state colour vocabulary,
 * the task node reading, and the HONEST legend (it names only the edge
 * states actually drawn — a fixed key describing colours that are not on
 * screen is worse than none). Layout is layered by dependency depth
 * (miniDagViewModel.layoutMiniDag) — no ELK: a plan small enough to open
 * inline is small enough for longest-path columns.
 *
 * Motion contract carried over verbatim: every edge is `animated: false` and
 * the one pulsing dot is `motion-safe:` gated — a never-settling canvas is
 * both an a11y violation and what timed out the capture path before.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react'
import './meshGraph.css'
import type { MeshGraphTheme } from './meshGraphTheme'
import { layoutMiniDag, MINI_DAG_LAYOUT, type MiniDagModel, type MiniDagNode } from './miniDagViewModel'
import type { TaskDagEdgeState } from './taskDagViewModel'
import { queueTaskDisplayText } from '../../utils/queue-task-label'

/** Edge palette — the same vocabulary the full canvas used. */
// Neutral strokes via theme tokens (SVG style strokes resolve CSS vars);
// dashes carry the state, and only a failed edge takes the semantic red.
const MINI_EDGE_COLORS: Record<'satisfied' | 'waiting' | 'failed', { color: string; dash?: string }> = {
    satisfied: { color: 'var(--text-muted)' },
    waiting: { color: 'var(--text-muted)', dash: '5 4' },
    failed: { color: 'var(--status-error)', dash: '3 4' },
}

/** Queue status → dot tone. */
const MINI_DOT_TONES: Record<string, { dot: string; pulse?: boolean }> = {
    pending: { dot: 'bg-text-muted' },
    assigned: { dot: 'bg-accent', pulse: true },
    completed: { dot: 'bg-status-online' },
    failed: { dot: 'bg-status-error' },
    cancelled: { dot: 'bg-status-offline' },
}

type MiniFlowNode = Node<Record<string, unknown> & { node: MiniDagNode; theme: MeshGraphTheme }, 'miniNode'>

function MiniNodeCard({ data }: NodeProps<MiniFlowNode>) {
    const { node } = data
    const tone = MINI_DOT_TONES[node.state] ?? MINI_DOT_TONES.pending
    const label = queueTaskDisplayText(node.label)
    return (
        <div
            className="cursor-pointer rounded-lg border border-solid border-border-default bg-surface-primary px-2.5 py-1.5 text-text-primary"
            style={{ width: MINI_DAG_LAYOUT.nodeWidth, minHeight: MINI_DAG_LAYOUT.nodeHeight }}
        >
            <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
            <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${tone.pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden />
                <span className="truncate text-4xs font-medium text-text-muted">
                    {node.state}
                </span>
            </div>
            <div className="mt-0.5 truncate text-3xs font-medium" title={label}>{label}</div>
        </div>
    )
}

const miniNodeTypes: NodeTypes = { miniNode: MiniNodeCard }

export default function MeshMiniDag({ model, meshTheme, onOpenTask }: {
    model: MiniDagModel
    meshTheme: MeshGraphTheme
    /** Clicking a node opens that task's detail. */
    onOpenTask?: (taskId: string) => void
}) {
    const { t } = useTranslation('common')
    const positions = useMemo(() => layoutMiniDag(model), [model])

    const nodes = useMemo<MiniFlowNode[]>(() => model.nodes
        .filter(node => positions.has(node.id))
        .map(node => ({
            id: node.id,
            type: 'miniNode' as const,
            position: positions.get(node.id)!,
            data: { node, theme: meshTheme },
            draggable: false,
            selectable: true,
        })), [model, positions, meshTheme])

    const edges = useMemo<Edge[]>(() => model.edges.map(edge => {
        const stroke = MINI_EDGE_COLORS[edge.state].color
        const dash = MINI_EDGE_COLORS[edge.state].dash
        return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep' as const,
            animated: false,
            style: { stroke, strokeWidth: 1.25, ...(dash ? { strokeDasharray: dash } : {}) },
            markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 12, height: 12 },
        }
    }), [model])

    /* Honest legend: only the states actually drawn, in a fixed order so the
     * key never reshuffles as data arrives; hides entirely with no edges. */
    const legendStates = useMemo<Array<'satisfied' | 'waiting' | 'failed'>>(() => {
        const present = new Set<TaskDagEdgeState>()
        for (const edge of model.edges) present.add(edge.state)
        return (['satisfied', 'waiting', 'failed'] as const).filter(state => present.has(state))
    }, [model])

    return (
        <div className="mesh-flow relative h-56 w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-secondary">
            <ReactFlow
                className="h-full w-full"
                nodes={nodes}
                edges={edges}
                nodeTypes={miniNodeTypes}
                onNodeClick={(_event, node) => {
                    onOpenTask?.((node as MiniFlowNode).data.node.taskId)
                }}
                fitView
                fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
                minZoom={0.3}
                maxZoom={1.2}
                nodesConnectable={false}
                nodesDraggable={false}
                panOnDrag
                panOnScroll
                zoomOnScroll={false}
                zoomOnPinch
                zoomOnDoubleClick={false}
                selectionOnDrag={false}
                proOptions={{ hideAttribution: true }}
                colorMode={meshTheme.isDark ? 'dark' : 'light'}
            />
            {legendStates.length > 0 && (
                <div className="pointer-events-none absolute bottom-2 right-2 z-10 flex items-center gap-2 rounded-md border border-border-default bg-surface-primary px-2 py-1 text-4xs text-text-secondary">
                    {legendStates.map(state => (
                        <span key={state} className="flex items-center gap-1">
                            <span
                                className="inline-block h-0.5 w-3.5 rounded"
                                style={{ backgroundColor: MINI_EDGE_COLORS[state].color }}
                                aria-hidden
                            />
                            {t(`mesh.taskDag.legend.${state}`)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}
