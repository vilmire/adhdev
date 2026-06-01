/**
 * MeshGraphView — React Flow-based visualization for live Repo Mesh status.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
    Background,
    BackgroundVariant,
    BaseEdge,
    Controls,
    EdgeLabelRenderer,
    Handle,
    MarkerType,
    MiniMap,
    Position,
    ReactFlow,
    getBezierPath,
    getSmoothStepPath,
    getStraightPath,
    useNodesInitialized,
    useReactFlow,
    type Edge,
    type EdgeProps,
    type EdgeTypes,
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
} from '../../utils/mesh-graph-viewport'
import { useTheme } from '../../hooks/useTheme'
import { getMeshGraphTheme } from './meshGraphTheme'
import {
    buildMeshGraphLayout,
    MESH_GRAPH_EDGE_LABEL,
    getMeshGraphNodeCardWidth,
    getNodeSummaryForLayout,
} from './meshGraphLayout'
import { getMeshGraphDataFingerprint, getMeshGraphLayoutFingerprint } from './meshGraphMemo'

/** Dense graph threshold: above this node count, switch to compact card mode */
const COMPACT_NODE_THRESHOLD = 7

interface MeshGraphViewProps {
    data: MeshGraphData
    selectedNodeId?: string | null
    onNodeClick?: (node: MeshGraphNode) => void
}

type FlowNodeData = Record<string, unknown> & {
    graphNode: MeshGraphNode
    compact: boolean
}

type FlowEdgeData = Record<string, unknown> & {
    graphEdge: MeshGraphEdge
}

type FlowNode = Node<FlowNodeData, 'meshNode'>
type FlowEdge = Edge<FlowEdgeData, 'meshEdge'>

const MeshGraphThemeContext = createContext(getMeshGraphTheme('dark'))
const MeshGraphCompactContext = createContext(false)

const boundedTextStyle: CSSProperties = {
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
}

const summaryTextStyle: CSSProperties = {
    ...boundedTextStyle,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
    overflow: 'hidden',
}

const calloutTextStyle: CSSProperties = {
    ...boundedTextStyle,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 4,
    overflow: 'hidden',
}

function isNodeActive(node: MeshGraphNode): boolean {
    return node.activeSessionCount > 0
}

function isNodeStale(node: MeshGraphNode): boolean {
    return node.health === 'offline' || (node.snapshotCompleteness === 'stale' && node.activeSessionCount === 0)
}

function getHealthClasses(node: MeshGraphNode, selected: boolean, isDark: boolean): string {
    const isActive = isNodeActive(node)
    const isStale = isNodeStale(node)

    let base: string
    if (selected) {
        base = 'border-cyan-400/70 shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_24px_60px_rgba(8,145,178,0.18)]'
    } else if (isActive) {
        base = isDark
            ? 'border-emerald-400/40 shadow-[0_0_0_1px_rgba(52,211,153,0.18),0_18px_48px_rgba(3,7,18,0.22)]'
            : 'border-emerald-400/60 shadow-[0_0_0_1px_rgba(52,211,153,0.2),0_18px_48px_rgba(148,163,184,0.20)]'
    } else if (isStale) {
        base = isDark
            ? 'border-white/6 shadow-[0_12px_32px_rgba(3,7,18,0.16)] opacity-60'
            : 'border-slate-200/70 shadow-[0_12px_32px_rgba(148,163,184,0.14)] opacity-60'
    } else {
        base = isDark
            ? 'border-white/10 shadow-[0_18px_48px_rgba(3,7,18,0.22)]'
            : 'border-slate-300/90 shadow-[0_18px_48px_rgba(148,163,184,0.20)]'
    }

    const attention = getMeshGraphAttentionBadge(node)

    if (attention?.tone === 'danger') return `${base} ${isDark ? 'bg-rose-500/12' : 'bg-rose-50/95'}`
    if (attention?.tone === 'warn') return `${base} ${isDark ? 'bg-amber-500/10' : 'bg-amber-50/95'}`
    if (attention?.tone === 'info') return `${base} ${isDark ? 'bg-violet-500/10' : 'bg-violet-50/95'}`

    switch (node.health) {
        case 'online':
            return `${base} ${isDark ? (isActive ? 'bg-emerald-500/10' : 'bg-emerald-500/8') : (isActive ? 'bg-emerald-50' : 'bg-emerald-50/95')}`
        case 'dirty':
            return `${base} ${isDark ? 'bg-amber-500/8' : 'bg-amber-50/95'}`
        case 'degraded':
            return `${base} ${isDark ? 'bg-rose-500/10' : 'bg-rose-50/95'}`
        case 'wrong_branch':
            return `${base} ${isDark ? 'bg-violet-500/10' : 'bg-violet-50/95'}`
        case 'offline':
            return `${base} ${isDark ? 'bg-slate-500/10' : 'bg-slate-100/90'}`
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

function formatLocality(locality: MeshGraphNode['locality']): string {
    if (locality === 'local') return 'local'
    if (locality === 'remote') return 'remote'
    return 'machine unknown'
}

function getLocalityBadgeKind(node: MeshGraphNode): 'meta' | 'health' {
    return node.locality === 'remote' ? 'meta' : 'health'
}

function MeshNodeCard({ data, selected }: NodeProps<FlowNode>) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const compact = useContext(MeshGraphCompactContext)
    const node = data.graphNode
    const isDefaultBranchNode = node.type === 'defaultBranchNode'
    const isSubmoduleNode = node.type === 'submoduleNode'
    const shouldShowCallout = shouldShowMeshGraphCallout(node)
    const subtitle = isDefaultBranchNode
        ? 'default branch anchor'
        : isSubmoduleNode
            ? node.submodulePath || 'submodule checkout'
            : [node.machineLabel, formatLocality(node.locality)].filter(Boolean).join(' · ') || node.workspace
    const shortCommit = node.submoduleCommit ? node.submoduleCommit.slice(0, 7) : null
    const attentionBadge = getMeshGraphAttentionBadge(node)
    const calloutText = getMeshGraphCalloutText(node)
    const hasActiveSession = isNodeActive(node)

    if (compact) {
        return (
            <div
                className={`rounded-xl border px-3 py-2.5 backdrop-blur-sm transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}`}
                style={{ width: getMeshGraphNodeCardWidth(node, true) }}
                title={[
                    node.label,
                    node.branch ? `Branch: ${node.branch}` : null,
                    node.machineLabel ? `Machine: ${node.machineLabel}` : null,
                    node.workspace ? `Workspace: ${node.workspace}` : null,
                    attentionBadge ? `Status: ${attentionBadge.label}` : null,
                    getNodeSummaryForLayout(node),
                ].filter(Boolean).join('\n')}
            >
                <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                        <div className={`truncate text-xs font-semibold leading-4 ${meshTheme.textPrimary}`}>{node.label}</div>
                        {!isDefaultBranchNode && (
                            <div className={`truncate text-[10px] leading-3.5 ${meshTheme.textMuted}`}>{subtitle}</div>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {hasActiveSession && (
                            <span className={`h-1.5 w-1.5 rounded-full ${meshTheme.isDark ? 'bg-emerald-400' : 'bg-emerald-500'} animate-pulse`} aria-label="active session" />
                        )}
                        <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: getHealthDot(node.health) }}
                            aria-hidden
                        />
                    </div>
                </div>
                {attentionBadge && (
                    <div className={`mt-1.5 inline-flex min-w-0 max-w-full items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] ${getAttentionBadgeClasses(attentionBadge.tone, meshTheme.isDark)}`} title={attentionBadge.label}>
                        <span className="truncate">{attentionBadge.label}</span>
                    </div>
                )}
                {!attentionBadge && node.branch && !isSubmoduleNode && (
                    <div className={`mt-1 min-w-0 max-w-full truncate text-[10px] ${getBadgeClasses('meta', meshTheme.isDark)} rounded-full border px-2 py-0.5 inline-block`} title={node.branch}>
                        {node.branch}
                    </div>
                )}
                <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: 'none' }} />
            </div>
        )
    }

    return (
        <div
            className={`rounded-2xl border px-4 py-3.5 backdrop-blur-sm transition-all ${getHealthClasses(node, selected, meshTheme.isDark)}`}
            style={{ width: getMeshGraphNodeCardWidth(node) }}
            title={[
                node.machineLabel ? `Machine: ${node.machineLabel}` : null,
                node.machineId ? `Machine id: ${node.machineId}` : null,
                node.daemonId ? `Daemon: ${node.daemonId}` : null,
                `Locality: ${formatLocality(node.locality)}`,
                node.workspace ? `Workspace: ${node.workspace}` : null,
            ].filter(Boolean).join('\n')}
        >
            <Handle
                type="target"
                position={Position.Left}
                isConnectable={false}
                style={{ opacity: 0, pointerEvents: 'none' }}
            />
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className={`truncate text-sm font-semibold ${meshTheme.textPrimary}`}>{node.label}</div>
                    <div className={`truncate text-[11px] ${meshTheme.textMuted}`}>{subtitle}</div>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 shrink-0">
                    {hasActiveSession && (
                        <span className={`h-2 w-2 rounded-full ${meshTheme.isDark ? 'bg-emerald-400' : 'bg-emerald-500'} animate-pulse`} aria-label="active session" />
                    )}
                    <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: getHealthDot(node.health) }}
                        aria-hidden
                    />
                </div>
            </div>

            {attentionBadge && (
                <div className={`mt-3 inline-flex min-w-0 max-w-full items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${getAttentionBadgeClasses(attentionBadge.tone, meshTheme.isDark)}`} title={attentionBadge.label}>
                    <span className="truncate">{attentionBadge.label}</span>
                </div>
            )}

            <div className="mt-3 flex min-w-0 flex-wrap gap-1.5 text-[10px]">
                <span className={`rounded-full border px-2 py-0.5 capitalize ${getBadgeClasses('health', meshTheme.isDark)}`}>
                    {formatHealth(node.health)}
                </span>
                {isSubmoduleNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('submodule', meshTheme.isDark)}`}>
                        submodule
                    </span>
                )}
                {!isDefaultBranchNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses(getLocalityBadgeKind(node), meshTheme.isDark)}`}>
                        {formatLocality(node.locality)}
                    </span>
                )}
                {node.branch && !isSubmoduleNode && (
                    <span className={`min-w-0 max-w-full rounded-full border px-2 py-0.5 ${getBadgeClasses('meta', meshTheme.isDark)}`} title={node.branch}>
                        <span className="block truncate">{node.branch}</span>
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

            <div className={`mt-3 text-[11px] leading-5 ${meshTheme.textSecondary}`} style={summaryTextStyle} title={getNodeSummaryForLayout(node)}>
                {getNodeSummaryForLayout(node)}
            </div>

            {shouldShowCallout && calloutText && (
                <div
                    className={`mt-3 rounded-xl border px-3 py-2 text-[10px] leading-4 ${meshTheme.isDark ? 'border-cyan-400/15 bg-cyan-500/8 text-cyan-50/90' : 'border-sky-300 bg-sky-50 text-sky-700'}`}
                    style={calloutTextStyle}
                    title={calloutText}
                >
                    {calloutText}
                </div>
            )}
            <Handle
                type="source"
                position={Position.Right}
                isConnectable={false}
                style={{ opacity: 0, pointerEvents: 'none' }}
            />
        </div>
    )
}

const nodeTypes: NodeTypes = {
    meshNode: MeshNodeCard,
}

function getEdgePath(args: EdgeProps<FlowEdge>): ReturnType<typeof getBezierPath> {
    const pathParams = {
        sourceX: args.sourceX,
        sourceY: args.sourceY,
        sourcePosition: args.sourcePosition,
        targetX: args.targetX,
        targetY: args.targetY,
        targetPosition: args.targetPosition,
    }
    const graphEdge = args.data.graphEdge

    if (graphEdge.type === 'parentBranch') return getStraightPath(pathParams)
    if (graphEdge.type === 'worktreeLink' || graphEdge.type === 'submoduleLink' || graphEdge.type === 'cloneLink') return getSmoothStepPath(pathParams)
    return getBezierPath(pathParams)
}

function getEdgeLabelClasses(edge: MeshGraphEdge, isDark: boolean): string {
    const base = 'nodrag nopan rounded-md border px-2 py-1 text-[10px] font-semibold shadow-sm backdrop-blur-sm'
    switch (edge.type) {
        case 'orphanLink':
            return isDark
                ? `${base} border-orange-400/35 bg-orange-500/14 text-orange-100`
                : `${base} border-orange-300 bg-orange-50 text-orange-700`
        case 'submoduleLink':
            return isDark
                ? `${base} border-violet-400/30 bg-violet-500/14 text-violet-100`
                : `${base} border-violet-300 bg-violet-50 text-violet-700`
        case 'sessionLink':
            return isDark
                ? `${base} border-emerald-400/30 bg-emerald-500/14 text-emerald-100`
                : `${base} border-emerald-300 bg-emerald-50 text-emerald-700`
        case 'cloneLink':
            return isDark
                ? `${base} border-teal-400/30 bg-teal-500/14 text-teal-100`
                : `${base} border-teal-300 bg-teal-50 text-teal-700`
        default:
            return isDark
                ? `${base} border-sky-400/25 bg-slate-950/78 text-sky-100`
                : `${base} border-sky-300 bg-white/95 text-sky-700`
    }
}

function MeshGraphEdgeLine(args: EdgeProps<FlowEdge>) {
    const meshTheme = useContext(MeshGraphThemeContext)
    const graphEdge = args.data.graphEdge
    const [edgePath, labelX, labelY] = getEdgePath(args)
    const labelTitle = typeof args.label === 'string' ? args.label : undefined

    return (
        <>
            <BaseEdge
                id={args.id}
                path={edgePath}
                markerEnd={args.markerEnd}
                style={args.style}
                interactionWidth={24}
            />
            {args.label && (
                <EdgeLabelRenderer>
                    <div
                        className={getEdgeLabelClasses(graphEdge, meshTheme.isDark)}
                        title={labelTitle}
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: 'none',
                            maxWidth: MESH_GRAPH_EDGE_LABEL.maxWidth,
                        }}
                    >
                        <span className="block truncate">{args.label}</span>
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    )
}

const edgeTypes: EdgeTypes = {
    meshEdge: MeshGraphEdgeLine,
}

async function buildLayout(data: MeshGraphData, meshTheme = getMeshGraphTheme('dark'), compact = false): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
    const layout = await buildMeshGraphLayout(data, compact)
    const layoutNodeIds = new Set(layout.nodes.map(node => node.id))
    const flowNodes: FlowNode[] = layout.nodes.map(node => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: { graphNode: node.graphNode, compact },
        selected: node.selected,
        draggable: node.draggable,
        selectable: node.selectable,
    }))

    const flowEdges: FlowEdge[] = data.edges
        .filter(edge => layoutNodeIds.has(edge.source) && layoutNodeIds.has(edge.target))
        .map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        type: 'meshEdge',
        data: { graphEdge: edge },
        animated: edge.type === 'orphanLink',
        markerEnd: edge.direction === 'directed'
            ? {
                type: MarkerType.ArrowClosed,
                width: edge.type === 'submoduleLink' ? 16 : 18,
                height: edge.type === 'submoduleLink' ? 16 : 18,
                color: edgeColor(edge),
            }
            : undefined,
        style: {
            stroke: edgeColor(edge),
            strokeWidth: edge.type === 'orphanLink' ? 2.25 : edge.type === 'submoduleLink' ? 1.7 : edge.type === 'worktreeLink' ? 1.8 : edge.type === 'cloneLink' ? 1.6 : 2,
            strokeDasharray: edge.type === 'orphanLink' ? '5 4' : edge.type === 'submoduleLink' ? '4 3' : edge.type === 'cloneLink' ? '6 3' : undefined,
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
        case 'cloneLink':
            return '#2dd4bf'
        default:
            return '#64748b'
    }
}

function minimapNodeColor(node: FlowNode): string {
    const graphNode = node.data.graphNode
    if (graphNode.locality === 'local') return '#38bdf8'
    switch (graphNode.health) {
        case 'online':
            return '#34d399'
        case 'dirty':
            return '#fbbf24'
        case 'degraded':
        case 'offline':
            return '#fb7185'
        case 'wrong_branch':
            return '#a78bfa'
        default:
            return '#94a3b8'
    }
}

function minimapNodeClassName(node: FlowNode): string {
    const graphNode = node.data.graphNode
    return [
        'mesh-minimap-node',
        `mesh-minimap-node--${graphNode.type}`,
        `mesh-minimap-node--${graphNode.health}`,
        graphNode.isOrphan ? 'mesh-minimap-node--attention' : null,
        graphNode.dirty ? 'mesh-minimap-node--dirty' : null,
        graphNode.outOfSync ? 'mesh-minimap-node--out-of-sync' : null,
    ].filter(Boolean).join(' ')
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

function getGraphHeightClass(nodeCount: number): string {
    if (nodeCount >= 16) return 'h-[720px] min-h-[720px] sm:h-[860px] xl:h-[980px]'
    if (nodeCount >= 10) return 'h-[580px] min-h-[580px] sm:h-[700px] xl:h-[820px]'
    return 'h-[460px] min-h-[460px] sm:h-[560px] xl:h-[680px]'
}

export default function MeshGraphView({ data, selectedNodeId = null, onNodeClick }: MeshGraphViewProps) {
    const { theme } = useTheme()
    const meshTheme = useMemo(() => getMeshGraphTheme(theme), [theme])
    const dataFingerprint = useMemo(() => getMeshGraphDataFingerprint(data), [data])
    const layoutFingerprint = useMemo(() => getMeshGraphLayoutFingerprint(data), [data])
    const compact = data.nodes.length >= COMPACT_NODE_THRESHOLD
    const [layout, setLayout] = useState<{ nodes: FlowNode[]; edges: FlowEdge[] }>({ nodes: [], edges: [] })
    const surfaceRef = useRef<HTMLDivElement | null>(null)
    const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
    const viewportKey = useMemo(
        () => getMeshGraphViewportKey(data, surfaceSize.width, surfaceSize.height),
        [dataFingerprint, data, surfaceSize.height, surfaceSize.width],
    )

    useEffect(() => {
        let cancelled = false
        void buildLayout(data, meshTheme, compact).then(nextLayout => {
            if (!cancelled) setLayout(nextLayout)
        })
        return () => {
            cancelled = true
        }
    }, [data, layoutFingerprint, meshTheme, compact])

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

    const graphHeightClass = getGraphHeightClass(data.nodes.length)

    return (
        <MeshGraphThemeContext.Provider value={meshTheme}>
        <MeshGraphCompactContext.Provider value={compact}>
        <div ref={surfaceRef} className={meshTheme.graphShellClass}>
            <div className={`absolute inset-x-3 top-3 z-10 flex flex-wrap items-center justify-between gap-2 text-[11px] ${meshTheme.textSecondary}`}>
                <div className="flex flex-wrap gap-2">
                    <span className={meshTheme.graphStatChipClass}>
                        {data.stats.totalNodes} node{data.stats.totalNodes === 1 ? '' : 's'}
                    </span>
                    {data.stats.totalActiveSessions > 0 && (
                        <span className={meshTheme.isDark ? 'rounded-full border border-emerald-400/25 bg-emerald-500/12 px-3 py-1 text-emerald-100' : 'rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-emerald-700'}>
                            {data.stats.totalActiveSessions} active session{data.stats.totalActiveSessions === 1 ? '' : 's'}
                        </span>
                    )}
                    {data.stats.orphanNodes > 0 && (
                        <span className={meshTheme.isDark ? 'rounded-full border border-orange-400/25 bg-orange-500/12 px-3 py-1 text-orange-100' : 'rounded-full border border-orange-300 bg-orange-50 px-3 py-1 text-orange-700'}>
                            {data.stats.orphanNodes} need attention
                        </span>
                    )}
                    {compact && (
                        <span className={meshTheme.isDark ? 'rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-slate-400' : 'rounded-full border border-slate-200 bg-slate-50/80 px-3 py-1 text-slate-500'}>
                            dense view · hover for details
                        </span>
                    )}
                </div>
                <div className={meshTheme.graphHintChipClass}>
                    {compact ? 'drag or scroll to pan' : 'Focused on the main path first · drag or scroll to pan'}
                </div>
            </div>
            <div className={`w-full min-w-0 ${graphHeightClass}`}>
                <ReactFlow<FlowNode, FlowEdge>
                    nodes={nodes}
                    edges={layout.edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    minZoom={0.18}
                    maxZoom={1.35}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable
                    panOnDrag
                    panOnScroll
                    zoomOnScroll={false}
                    zoomOnPinch
                    zoomOnDoubleClick={false}
                    selectionOnDrag={false}
                    onNodeClick={(_, node) => onNodeClick?.(node.data.graphNode)}
                    className="h-full w-full"
                    colorMode={meshTheme.flowColorMode}
                    proOptions={{ hideAttribution: true }}
                >
                    <MeshViewportController data={data} viewportKey={viewportKey} />
                    <Controls className={meshTheme.graphControlsClass} position="bottom-left" showZoom showFitView showInteractive={false} />
                    <MiniMap
                        position="bottom-right"
                        pannable
                        zoomable
                        nodeColor={minimapNodeColor}
                        nodeClassName={minimapNodeClassName}
                        nodeStrokeWidth={3}
                        className={meshTheme.isDark ? 'overflow-hidden rounded-xl border border-white/10 bg-slate-950/85' : 'overflow-hidden rounded-xl border border-slate-200 bg-white/95'}
                    />
                    <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color={meshTheme.graphBackgroundDotColor} />
                </ReactFlow>
            </div>
        </div>
        </MeshGraphCompactContext.Provider>
        </MeshGraphThemeContext.Provider>
    )
}
