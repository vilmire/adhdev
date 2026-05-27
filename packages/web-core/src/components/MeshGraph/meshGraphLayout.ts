/**
 * Deterministic Repo Mesh graph layout helpers.
 *
 * Keep the spacing model close to the card renderer: when card chrome grows
 * (badges, summaries, callouts, submodule rows), update the estimator here so
 * React Flow positions keep using the same effective geometry humans see.
 */

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
    columnGap: 540,
    edgeLabelBuffer: 180,
    defaultToContentGap: 136,
    worktreeStackGap: 82,
    parentToSubmoduleGap: 48,
    submoduleStackGap: 36,
    siblingGapX: 56,
    siblingRowGap: 72,
    placeholderTopOffset: 0,
} as const

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
}

function estimateTextLines(value: string | null | undefined, charsPerLine: number, maxLines: number): number {
    const text = (value || '').trim()
    if (!text) return 0
    return Math.max(1, Math.min(maxLines, Math.ceil(text.length / charsPerLine)))
}

function countRenderedBadges(node: MeshGraphNode): number {
    let count = 1 // health badge is always visible
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

export function getMeshGraphNodeCardWidth(node: MeshGraphNode): number {
    return node.type === 'submoduleNode'
        ? MESH_GRAPH_LAYOUT.submoduleCardWidth
        : MESH_GRAPH_LAYOUT.worktreeCardWidth
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

export function estimateMeshGraphNodeHeight(node: MeshGraphNode): number {
    const width = getMeshGraphNodeCardWidth(node)
    const charsPerLine = node.type === 'submoduleNode' ? 24 : 30
    const badgeRows = Math.ceil(countRenderedBadges(node) / (node.type === 'submoduleNode' ? 2 : 3))
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
        ? MESH_GRAPH_LAYOUT.minSubmoduleCardHeight
        : MESH_GRAPH_LAYOUT.minWorktreeCardHeight
    return Math.min(MESH_GRAPH_LAYOUT.maxEstimatedCardHeight, Math.max(minHeight, Math.ceil(estimated)))
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

function estimateEdgeLabelWidth(label: string | null | undefined): number {
    if (!label) return 0
    return Math.min(260, Math.max(72, label.length * 7 + 26))
}

function computeColumnGap(data: MeshGraphData): number {
    const widestEdgeLabel = data.edges.reduce((widest, edge) => Math.max(widest, estimateEdgeLabelWidth(edge.label)), 0)
    return Math.max(
        MESH_GRAPH_LAYOUT.columnGap,
        MESH_GRAPH_LAYOUT.worktreeCardWidth + widestEdgeLabel + MESH_GRAPH_LAYOUT.edgeLabelBuffer,
    )
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

function chunkSiblings(nodes: MeshGraphNode[], maxPerRow: number): MeshGraphNode[][] {
    const rows: MeshGraphNode[][] = []
    for (let index = 0; index < nodes.length; index += maxPerRow) {
        rows.push(nodes.slice(index, index + maxPerRow))
    }
    return rows
}

function maxRowHeight(nodes: MeshGraphNode[]): number {
    return nodes.reduce((height, node) => Math.max(height, estimateMeshGraphNodeHeight(node)), 0)
}

function getSiblingRowWidth(nodes: MeshGraphNode[]): number {
    if (nodes.length === 0) return 0
    return nodes.reduce((width, node) => width + getMeshGraphNodeCardWidth(node), 0)
        + Math.max(0, nodes.length - 1) * MESH_GRAPH_LAYOUT.siblingGapX
}

function getSpacedRowWidth(widths: number[]): number {
    if (widths.length === 0) return 0
    return widths.reduce((total, width) => total + width, 0)
        + Math.max(0, widths.length - 1) * MESH_GRAPH_LAYOUT.siblingGapX
}

function placeSiblingRows(args: {
    nodes: MeshGraphNode[]
    centerX: number
    startY: number
    maxPerRow: number
    flowNodes: MeshGraphLayoutNode[]
    bounds: MeshGraphLayoutBounds[]
}): number {
    let cursorY = args.startY
    for (const row of chunkSiblings(args.nodes, args.maxPerRow)) {
        const rowWidth = getSiblingRowWidth(row)
        let cursorX = args.centerX - rowWidth / 2
        for (const node of row) {
            args.flowNodes.push(toLayoutNode(node, cursorX, cursorY))
            args.bounds.push(makeBounds(node, cursorX, cursorY))
            cursorX += getMeshGraphNodeCardWidth(node) + MESH_GRAPH_LAYOUT.siblingGapX
        }
        cursorY += maxRowHeight(row) + MESH_GRAPH_LAYOUT.siblingRowGap
    }
    return cursorY
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

export function buildMeshGraphLayout(data: MeshGraphData): MeshGraphLayoutResult {
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
        const bucket = branchGroups.get(node.branch) ?? []
        bucket.push(node)
        branchGroups.set(node.branch, bucket)
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

    const getNodeSubtreeWidth = (node: MeshGraphNode): number => {
        const submoduleRows = chunkSiblings([...(submoduleNodesByParent.get(node.id) ?? [])].sort(compareNodes), 3)
        const widestSubmoduleRow = submoduleRows.reduce((widest, row) => Math.max(widest, getSiblingRowWidth(row)), 0)
        return Math.max(getMeshGraphNodeCardWidth(node), widestSubmoduleRow)
    }

    const getWorktreeRowWidth = (nodes: MeshGraphNode[]): number => getSpacedRowWidth(nodes.map(getNodeSubtreeWidth))

    const getGroupWidth = (nodes: MeshGraphNode[]): number => {
        const rows = chunkSiblings(nodes, 3)
        return rows.reduce((widest, row) => Math.max(widest, getWorktreeRowWidth(row)), 0)
    }

    const flowNodes: MeshGraphLayoutNode[] = []
    const bounds: MeshGraphLayoutBounds[] = []
    const groupCount = orderedGroups.length
    const widestGroup = orderedGroups.reduce((widest, [, groupNodes]) => Math.max(widest, getGroupWidth(groupNodes)), 0)
    const columnGap = Math.max(computeColumnGap(data), widestGroup + MESH_GRAPH_LAYOUT.edgeLabelBuffer)
    const totalWidth = Math.max(1, groupCount - 1) * columnGap
    const topRowY = defaultAnchor ? 0 : 96
    const defaultAnchorHeight = defaultAnchor ? estimateMeshGraphNodeHeight(defaultAnchor) : 0
    const contentRowStartY = defaultAnchor
        ? topRowY + defaultAnchorHeight + MESH_GRAPH_LAYOUT.defaultToContentGap
        : 0

    if (defaultAnchor) {
        const x = totalWidth / 2
        flowNodes.push(toLayoutNode(defaultAnchor, x, topRowY))
        bounds.push(makeBounds(defaultAnchor, x, topRowY))
    }

    orderedGroups.forEach(([groupKey, groupNodes], columnIndex) => {
        const groupCenterX = columnIndex * columnGap
        const nodesForColumn = groupNodes.length > 0
            ? groupNodes
            : nonDefaultNodes.length > 0
                ? nonDefaultNodes
                : []
        let cursorY = contentRowStartY
        const worktreeRows = chunkSiblings(nodesForColumn, 3)

        for (const row of worktreeRows) {
            const rowWidth = getWorktreeRowWidth(row)
            let subtreeCursorX = groupCenterX - rowWidth / 2
            const rowY = cursorY
            const rowBottomY = rowY + maxRowHeight(row)
            let deepestY = rowBottomY

            for (const node of row) {
                const nodeWidth = getMeshGraphNodeCardWidth(node)
                const subtreeWidth = getNodeSubtreeWidth(node)
                const subtreeCenterX = subtreeCursorX + subtreeWidth / 2
                const nodeX = subtreeCenterX - nodeWidth / 2
                flowNodes.push(toLayoutNode(node, nodeX, rowY))
                bounds.push(makeBounds(node, nodeX, rowY))

                const submoduleNodes = [...(submoduleNodesByParent.get(node.id) ?? [])].sort(compareNodes)
                if (submoduleNodes.length > 0) {
                    const submoduleEndY = placeSiblingRows({
                        nodes: submoduleNodes,
                        centerX: subtreeCenterX,
                        startY: rowBottomY + MESH_GRAPH_LAYOUT.parentToSubmoduleGap,
                        maxPerRow: 3,
                        flowNodes,
                        bounds,
                    })
                    deepestY = Math.max(deepestY, submoduleEndY - MESH_GRAPH_LAYOUT.siblingRowGap)
                }

                subtreeCursorX += subtreeWidth + MESH_GRAPH_LAYOUT.siblingGapX
            }

            cursorY = deepestY + MESH_GRAPH_LAYOUT.worktreeStackGap
        }

        if (groupKey === '__nodes__' && nonDefaultNodes.length === 0 && defaultAnchor) {
            const placeholder = createPlaceholderNode(defaultAnchor, data)
            const y = contentRowStartY + MESH_GRAPH_LAYOUT.placeholderTopOffset
            flowNodes.push(toLayoutNode(placeholder, groupCenterX, y, false))
            bounds.push(makeBounds(placeholder, groupCenterX, y))
        }
    })

    return { nodes: flowNodes, bounds, columnGap }
}
