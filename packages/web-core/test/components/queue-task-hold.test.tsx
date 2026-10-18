import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QueueTaskHold } from '../../src/components/MeshGraph/QueueTaskHold'
import type { RepoMeshQueueTask } from '@adhdev/daemon-core'
const task = { id: 'held', status: 'pending', message: 'Fix tests', hold: { reason: 'owned_paths_conflict', since: '2026-10-18T00:00:00Z', blockingTaskIds: ['holder-task-id'], blockingTasks: [{ taskId: 'holder-task-id', title: 'Broad test owner' }], detail: {} } } as RepoMeshQueueTask
describe('held task presentation', () => {
    it('shows reason, blocker title/id and age on pending tasks', () => {
        const html = renderToStaticMarkup(<QueueTaskHold task={task} nowMs={Date.parse('2026-10-18T00:04:00Z')} />)
        expect(html).toContain('Held: owned_paths_conflict by Broad test owner (holder-t)')
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
})
