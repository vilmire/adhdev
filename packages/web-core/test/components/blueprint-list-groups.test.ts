/**
 * ★ Blueprint LIST section rules (P1 canvas → list redesign, 2026-09-16).
 *
 * The list replaces the fused ELK canvas; these are the properties the
 * redesign is pinned to, as PROPERTIES of the pure grouping model (the same
 * convention as taskDagViewModel/blueprintViewModel — no React Flow, no DOM):
 *
 *  - a generating/assigned/pending task appears in the Running section
 *  - a session awaiting approval/choice moves its task to Blocked
 *  - a system-blocked or dependency-waiting task is Blocked, not Running
 *  - terminal statuses never appear in Running/Blocked; the newest 10 are
 *    Recent, older ones History behind the caller's limit
 *  - a blocking coordinator gate is its own Blocked row; a settled gate is not
 *  - the plan (mini-DAG) affordance exists ONLY where a plan exists: a graph
 *    WITH edges, or queue dependency edges — an edgeless graph offers none
 *
 * Red-when-reverted: each block names the classification branch that breaks it.
 */
import { describe, expect, it } from 'vitest'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
import {
    BLUEPRINT_RECENT_TERMINAL_LIMIT,
    buildBlueprintGroups,
    buildBlueprintMissionGroups,
    buildPlanGraphIndex,
    deriveSessionActivity,
} from '../../src/components/MeshGraph/useBlueprintGroups'

const task = (over: Partial<RepoMeshQueueTask> & { id: string }): RepoMeshQueueTask => ({
    meshId: 'mesh-1',
    message: `message for ${over.id}`,
    status: 'pending',
    createdAt: '2026-09-16T10:00:00Z',
    updatedAt: '2026-09-16T10:00:00Z',
    ...over,
} as RepoMeshQueueTask)

const statusWithSession = (sessionId: string, state: string) => ({
    nodes: [{
        nodeId: 'node-1',
        activeSessionDetails: [{ sessionId, state }],
    }],
}) as any

const graphNode = (nodeId: string, over: Record<string, unknown> = {}) => ({
    nodeId, ref: nodeId, kind: 'worker_task', state: 'materialized', materializationVersion: 1, ...over,
})

const makeGraph = (graphId: string, over: Record<string, unknown> = {}) => ({
    graphId,
    status: 'running',
    nodes: [],
    gates: [],
    edges: [],
    createdAt: '2026-09-16T09:00:00Z',
    ...over,
}) as any

describe('Running section', () => {
    it('a generating task appears in Running, labelled generating', () => {
        const groups = buildBlueprintGroups(
            [task({ id: 't-gen', status: 'assigned', assignedSessionId: 's1', assignedNodeId: 'node-1' })],
            statusWithSession('s1', 'generating'),
            [],
        )
        expect(groups.running.map(row => row.task.id)).toEqual(['t-gen'])
        expect(groups.running[0].statusToken).toBe('generating')
        expect(groups.blocked).toEqual([])
    })

    it('assigned and dispatchable pending tasks are Running; live work sorts above queued', () => {
        const groups = buildBlueprintGroups(
            [
                task({ id: 't-pending', status: 'pending', updatedAt: '2026-09-16T12:00:00Z' }),
                task({ id: 't-assigned', status: 'assigned', updatedAt: '2026-09-16T10:00:00Z' }),
            ],
            { nodes: [] } as any,
            [],
        )
        expect(groups.running.map(row => row.task.id)).toEqual(['t-assigned', 't-pending'])
        expect(groups.counts.running).toBe(2)
    })
})

describe('Blocked section', () => {
    it('a session awaiting approval moves its task to Blocked with the approval flag', () => {
        const groups = buildBlueprintGroups(
            [task({ id: 't-appr', status: 'assigned', assignedSessionId: 's1', assignedNodeId: 'node-1' })],
            statusWithSession('s1', 'waiting_approval'),
            [],
        )
        expect(groups.running).toEqual([])
        expect(groups.blocked).toHaveLength(1)
        const row = groups.blocked[0]
        expect(row.kind).toBe('task')
        expect(row.kind === 'task' && row.awaitingApproval).toBe(true)
    })

    it('a session awaiting a choice is Blocked with the choice flag (not the approval one)', () => {
        const groups = buildBlueprintGroups(
            [task({ id: 't-choice', status: 'assigned', assignedSessionId: 's1', assignedNodeId: 'node-1' })],
            statusWithSession('s1', 'waiting_choice'),
            [],
        )
        const row = groups.blocked[0]
        expect(row.kind === 'task' && row.awaitingChoice).toBe(true)
        expect(row.kind === 'task' && row.awaitingApproval).toBe(false)
    })

    it('a pending task waiting on an unmet dependency is Blocked, and satisfied deps release it', () => {
        const blocked = buildBlueprintGroups(
            [
                task({ id: 't-dep', status: 'assigned' }),
                task({ id: 't-waits', status: 'pending', dependsOn: ['t-dep'] }),
            ],
            { nodes: [] } as any,
            [],
        )
        expect(blocked.blocked.map(row => row.kind === 'task' ? row.task.id : '')).toEqual(['t-waits'])
        expect(blocked.blocked[0].kind === 'task' && blocked.blocked[0].waitingOn).toEqual(['t-dep'])

        const released = buildBlueprintGroups(
            [
                task({ id: 't-dep', status: 'completed' }),
                task({ id: 't-waits', status: 'pending', dependsOn: ['t-dep'] }),
            ],
            { nodes: [] } as any,
            [],
        )
        expect(released.running.map(row => row.task.id)).toEqual(['t-waits'])
    })

    it('a system-blocked task (blockedReason) is Blocked', () => {
        const groups = buildBlueprintGroups(
            [task({ id: 't-held', status: 'pending', blockedReason: 'dependency_failed:t0' })],
            { nodes: [] } as any,
            [],
        )
        expect(groups.blocked).toHaveLength(1)
        expect(groups.blocked[0].kind === 'task' && groups.blocked[0].blockedReason).toBe('dependency_failed:t0')
    })

    it('a blocking coordinator gate is its own Blocked row; a released gate is not', () => {
        const graph = makeGraph('g1', {
            nodes: [
                graphNode('gate-open', { kind: 'coordinator_gate', state: 'awaiting_coordinator' }),
                graphNode('gate-done', { kind: 'coordinator_gate', state: 'released' }),
            ],
            gates: [
                { gateId: 'ga', nodeId: 'gate-open', state: 'awaiting_coordinator', action: 'approval', onTimeout: 'hold', leaseGeneration: 0 },
                { gateId: 'gb', nodeId: 'gate-done', state: 'released', action: 'approval', onTimeout: 'hold', leaseGeneration: 0 },
            ],
        })
        const groups = buildBlueprintGroups([], { nodes: [] } as any, [graph])
        expect(groups.blocked).toHaveLength(1)
        const row = groups.blocked[0]
        expect(row.kind).toBe('gate')
        expect(row.kind === 'gate' && row.nodeId).toBe('gate-open')
        expect(groups.counts.blocked).toBe(1)
    })
})

describe('terminal sections', () => {
    const terminal = Array.from({ length: 14 }, (_, index) => task({
        id: `t-done-${index}`,
        status: index === 0 ? 'failed' : 'completed',
        // Newest first by construction: index 0 is the most recent.
        updatedAt: `2026-09-16T0${Math.floor((13 - index) / 10)}:${String((13 - index) % 10)}0:00Z`,
    }))

    it('terminal queue statuses never appear in Running or Blocked', () => {
        const groups = buildBlueprintGroups(terminal, { nodes: [] } as any, [])
        expect(groups.running).toEqual([])
        expect(groups.blocked).toEqual([])
    })

    it(`the newest ${BLUEPRINT_RECENT_TERMINAL_LIMIT} terminal rows are Recent, older ones History behind the limit`, () => {
        const groups = buildBlueprintGroups(terminal, { nodes: [] } as any, [], 2)
        expect(groups.recent).toHaveLength(BLUEPRINT_RECENT_TERMINAL_LIMIT)
        expect(groups.recent[0].task.id).toBe('t-done-0')
        expect(groups.recent.every(row => row.section === 'recent')).toBe(true)
        expect(groups.history).toHaveLength(2)
        expect(groups.historyHiddenCount).toBe(2)
        expect(groups.counts.history).toBe(4)
    })
})

describe('plan (mini-DAG) availability', () => {
    it('a graph WITH edges gives its tasks planSource graph', () => {
        const graph = makeGraph('g-edges', {
            nodes: [graphNode('n1', { taskId: 't1' }), graphNode('n2', { taskId: 't2' })],
            edges: [{ from: 'n1', to: 'n2', active: true }],
        })
        const groups = buildBlueprintGroups(
            [task({ id: 't1', status: 'assigned' })],
            { nodes: [] } as any,
            [graph],
        )
        expect(groups.running[0].planSource).toBe('graph')
        expect(groups.running[0].planGraphId).toBe('g-edges')
    })

    it('an EDGELESS graph offers no plan affordance at all', () => {
        const graph = makeGraph('g-bare', { nodes: [graphNode('n1', { taskId: 't1' })] })
        const groups = buildBlueprintGroups(
            [task({ id: 't1', status: 'assigned' })],
            { nodes: [] } as any,
            [graph],
        )
        expect(groups.running[0].planSource).toBeUndefined()
        expect(buildPlanGraphIndex([graph]).size).toBe(0)
    })

    it('queue dependency edges give planSource queue without any persistent graph', () => {
        const groups = buildBlueprintGroups(
            [
                task({ id: 't-dep', status: 'completed' }),
                task({ id: 't-next', status: 'pending', dependsOn: ['t-dep'] }),
            ],
            { nodes: [] } as any,
            [],
        )
        expect(groups.running[0].planSource).toBe('queue')
        // A loose task with no edges anywhere has none.
        const loose = buildBlueprintGroups([task({ id: 't-solo' })], { nodes: [] } as any, [])
        expect(loose.running[0].planSource).toBeUndefined()
    })
})

describe('deriveSessionActivity', () => {
    it('joins via assignedSessionId and reads generating/approval/choice from the status text', () => {
        expect(deriveSessionActivity(statusWithSession('s1', 'generating'), { assignedSessionId: 's1' })?.generating).toBe(true)
        expect(deriveSessionActivity(statusWithSession('s1', 'waiting_approval'), { assignedSessionId: 's1' })?.awaitingApproval).toBe(true)
        expect(deriveSessionActivity(statusWithSession('s1', 'idle'), { assignedSessionId: 'other' })).toBeUndefined()
        expect(deriveSessionActivity(statusWithSession('s1', 'idle'), {})).toBeUndefined()
    })
})

describe('by-mission regrouping', () => {
    it('groups visible rows under their mission, live groups first, section order inside', () => {
        const groups = buildBlueprintGroups(
            [
                task({ id: 't-m1-run', status: 'assigned', missionId: 'm1', updatedAt: '2026-09-16T13:00:00Z' }),
                task({ id: 't-m2-done', status: 'completed', missionId: 'm2', updatedAt: '2026-09-16T12:00:00Z' }),
                task({ id: 't-adhoc', status: 'pending', updatedAt: '2026-09-16T11:00:00Z' }),
            ],
            { nodes: [] } as any,
            [],
        )
        const rows = [...groups.running, ...groups.blocked, ...groups.recent, ...groups.history]
        const missionGroups = buildBlueprintMissionGroups(rows, { m1: 'Mission One' })
        expect(missionGroups.map(group => group.missionId)).toEqual(['m1', null, 'm2'])
        expect(missionGroups[0].title).toBe('Mission One')
        expect(missionGroups[0].hasLiveWork).toBe(true)
        expect(missionGroups[2].hasLiveWork).toBe(false)
        expect(groups.counts.missions).toBe(2)
    })
})
