import { describe, expect, it } from 'vitest'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
import { buildTaskDag } from '../../src/components/MeshGraph/taskDagViewModel'

// Task-DAG projection: queue rows → dependency graph. Edge state must mirror the
// scheduler's dependency predicate (satisfied iff the dep task is 'completed'),
// and a dep id absent from the snapshot must surface as a warning, not an edge.

function task(partial: Partial<RepoMeshQueueTask> & { id: string }): RepoMeshQueueTask {
    return {
        meshId: 'mesh_test',
        message: `message for ${partial.id}`,
        status: 'pending',
        createdAt: '2026-08-15T00:00:00.000Z',
        updatedAt: '2026-08-15T00:00:00.000Z',
        ...partial,
    } as RepoMeshQueueTask
}

describe('buildTaskDag', () => {
    it('builds one edge per present dependency with the scheduler-mirrored state', () => {
        const dag = buildTaskDag([
            task({ id: 'done', status: 'completed' }),
            task({ id: 'running', status: 'assigned' }),
            task({ id: 'dead', status: 'failed' }),
            task({ id: 'child', dependsOn: ['done', 'running', 'dead'] }),
        ])

        expect(dag.nodes).toHaveLength(4)
        expect(dag.edges).toHaveLength(3)
        const stateBySource = new Map(dag.edges.map(edge => [edge.source, edge.state]))
        expect(stateBySource.get('done')).toBe('satisfied')
        expect(stateBySource.get('running')).toBe('waiting')
        expect(stateBySource.get('dead')).toBe('failed')

        const child = dag.nodes.find(node => node.id === 'child')!
        // Unmet = everything not completed, exactly like taskDependenciesSatisfied.
        expect(child.waitingOn.sort()).toEqual(['dead', 'running'])
        expect(child.missingDeps).toEqual([])
    })

    it('surfaces a dependency absent from the snapshot as missingDeps (no broken edge)', () => {
        const dag = buildTaskDag([
            task({ id: 'orphan-child', dependsOn: ['gone-task'] }),
        ])
        expect(dag.edges).toHaveLength(0)
        const node = dag.nodes[0]
        expect(node.missingDeps).toEqual(['gone-task'])
        // The scheduler treats a missing dep as unsatisfied — the view must agree.
        expect(node.waitingOn).toEqual(['gone-task'])
    })

    it('counts stats: statuses, waiting, blocked, missions', () => {
        const dag = buildTaskDag([
            task({ id: 'a', status: 'completed', missionId: 'm1' }),
            task({ id: 'b', status: 'assigned', missionId: 'm1' }),
            task({ id: 'c', dependsOn: ['b'], missionId: 'm2' }),
            task({ id: 'd', status: 'cancelled', blockedReason: 'dependency_failed:x' }),
        ])
        expect(dag.stats).toMatchObject({
            total: 4,
            edges: 1,
            completed: 1,
            assigned: 1,
            pending: 1,
            cancelled: 1,
            waiting: 1,
            blocked: 1,
            missions: 2,
        })
    })

    it('dedupes repeated dependency ids and ignores malformed input', () => {
        const dag = buildTaskDag([
            task({ id: 'dep', status: 'completed' }),
            task({ id: 'child', dependsOn: ['dep', 'dep', '', '  '] as string[] }),
        ])
        expect(dag.edges).toHaveLength(1)
        expect(dag.nodes.find(node => node.id === 'child')!.dependsOn).toEqual(['dep'])
    })

    it('returns an empty projection for null/empty input', () => {
        expect(buildTaskDag(null).nodes).toHaveLength(0)
        expect(buildTaskDag([]).stats.total).toBe(0)
    })
})
