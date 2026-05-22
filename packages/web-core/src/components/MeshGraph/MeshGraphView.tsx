/**
 * MeshGraphView — React Flow-based visualization for live Repo Mesh status.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MarkerType,
    MiniMap,
    Position,
    ReactFlow,
    useNodesInitialized,
    useReactFlow,
    type Edge,
    type Node,
    type NodeProps,
    type NodeTypes,
} from '@xyflow/react'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'
import {
    getMeshGraphAttentionBadge,
    getMeshGraphCalloutText,
    shouldShowMeshGraphCallout,
} from './meshGraphViewModel'
import {
    getMeshGraphInitialFocusNodeIds,
    getMeshGraphLayoutKey,
    getMeshGraphViewportKey,
    shouldShowMeshGraphMiniMap,
} from '../../utils/mesh-graph-viewport'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme } from './meshGraphTheme'
import {
    buildMeshGraphLayout,
    getMeshGraphNodeCardWidth,
    getNodeSummaryForLayout,
} from './meshGraphLayout'

interface MeshGraphViewProps {
    data: MeshGraphData
    selectedNodeId?: string | null
    onNodeClick?: (node: MeshGraphNode) => void
}

type FlowNodeData = Record<string, unknown> & {
    graphNode: MeshGraphNode
}

type FlowNode = Node<FlowNodeData, 'meshNode'>
type FlowEdge = Edge

const MeshGraphThemeContext = createContext(getMeshGraphTheme('dark'))

function getHealthClasses(node: MeshGraphNode, selected: boolean, isDark: boolean): string {
    const base = selected
        ? 'border-cyan-400/70 shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_24px_60px_rgba(8,145,178,0.18)]'
        : isDark
            ? 'border-white/10 shadow-[0_18px_48px_rgba(3,7,18,0.22)]'
            : 'border-slate-300/90 shadow-[0_18px_48px_rgba(148,163,184,0.20)]'
    const attention = getMeshGraphAttentionBadge(node)

    if (attention?.tone === 'danger') return `${base} ${isDark ? 'bg-rose-500/12' : 'bg-rose-50/95'}`
    if (attention?.tone === 'warn') return `${base} ${isDark ? 'bg-amber-500/10' : 'bg-amber-50/95'}`
    if (attention?.tone === 'info') return `${base} ${isDark ? 'bg-violet-500/10' : 'bg-violet-50/95'}`

    switch (node.health) {
        case 'online':
            return `${base} ${isDark ? 'bg-emerald-500/8' : 'bg-emerald-50/95'}`
        case 'dirty':
            return `${base} ${isDark ? 'bg-amber-500/8' : 'bg-amber-50/95'}`
        case 'degraded':
            return `${base} ${isDark ? 'bg-rose-500/10' : 'bg-rose-50/95'}`
        case 'wrong_branch':
            return `${base} ${isDark ? 'bg-violet-500/10' : 'bg-violet-50/95'}`
        case 'offline':
            return `${base} ${isDark ? 'bg-slate-500/12' : 'bg-slate-100/95'}`
        default:
            return `${base} ${isDark ? 'bg-slate-950/78' : 'bg-white/96'}`
    }
}

function getBadgeClasses(kind: 'health' | 'dirty' | 'conflict' | 'orphan' | 'meta' | 'submodule', isDark: boolean): string {
    switch (kind) {
        case 'health':
            return isDark
                ? 'border-white/10 bg-slate-950/60 text-slate-200'
                : 'border-slate-300 bg-white/95 text-slate-700'
        case 'dirty':
            return isDark
                ? 'border-amber-400/25 bg-amber-500/10 text-amber-200'
                : 'border-amber-300 bg-amber-50 text-amber-700'
        case 'conflict':
            return isDark
                ? 'border-rose-400/25 bg-rose-500/10 text-rose-200'
                : 'border-rose-300 bg-rose-50 text-rose-700'
        case 'orphan':
            return isDark
                ? 'border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-200'
                : 'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700'
        case 'submodule':
            return isDark
                ? 'border-violet-400/25 bg-violet-500/10 text-violet-200'
                : 'border-violet-300 bg-violet-50 text-violet-700'
        case 'meta':
        default:
            return isDark
                ? 'border-cyan-400/20 bg-cyan-500/8 text-cyan-100'
                : 'border-sky-300 bg-sky-50 text-sky-700'
    }
}

function getAttentionBadgeClasses(tone: 'good' | 'warn' | 'danger' | 'info', isDark: boolean): string {
    switch (tone) {
        case 'danger':
            return isDark
                ? 'border-rose-400/35 bg-rose-500/14 text-rose-50'
                : 'border-rose-300 bg-rose-50 text-rose-700'
        case 'warn':
            return isDark
                ? 'border-amber-400/35 bg-amber-500/14 text-amber-50'
                : 'border-amber-300 bg-amber-50 text-amber-700'
        case 'info':
            return isDark
                ? 'border-violet-400/35 bg-violet-500/14 text-violet-50'
                : 'border-violet-300 bg-violet-50 text-violet-700'
        case 'good':
        default:
            return isDark
                ? 'border-emerald-400/35 bg-emerald-500/12 text-emerald-50'
                : 'border-emerald-300 bg-emerald-50 text-emerald-700'
    }
}

function getHealthDot(health: MeshGraphNode['health']): string {
    switch (health) {
        case 'online':
            return '#34d399'
        case 'dirty':
            return '#fbbf24'
        case 'degraded':
            return '#fb7185'
        case 'wrong_branch':
            return '#a78bfa'
        case 'offline':
            return '#94a3b8'
        default:
            return '#64748b'
    }
}

function formatHealth(health: MeshGraphNode['health']): string {
    return health.replace(/_/g, ' ')
}

function MeshNodeCard({ data, selected }: NodeProps<FlowNode>) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const node = data.graphNode
    const isDefaultBranchNode = node.type === 'defaultBranchNode'
    const isSubmoduleNode = node.type === 'submoduleNode'
    const shouldShowCallout = shouldShowMeshGraphCallout(node)
    const subtitle = isDefaultBranchNode
        ? 'default branch anchor'
        : isSubmoduleNode
            ? node.submodulePath || 'submodule checkout'
            : node.machineLabel || node.workspace
    const shortCommit = node.submoduleCommit ? node.submoduleCommit.slice(0, 7) : null
    const attentionBadge = getMeshGraphAttentionBadge(node)
    const nodeSummary = getNodeSummaryForLayout(node)
    const calloutText = getMeshGraphCalloutText(node)

    return (
        <div
            className={`${isSubmoduleNode ? 'w-[228px]' : 'w-[256px]'} rounded-2xl border px-4 py-3.5 backdrop-blur-sm transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}`}
            style={{ width: getMeshGraphNodeCardWidth(node) }}
        >
            <Handle
                type="target"
                position={Position.Top}
                isConnectable={false}
                style={{ opacity: 0, pointerEvents: 'none' }}
            />
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{node.label}</div>
                    <div className={`truncate text-[11px] ${meshTheme.textMuted}`}>{subtitle}</div>
                </div>
                <span
                    className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: getHealthDot(node.health) }}
                    aria-hidden
                />
            </div>

            {attentionBadge && (
                <div className={`mt-3 inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${getAttentionBadgeClasses(attentionBadge.tone, meshTheme.isDark)}`}>
                    <span className="truncate">{attentionBadge.label}</span>
                </div>
            )}

            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                <span className={`rounded-full border px-2 py-0.5 capitalize ${getBadgeClasses('health', meshTheme.isDark)}`}>
                    {formatHealth(node.health)}
                </span>
                {isSubmoduleNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('submodule', meshTheme.isDark)}`}>
                        submodule
                    </span>
                )}
                {node.branch && !isSubmoduleNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('meta', meshTheme.isDark)}`}>
                        {node.branch}
                    </span>
                )}
                {shortCommit && isSubmoduleNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('meta', meshTheme.isDark)}`}>
                        {shortCommit}
                    </span>
                )}
                {node.dirty && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('dirty', meshTheme.isDark)}`}>
                        {isSubmoduleNode ? 'local changes' : `${node.dirtyFiles} dirty`}
                    </span>
                )}
                {node.outOfSync && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('conflict', meshTheme.isDark)}`}>
                        out of sync
                    </span>
                )}
                {node.hasConflicts && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('conflict', meshTheme.isDark)}`}>
                        conflicts
                    </span>
                )}
                {!isSubmoduleNode && node.upstream && node.upstreamStatus !== 'fresh' && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('orphan', meshTheme.isDark)}`}>
                        upstream unverified
                    </span>
                )}
                {node.isOrphan && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('orphan', meshTheme.isDark)}`}>
                        needs follow-up
                    </span>
                )}
            </div>

            <div className={`mt-3 text-[11px] leading-5 ${meshTheme.textSecondary}`}>
                {nodeSummary}
            </div>

            {shouldShowCallout && calloutText && (
                <div className={`mt-3 rounded-xl border px-3 py-2 text-[10px] leading-4 ${meshTheme.isDark ? 'border-cyan-400/15 bg-cyan-500/8 text-cyan-50/90' : 'border-sky-300 bg-sky-50 text-sky-700'}`}>
                    {calloutText}
                </div>
            )}
            <Handle
                type="source"
                position={Position.Bottom}
                isConnectable={false}
                style={{ opacity: 0, pointerEvents: 'none' }}
            />
        </div>
    )
}

const nodeTypes: NodeTypes = {
    meshNode: MeshNodeCard,
}

function buildLayout(data: MeshGraphData, meshTheme = getMeshGraphTheme('dark')): { nodes: FlowNode[]; edges: FlowEdge[] } {
    const layout = buildMeshGraphLayout(data)
    const flowNodes: FlowNode[] = layout.nodes.map(node => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: { graphNode: node.graphNode },
        selected: node.selected,
        draggable: node.draggable,
        selectable: node.selectable,
    }))

    const flowEdges: FlowEdge[] = data.edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        type: edge.type === 'worktreeLink' || edge.type === 'submoduleLink' ? 'smoothstep' : 'bezier',
        animated: edge.type === 'orphanLink',
        markerEnd: {
            type: MarkerType.ArrowClosed,
            width: edge.type === 'submoduleLink' ? 16 : 18,
            height: edge.type === 'submoduleLink' ? 16 : 18,
            color: edgeColor(edge),
        },
        style: {
            stroke: edgeColor(edge),
            strokeWidth: edge.type === 'orphanLink' ? 2.25 : edge.type === 'submoduleLink' ? 1.7 : edge.type === 'worktreeLink' ? 1.8 : 2,
            strokeDasharray: edge.type === 'orphanLink' ? '5 4' : edge.type === 'submoduleLink' ? '4 3' : undefined,
        },
        labelStyle: {
            fill: meshTheme.edgeLabelTextColor,
            fontSize: 10,
            fontWeight: 600,
        },
        labelBgStyle: {
            fill: meshTheme.edgeLabelBackgroundColor,
            fillOpacity: 1,
            stroke: meshTheme.edgeLabelBorderColor,
        },
        labelBgPadding: [6, 4],
        labelBgBorderRadius: 7,
    }))

    return { nodes: flowNodes, edges: flowEdges }
}

function edgeColor(edge: MeshGraphEdge): string {
    switch (edge.type) {
        case 'parentBranch':
            return '#38bdf8'
        case 'worktreeLink':
            return '#a78bfa'
        case 'sessionLink':
            return '#34d399'
        case 'orphanLink':
            return '#f97316'
        case 'submoduleLink':
            return '#c084fc'
        default:
            return '#64748b'
    }
}

function MeshViewportController({ data, viewportKey }: { data: MeshGraphData; viewportKey: string }) {
    const nodesInitialized = useNodesInitialized()
    const reactFlow = useReactFlow<FlowNode, FlowEdge>()
    const lastViewportKeyRef = useRef<string | null>(null)
    const layoutKey = useMemo(() => getMeshGraphLayoutKey(data), [data])
    const initialFocusNodeIds = useMemo(() => getMeshGraphInitialFocusNodeIds(data), [data])

    useEffect(() => {
        if (!nodesInitialized || data.nodes.length === 0) return
        if (lastViewportKeyRef.current === viewportKey) return

        let cancelled = false
        const frame = requestAnimationFrame(() => {
            if (cancelled) return
            const shouldFocusSubset = initialFocusNodeIds.length > 0 && initialFocusNodeIds.length < data.nodes.length
            void reactFlow.fitView({
                nodes: shouldFocusSubset ? initialFocusNodeIds.map(id => ({ id })) : undefined,
                padding: shouldFocusSubset ? 0.24 : 0.2,
                maxZoom: shouldFocusSubset ? 0.98 : 0.9,
                duration: 260,
            })
            lastViewportKeyRef.current = viewportKey
        })

        return () => {
            cancelled = true
            cancelAnimationFrame(frame)
        }
    }, [data.nodes.length, initialFocusNodeIds, layoutKey, nodesInitialized, reactFlow, viewportKey])

    return null
}

export default function MeshGraphView({ data, selectedNodeId = null, onNodeClick }: MeshGraphViewProps) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const layout = useMemo(() => buildLayout(data, meshTheme), [data, meshTheme])
    const showMiniMap = useMemo(() => shouldShowMeshGraphMiniMap(data), [data])
    const surfaceRef = useRef<HTMLDivElement | null>(null)
    const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
    const viewportKey = useMemo(
        () => getMeshGraphViewportKey(data, surfaceSize.width, surfaceSize.height),
        [data, surfaceSize.height, surfaceSize.width],
    )

    const nodes = useMemo(
        () => layout.nodes.map(node => ({ ...node, selected: node.id === selectedNodeId })),
        [layout.nodes, selectedNodeId],
    )

    useEffect(() => {
        const element = surfaceRef.current
        if (!element) return

        const updateSize = () => {
            const nextWidth = Math.max(0, Math.round(element.clientWidth))
            const nextHeight = Math.max(0, Math.round(element.clientHeight))
            setSurfaceSize(prev => (
                prev.width === nextWidth && prev.height === nextHeight
                    ? prev
                    : { width: nextWidth, height: nextHeight }
            ))
        }

        updateSize()
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateSize())
            : null
        resizeObserver?.observe(element)
        window.addEventListener('resize', updateSize)

        return () => {
            resizeObserver?.disconnect()
            window.removeEventListener('resize', updateSize)
        }
    }, [])

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <div ref={surfaceRef} className={meshTheme.graphShellClass}>
            <div className={`absolute inset-x-3 top-3 z-10 flex flex-wrap items-center justify-between gap-2 text-[11px] ${meshTheme.textSecondary}`}>
                <div className="flex flex-wrap gap-2">
                    <span className={meshTheme.graphStatChipClass}>
                        {data.stats.totalNodes} node{data.stats.totalNodes === 1 ? '' : 's'}
                    </span>
                    <span className={meshTheme.graphStatChipClass}>
                        {data.stats.totalActiveSessions} active session{data.stats.totalActiveSessions === 1 ? '' : 's'}
                    </span>
                    {data.stats.orphanNodes > 0 && (
                        <span className={meshTheme.isDark ? 'rounded-full border border-orange-400/25 bg-orange-500/12 px-3 py-1 text-orange-100' : 'rounded-full border border-orange-300 bg-orange-50 px-3 py-1 text-orange-700'}>
                            {data.stats.orphanNodes} need attention
                        </span>
                    )}
                </div>
                <div className={meshTheme.graphHintChipClass}>
                    Focused on the main path first · drag or scroll to pan
                </div>
            </div>
            <div className="h-[460px] w-full min-w-0 min-h-[460px] sm:h-[560px] xl:h-[680px]">
                <ReactFlow<FlowNode, FlowEdge>
                    nodes={nodes}
                    edges={layout.edges}
                    nodeTypes={nodeTypes}
                    minZoom={0.25}
                    maxZoom={1.35}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable
                    panOnDrag
                    panOnScroll
                    zoomOnScroll={false}
                    zoomOnPinch={false}
                    zoomOnDoubleClick={false}
                    selectionOnDrag={false}
                    onNodeClick={(_, node) => onNodeClick?.(node.data.graphNode)}
                    className="h-full w-full"
                    colorMode={meshTheme.flowColorMode}
                    proOptions={{ hideAttribution: true }}
                >
                    <MeshViewportController data={data} viewportKey={viewportKey} />
                    {showMiniMap && (
                        <MiniMap
                            className={meshTheme.graphMiniMapClass}
                            nodeColor={currentNode => getHealthDot((currentNode.data as FlowNodeData).graphNode.health)}
                        />
                    )}
                    <Controls className={meshTheme.graphControlsClass} showInteractive={false} />
                    <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color={meshTheme.graphBackgroundDotColor} />
                </ReactFlow>
            </div>
        </div>
        </MeshGraphThemeContext.Provider>
    )
}
