import { describe, expect, it } from 'vitest'
import type { RepoMeshQueueTask, RepoMeshStatus } from '@adhdev/daemon-core'
import { buildMeshTasksView } from '../../src/components/MeshGraph/meshTasksViewModel'
import { queueTaskDisplayText, stripMarkdownSyntax } from '../../src/utils/queue-task-label'

// Mission-centric Tasks-tab projection: queue rows → running strip + attention
// strip + mission groups. Grouping keys off missionId, titles resolve from
// status.missions, and the dependency drill-down is offered only for groups
// whose tasks carry renderable edges.

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

function statusWithMissions(missions: Array<{ id: string; title: string; status: string }>): Pick<RepoMeshStatus, 'missions'> {
    return { missions: missions as RepoMeshStatus['missions'] }
}

describe('buildMeshTasksView', () => {
    it('groups tasks by mission, resolves titles, and buckets mission-less tasks as ad-hoc', () => {
        const view = buildMeshTasksView(
            [
                task({ id: 'a', missionId: 'm1', status: 'assigned' }),
                task({ id: 'b', missionId: 'm1', status: 'completed' }),
                task({ id: 'c', status: 'pending' }),
            ],
            statusWithMissions([{ id: 'm1', title: 'Fix the flaky gate', status: 'active' }]),
        )
        expect(view.groups).toHaveLength(2)
        const m1 = view.groups.find(group => group.missionId === 'm1')!
        expect(m1.title).toBe('Fix the flaky gate')
        expect(m1.missionStatus).toBe('active')
        expect(m1.counts).toMatchObject({ total: 2, assigned: 1, completed: 1 })
        const adhoc = view.groups.find(group => group.missionId === null)!
        expect(adhoc.title).toBeNull()
        expect(adhoc.tasks.map(t => t.id)).toEqual(['c'])
    })

    it('keeps a null title for a missionId absent from the missions list', () => {
        const view = buildMeshTasksView([task({ id: 'a', missionId: 'm-unknown' })], statusWithMissions([]))
        expect(view.groups[0].missionId).toBe('m-unknown')
        expect(view.groups[0].title).toBeNull()
    })

    it('orders groups: running work first, then most recent activity', () => {
        const view = buildMeshTasksView(
            [
                task({ id: 'old-done', missionId: 'm-idle', status: 'completed', updatedAt: '2026-08-16T00:00:00.000Z' }),
                task({ id: 'fresh-done', missionId: 'm-fresh', status: 'completed', updatedAt: '2026-08-16T12:00:00.000Z' }),
                task({ id: 'run', missionId: 'm-running', status: 'assigned', updatedAt: '2026-08-15T00:00:00.000Z' }),
            ],
            null,
        )
        expect(view.groups.map(group => group.missionId)).toEqual(['m-running', 'm-fresh', 'm-idle'])
    })

    it('orders tasks inside a group by display status: running → queued → failed → done → cancelled', () => {
        const view = buildMeshTasksView(
            [
                task({ id: 'done', missionId: 'm', status: 'completed' }),
                task({ id: 'gone', missionId: 'm', status: 'cancelled' }),
                task({ id: 'broken', missionId: 'm', status: 'failed' }),
                task({ id: 'run', missionId: 'm', status: 'assigned' }),
                task({ id: 'wait', missionId: 'm', status: 'pending' }),
            ],
            null,
        )
        expect(view.groups[0].tasks.map(t => t.id)).toEqual(['run', 'wait', 'broken', 'done', 'gone'])
    })

    it('collects running and attention strips (failed + dependency-blocked pending)', () => {
        const view = buildMeshTasksView(
            [
                task({ id: 'run', status: 'assigned' }),
                task({ id: 'broken', status: 'failed' }),
                task({ id: 'held', status: 'pending', blockedReason: 'dependency_failed:broken' }),
                task({ id: 'plain', status: 'pending' }),
            ],
            null,
        )
        expect(view.running.map(t => t.id)).toEqual(['run'])
        expect(view.attention.map(t => t.id).sort()).toEqual(['broken', 'held'])
        expect(view.counts.blocked).toBe(1)
    })

    it('marks hasDependencies only when an edge target is inside the scoped set', () => {
        const view = buildMeshTasksView(
            [
                task({ id: 'root', missionId: 'wired', status: 'completed' }),
                task({ id: 'child', missionId: 'wired', status: 'pending', dependsOn: ['root'] }),
                task({ id: 'dangling', missionId: 'plain', status: 'pending', dependsOn: ['not-in-scope'] }),
            ],
            null,
        )
        expect(view.groups.find(group => group.missionId === 'wired')!.hasDependencies).toBe(true)
        expect(view.groups.find(group => group.missionId === 'plain')!.hasDependencies).toBe(false)
    })

    it('caps terminal history via the shared scope and reports hiddenCount', () => {
        const tasks = [
            task({ id: 'active', status: 'pending' }),
            ...Array.from({ length: 5 }, (_, i) => task({
                id: `done-${i}`,
                status: 'completed' as const,
                updatedAt: `2026-08-10T0${i}:00:00.000Z`,
            })),
        ]
        const view = buildMeshTasksView(tasks, null, 2)
        expect(view.hiddenCount).toBe(3)
        expect(view.counts.total).toBe(3)
    })
})

describe('stripMarkdownSyntax', () => {
    it('removes headings, emphasis, code and list markers but keeps the wording', () => {
        const input = '# 실행 중인 워크트리가 삭제됐다\n## ★먼저 읽어라\n- `mesh_git_status` 확인\n**의미 있는 진전**이 생길 때마다 *즉시* 커밋'
        const output = stripMarkdownSyntax(input)
        expect(output).toContain('실행 중인 워크트리가 삭제됐다')
        expect(output).toContain('★먼저 읽어라')
        expect(output).toContain('mesh_git_status 확인')
        expect(output).toContain('의미 있는 진전이 생길 때마다 즉시 커밋')
        expect(output).not.toMatch(/[#*`]|^- /m)
    })

    it('unwraps links and drops code-fence delimiters', () => {
        expect(stripMarkdownSyntax('See [the guide](https://example.com)\n```bash\nnpm test\n```')).toBe('See the guide\nnpm test')
    })

    it('passes plain text through untouched', () => {
        expect(stripMarkdownSyntax('plain sentence with 2 * 3 math')).toBe('plain sentence with 2 * 3 math')
    })
})

describe('queueTaskDisplayText', () => {
    it('composes the MAGI relabel with the markdown strip', () => {
        const magi = 'You are one independent member of a multi-agent cross-verification quorum.\n## Question\nIs **this** real?\n## Rules\n…'
        expect(queueTaskDisplayText(magi)).toBe('MAGI cross-verify — Is **this** real?'.replace('**this**', 'this'))
    })
})
