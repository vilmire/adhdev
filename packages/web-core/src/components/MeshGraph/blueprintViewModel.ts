/**
 * blueprintViewModel — pure derivations for the blueprint DAG
 * (MeshBlueprintDagView). Extracted from the component so the edge-state
 * vocabulary — the "what unlocks what" reading of the graph — is unit-tested
 * without rendering React Flow (same convention as taskDagViewModel).
 */
import type { MeshGraphView, MeshGraphEdgeView, MeshGraphGateView } from '@adhdev/daemon-core'

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
