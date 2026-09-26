/**
 * blueprintGraphLayout — geometry for the Blueprint graph view.
 *
 * Each visible lane (mission / graph / chain / ad-hoc group) is laid out on
 * its own with ELK layered, left → right; lanes then stack top → bottom with a
 * labelled header band. Per-lane layout keeps every lane readable on its own
 * (a mission never interleaves with another one's columns) and keeps ELK's
 * inputs small — 200 tasks spread across lanes is many small layouts, not one
 * big one. A lane with no internal edges (the ad-hoc bucket) is a plain grid:
 * layered placement would stack it into one very tall column.
 *
 * Node sizes are FIXED per kind, so geometry depends only on the structure
 * key (blueprintGraphStructureKey) — never on measured DOM or on status.
 */
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { BlueprintGraphNode, BlueprintGraphViewResult } from './blueprintGraphModel'

export const BLUEPRINT_GRAPH_SIZES = {
    task: { width: 232, height: 78 },
    gate: { width: 176, height: 58 },
    fold: { width: 150, height: 44 },
} as const

export const BLUEPRINT_GRAPH_LANE = {
    headerHeight: 34,
    padding: 16,
    gap: 22,
    collapsedHeight: 38,
    minWidth: 320,
    gridColumns: 4,
    gridGapX: 22,
    gridGapY: 18,
} as const

const ELK_LANE_OPTIONS = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': '22',
    'elk.layered.spacing.nodeNodeBetweenLayers': '64',
    'elk.layered.spacing.edgeNodeBetweenLayers': '18',
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.separateConnectedComponents': 'true',
    'elk.spacing.componentComponent': '26',
    'elk.randomSeed': '1',
}

export function blueprintGraphNodeSize(node: Pick<BlueprintGraphNode, 'kind'>): { width: number; height: number } {
    return BLUEPRINT_GRAPH_SIZES[node.kind]
}

export interface BlueprintGraphLaneRect {
    key: string
    x: number
    y: number
    width: number
    height: number
}

export interface BlueprintGraphLayout {
    /** Absolute top-left per visible node. */
    positions: Map<string, { x: number; y: number }>
    lanes: BlueprintGraphLaneRect[]
}

let elkInstance: InstanceType<typeof ELK> | null = null
function elk(): InstanceType<typeof ELK> {
    if (!elkInstance) elkInstance = new ELK()
    return elkInstance
}

/** Grid placement for an edgeless lane, in model order. */
export function layoutLaneGrid(nodes: ReadonlyArray<Pick<BlueprintGraphNode, 'id' | 'kind'>>): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
    const positions = new Map<string, { x: number; y: number }>()
    const columns = Math.max(1, Math.min(BLUEPRINT_GRAPH_LANE.gridColumns, Math.ceil(Math.sqrt(nodes.length))))
    const cellWidth = Math.max(...nodes.map(node => blueprintGraphNodeSize(node).width), 0)
    const cellHeight = Math.max(...nodes.map(node => blueprintGraphNodeSize(node).height), 0)
    nodes.forEach((node, index) => {
        positions.set(node.id, {
            x: (index % columns) * (cellWidth + BLUEPRINT_GRAPH_LANE.gridGapX),
            y: Math.floor(index / columns) * (cellHeight + BLUEPRINT_GRAPH_LANE.gridGapY),
        })
    })
    const rows = Math.ceil(nodes.length / columns)
    return {
        positions,
        width: nodes.length ? columns * cellWidth + (columns - 1) * BLUEPRINT_GRAPH_LANE.gridGapX : 0,
        height: nodes.length ? rows * cellHeight + (rows - 1) * BLUEPRINT_GRAPH_LANE.gridGapY : 0,
    }
}

async function layoutLane(
    nodes: ReadonlyArray<BlueprintGraphNode>,
    edges: ReadonlyArray<{ id: string; source: string; target: string }>,
): Promise<{ positions: Map<string, { x: number; y: number }>; width: number; height: number }> {
    if (edges.length === 0) return layoutLaneGrid(nodes)
    const input: ElkNode = {
        id: 'lane',
        layoutOptions: ELK_LANE_OPTIONS,
        children: nodes.map(node => ({ id: node.id, ...blueprintGraphNodeSize(node) })),
        edges: edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    }
    const result = await elk().layout(input)
    const positions = new Map<string, { x: number; y: number }>()
    let width = 0
    let height = 0
    for (const child of result.children ?? []) {
        const x = child.x ?? 0
        const y = child.y ?? 0
        positions.set(child.id, { x, y })
        width = Math.max(width, x + (child.width ?? 0))
        height = Math.max(height, y + (child.height ?? 0))
    }
    return { positions, width, height }
}

/**
 * Lay out the visible graph. Cross-lane edges (a chain spanning two missions)
 * are drawn by React Flow between the lanes but do not shape either lane.
 */
export async function layoutBlueprintGraph(view: Pick<BlueprintGraphViewResult, 'lanes' | 'nodes' | 'edges'>): Promise<BlueprintGraphLayout> {
    const nodeById = new Map(view.nodes.map(node => [node.id, node]))
    const positions = new Map<string, { x: number; y: number }>()
    const lanes: BlueprintGraphLaneRect[] = []
    const laneLayouts = await Promise.all(view.lanes.map(async lane => {
        if (lane.collapsed || lane.nodeIds.length === 0) return null
        const members = new Set(lane.nodeIds)
        const laneNodes = lane.nodeIds.map(id => nodeById.get(id)!).filter(Boolean)
        const laneEdges = view.edges.filter(edge => members.has(edge.source) && members.has(edge.target))
        return layoutLane(laneNodes, laneEdges)
    }))
    let y = 0
    view.lanes.forEach((lane, index) => {
        const inner = laneLayouts[index]
        const pad = BLUEPRINT_GRAPH_LANE.padding
        if (!inner) {
            lanes.push({ key: lane.group.key, x: 0, y, width: BLUEPRINT_GRAPH_LANE.minWidth, height: BLUEPRINT_GRAPH_LANE.collapsedHeight })
            y += BLUEPRINT_GRAPH_LANE.collapsedHeight + BLUEPRINT_GRAPH_LANE.gap
            return
        }
        const top = y + BLUEPRINT_GRAPH_LANE.headerHeight
        for (const [id, pos] of inner.positions) positions.set(id, { x: pad + pos.x, y: top + pos.y })
        const height = BLUEPRINT_GRAPH_LANE.headerHeight + inner.height + pad
        lanes.push({ key: lane.group.key, x: 0, y, width: Math.max(BLUEPRINT_GRAPH_LANE.minWidth, inner.width + pad * 2), height })
        y += height + BLUEPRINT_GRAPH_LANE.gap
    })
    return { positions, lanes }
}

/** Panes narrower than this fit lanes to WIDTH instead of fitting the view. */
export const BLUEPRINT_GRAPH_NARROW_PANE = 640
/** Floor for the narrow width-fit (checked on a 390px phone screenshot: 3-card lanes land ~0.42, titles still legible). */
export const BLUEPRINT_GRAPH_NARROW_MIN_ZOOM = 0.35
const NARROW_FIT_PADDING = 8

/**
 * Narrow-pane (phone) initial viewport: zoom so the WIDEST lane fits the pane
 * width, clamped to [NARROW_MIN_ZOOM, 1], anchored top-left; lanes keep
 * stacking vertically and the rest is a vertical pan away. Returns null on a
 * wide pane (the caller uses a regular fitView there).
 */
export function narrowPaneViewport(
    paneWidth: number,
    lanes: ReadonlyArray<Pick<BlueprintGraphLaneRect, 'x' | 'y' | 'width'>>,
): { x: number; y: number; zoom: number } | null {
    if (!(paneWidth > 0) || paneWidth >= BLUEPRINT_GRAPH_NARROW_PANE || lanes.length === 0) return null
    const left = Math.min(...lanes.map(lane => lane.x))
    const top = Math.min(...lanes.map(lane => lane.y))
    const right = Math.max(...lanes.map(lane => lane.x + lane.width))
    const zoom = Math.min(1, Math.max(BLUEPRINT_GRAPH_NARROW_MIN_ZOOM, (paneWidth - NARROW_FIT_PADDING * 2) / Math.max(1, right - left)))
    return { x: NARROW_FIT_PADDING - left * zoom, y: NARROW_FIT_PADDING - top * zoom, zoom }
}
