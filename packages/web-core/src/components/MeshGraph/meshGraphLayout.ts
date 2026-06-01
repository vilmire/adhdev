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
    submoduleCardWidth: 164,
    minWorktreeCardHeight: 68,
    minSubmoduleCardHeight: 56,
    maxEstimatedCardHeight: 120,
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

export const MESH_GRAPH_LAYOUT_DIRECTION = 'RIGHT' as const

export const MESH_GRAPH_ELK_OPTIONS: LayoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': MESH_GRAPH_LAYOUT_DIRECTION,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': String(MESH_GRAPH_LAYOUT.nodeGap),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(MESH_GRAPH_LAYOUT.layerGap),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(MESH_GRAPH_LAYOUT.edgeLabelBuffer),
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.layered.mergeEdges': 'false',
    'elk.randomSeed': '1',
}

export const MESH_GRAPH_ELK_OPTIONS_COMPACT: LayoutOptions = {
    ...MESH_GRAPH_ELK_OPTIONS,
    'elk.spacing.nodeNode': String(MESH_GRAPH_LAYOUT_COMPACT.nodeGap),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(MESH_GRAPH_LAYOUT_COMPACT.layerGap),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(MESH_GRAPH_LAYOUT_COMPACT.edgeLabelBuffer),
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

export interface MeshGraphLayoutResult {
    nodes: MeshGraphLayoutNode[]
    bounds: MeshGraphLayoutBounds[]
    columnGap: number
    layoutOptions: LayoutOptions
}

const elk = new ELK()

function estimateTextLines(value: string | null | undefined, charsPerLine: number, maxLines: number): number {
    const text = (value || '').trim()
    if (!text) return 0
    return Math.max(1, Math.min(maxLines, Math.ceil(text.length / charsPerLine)))
}

const BADGE_WIDTH_APPROX_PX = 6.2 // chars/px at 10px sans-serif
const BADGE_H_PAD_PX = 20 // px-2 * 2 sides

function estimateBadgeWidth(text: string): number {
    return Math.ceil(text.length * BADGE_WIDTH_APPROX_PX) + BADGE_H_PAD_PX
}

function estimateBadgeRows(node: MeshGraphNode, cardWidth: number): number {
    const contentWidth = cardWidth - 32 // px-4 * 2 sides
    const badges: string[] = []
    badges.push(node.health.replace(/_/g, ' '))
    if (node.type === 'submoduleNode') {
        badges.push('submodule')
    } else {
        badges.push(node.locality === 'remote' ? 'remote' : 'local')
    }
    if (node.branch && node.type !== 'submoduleNode') badges.push(node.branch)
    if (node.submoduleCommit && node.type === 'submoduleNode') badges.push(node.submoduleCommit.slice(0, 7))
    if (node.dirty) badges.push(node.type === 'submoduleNode' ? 'local changes' : `${node.dirtyFiles} dirty`)
    if (node.outOfSync) badges.push('out of sync')
    if (node.hasConflicts) badges.push('conflicts')
    if (node.type !== 'submoduleNode' && node.upstream && node.upstreamStatus !== 'fresh') badges.push('upstream unverified')
    if (node.isOrphan) badges.push('needs follow-up')

    let rows = 0
    let rowWidth = 0
    for (const badge of badges) {
        const w = estimateBadgeWidth(badge) + 6 // gap-1.5 = 6px
        if (rowWidth > 0 && rowWidth + w > contentWidth) {
            rows += 1
            rowWidth = w
        } else {
            rowWidth += w
        }
    }
    if (rowWidth > 0) rows += 1
    return Math.max(1, rows)
}

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
    if (compact) {
        const attentionBadge = getMeshGraphAttentionBadge(node)
        const isDefaultBranchNode = node.type === 'defaultBranchNode'
        const hasBranchBadge = !attentionBadge && node.branch && node.type !== 'submoduleNode'
        // py-2.5*2=20 + title~16 + subtitle~14 + (attention mt-1.5+18=24 | branch mt-1+14=16 | nothing~0)
        const estimated = 20
            + 16
            + (isDefaultBranchNode ? 0 : 14)
            + (attentionBadge ? 24 : hasBranchBadge ? 16 : 0)
        const minHeight = node.type === 'submoduleNode'
            ? layout.minSubmoduleCardHeight
            : layout.minWorktreeCardHeight
        return Math.min(layout.maxEstimatedCardHeight, Math.max(minHeight, Math.ceil(estimated)))
    }
    const width = getMeshGraphNodeCardWidth(node)
    const charsPerLine = node.type === 'submoduleNode' ? 24 : 30
    const badgeRows = estimateBadgeRows(node, width)
    const titleLines = estimateTextLines(node.label, charsPerLine, 2)
    const subtitleLines = estimateTextLines(node.type === 'submoduleNode' ? node.submodulePath : node.machineLabel || node.workspace, charsPerLine, 2)
    const summaryLines = estimateTextLines(getNodeSummaryForLayout(node), charsPerLine + 4, 3)
    const attentionBadge = getMeshGraphAttentionBadge(node)
    const calloutText = shouldShowMeshGraphCallout(node) ? getMeshGraphCalloutText(node) : null
    const calloutLines = estimateTextLines(calloutText, Math.max(24, Math.floor(width / 8)), 4)

    const estimated = 52
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

export function buildMeshGraphElkInput(data: MeshGraphData, layoutOptions: LayoutOptions = MESH_GRAPH_ELK_OPTIONS, compact = false): ElkNode {
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

export async function buildMeshGraphLayout(data: MeshGraphData, compact = false): Promise<MeshGraphLayoutResult> {
    const layoutOptions = compact ? MESH_GRAPH_ELK_OPTIONS_COMPACT : MESH_GRAPH_ELK_OPTIONS
    const graphNodes = getOrderedGraphNodes(data)
    const graphNodeById = new Map(graphNodes.map(node => [node.id, node]))
    const elkGraph = await elk.layout(buildMeshGraphElkInput(data, layoutOptions, compact))
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
    return {
        nodes: layoutNodes,
        bounds,
        columnGap: calculateColumnGap(bounds, compact),
        layoutOptions: { ...layoutOptions },
    }
}
