/**
 * Blueprint DAG derivations — the "what unlocks what" edge vocabulary.
 *
 * Properties pinned:
 *  - a gate NODE displays its gate's state, not the graph node state
 *  - satisfied (green) requires a SUCCESSFUL terminal source: completed task
 *    or released gate — a failed/cancelled source is 'failed', never green
 *  - a projection-deactivated edge is 'inactive' regardless of states
 *  - an in-flight source animates ('waiting') only while the target itself
 *    still waits; a terminal target goes quiet ('idle')
 */
import { describe, expect, it } from 'vitest'
import {
    BLUEPRINT_GRAPH_MAX_LIMIT,
    buildBlueprintGraphOverviewArgs,
    buildGateByNodeId,
    buildNodeIdByEndpoint,
    buildStateByNodeId,
    deriveBlueprintEdgeState,
    getBlueprintGraphPagination,
    nextBlueprintGraphLimit,
} from '../../src/components/MeshGraph/blueprintViewModel'

describe('blueprint graph pagination', () => {
    it('limits only the include-finished request so the in-flight-only behavior stays unchanged', () => {
        expect(buildBlueprintGraphOverviewArgs('mesh-1', true, 20)).toEqual({
            meshId: 'mesh-1', includeTerminal: true, limit: 20,
        })
        expect(buildBlueprintGraphOverviewArgs('mesh-1', false, 20)).toEqual({
            meshId: 'mesh-1', includeTerminal: false,
        })
    })

    it('offers another page when the response fills the requested window', () => {
        expect(getBlueprintGraphPagination(20, 22, 20)).toEqual({
            hiddenCount: 2, canLoadMore: true, atServerLimit: false,
        })
        expect(getBlueprintGraphPagination(22, 22, 40)).toEqual({
            hiddenCount: 0, canLoadMore: false, atServerLimit: false,
        })
    })

    it('increments in 20-graph pages without exceeding the daemon cap', () => {
        expect(nextBlueprintGraphLimit(20)).toBe(40)
        expect(nextBlueprintGraphLimit(80)).toBe(BLUEPRINT_GRAPH_MAX_LIMIT)
        expect(nextBlueprintGraphLimit(BLUEPRINT_GRAPH_MAX_LIMIT)).toBe(BLUEPRINT_GRAPH_MAX_LIMIT)
        expect(getBlueprintGraphPagination(100, 120, 100)).toEqual({
            hiddenCount: 20, canLoadMore: false, atServerLimit: true,
        })
    })
})

const gate = (nodeId: string, state: string) => ({
    gateId: `g-${nodeId}`, nodeId, state, action: 'approval',
    onTimeout: 'hold', leaseGeneration: 0,
}) as any

const node = (nodeId: string, kind: 'worker_task' | 'coordinator_gate', state: string) => ({
    nodeId, kind, state, materializationVersion: 1,
}) as any

describe('buildStateByNodeId', () => {
    it('gate nodes show the gate state, worker nodes the node state', () => {
        const graph = {
            nodes: [node('t1', 'worker_task', 'completed'), node('gA', 'coordinator_gate', 'awaiting_coordinator')],
            gates: [gate('gA', 'claimed')],
        }
        const states = buildStateByNodeId(graph as any)
        expect(states.get('t1')).toBe('completed')
        expect(states.get('gA')).toBe('claimed')
    })

    it('a gate node with no gate row falls back to the node state', () => {
        const states = buildStateByNodeId({ nodes: [node('gA', 'coordinator_gate', 'blocked')], gates: [] } as any)
        expect(states.get('gA')).toBe('blocked')
    })
})

describe('deriveBlueprintEdgeState', () => {
    const states = new Map<string, string>([
        ['done', 'completed'], ['released', 'released'], ['failed', 'failed'],
        ['cancelled', 'cancelled'], ['running', 'materialized'], ['pending', 'declared'],
        ['terminalTarget', 'completed'],
    ])
    const edge = (from: string, to: string, active = true) => ({ from, to, active })

    it('successful terminal sources satisfy the edge', () => {
        expect(deriveBlueprintEdgeState(edge('done', 'pending'), states)).toBe('satisfied')
        expect(deriveBlueprintEdgeState(edge('released', 'pending'), states)).toBe('satisfied')
    })

    it('unsuccessful terminal sources fail the edge — never green', () => {
        expect(deriveBlueprintEdgeState(edge('failed', 'pending'), states)).toBe('failed')
        expect(deriveBlueprintEdgeState(edge('cancelled', 'pending'), states)).toBe('failed')
    })

    it('in-flight source + waiting target animates; terminal target goes idle', () => {
        expect(deriveBlueprintEdgeState(edge('running', 'pending'), states)).toBe('waiting')
        expect(deriveBlueprintEdgeState(edge('running', 'terminalTarget'), states)).toBe('idle')
    })

    it('a deactivated edge is inactive no matter the states', () => {
        expect(deriveBlueprintEdgeState(edge('done', 'pending', false), states)).toBe('inactive')
    })

    it('unknown endpoints default to declared (waiting)', () => {
        expect(deriveBlueprintEdgeState(edge('ghost', 'pending'), states)).toBe('waiting')
    })

    it('resolves ref endpoints through the endpoint map (view edges carry ref ?? nodeId)', () => {
        // Regression: ELK threw "Referenced shape does not exist: review_land"
        // because edge endpoints are refs while nodes are keyed by nodeId.
        const graph = {
            nodes: [
                { nodeId: 'uuid-1', ref: 'audit', kind: 'worker_task', state: 'completed', materializationVersion: 1 },
                { nodeId: 'uuid-2', ref: 'review_land', kind: 'coordinator_gate', state: 'awaiting_coordinator', materializationVersion: 1 },
            ],
            gates: [],
        } as any
        const endpointMap = buildNodeIdByEndpoint(graph)
        expect(endpointMap.get('audit')).toBe('uuid-1')
        expect(endpointMap.get('uuid-1')).toBe('uuid-1')
        expect(endpointMap.get('review_land')).toBe('uuid-2')
        const nodeStates = buildStateByNodeId(graph)
        expect(deriveBlueprintEdgeState({ from: 'audit', to: 'review_land', active: true }, nodeStates, endpointMap)).toBe('satisfied')
    })
})

describe('buildGateByNodeId', () => {
    it('maps gates by their graph nodeId', () => {
        const map = buildGateByNodeId({ gates: [gate('gA', 'released'), gate('gB', 'awaiting_coordinator')] } as any)
        expect(map.get('gA')?.state).toBe('released')
        expect(map.get('gB')?.state).toBe('awaiting_coordinator')
        expect(map.size).toBe(2)
    })
})
