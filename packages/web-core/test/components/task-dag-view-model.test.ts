import { describe, expect, it } from 'vitest'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
import { buildTaskDag, scopeTaskDagTasks, TASK_DAG_RECENT_TERMINAL_LIMIT } from '../../src/components/MeshGraph/taskDagViewModel'

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

describe('scopeTaskDagTasks', () => {
    it('keeps every active task plus its full dependency ancestry, regardless of age', () => {
        const tasks = [
            task({ id: 'ancient-dep', status: 'completed', updatedAt: '2020-01-01T00:00:00.000Z' }),
            task({ id: 'mid-dep', status: 'completed', dependsOn: ['ancient-dep'], updatedAt: '2020-01-02T00:00:00.000Z' }),
            task({ id: 'active', status: 'assigned', dependsOn: ['mid-dep'] }),
            // 40 unrelated old terminals — more than the recent cap.
            ...Array.from({ length: 40 }, (_, i) => task({
                id: `old-${i}`, status: 'completed',
                updatedAt: `2021-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
            })),
        ]
        const scoped = scopeTaskDagTasks(tasks)
        const ids = new Set(scoped.tasks.map(t => t.id))
        // Ancestry survives even though those rows are older than every capped terminal.
        expect(ids.has('active')).toBe(true)
        expect(ids.has('mid-dep')).toBe(true)
        expect(ids.has('ancient-dep')).toBe(true)
        // Unrelated terminals are capped at the recent limit.
        const oldKept = scoped.tasks.filter(t => t.id.startsWith('old-')).length
        expect(oldKept).toBe(TASK_DAG_RECENT_TERMINAL_LIMIT)
        expect(scoped.hiddenCount).toBe(40 - TASK_DAG_RECENT_TERMINAL_LIMIT)
    })

    it('picks the NEWEST terminals by updatedAt within the limit', () => {
        const tasks = Array.from({ length: 5 }, (_, i) => task({
            id: `t-${i}`, status: 'completed', updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }))
        const scoped = scopeTaskDagTasks(tasks, 2)
        expect(scoped.tasks.map(t => t.id).sort()).toEqual(['t-3', 't-4'])
        expect(scoped.hiddenCount).toBe(3)
    })

    it('raising the limit ("load more") reveals more terminals until none are hidden', () => {
        const tasks = Array.from({ length: 100 }, (_, i) => task({
            id: `t-${i}`, status: 'completed', updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        }))
        const first = scopeTaskDagTasks(tasks, TASK_DAG_RECENT_TERMINAL_LIMIT)
        expect(first.tasks).toHaveLength(TASK_DAG_RECENT_TERMINAL_LIMIT)
        expect(first.hiddenCount).toBe(100 - TASK_DAG_RECENT_TERMINAL_LIMIT)
        const more = scopeTaskDagTasks(tasks, TASK_DAG_RECENT_TERMINAL_LIMIT + 50)
        expect(more.tasks).toHaveLength(80)
        expect(more.hiddenCount).toBe(20)
        const all = scopeTaskDagTasks(tasks, 999)
        expect(all.tasks).toHaveLength(100)
        expect(all.hiddenCount).toBe(0)
    })
})
