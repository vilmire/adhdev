/**
 * Deterministic Repo Mesh graph layout helpers backed by ELK layered layout.
 *
 * Keep node dimensions close to the card renderer: when card chrome grows
 * (badges, summaries, callouts, submodule rows), update the estimator here so
 * ELK receives the same effective geometry humans see.
 */

import ELK, { type ElkExtendedEdge, type ElkNode, type LayoutOptions } from 'elkjs/lib/elk.bundled.js'
import type { MeshGraphData, MeshGraphNode } from './types'
import {
    formatMeshGraphAheadBehind,
    getMeshGraphAttentionBadge,
    getMeshGraphCalloutText,
    shouldShowMeshGraphCallout,
} from './meshGraphViewModel'

export const MESH_GRAPH_LAYOUT = {
    worktreeCardWidth: 256,
    submoduleCardWidth: 228,
    minWorktreeCardHeight: 174,
    minSubmoduleCardHeight: 146,
    maxEstimatedCardHeight: 304,
    layerGap: 220,
    nodeGap: 82,
    edgeLabelBuffer: 180,
    placeholderTopOffset: 0,
} as const

export const MESH_GRAPH_LAYOUT_COMPACT = {
    worktreeCardWidth: 188,
    submoduleCardWidth: 188,
    minWorktreeCardHeight: 88,
    minSubmoduleCardHeight: 88,
    maxEstimatedCardHeight: 178,
    layerGap: 160,
    nodeGap: 52,
    edgeLabelBuffer: 120,
    placeholderTopOffset: 0,
} as const

export const MESH_GRAPH_EDGE_LABEL = {
    maxWidth: 180,
    minWidth: 44,
    height: 24,
    charWidth: 6.2,
    horizontalPadding: 18,
} as const

export type MeshGraphDirection = 'LR' | 'TB'

export const MESH_GRAPH_LAYOUT_DIRECTION: MeshGraphDirection = 'LR'

function elkDirection(dir: MeshGraphDirection): 'RIGHT' | 'DOWN' {
    return dir === 'TB' ? 'DOWN' : 'RIGHT'
}

interface MeshGraphLayoutShape {
    readonly worktreeCardWidth: number
    readonly submoduleCardWidth: number
    readonly minWorktreeCardHeight: number
    readonly minSubmoduleCardHeight: number
    readonly maxEstimatedCardHeight: number
    readonly layerGap: number
    readonly nodeGap: number
    readonly edgeLabelBuffer: number
    readonly placeholderTopOffset: number
}

function elkOptionsFor(layout: MeshGraphLayoutShape, dir: MeshGraphDirection): LayoutOptions {
    return {
        'elk.algorithm': 'layered',
        'elk.direction': elkDirection(dir),
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': String(layout.nodeGap),
        'elk.layered.spacing.nodeNodeBetweenLayers': String(layout.layerGap),
        'elk.layered.spacing.edgeNodeBetweenLayers': String(layout.edgeLabelBuffer),
        'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.layered.cycleBreaking.strategy': 'GREEDY',
        'elk.layered.mergeEdges': 'false',
        'elk.randomSeed': '1',
    }
}

export const MESH_GRAPH_ELK_OPTIONS: LayoutOptions = elkOptionsFor(MESH_GRAPH_LAYOUT, 'LR')

export const MESH_GRAPH_ELK_OPTIONS_COMPACT: LayoutOptions = elkOptionsFor(MESH_GRAPH_LAYOUT_COMPACT, 'LR')

/**
 * Heuristic: TB reads better when there are many nodes but the dominant
 * connection pattern is shallow fan-out (few hops, many siblings). LR wins
 * when there's a real left-to-right pipeline. Anything else, leave LR.
 */
export function pickMeshGraphDirection(data: MeshGraphData): MeshGraphDirection {
    const nodeCount = data.nodes.length
    if (nodeCount < 8) return 'LR'
    const outDegree = new Map<string, number>()
    for (const edge of data.edges) {
        outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1)
    }
    let maxFanOut = 0
    for (const count of outDegree.values()) {
        if (count > maxFanOut) maxFanOut = count
    }
    // Wide fan-out from a single hub on dense graphs → TB usually wins.
    if (maxFanOut >= Math.max(6, Math.floor(nodeCount / 2))) return 'TB'
    return 'LR'
}

type MeshGraphLayoutNodeKind = 'meshNode'

export interface MeshGraphLayoutNode {
    id: string
    type: MeshGraphLayoutNodeKind
    position: { x: number; y: number }
    graphNode: MeshGraphNode
    selected: false
    draggable: false
    selectable: boolean
}

export interface MeshGraphLayoutBounds {
    id: string
    x: number
    y: number
    width: number
    height: number
}

export interface MeshGraphLayoutEdgePoint {
    x: number
    y: number
}

export interface MeshGraphLayoutEdgeRoute {
    id: string
    source: string
    target: string
    points: MeshGraphLayoutEdgePoint[]
}

export interface MeshGraphLayoutResult {
    nodes: MeshGraphLayoutNode[]
    bounds: MeshGraphLayoutBounds[]
    edgeRoutes: Map<string, MeshGraphLayoutEdgeRoute>
    columnGap: number
    layoutOptions: LayoutOptions
}

const elk = new ELK()

export function getMeshGraphNodeCardWidth(node: MeshGraphNode, compact = false): number {
    const layout = compact ? MESH_GRAPH_LAYOUT_COMPACT : MESH_GRAPH_LAYOUT
    return node.type === 'submoduleNode' ? layout.submoduleCardWidth : layout.worktreeCardWidth
}

export function getNodeSummaryForLayout(node: MeshGraphNode): string {
    if (node.type === 'defaultBranchNode') {
        return node.nextStepHint || 'Default branch anchor'
    }

    if (node.type === 'submoduleNode') {
        const parts = [node.machineLabel ? `parent ${node.machineLabel}` : null]
        if (node.outOfSync) parts.push('out of sync')
        else if (node.dirty) parts.push('local changes')
        else parts.push('synced')
        return parts.filter(Boolean).join(' · ')
    }

    const parts: string[] = []
    if (node.upstream) parts.push(node.upstream)
    if (node.upstream && node.upstreamStatus !== 'fresh') {
        parts.push('upstream unverified')
    } else {
        const drift = formatMeshGraphAheadBehind(node)
        if (drift) parts.push(drift)
    }
    if (node.activeSessionCount > 0) parts.push(`${node.activeSessionCount} session${node.activeSessionCount === 1 ? '' : 's'}`)
    if (node.dirtyFiles > 0) parts.push(`${node.dirtyFiles} dirty`)
    if (node.hasConflicts) parts.push('conflicts')
    if (parts.length === 0) return node.branchConvergence?.needsConvergence ? 'Needs follow-up' : 'Clean and even with upstream'
    return parts.join(' · ')
}

export function estimateMeshGraphNodeHeight(node: MeshGraphNode, compact = false): number {
    const layout = compact ? MESH_GRAPH_LAYOUT_COMPACT : MESH_GRAPH_LAYOUT
    const width = getMeshGraphNodeCardWidth(node, compact)
    const charsPerLine = compact
        ? (node.type === 'submoduleNode' ? 20 : 22)
        : (node.type === 'submoduleNode' ? 24 : 30)
    const badgesPerRow = compact
        ? (node.type === 'submoduleNode' ? 2 : 2)
        : (node.type === 'submoduleNode' ? 2 : 3)
    const badgeRows = Math.ceil(countRenderedBadges(node) / badgesPerRow)
    const titleLines = estimateTextLines(node.label, charsPerLine, compact ? 2 : 2)
    const subtitleLines = estimateTextLines(
        node.type === 'submoduleNode' ? node.submodulePath : node.machineLabel || node.workspace,
        charsPerLine,
        compact ? 2 : 2,
    )
    const summaryLines = estimateTextLines(getNodeSummaryForLayout(node), charsPerLine + (compact ? 1 : 4), compact ? 2 : 3)
    const attentionBadge = getMeshGraphAttentionBadge(node)
    const calloutText = shouldShowMeshGraphCallout(node) ? getMeshGraphCalloutText(node) : null
    const calloutLines = compact
        ? 0
        : estimateTextLines(calloutText, Math.max(24, Math.floor(width / 8)), 4)

    const estimated = compact
        ? 40
            + titleLines * 16
            + subtitleLines * 12
            + (attentionBadge ? 22 : 0)
            + Math.max(0, badgeRows - 1) * 18
            + Math.max(18, summaryLines * 16)
        : 52
            + titleLines * 18
            + subtitleLines * 14
            + (attentionBadge ? 30 : 0)
            + badgeRows * 24
            + Math.max(22, summaryLines * 18)
            + (calloutLines > 0 ? 22 + calloutLines * 16 : 0)

    const minHeight = node.type === 'submoduleNode'
        ? layout.minSubmoduleCardHeight
        : layout.minWorktreeCardHeight
    return Math.min(layout.maxEstimatedCardHeight, Math.max(minHeight, Math.ceil(estimated)))
}

function estimateTextLines(value: string | null | undefined, charsPerLine: number, maxLines: number): number {
    const text = (value || '').trim()
    if (!text) return 0
    return Math.max(1, Math.min(maxLines, Math.ceil(text.length / charsPerLine)))
}

function countRenderedBadges(node: MeshGraphNode): number {
    let count = 1
    if (node.type === 'submoduleNode') count += 1
    if (node.branch && node.type !== 'submoduleNode') count += 1
    if (node.submoduleCommit && node.type === 'submoduleNode') count += 1
    if (node.dirty) count += 1
    if (node.outOfSync) count += 1
    if (node.hasConflicts) count += 1
    if (node.type !== 'submoduleNode' && node.upstream && node.upstreamStatus !== 'fresh') count += 1
    if (node.isOrphan) count += 1
    return count
}

function compareNodes(a: MeshGraphNode, b: MeshGraphNode): number {
    if (a.type === 'defaultBranchNode' && b.type !== 'defaultBranchNode') return -1
    if (b.type === 'defaultBranchNode' && a.type !== 'defaultBranchNode') return 1
    if (a.type === 'submoduleNode' && b.type !== 'submoduleNode') return 1
    if (b.type === 'submoduleNode' && a.type !== 'submoduleNode') return -1
    if (a.branch && b.branch && a.branch !== b.branch) return a.branch.localeCompare(b.branch)
    if (a.branch && !b.branch) return -1
    if (!a.branch && b.branch) return 1
    return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

function compareEdges(a: { id: string; source: string; target: string }, b: { id: string; source: string; target: string }): number {
    return a.source.localeCompare(b.source)
        || a.target.localeCompare(b.target)
        || a.id.localeCompare(b.id)
}

function toLayoutNode(node: MeshGraphNode, x: number, y: number, selectable = true): MeshGraphLayoutNode {
    return {
        id: node.id,
        type: 'meshNode',
        position: { x, y },
        graphNode: node,
        selected: false,
        draggable: false,
        selectable,
    }
}

function makeBounds(node: MeshGraphNode, x: number, y: number): MeshGraphLayoutBounds {
    return {
        id: node.id,
        x,
        y,
        width: getMeshGraphNodeCardWidth(node),
        height: estimateMeshGraphNodeHeight(node),
    }
}

export function estimateMeshGraphEdgeLabelWidth(label: string | null | undefined): number {
    const text = (label || '').trim()
    if (!text) return 0
    return Math.max(
        MESH_GRAPH_EDGE_LABEL.minWidth,
        Math.min(
            MESH_GRAPH_EDGE_LABEL.maxWidth,
            Math.ceil(text.length * MESH_GRAPH_EDGE_LABEL.charWidth) + MESH_GRAPH_EDGE_LABEL.horizontalPadding,
        ),
    )
}

export function estimateMeshGraphEdgeLabelBounds(
    edge: { source: string; target: string; label?: string },
    nodes: MeshGraphLayoutNode[],
    compact = false,
): MeshGraphLayoutBounds | null {
    const source = nodes.find(node => node.id === edge.source)
    const target = nodes.find(node => node.id === edge.target)
    const width = estimateMeshGraphEdgeLabelWidth(edge.label)
    if (!source || !target || width <= 0) return null

    const sourceWidth = getMeshGraphNodeCardWidth(source.graphNode, compact)
    const sourceHeight = estimateMeshGraphNodeHeight(source.graphNode, compact)
    const targetHeight = estimateMeshGraphNodeHeight(target.graphNode, compact)
    const sourceCenter = {
        x: source.position.x + sourceWidth,
        y: source.position.y + sourceHeight / 2,
    }
    const targetCenter = {
        x: target.position.x,
        y: target.position.y + targetHeight / 2,
    }
    const centerX = (sourceCenter.x + targetCenter.x) / 2
    const centerY = (sourceCenter.y + targetCenter.y) / 2

    return {
        id: edge.label ? `${edge.source}--${edge.target}::label` : `${edge.source}--${edge.target}::label-empty`,
        x: Math.round(centerX - width / 2),
        y: Math.round(centerY - MESH_GRAPH_EDGE_LABEL.height / 2),
        width,
        height: MESH_GRAPH_EDGE_LABEL.height,
    }
}

function createPlaceholderNode(defaultAnchor: MeshGraphNode, data: MeshGraphData): MeshGraphNode {
    return {
        id: `${defaultAnchor.id}__placeholder`,
        type: 'worktreeNode',
        label: 'No active worktrees',
        workspace: data.repoIdentity,
        branch: defaultAnchor.branch,
        upstream: null,
        upstreamStatus: null,
        daemonId: null,
        machineId: null,
        machineLabel: null,
        locality: 'unknown',
        health: 'unknown',
        ahead: 0,
        behind: 0,
        dirty: false,
        dirtyFiles: 0,
        hasConflicts: false,
        activeSessionCount: 0,
        activeSessions: [],
        sessionDetails: [],
        providers: [],
        isOrphan: false,
        orphanReasons: [],
        nextStepHint: 'Waiting for worktree nodes to report live mesh status.',
        error: undefined,
        parentNodeId: null,
        submodulePath: null,
        submoduleCommit: null,
        outOfSync: false,
        snapshotCompleteness: 'complete',
        snapshotWarnings: [],
        branchConvergence: null,
        source: {
            nodeId: `${defaultAnchor.id}__placeholder`,
            machineLabel: '',
            workspace: data.repoIdentity,
            health: 'unknown',
            providers: [],
            activeSessions: [],
        },
    }
}

function getOrderedGraphNodes(data: MeshGraphData): MeshGraphNode[] {
    const sortedNodes = [...data.nodes].sort(compareNodes)
    const defaultAnchor = sortedNodes.find(node => node.type === 'defaultBranchNode') ?? null
    const hasVisibleWorktree = sortedNodes.some(node => node.id !== defaultAnchor?.id && node.type !== 'submoduleNode')

    if (!defaultAnchor || hasVisibleWorktree) return sortedNodes
    return [...sortedNodes, createPlaceholderNode(defaultAnchor, data)]
}

export function buildMeshGraphElkInput(data: MeshGraphData, layoutOptions: LayoutOptions = MESH_GRAPH_ELK_OPTIONS, compact = false, _direction: MeshGraphDirection = 'LR'): ElkNode {
    void _direction
    const nodes = getOrderedGraphNodes(data)
    const nodeIds = new Set(nodes.map(node => node.id))
    const children: ElkNode[] = nodes.map(node => ({
        id: node.id,
        width: getMeshGraphNodeCardWidth(node, compact),
        height: estimateMeshGraphNodeHeight(node, compact),
    }))
    const edges: ElkExtendedEdge[] = data.edges
        .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
        .sort(compareEdges)
        .map(edge => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
        }))

    return {
        id: `${data.meshId || 'mesh'}__elk_root`,
        layoutOptions: { ...layoutOptions },
        children,
        edges,
    }
}

function calculateColumnGap(bounds: MeshGraphLayoutBounds[], compact = false): number {
    const xs = [...new Set(bounds.map(bound => Math.round(bound.x)))].sort((a, b) => a - b)
    const fallback = compact ? MESH_GRAPH_LAYOUT_COMPACT.layerGap : MESH_GRAPH_LAYOUT.layerGap
    if (xs.length < 2) return fallback
    return Math.min(...xs.slice(1).map((x, index) => x - xs[index]))
}

export async function buildMeshGraphLayout(data: MeshGraphData, compact = false, direction: MeshGraphDirection = 'LR'): Promise<MeshGraphLayoutResult> {
    const baseLayout = compact ? MESH_GRAPH_LAYOUT_COMPACT : MESH_GRAPH_LAYOUT
    const layoutOptions = elkOptionsFor(baseLayout, direction)
    const graphNodes = getOrderedGraphNodes(data)
    const graphNodeById = new Map(graphNodes.map(node => [node.id, node]))
    const elkGraph = await elk.layout(buildMeshGraphElkInput(data, layoutOptions, compact, direction))
    const layoutNodes = (elkGraph.children ?? [])
        .map(node => {
            const graphNode = graphNodeById.get(node.id)
            if (!graphNode) return null
            return toLayoutNode(
                graphNode,
                Math.round(node.x ?? 0),
                Math.round(node.y ?? MESH_GRAPH_LAYOUT.placeholderTopOffset),
                !node.id.endsWith('__placeholder'),
            )
        })
        .filter(Boolean) as MeshGraphLayoutNode[]

    const order = new Map(graphNodes.map((node, index) => [node.id, index]))
    layoutNodes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

    const bounds = layoutNodes.map(node => makeBounds(node.graphNode, node.position.x, node.position.y))

    const edgeRoutes = new Map<string, MeshGraphLayoutEdgeRoute>()
    for (const elkEdge of elkGraph.edges ?? []) {
        const sections = elkEdge.sections
        if (!sections || sections.length === 0) continue
        const section = sections[0]
        const source = elkEdge.sources?.[0]
        const target = elkEdge.targets?.[0]
        if (!source || !target) continue
        const points: MeshGraphLayoutEdgePoint[] = []
        points.push({ x: Math.round(section.startPoint.x), y: Math.round(section.startPoint.y) })
        for (const bend of section.bendPoints ?? []) {
            points.push({ x: Math.round(bend.x), y: Math.round(bend.y) })
        }
        points.push({ x: Math.round(section.endPoint.x), y: Math.round(section.endPoint.y) })
        edgeRoutes.set(elkEdge.id, { id: elkEdge.id, source, target, points })
    }

    return {
        nodes: layoutNodes,
        bounds,
        edgeRoutes,
        columnGap: calculateColumnGap(bounds, compact),
        layoutOptions: { ...layoutOptions },
    }
}
