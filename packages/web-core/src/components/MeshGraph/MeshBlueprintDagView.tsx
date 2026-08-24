/**
 * MeshBlueprintDagView — React Flow rendering of ONE persistent orchestration
 * graph (mesh_graph_overview payload) as a dependency blueprint: worker-task
 * nodes and coordinator-gate nodes laid out left→right, edges showing what
 * unlocks what. This is the "설계도면" half of the blueprint tab; the graph
 * picker, gate action panel, and scheduling preview live in MeshBlueprintView.
 *
 * Rendering conventions (shared vocabulary with MeshTaskDagView):
 *  - task card: state-tinted, dot pulse while in flight
 *  - gate card: ⛩ marker, amber pulse while awaiting a coordinator decision
 *  - edge: solid emerald when its source reached a terminal-success state,
 *    animated amber while the target still waits on it, dashed muted when the
 *    edge was deactivated by a skip.
 */
import { useCallback, useEffect, useMemo, type CSSProperties } from 'react'
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
import { useState } from 'react'
import type { MeshGraphView, MeshGraphNodeView, MeshGraphGateView } from '@adhdev/daemon-core'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme, type MeshGraphTheme } from './meshGraphTheme'
import { buildGateByNodeId, buildNodeIdByEndpoint, buildStateByNodeId, deriveBlueprintEdgeState } from './blueprintViewModel'

const elk = new ELK()

const CARD_WIDTH = 220
const CARD_MIN_HEIGHT = 76

type NodeStateStyle = { dark: string; light: string; dot: string; pulse?: boolean }

const TASK_STATE_STYLES: Record<string, NodeStateStyle> = {
    declared: { dark: 'border-slate-400/30 bg-slate-500/10 text-slate-200', light: 'border-slate-300 bg-slate-50 text-slate-700', dot: 'bg-slate-400' },
    blocked: { dark: 'border-amber-400/40 bg-amber-500/10 text-amber-100', light: 'border-amber-300 bg-amber-50 text-amber-800', dot: 'bg-amber-400' },
    materialized: { dark: 'border-sky-400/40 bg-sky-500/10 text-sky-100', light: 'border-sky-300 bg-sky-50 text-sky-800', dot: 'bg-sky-400', pulse: true },
    completed: { dark: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100', light: 'border-emerald-300 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-400' },
    failed: { dark: 'border-rose-400/40 bg-rose-500/10 text-rose-100', light: 'border-rose-300 bg-rose-50 text-rose-800', dot: 'bg-rose-400' },
    skipped: { dark: 'border-slate-500/25 bg-slate-600/10 text-slate-400', light: 'border-slate-200 bg-slate-100 text-slate-400', dot: 'bg-slate-500' },
    cancelled: { dark: 'border-slate-500/25 bg-slate-600/10 text-slate-400', light: 'border-slate-200 bg-slate-100 text-slate-400', dot: 'bg-slate-500' },
}

const GATE_STATE_STYLES: Record<string, NodeStateStyle> = {
    declared: { dark: 'border-slate-400/30 bg-slate-500/10 text-slate-200', light: 'border-slate-300 bg-slate-50 text-slate-700', dot: 'bg-slate-400' },
    awaiting_coordinator: { dark: 'border-amber-400/50 bg-amber-500/15 text-amber-100', light: 'border-amber-400 bg-amber-50 text-amber-800', dot: 'bg-amber-400', pulse: true },
    claimed: { dark: 'border-sky-400/50 bg-sky-500/15 text-sky-100', light: 'border-sky-400 bg-sky-50 text-sky-800', dot: 'bg-sky-400', pulse: true },
    released: { dark: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100', light: 'border-emerald-300 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-400' },
    cancelled: { dark: 'border-slate-500/25 bg-slate-600/10 text-slate-400', light: 'border-slate-200 bg-slate-100 text-slate-400', dot: 'bg-slate-500' },
    expired: { dark: 'border-rose-400/40 bg-rose-500/10 text-rose-100', light: 'border-rose-300 bg-rose-50 text-rose-800', dot: 'bg-rose-400', pulse: true },
}

const clampStyle: CSSProperties = {
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
}

type BlueprintFlowData = Record<string, unknown> & {
    node: MeshGraphNodeView
    gate?: MeshGraphGateView
    theme: MeshGraphTheme
    selected: boolean
}

type BlueprintFlowNode = Node<BlueprintFlowData, 'blueprintNode'>

function BlueprintNodeCard({ data }: NodeProps<BlueprintFlowNode>) {
    const { t } = useTranslation('common')
    const { node, gate, theme, selected } = data
    const isGate = node.kind === 'coordinator_gate'
    const stateKey = isGate ? (gate?.state ?? node.state) : node.state
    const style = (isGate ? GATE_STATE_STYLES[stateKey] : TASK_STATE_STYLES[stateKey])
        ?? TASK_STATE_STYLES.declared
    const stateClass = theme.isDark ? style.dark : style.light
    const leaseExpired = gate?.leaseExpired === true
    return (
        <div
            className={`rounded-2xl border px-3 py-2 shadow-sm transition-shadow ${stateClass} ${selected ? (theme.isDark ? 'ring-2 ring-cyan-300/60' : 'ring-2 ring-sky-400/70') : ''} ${isGate ? 'border-dashed' : ''}`}
            style={{ width: CARD_WIDTH }}
        >
            <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
            <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'animate-pulse' : ''}`} aria-hidden />
                    <span className="truncate text-3xs font-semibold uppercase tracking-wide opacity-80">
                        {isGate ? `⛩ ${gate?.action ?? 'gate'}` : stateKey}
                    </span>
                </span>
                <span className="shrink-0 font-mono text-4xs opacity-60" title={node.nodeId}>{node.nodeId.slice(0, 8)}</span>
            </div>
            <div className="mt-1 text-2xs font-medium leading-[15px]" style={clampStyle} title={node.ref || node.nodeId}>
                {node.ref || node.nodeId.slice(0, 8)}
            </div>
            {isGate && (
                <div className="mt-1 text-4xs opacity-75">
                    {stateKey}{leaseExpired ? ` · ${t('meshGraph.blueprint.leaseExpired')}` : ''}
                    {gate?.releaseOutcome ? ` · ${gate.releaseOutcome}` : ''}
                </div>
            )}
            {!isGate && node.blockedReason && (
                <div className="mt-1 text-4xs opacity-75" style={clampStyle} title={node.blockedReason}>
                    {node.blockedReason}
                </div>
            )}
        </div>
    )
}

const nodeTypes: NodeTypes = { blueprintNode: BlueprintNodeCard }

async function layoutBlueprint(graph: MeshGraphView): Promise<Map<string, { x: number; y: number }>> {
    // Edge endpoints are `ref ?? nodeId` in the view projection — resolve to
    // nodeIds so ELK's shape references match the children ids.
    const endpointMap = buildNodeIdByEndpoint(graph)
    const elkGraph = {
        id: 'blueprint-root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'SPLINES',
            'elk.spacing.nodeNode': '40',
            'elk.layered.spacing.nodeNodeBetweenLayers': '110',
            'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            'elk.randomSeed': '1',
        },
        children: graph.nodes.map(node => ({ id: node.nodeId, width: CARD_WIDTH, height: CARD_MIN_HEIGHT })),
        edges: graph.edges.map((edge, index) => ({
            id: `e${index}`,
            sources: [endpointMap.get(edge.from) ?? edge.from],
            targets: [endpointMap.get(edge.to) ?? edge.to],
        })),
    }
    const result = await elk.layout(elkGraph)
    const positions = new Map<string, { x: number; y: number }>()
    for (const child of result.children ?? []) positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
    return positions
}

export default function MeshBlueprintDagView({ graph, selectedNodeId, onSelectNode }: {
    graph: MeshGraphView
    selectedNodeId: string | null
    onSelectNode: (nodeId: string | null) => void
}) {
    const { t } = useTranslation('common')
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const gateByNodeId = useMemo(() => buildGateByNodeId(graph), [graph.gates])

    const fingerprint = useMemo(
        () => graph.nodes.map(n => `${n.nodeId}:${n.state}:${gateByNodeId.get(n.nodeId)?.state ?? ''}`).join('|')
            + '||' + graph.edges.map(e => `${e.from}>${e.to}:${e.active ? 1 : 0}`).join('|'),
        [graph, gateByNodeId],
    )
    const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null)

    useEffect(() => {
        let cancelled = false
        if (graph.nodes.length === 0) { setPositions(null); return }
        void layoutBlueprint(graph)
            .then(next => { if (!cancelled) setPositions(next) })
            .catch(error => {
                // Surface layout failures — a silently blank canvas is undebuggable.
                console.error('[MeshBlueprintDagView] ELK layout failed:', error)
                if (!cancelled) setPositions(null)
            })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fingerprint])

    const flowNodes = useMemo<BlueprintFlowNode[]>(() => {
        if (!positions) return []
        return graph.nodes
            .filter(node => positions.has(node.nodeId))
            .map(node => ({
                id: node.nodeId,
                type: 'blueprintNode' as const,
                position: positions.get(node.nodeId)!,
                data: { node, gate: gateByNodeId.get(node.nodeId), theme: meshTheme, selected: selectedNodeId === node.nodeId },
                draggable: false,
                selectable: true,
            }))
    }, [graph.nodes, gateByNodeId, meshTheme, positions, selectedNodeId])

    const stateByNodeId = useMemo(() => buildStateByNodeId(graph), [graph.nodes, gateByNodeId])
    const nodeIdByEndpoint = useMemo(() => buildNodeIdByEndpoint(graph), [graph.nodes])

    const flowEdges = useMemo<Edge[]>(() => {
        if (!positions) return []
        return graph.edges.map((edge, index) => {
            const edgeState = deriveBlueprintEdgeState(edge, stateByNodeId, nodeIdByEndpoint)
            const stroke = edgeState === 'inactive'
                ? (meshTheme.isDark ? '#475569' : '#94a3b8')
                : edgeState === 'failed'
                    ? (meshTheme.isDark ? '#fb7185' : '#e11d48')
                    : edgeState === 'satisfied'
                        ? (meshTheme.isDark ? '#34d399' : '#059669')
                        : (meshTheme.isDark ? '#fbbf24' : '#d97706')
            return {
                id: `e${index}`,
                source: nodeIdByEndpoint.get(edge.from) ?? edge.from,
                target: nodeIdByEndpoint.get(edge.to) ?? edge.to,
                type: 'smoothstep' as const,
                animated: edgeState === 'waiting',
                style: {
                    stroke,
                    strokeWidth: 1.6,
                    ...(edgeState === 'inactive'
                        ? { strokeDasharray: '2 5', opacity: 0.5 }
                        : edgeState === 'waiting' ? { strokeDasharray: '6 4' } : {}),
                },
                markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
                ...(edge.kind && edge.kind !== 'dependency' ? { label: edge.kind, labelStyle: { fontSize: 9 } } : {}),
            }
        })
    }, [graph.edges, meshTheme, positions, stateByNodeId, nodeIdByEndpoint])

    const handleNodeClick = useCallback((_event: unknown, node: BlueprintFlowNode) => {
        onSelectNode(selectedNodeId === node.id ? null : node.id)
    }, [onSelectNode, selectedNodeId])

    if (graph.nodes.length === 0) {
        return (
            <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center text-sm text-slate-400">
                {t('meshGraph.blueprint.emptyGraph')}
            </div>
        )
    }

    return (
        <div className="relative h-full min-h-[160px] w-full" style={{ minHeight: 160 }}>
            <ReactFlow
                className="h-full w-full"
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onNodeClick={handleNodeClick}
                onPaneClick={() => onSelectNode(null)}
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
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
        </div>
    )
}
