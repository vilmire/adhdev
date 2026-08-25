/**
 * blueprintViewModel — pure derivations for the blueprint DAG
 * (the fused blueprint canvas (MeshTaskDagView)). Extracted from the component so the edge-state
 * vocabulary — the "what unlocks what" reading of the graph — is unit-tested
 * without rendering React Flow (same convention as taskDagViewModel).
 */
import type { MeshGraphView, MeshGraphEdgeView, MeshGraphGateView, RepoMeshQueueTask } from '@adhdev/daemon-core'

/** The daemon defaults to 20 and clamps mesh_graph_overview requests at 100. */
export const BLUEPRINT_GRAPH_INITIAL_LIMIT = 20
export const BLUEPRINT_GRAPH_LOAD_MORE_STEP = 20
export const BLUEPRINT_GRAPH_MAX_LIMIT = 100

export function buildBlueprintGraphOverviewArgs(meshId: string, includeTerminal: boolean, limit: number): Record<string, unknown> {
    return includeTerminal ? { meshId, includeTerminal, limit } : { meshId, includeTerminal }
}

export function nextBlueprintGraphLimit(limit: number): number {
    return Math.min(BLUEPRINT_GRAPH_MAX_LIMIT, limit + BLUEPRINT_GRAPH_LOAD_MORE_STEP)
}

export function getBlueprintGraphPagination(graphCount: number, totalGraphCount: number, requestedLimit: number): {
    hiddenCount: number
    canLoadMore: boolean
    atServerLimit: boolean
} {
    const hiddenCount = Math.max(0, totalGraphCount - graphCount)
    return {
        hiddenCount,
        canLoadMore: hiddenCount > 0 && requestedLimit < BLUEPRINT_GRAPH_MAX_LIMIT,
        atServerLimit: hiddenCount > 0 && requestedLimit >= BLUEPRINT_GRAPH_MAX_LIMIT,
    }
}

/* ── Route-preview requests: the forecast must respect the pin ─────────────
 * The scheduling forecast used to ask mesh_route_preview only the four bare
 * difficulties, so a task PINNED to a node (targetNodeId) was annotated with
 * the UNPINNED prediction — the owner watched the blueprint predict a
 * machine the pinned task could never land on. The engine has the pin axis
 * (targetNodeId, verified against both conditions); the fix is on the
 * display axis: request a pinned preview per pending pinned task and keep
 * the generic forecast as a separate, explicitly-unpinned reading. */

export const ROUTE_PREVIEW_DIFFICULTIES = ['easy', 'medium', 'difficult', 'freeform'] as const

export interface RoutePreviewRequest {
    difficulty: string
    /** Present only for pinned previews — the generic forecast omits it. */
    targetNodeId?: string
}

/** Matrix key: bare difficulty for the generic forecast, `difficulty::nodeId` for a pinned one. */
export function routePreviewKey(difficulty: string, targetNodeId?: string): string {
    return targetNodeId ? `${difficulty}::${targetNodeId}` : difficulty
}

/**
 * The full request sweep: the four generic difficulties PLUS one pinned
 * preview per distinct (difficulty, targetNodeId) among PENDING pinned tasks
 * (settled tasks no longer need a prediction; assigned ones already landed).
 */
export function buildRoutePreviewRequests(
    tasks: ReadonlyArray<Pick<RepoMeshQueueTask, 'status' | 'difficulty' | 'targetNodeId'>>,
): RoutePreviewRequest[] {
    const requests: RoutePreviewRequest[] = ROUTE_PREVIEW_DIFFICULTIES.map(difficulty => ({ difficulty }))
    const seen = new Set<string>()
    for (const task of tasks) {
        const targetNodeId = typeof task.targetNodeId === 'string' ? task.targetNodeId.trim() : ''
        if (task.status !== 'pending' || !targetNodeId) continue
        const difficulty = task.difficulty ?? 'medium'
        const key = routePreviewKey(difficulty, targetNodeId)
        if (seen.has(key)) continue
        seen.add(key)
        requests.push({ difficulty, targetNodeId })
    }
    return requests
}

/** Minimal shape of one node entry in a mesh_route_preview response. */
export interface RoutePreviewNodeLike {
    nodeId: string
    predictedWinner?: { providerType: string; model?: string; fitnessScore?: number }
    stages?: { fitness?: Array<{ providerType: string; model?: string }> }
}

/** Label for one slot: `provider·model` or bare provider. */
export function routePreviewSlotLabel(slot: { providerType: string; model?: string }): string {
    return slot.model ? `${slot.providerType}·${slot.model}` : slot.providerType
}

/**
 * The next-match reading of one preview response: the first node's top-ranked
 * fitness slot (falling back to its predictedWinner), labelled with the
 * node suffix the caller supplies for that node ('' when none applies).
 */
export function routePreviewNextSlotLabel(
    nodes: ReadonlyArray<RoutePreviewNodeLike> | undefined,
    nodeSuffix?: (nodeId: string) => string,
): string | undefined {
    const first = nodes?.[0]
    if (!first) return undefined
    const slot = first.stages?.fitness?.[0] ?? first.predictedWinner
    if (!slot) return undefined
    return `${routePreviewSlotLabel(slot)}${nodeSuffix?.(first.nodeId) ?? ''}`
}

/**
 * taskId → predicted slot label for PENDING pinned tasks, read from the
 * pinned entries of the preview matrix. Tasks whose pinned preview has no
 * eligible slot are omitted (the card then shows no forecast rather than a
 * wrong one).
 */
export function buildPinnedSlotLabels(
    tasks: ReadonlyArray<Pick<RepoMeshQueueTask, 'id' | 'status' | 'difficulty' | 'targetNodeId'>>,
    matrix: Readonly<Record<string, ReadonlyArray<RoutePreviewNodeLike>>>,
    nodeSuffix?: (nodeId: string) => string,
): Record<string, string> {
    const out: Record<string, string> = {}
    for (const task of tasks) {
        const targetNodeId = typeof task.targetNodeId === 'string' ? task.targetNodeId.trim() : ''
        if (task.status !== 'pending' || !targetNodeId) continue
        const label = routePreviewNextSlotLabel(matrix[routePreviewKey(task.difficulty ?? 'medium', targetNodeId)], nodeSuffix)
        if (label) out[task.id] = label
    }
    return out
}

/**
 * Which forecast a task card shows: the PINNED prediction when the task pins
 * a target node and that preview exists, else the generic per-difficulty
 * one. The `pinned` flag lets the card render the two readings distinctly —
 * the generic forecast is a hypothetical unpinned dispatch, the pinned one
 * is where THIS task would actually go. A pinned task WITHOUT its pinned
 * preview shows nothing: falling back to the unpinned forecast there is
 * exactly the misprediction this fixes.
 */
export function resolveTaskPredictedSlot(
    task: Pick<RepoMeshQueueTask, 'id' | 'difficulty' | 'targetNodeId'>,
    predictedSlots: Readonly<Record<string, string>> | undefined,
    pinnedSlots: Readonly<Record<string, string>> | undefined,
): { label: string; pinned: boolean } | undefined {
    if (task.targetNodeId) {
        const pinnedLabel = pinnedSlots?.[task.id]
        return pinnedLabel ? { label: pinnedLabel, pinned: true } : undefined
    }
    const generic = predictedSlots?.[task.difficulty ?? 'medium']
    return generic ? { label: generic, pinned: false } : undefined
}

/** One graph's placement on the blueprint's vertical time axis. */
export interface BlueprintGraphTimelineEntry {
    graphId: string
    /** Epoch ms — terminalAt when the graph settled, else createdAt; 0 when neither parses. */
    timestamp: number
    /** Day bucket (yyyy-mm-dd) — graphs sharing one collapse under a single date header. */
    dateKey: string
    /** True for the first entry of a day — the axis renders the date label there only. */
    showDate: boolean
}

/**
 * The moment a graph belongs to on the timeline: when it SETTLED (terminalAt)
 * for finished graphs, when it was CREATED otherwise. Read the structured
 * fields — never parse the date out of a graph title.
 */
export function blueprintGraphTimelineTime(graph: Pick<MeshGraphView, 'createdAt' | 'terminalAt'>): number {
    const terminal = graph.terminalAt ? Date.parse(graph.terminalAt) : Number.NaN
    if (Number.isFinite(terminal)) return terminal
    const created = graph.createdAt ? Date.parse(graph.createdAt) : Number.NaN
    return Number.isFinite(created) ? created : 0
}

/** Local-day bucket key — the axis groups by the viewer's own calendar day. */
export function blueprintTimelineDateKey(ms: number): string {
    const date = new Date(ms)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Graphs ordered for the vertical timeline: newest first (matching the
 * daemon's mesh_graph_overview order), each stamped with its day bucket and a
 * showDate flag that fires only on the day's first graph. The dateKey source
 * is injectable so tests stay timezone-deterministic.
 */
export function buildBlueprintGraphTimeline(
    graphs: Array<Pick<MeshGraphView, 'graphId' | 'createdAt' | 'terminalAt'>>,
    toDateKey: (ms: number) => string = blueprintTimelineDateKey,
): BlueprintGraphTimelineEntry[] {
    const ordered = graphs
        .map(graph => ({ graphId: graph.graphId, timestamp: blueprintGraphTimelineTime(graph) }))
        .sort((a, b) => b.timestamp - a.timestamp)
    let lastDateKey = ''
    return ordered.map(entry => {
        const dateKey = toDateKey(entry.timestamp)
        const showDate = dateKey !== lastDateKey
        lastDateKey = dateKey
        return { ...entry, dateKey, showDate }
    })
}

/** Source states that mean "this dependency is satisfied — the edge is green". */
const TERMINAL_OK_STATES = new Set(['completed', 'released'])
/** All terminal states (success or not) — a terminal target no longer waits. */
const TERMINAL_STATES = new Set(['completed', 'failed', 'skipped', 'cancelled', 'released'])

export type BlueprintEdgeState = 'inactive' | 'satisfied' | 'failed' | 'waiting' | 'idle'

/** Gate lookups keyed by the gate's graph nodeId. */
export function buildGateByNodeId(graph: Pick<MeshGraphView, 'gates'>): Map<string, MeshGraphGateView> {
    const map = new Map<string, MeshGraphGateView>()
    for (const gate of graph.gates ?? []) map.set(gate.nodeId, gate)
    return map
}

/**
 * Effective display state per node: a coordinator_gate node shows its GATE
 * state (awaiting/claimed/released…), a worker node its graph node state.
 */
export function buildStateByNodeId(graph: Pick<MeshGraphView, 'nodes' | 'gates'>): Map<string, string> {
    const gates = buildGateByNodeId(graph)
    const map = new Map<string, string>()
    for (const node of graph.nodes) {
        map.set(node.nodeId, node.kind === 'coordinator_gate' ? (gates.get(node.nodeId)?.state ?? node.state) : node.state)
    }
    return map
}

/**
 * Edge endpoints in MeshGraphEdgeView are `ref ?? nodeId` (the view projects
 * the human-readable ref when the node has one). React Flow and ELK are keyed
 * by nodeId, so every edge endpoint must be resolved back through this map.
 */
export function buildNodeIdByEndpoint(graph: Pick<MeshGraphView, 'nodes'>): Map<string, string> {
    const map = new Map<string, string>()
    for (const node of graph.nodes) {
        map.set(node.nodeId, node.nodeId)
        if (node.ref) map.set(node.ref, node.nodeId)
    }
    return map
}

/**
 * Edge display state:
 *  - inactive: the projection deactivated the edge (source skipped)
 *  - satisfied: source reached a successful terminal state — dependency met
 *  - failed: source terminal but NOT successful — the dependency can never be met
 *  - waiting: source still in flight and the target still waits on it (animated)
 *  - idle: source in flight but the target itself is already terminal
 */
export function deriveBlueprintEdgeState(
    edge: Pick<MeshGraphEdgeView, 'active' | 'from' | 'to'>,
    stateByNodeId: Map<string, string>,
    nodeIdByEndpoint?: Map<string, string>,
): BlueprintEdgeState {
    if (edge.active === false) return 'inactive'
    const sourceId = nodeIdByEndpoint?.get(edge.from) ?? edge.from
    const targetId = nodeIdByEndpoint?.get(edge.to) ?? edge.to
    const sourceState = stateByNodeId.get(sourceId) ?? 'declared'
    const targetState = stateByNodeId.get(targetId) ?? 'declared'
    if (TERMINAL_OK_STATES.has(sourceState)) return 'satisfied'
    if (TERMINAL_STATES.has(sourceState)) return 'failed'
    return TERMINAL_STATES.has(targetState) ? 'idle' : 'waiting'
}
