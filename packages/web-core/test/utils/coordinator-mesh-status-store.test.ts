/**
 * The shared coordinator mesh-status store: ONE loader per mesh for every
 * surface (/mesh page, graph dialog, session info dialog).
 *
 * Pins: concurrent reads collapse into one request; an explicit refresh that
 * arrives mid-read runs once, after; a failed read keeps the last good status
 * and never rejects; nothing retries on its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    getCoordinatorMeshStatusSnapshot,
    loadCoordinatorMeshStatus,
    peekCoordinatorMeshStatus,
    resetCoordinatorMeshStatusStore,
    subscribeCoordinatorMeshStatus,
} from '../../src/utils/coordinator-mesh-status-store'

function meshStatusResponse(meshId: string, refreshedAt: string) {
    return {
        success: true,
        result: {
            success: true,
            meshId,
            meshName: 'Mesh',
            repoIdentity: 'repo',
            refreshedAt,
            nodes: [{ nodeId: 'node_1', workspace: '/repo', machineLabel: 'box', health: 'online', providers: [], activeSessions: [] }],
            queue: { tasks: [{ id: 'task_1', message: 'x', status: 'assigned', assignedNodeId: 'node_1' }], summary: {} },
        },
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

afterEach(() => resetCoordinatorMeshStatusStore())

describe('coordinator mesh-status store', () => {
    it('collapses concurrent reads of the same mesh into ONE coordinator request', async () => {
        const gate = deferred<unknown>()
        const load = vi.fn(() => gate.promise)
        const a = loadCoordinatorMeshStatus({ meshId: 'm1', daemonId: 'coord', load })
        const b = loadCoordinatorMeshStatus({ meshId: 'm1', daemonId: 'coord', load })
        gate.resolve(meshStatusResponse('m1', '2026-09-27T00:00:00.000Z'))
        const [sa, sb] = await Promise.all([a, b])
        expect(load).toHaveBeenCalledTimes(1)
        expect(load).toHaveBeenCalledWith('coord', 'm1', { refresh: false })
        expect(sa).toBe(sb)
        expect(peekCoordinatorMeshStatus('m1')?.meshId).toBe('m1')
        expect(getCoordinatorMeshStatusSnapshot('m1')?.daemonId).toBe('coord')
    })

    it('an explicit refresh arriving mid-read runs once, after the plain read', async () => {
        const gate = deferred<unknown>()
        const load = vi.fn((_d: string, _m: string, opts: { refresh: boolean }) =>
            opts.refresh ? Promise.resolve(meshStatusResponse('m1', '2026-09-27T00:00:05.000Z')) : gate.promise)
        const plain = loadCoordinatorMeshStatus({ meshId: 'm1', daemonId: 'coord', load })
        const r1 = loadCoordinatorMeshStatus({ meshId: 'm1', daemonId: 'coord', load, refresh: true })
        const r2 = loadCoordinatorMeshStatus({ meshId: 'm1', daemonId: 'coord', load, refresh: true })
        gate.resolve(meshStatusResponse('m1', '2026-09-27T00:00:00.000Z'))
        await Promise.all([plain, r1, r2])
        expect(load.mock.calls.map(call => call[2])).toEqual([{ refresh: false }, { refresh: true }])
        expect(peekCoordinatorMeshStatus('m1')?.refreshedAt).toBe('2026-09-27T00:00:05.000Z')
    })

    it('a failed read keeps the last good status, records the error, resolves null, and does not retry', async () => {
        const ok = vi.fn(async () => meshStatusResponse('m1', '2026-09-27T00:00:00.000Z'))
        await loadCoordinatorMeshStatus({ meshId: 'm1', daemonId: 'coord', load: ok })
        const failing = vi.fn(async () => { throw new Error('p2p down') })
        await expect(loadCoordinatorMeshStatus({ meshId: 'm1', daemonId: 'coord', load: failing })).resolves.toBeNull()
        expect(failing).toHaveBeenCalledTimes(1)
        const snapshot = getCoordinatorMeshStatusSnapshot('m1')
        expect(snapshot?.status?.refreshedAt).toBe('2026-09-27T00:00:00.000Z')
        expect(snapshot?.error).toBe('p2p down')
        expect(snapshot?.loading).toBe(false)
    })

    it('a loader that throws synchronously still settles cleanly', async () => {
        const load = vi.fn(() => { throw new Error('boom') })
        await expect(loadCoordinatorMeshStatus({ meshId: 'm2', daemonId: 'coord', load: load as any })).resolves.toBeNull()
        expect(getCoordinatorMeshStatusSnapshot('m2')?.error).toBe('boom')
        // The in-flight slot was released: the next read issues a new request.
        await loadCoordinatorMeshStatus({ meshId: 'm2', daemonId: 'coord', load: load as any })
        expect(load).toHaveBeenCalledTimes(2)
    })

    it('notifies subscribers of the shared snapshot and refuses to read without a coordinator', async () => {
        const listener = vi.fn()
        const unsubscribe = subscribeCoordinatorMeshStatus('m3', listener)
        const load = vi.fn(async () => meshStatusResponse('m3', '2026-09-27T00:00:00.000Z'))
        await loadCoordinatorMeshStatus({ meshId: 'm3', daemonId: '', load })
        expect(load).not.toHaveBeenCalled()
        await loadCoordinatorMeshStatus({ meshId: 'm3', daemonId: 'coord', load })
        expect(listener).toHaveBeenCalled()
        unsubscribe()
    })
})
