/**
 * useMeshQueue — the mesh task queue, read from the coordinator's mesh_status.
 *
 * The coordinator's `mesh_status` already carries the queue (`queue.tasks`),
 * so the page never asks a separate daemon for it — in particular never an
 * arbitrary connected daemon (`daemons[0]`), which on cloud is just whichever
 * peer connected first. The queue refreshes whenever the coordinator status
 * does (revision push / backstop / manual refresh).
 */
import { useMemo } from 'react'
import type { RepoMeshStatus } from '@adhdev/daemon-core'
import type { MeshQueueEntry } from './types'

/** Stable empty result so consumers depending on `meshQueue` identity don't re-run. */
const EMPTY_QUEUE: MeshQueueEntry[] = []

export function readMeshQueueFromStatus(status: RepoMeshStatus | null | undefined): MeshQueueEntry[] {
    const queue = (status as { queue?: unknown } | null | undefined)?.queue
    const tasks = queue && typeof queue === 'object' && !Array.isArray(queue)
        ? (queue as { tasks?: unknown }).tasks
        : queue
    if (!Array.isArray(tasks)) return EMPTY_QUEUE
    return tasks.filter((task): task is MeshQueueEntry => !!task && typeof task === 'object' && typeof (task as MeshQueueEntry).id === 'string')
}

interface UseMeshQueueOptions {
    /** The selected mesh's coordinator status (null while not loaded). */
    status: RepoMeshStatus | null
}

export function useMeshQueue({ status }: UseMeshQueueOptions) {
    const meshQueue = useMemo(() => readMeshQueueFromStatus(status), [status])
    return { meshQueue }
}
