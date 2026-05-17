/**
 * MeshGraphView — React Flow-based visualization for live Repo Mesh status.
 */

import { useEffect, useMemo, useRef } from 'react'
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
import {
    getMeshGraphViewportFocusNodeIds,
    shouldShowMeshGraphCallout,
    shouldShowMeshGraphMiniMap,
} from './meshGraphViewModel'
import type { MeshGraphData, MeshGraphEdge, MeshGraphNode } from './types'

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

const COLUMN_GAP = 420
const WORKTREE_ROW_GAP = 212
const SUBMODULE_ROW_GAP = 150
const SUBMODULE_OFFSET_Y = 164
const STACK_SECTION_GAP = 32

function getHealthClasses(health: MeshGraphNode['health'], selected: boolean): string {
    const base = selected
        ? 'border-cyan-400/70 shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_24px_60px_rgba(8,145,178,0.18)]'
        : 'border-white/10 shadow-[0_18px_48px_rgba(3,7,18,0.22)]'

    switch (health) {
        case 'online':
            return `${base} bg-emerald-500/8`
        case 'dirty':
            return `${base} bg-amber-500/8`
        case 'degraded':
            return `${base} bg-rose-500/10`
        case 'wrong_branch':
            return `${base} bg-violet-500/10`
        case 'offline':
            return `${base} bg-slate-500/12`
        default:
            return `${base} bg-slate-950/78`
    }
}

function getBadgeClasses(kind: 'health' | 'dirty' | 'conflict' | 'orphan' | 'meta' | 'submodule'): string {
    switch (kind) {
        case 'health':
            return 'border-white/10 bg-slate-950/60 text-slate-200'
        case 'dirty':
            return 'border-amber-400/25 bg-amber-500/10 text-amber-200'
        case 'conflict':
            return 'border-rose-400/25 bg-rose-500/10 text-rose-200'
        case 'orphan':
            return 'border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-200'
        case 'submodule':
            return 'border-violet-400/25 bg-violet-500/10 text-violet-200'
        case 'meta':
        default:
            return 'border-cyan-400/20 bg-cyan-500/8 text-cyan-100'
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

    return (
        <div
            className={`${isSubmoduleNode ? 'w-[220px]' : 'w-[244px]'} rounded-2xl border px-4 py-3 backdrop-blur-sm transition-all ${getHealthClasses(node.health, selected)}`}
        >
            <Handle
                type="target"
                position={Position.Top}
                isConnectable={false}
                style={{ opacity: 0, pointerEvents: 'none' }}
            />
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-100">{node.label}</div>
                    <div className="truncate text-[11px] text-slate-400">{subtitle}</div>
                </div>
                <span
                    className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: getHealthDot(node.health) }}
                    aria-hidden
                />
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                <span className={`rounded-full border px-2 py-0.5 capitalize ${getBadgeClasses('health')}`}>
                    {formatHealth(node.health)}
                </span>
                {isSubmoduleNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('submodule')}`}>
                        submodule
                    </span>
                )}
                {node.branch && !isSubmoduleNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('meta')}`}>
                        {node.branch}
                    </span>
                )}
                {shortCommit && isSubmoduleNode && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('meta')}`}>
                        {shortCommit}
                    </span>
                )}
                {node.dirty && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('dirty')}`}>
                        {isSubmoduleNode ? 'local changes' : `${node.dirtyFiles} dirty`}
                    </span>
                )}
                {node.outOfSync && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('conflict')}`}>
                        out of sync
                    </span>
                )}
                {node.hasConflicts && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('conflict')}`}>
                        conflicts
                    </span>
                )}
                {node.isOrphan && (
                    <span className={`rounded-full border px-2 py-0.5 ${getBadgeClasses('orphan')}`}>
                        needs attention
                    </span>
                )}
            </div>

            {isSubmoduleNode ? (
                <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-300">
                    <span className="text-slate-500">Parent</span>
                    <span className="truncate font-medium text-slate-100">{node.machineLabel || 'mesh node'}</span>
                    <span className="text-slate-600">•</span>
                    <span className="font-medium text-slate-100">{node.outOfSync ? 'Out of sync' : node.dirty ? 'Local changes' : 'Synced'}</span>
                </div>
            ) : (
                <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-300">
                    <span className="text-slate-500">Sessions</span>
                    <span className="font-medium text-slate-100">{node.activeSessionCount}</span>
                    <span className="text-slate-600">•</span>
                    <span className="text-slate-500">Drift</span>
                    <span className="font-medium text-slate-100">+{node.ahead} / -{node.behind}</span>
                    {node.dirtyFiles > 0 && (
                        <>
                            <span className="text-slate-600">•</span>
                            <span className="font-medium text-slate-100">{node.dirtyFiles} dirty</span>
                        </>
                    )}
                </div>
            )}

            {shouldShowCallout && (
                <div className="mt-3 rounded-xl border border-cyan-400/15 bg-cyan-500/8 px-3 py-2 text-[10px] leading-4 text-cyan-50/90">
                    {node.nextStepHint}
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

function compareNodes(a: MeshGraphNode, b: MeshGraphNode): number {
    if (a.type === 'defaultBranchNode' && b.type !== 'defaultBranchNode') return -1
    if (b.type === 'defaultBranchNode' && a.type !== 'defaultBranchNode') return 1
    if (a.type === 'submoduleNode' && b.type !== 'submoduleNode') return 1
    if (b.type === 'submoduleNode' && a.type !== 'submoduleNode') return -1
    if (a.branch && b.branch && a.branch !== b.branch) return a.branch.localeCompare(b.branch)
    if (a.branch && !b.branch) return -1
    if (!a.branch && b.branch) return 1
    return a.label.localeCompare(b.label)
}

function buildLayout(data: MeshGraphData): { nodes: FlowNode[]; edges: FlowEdge[] } {
    const sortedNodes = [...data.nodes].sort(compareNodes)
    const defaultAnchor = sortedNodes.find(node => node.type === 'defaultBranchNode') ?? null
    const submoduleNodesByParent = new Map<string, MeshGraphNode[]>()

    for (const node of sortedNodes) {
        if (node.type !== 'submoduleNode' || !node.parentNodeId) continue
        const bucket = submoduleNodesByParent.get(node.parentNodeId) ?? []
        bucket.push(node)
        submoduleNodesByParent.set(node.parentNodeId, bucket)
    }

    const nonDefaultNodes = sortedNodes.filter(node => node.id !== defaultAnchor?.id && node.type !== 'submoduleNode')
    const branchGroups = new Map<string, MeshGraphNode[]>()
    const orphanNodes: MeshGraphNode[] = []

    for (const node of nonDefaultNodes) {
        if (node.isOrphan || !node.branch) {
            orphanNodes.push(node)
            continue
        }
        const key = node.branch
        const bucket = branchGroups.get(key) ?? []
        bucket.push(node)
        branchGroups.set(key, bucket)
    }

    const orderedGroups = [...branchGroups.entries()].sort(([a], [b]) => {
        if (defaultAnchor?.branch && a === defaultAnchor.branch && b !== defaultAnchor.branch) return -1
        if (defaultAnchor?.branch && b === defaultAnchor.branch && a !== defaultAnchor.branch) return 1
        return a.localeCompare(b)
    })

    if (orphanNodes.length > 0) {
        orderedGroups.push(['__orphans__', [...orphanNodes].sort(compareNodes)])
    }

    if (orderedGroups.length === 0) {
        orderedGroups.push(['__nodes__', []])
    }

    const flowNodes: FlowNode[] = []
    const groupCount = orderedGroups.length
    const totalWidth = Math.max(1, groupCount - 1) * COLUMN_GAP
    const topRowY = defaultAnchor ? 0 : 80
    const contentRowStartY = defaultAnchor ? WORKTREE_ROW_GAP : 0

    if (defaultAnchor) {
        flowNodes.push({
            id: defaultAnchor.id,
            type: 'meshNode',
            position: { x: totalWidth / 2, y: topRowY },
            data: { graphNode: defaultAnchor },
            selected: false,
            draggable: false,
            selectable: true,
        })
    }

    orderedGroups.forEach(([groupKey, groupNodes], columnIndex) => {
        const x = columnIndex * COLUMN_GAP
        const nodesForColumn = groupNodes.length > 0
            ? groupNodes
            : nonDefaultNodes.length > 0
                ? nonDefaultNodes
                : []
        let cursorY = contentRowStartY

        nodesForColumn.forEach(node => {
            flowNodes.push({
                id: node.id,
                type: 'meshNode',
                position: { x, y: cursorY },
                data: { graphNode: node },
                selected: false,
                draggable: false,
                selectable: true,
            })

            const submoduleNodes = [...(submoduleNodesByParent.get(node.id) ?? [])].sort(compareNodes)
            if (submoduleNodes.length > 0) {
                submoduleNodes.forEach((submoduleNode, submoduleIndex) => {
                    flowNodes.push({
                        id: submoduleNode.id,
                        type: 'meshNode',
                        position: { x, y: cursorY + SUBMODULE_OFFSET_Y + submoduleIndex * SUBMODULE_ROW_GAP },
                        data: { graphNode: submoduleNode },
                        selected: false,
                        draggable: false,
                        selectable: true,
                    })
                })
                cursorY += SUBMODULE_OFFSET_Y + submoduleNodes.length * SUBMODULE_ROW_GAP + STACK_SECTION_GAP
                return
            }

            cursorY += WORKTREE_ROW_GAP
        })

        if (groupKey === '__nodes__' && nonDefaultNodes.length === 0 && defaultAnchor) {
            flowNodes.push({
                id: `${defaultAnchor.id}__placeholder`,
                type: 'meshNode',
                position: { x, y: contentRowStartY },
                data: {
                    graphNode: {
                        id: `${defaultAnchor.id}__placeholder`,
                        type: 'worktreeNode',
                        label: 'No active worktrees',
                        workspace: data.repoIdentity,
                        branch: defaultAnchor.branch,
                        machineLabel: null,
                        health: 'unknown',
                        ahead: 0,
                        behind: 0,
                        dirty: false,
                        dirtyFiles: 0,
                        hasConflicts: false,
                        activeSessionCount: 0,
                        activeSessions: [],
                        providers: [],
                        isOrphan: false,
                        orphanReasons: [],
                        nextStepHint: 'Waiting for worktree nodes to report live mesh status.',
                        error: undefined,
                        parentNodeId: null,
                        submodulePath: null,
                        submoduleCommit: null,
                        outOfSync: false,
                        source: {
                            nodeId: `${defaultAnchor.id}__placeholder`,
                            machineLabel: null,
                            workspace: data.repoIdentity,
                            health: 'unknown',
                            providers: [],
                            activeSessions: [],
                        },
                    },
                },
                selected: false,
                draggable: false,
                selectable: false,
            })
        }
    })

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
            fill: 'var(--text-secondary, #cbd5e1)',
            fontSize: 10,
            fontWeight: 600,
        },
        labelBgStyle: {
            fill: 'rgba(2, 6, 23, 0.86)',
            fillOpacity: 1,
            stroke: 'rgba(148, 163, 184, 0.2)',
        },
        labelBgPadding: [5, 3],
        labelBgBorderRadius: 6,
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

function MeshGraphViewportController({
    layoutKey,
    focusNodeIds,
}: {
    layoutKey: string
    focusNodeIds: string[]
}) {
    const nodesInitialized = useNodesInitialized()
    const { fitView, getNodes } = useReactFlow<FlowNode, FlowEdge>()
    const appliedLayoutKeyRef = useRef<string | null>(null)

    useEffect(() => {
        if (!nodesInitialized) return
        if (appliedLayoutKeyRef.current === layoutKey) return

        const allNodes = getNodes()
        if (allNodes.length === 0) return
        const focusNodeIdSet = new Set(focusNodeIds)
        const primaryNodes = focusNodeIdSet.size > 0
            ? allNodes.filter(node => focusNodeIdSet.has(node.id))
            : []
        const targetNodes = primaryNodes.length > 0 ? primaryNodes : allNodes

        const frame = requestAnimationFrame(() => {
            void fitView({
                nodes: targetNodes,
                padding: primaryNodes.length > 0 ? 0.2 : 0.24,
                maxZoom: 1.08,
                duration: 0,
            })
        })

        appliedLayoutKeyRef.current = layoutKey
        return () => cancelAnimationFrame(frame)
    }, [fitView, focusNodeIds, getNodes, layoutKey, nodesInitialized])

    return null
}

export default function MeshGraphView({ data, selectedNodeId = null, onNodeClick }: MeshGraphViewProps) {
    const layout = useMemo(() => buildLayout(data), [data])
    const focusNodeIds = useMemo(() => getMeshGraphViewportFocusNodeIds(data), [data])
    const showMiniMap = useMemo(() => shouldShowMeshGraphMiniMap(data), [data])
    const layoutKey = useMemo(
        () => `${data.refreshedAt}:${data.nodes.map(node => node.id).join('|')}:${data.edges.map(edge => edge.id).join('|')}`,
        [data],
    )

    const nodes = useMemo(
        () => layout.nodes.map(node => ({ ...node, selected: node.id === selectedNodeId })),
        [layout.nodes, selectedNodeId],
    )

    return (
        <div className="relative h-full min-h-[500px] overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),_rgba(15,23,42,0.98)_42%,_rgba(2,6,23,1))]">
            <div className="absolute left-4 top-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap gap-2 text-[11px] text-slate-200">
                <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1">
                    {data.stats.totalNodes} node{data.stats.totalNodes === 1 ? '' : 's'}
                </span>
                <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1">
                    {data.stats.totalActiveSessions} active session{data.stats.totalActiveSessions === 1 ? '' : 's'}
                </span>
                <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-slate-300">
                    drag or scroll to pan
                </span>
                {data.stats.orphanNodes > 0 && (
                    <span className="rounded-full border border-orange-400/25 bg-orange-500/12 px-3 py-1 text-orange-100">
                        {data.stats.orphanNodes} need attention
                    </span>
                )}
            </div>
            <ReactFlow<FlowNode, FlowEdge>
                nodes={nodes}
                edges={layout.edges}
                nodeTypes={nodeTypes}
                minZoom={0.35}
                maxZoom={1.4}
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
                colorMode="dark"
                proOptions={{ hideAttribution: true }}
            >
                <MeshGraphViewportController layoutKey={layoutKey} focusNodeIds={focusNodeIds} />
                {showMiniMap && (
                    <MiniMap
                        className="!bottom-4 !right-4 !bg-slate-950/85 !border !border-white/10 !rounded-xl"
                        nodeColor={currentNode => getHealthDot((currentNode.data as FlowNodeData).graphNode.health)}
                    />
                )}
                <Controls className="!bottom-4 !left-4 !shadow-lg" showInteractive={false} />
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="rgba(148, 163, 184, 0.22)" />
            </ReactFlow>
        </div>
    )
}
