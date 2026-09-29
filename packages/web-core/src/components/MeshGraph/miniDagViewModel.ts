/**
 * miniDagViewModel — pure model + layout for the on-demand mini plan DAG
 * (MeshMiniDag) behind a blueprint list row: the task's connected component
 * over the queue's `depends_on` edges, laid out by dependency depth
 * (longest-path layering) — a few dozen nodes at most, which is exactly the
 * size where a hand-rolled layered placement reads as well as ELK.
 *
 * The builder returns null when there is NOTHING to draw (no edges): the
 * caller must not render a plan affordance for a lone task — a canvas with a
 * disconnected box explains nothing a list row doesn't already say.
 */
import type { TaskDagData, TaskDagEdgeState } from './taskDagViewModel'

export interface MiniDagNode {
    id: string
    /** Card headline: the task message (stripped elsewhere). */
    label: string
    /** Display state: the queue status. */
    state: string
    /** Backing queue row — makes the node openable. */
    taskId: string
}

export interface MiniDagEdge {
    id: string
    source: string
    target: string
    state: TaskDagEdgeState
}

export interface MiniDagModel {
    nodes: MiniDagNode[]
    edges: MiniDagEdge[]
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
            label: node.task.message ?? node.id.slice(0, 8),
            state: node.task.status,
            taskId: node.id,
        }))
    const edges: MiniDagEdge[] = dag.edges
        .filter(edge => component.has(edge.source) && component.has(edge.target))
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
