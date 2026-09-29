/**
 * ★ Blueprint LIST section rules (P1 canvas → list redesign, 2026-09-16).
 *
 * The list replaces the fused ELK canvas; these are the properties the
 * redesign is pinned to, as PROPERTIES of the pure grouping model (the same
 * convention as taskDagViewModel/blueprintViewModel — no React Flow, no DOM):
 *
 *  - a generating/assigned/pending task appears in the Running section
 *  - a session awaiting approval/choice moves its task to Blocked
 *  - a dependency-waiting or dependency-failed task is Blocked, not Running
 *  - terminal statuses never appear in Running/Blocked; the newest 10 are
 *    Recent, older ones History behind the caller's limit
 *  - the plan (mini-DAG) affordance exists ONLY where a plan exists: queue
 *    dependency edges — a lone task offers none
 *
 * Red-when-reverted: each block names the classification branch that breaks it.
 */
import { describe, expect, it } from 'vitest'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
import {
    BLUEPRINT_RECENT_TERMINAL_LIMIT,
    buildBlueprintGroups,
    buildBlueprintMissionGroups,
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

describe('Running section', () => {
    it('a generating task appears in Running, labelled generating', () => {
        const groups = buildBlueprintGroups(
            [task({ id: 't-gen', status: 'assigned', assignedSessionId: 's1', assignedNodeId: 'node-1' })],
            statusWithSession('s1', 'generating'),
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
        )
        expect(blocked.blocked.map(row => row.kind === 'task' ? row.task.id : '')).toEqual(['t-waits'])
        expect(blocked.blocked[0].kind === 'task' && blocked.blocked[0].waitingOn).toEqual(['t-dep'])

        const released = buildBlueprintGroups(
            [
                task({ id: 't-dep', status: 'completed' }),
                task({ id: 't-waits', status: 'pending', dependsOn: ['t-dep'] }),
            ],
            { nodes: [] } as any,
        )
        expect(released.running.map(row => row.task.id)).toEqual(['t-waits'])
    })

    it('a task behind a failed dependency is Blocked', () => {
        const groups = buildBlueprintGroups(
            [task({ id: 't-held', status: 'pending', dependencyFailures: [{ taskId: 't0', status: 'failed' }] })],
            { nodes: [] } as any,
        )
        expect(groups.blocked).toHaveLength(1)
        expect(groups.blocked[0].dependencyFailureCount).toBe(1)
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
        const groups = buildBlueprintGroups(terminal, { nodes: [] } as any)
        expect(groups.running).toEqual([])
        expect(groups.blocked).toEqual([])
    })

    it(`the newest ${BLUEPRINT_RECENT_TERMINAL_LIMIT} terminal rows are Recent, older ones History behind the limit`, () => {
        const groups = buildBlueprintGroups(terminal, { nodes: [] } as any, 2)
        expect(groups.recent).toHaveLength(BLUEPRINT_RECENT_TERMINAL_LIMIT)
        expect(groups.recent[0].task.id).toBe('t-done-0')
        expect(groups.recent.every(row => row.section === 'recent')).toBe(true)
        expect(groups.history).toHaveLength(2)
        expect(groups.historyHiddenCount).toBe(2)
        expect(groups.counts.history).toBe(4)
    })
})

describe('plan (mini-DAG) availability', () => {
    it('queue dependency edges give the row a plan; a loose task has none', () => {
        const groups = buildBlueprintGroups(
            [
                task({ id: 't-dep', status: 'completed' }),
                task({ id: 't-next', status: 'pending', dependsOn: ['t-dep'] }),
            ],
            { nodes: [] } as any,
        )
        expect(groups.running[0].hasPlan).toBe(true)
        const loose = buildBlueprintGroups([task({ id: 't-solo' })], { nodes: [] } as any)
        expect(loose.running[0].hasPlan).toBe(false)
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
