/**
 * miniDagViewModel — pure model + layout for the on-demand mini plan DAG
 * (MeshMiniDag), the surviving graph rendering of the blueprint redesign.
 *
 * The full-canvas blueprint laid EVERYTHING out with ELK. The list replaces
 * that; a graph drawing remains only where a graph actually exists — a row
 * whose task belongs to a persistent orchestration graph WITH edges, or a
 * task wired into the queue's dependsOn DAG. Both funnel into one small
 * normalized model here, laid out by dependency depth (longest-path
 * layering) — a few dozen nodes at most, which is exactly the size where a
 * hand-rolled layered placement reads as well as ELK without the engine.
 *
 * Builders return null when there is NOTHING to draw (no edges): the caller
 * must not render a plan affordance for an edgeless graph — a canvas with
 * disconnected boxes explains nothing a list row doesn't already say.
 */
import type { MeshGraphView, RepoMeshQueueTask } from '@adhdev/daemon-core'
import type { TaskDagData } from './taskDagViewModel'
import {
    buildNodeIdByEndpoint,
    buildStateByNodeId,
    deriveBlueprintEdgeState,
    type BlueprintEdgeState,
} from './blueprintViewModel'

export interface MiniDagNode {
    id: string
    kind: 'task' | 'gate' | 'plan'
    /** Card headline: task message (stripped elsewhere), or the graph ref. */
    label: string
    /** Display state: queue status / gate state / graph node state. */
    state: string
    /** Backing queue row, when one exists — makes the node openable. */
    taskId?: string
    /** True for a gate in a blocking state — the loud styling. */
    blocking?: boolean
    /** run_if-guarded step (features includes 'run_if'). */
    conditional?: boolean
    /** Gate node's graph-node id, for the gate detail panel. */
    gateNodeId?: string
}

export interface MiniDagEdge {
    id: string
    source: string
    target: string
    state: BlueprintEdgeState
}

export interface MiniDagModel {
    nodes: MiniDagNode[]
    edges: MiniDagEdge[]
    /** Owning persistent graph, when the model came from one. */
    graphId?: string
}

/** Gate blocking predicate — kept in the view model the mini DAG consumes. */
function isBlockingGateState(state: string): boolean {
    return state === 'awaiting_coordinator' || state === 'claimed' || state === 'expired'
}

/**
 * A persistent orchestration graph, as a mini-DAG model. Returns null when
 * the graph has no edges — the property the list's plan affordance is pinned
 * to ("only graphs with edges get a mini DAG").
 */
export function buildGraphMiniDag(
    graph: MeshGraphView,
    taskById?: ReadonlyMap<string, RepoMeshQueueTask>,
): MiniDagModel | null {
    const endpointMap = buildNodeIdByEndpoint(graph)
    const stateByNodeId = buildStateByNodeId(graph)
    const nodes: MiniDagNode[] = graph.nodes.map(node => {
        if (node.kind === 'coordinator_gate') {
            const gate = graph.gates.find(candidate => candidate.nodeId === node.nodeId)
            const state = gate?.state ?? node.state
            return {
                id: node.nodeId,
                kind: 'gate' as const,
                label: node.ref || node.nodeId.slice(0, 8),
                state,
                blocking: isBlockingGateState(state),
                gateNodeId: node.nodeId,
            }
        }
        const task = node.taskId ? taskById?.get(node.taskId) : undefined
        return {
            id: node.nodeId,
            kind: task ? 'task' as const : 'plan' as const,
            label: node.ref || node.nodeId.slice(0, 8),
            // The queue row's LIVE status wins over the plan-side state — the
            // two genuinely diverge mid-flight (same rule the old ghost cards
            // followed).
            state: task?.status ?? node.taskStatus ?? node.state,
            ...(node.taskId ? { taskId: node.taskId } : {}),
            ...(node.features?.includes('run_if') ? { conditional: true } : {}),
        }
    })
    const edges: MiniDagEdge[] = []
    graph.edges.forEach((edge, index) => {
        const source = endpointMap.get(edge.from) ?? edge.from
        const target = endpointMap.get(edge.to) ?? edge.to
        if (!stateByNodeId.has(source) || !stateByNodeId.has(target)) return
        edges.push({
            id: `ge:${graph.graphId}:${index}`,
            source,
            target,
            state: deriveBlueprintEdgeState(edge, stateByNodeId, endpointMap),
        })
    })
    if (edges.length === 0) return null
    return { nodes, edges, graphId: graph.graphId }
}

/**
 * The queue-dependency plan around ONE task: its connected component over the
 * projected dependsOn edges. Returns null when no edge touches the task —
 * a lone card is not a plan.
 */
export function buildQueueMiniDag(taskId: string, dag: TaskDagData): MiniDagModel | null {
    const neighbours = new Map<string, string[]>()
    for (const edge of dag.edges) {
        neighbours.set(edge.source, [...(neighbours.get(edge.source) ?? []), edge.target])
        neighbours.set(edge.target, [...(neighbours.get(edge.target) ?? []), edge.source])
    }
    if (!neighbours.has(taskId)) return null
    const component = new Set<string>()
    const stack = [taskId]
    while (stack.length > 0) {
        const current = stack.pop()!
        if (component.has(current)) continue
        component.add(current)
        for (const next of neighbours.get(current) ?? []) {
            if (!component.has(next)) stack.push(next)
        }
    }
    const nodes: MiniDagNode[] = dag.nodes
        .filter(node => component.has(node.id))
        .map(node => ({
            id: node.id,
            kind: 'task' as const,
            label: node.task.message ?? node.id.slice(0, 8),
            state: node.task.status,
            taskId: node.id,
        }))
    const edges: MiniDagEdge[] = dag.edges
        .filter(edge => component.has(edge.source) && component.has(edge.target))
        // TaskDagEdgeState ('satisfied'|'waiting'|'failed') is a subset of
        // BlueprintEdgeState by the same names — one edge vocabulary.
        .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, state: edge.state }))
    if (edges.length === 0) return null
    return { nodes, edges }
}

export interface MiniDagLayoutOptions {
    nodeWidth: number
    nodeHeight: number
    gapX: number
    gapY: number
}

export const MINI_DAG_LAYOUT: MiniDagLayoutOptions = {
    nodeWidth: 172,
    nodeHeight: 54,
    gapX: 56,
    gapY: 14,
}

/**
 * Longest-path layered placement: a node's column is one past its deepest
 * dependency; nodes sharing a column stack vertically in model order. Cycles
 * (which a dependsOn queue can technically contain via bad input) break by
 * treating the back edge as depth 0 rather than recursing forever.
 */
export function layoutMiniDag(
    model: Pick<MiniDagModel, 'nodes' | 'edges'>,
    options: MiniDagLayoutOptions = MINI_DAG_LAYOUT,
): Map<string, { x: number; y: number }> {
    const incoming = new Map<string, string[]>()
    for (const edge of model.edges) {
        incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
    }
    const depthById = new Map<string, number>()
    const onStack = new Set<string>()
    const depthOf = (id: string): number => {
        const known = depthById.get(id)
        if (known !== undefined) return known
        if (onStack.has(id)) return 0
        onStack.add(id)
        let depth = 0
        for (const source of incoming.get(id) ?? []) {
            depth = Math.max(depth, depthOf(source) + 1)
        }
        onStack.delete(id)
        depthById.set(id, depth)
        return depth
    }
    const rowsByDepth = new Map<number, number>()
    const positions = new Map<string, { x: number; y: number }>()
    for (const node of model.nodes) {
        const depth = depthOf(node.id)
        const row = rowsByDepth.get(depth) ?? 0
        rowsByDepth.set(depth, row + 1)
        positions.set(node.id, {
            x: depth * (options.nodeWidth + options.gapX),
            y: row * (options.nodeHeight + options.gapY),
        })
    }
    return positions
}
