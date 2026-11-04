import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QueueTaskHold } from '../../src/components/MeshGraph/QueueTaskHold'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
const task = { id: 'held', status: 'pending', message: 'Fix tests', hold: { reason: 'owned_paths_conflict', since: '2026-10-18T00:00:00Z', blockingTaskIds: ['holder-task-id'], blockingTasks: [{ taskId: 'holder-task-id', title: 'Broad test owner' }], detail: {} } } as RepoMeshQueueTask
describe('held task presentation', () => {
    it('shows reason, blocker title/id and age on pending tasks', () => {
        const html = renderToStaticMarkup(<QueueTaskHold task={task} nowMs={Date.parse('2026-10-18T00:04:00Z')} />)
        expect(html).toContain('Held: owned_paths_conflict by Broad test owner (holder-task-id)')
        expect(html).toContain('4 min')
    })
    it('hides a stale hold on assigned tasks', () => {
        expect(renderToStaticMarkup(<QueueTaskHold task={{ ...task, status: 'assigned' }} />)).toBe('')
    })
    it('renders a reason without an unknown blocker', () => {
        const html = renderToStaticMarkup(<QueueTaskHold task={{ ...task, hold: { ...task.hold!, blockingTaskIds: [] } }} />)
        expect(html).toContain('Held: owned_paths_conflict')
        expect(html).not.toContain(' by ')
    })
    it('names the colliding path or shared resource and the way out', () => {
        const held = { ...task, hold: { ...task.hold!, detail: {
            overlappingPaths: [{ taskId: 'holder-task-id', ownedPath: 'src/a.ts', blockingPath: 'src/**' }, { taskId: 'holder-task-id', ownedPath: 'physical_workspace_or_shared_resource', blockingPath: 'physical_workspace_or_shared_resource' }],
            canonicalResource: '/repo/.git/refs',
            resolution: 'resolves when task holder-task-id is no longer assigned',
        } } } as RepoMeshQueueTask
        const html = renderToStaticMarkup(<QueueTaskHold task={held} nowMs={Date.parse('2026-10-18T00:04:00Z')} />)
        expect(html).toContain('src/a.ts ↔ src/**')
        expect(html).toContain('physical_workspace_or_shared_resource')
        expect(html).toContain('/repo/.git/refs')
        expect(html).toContain('resolves when task holder-task-id is no longer assigned')
    })
})
