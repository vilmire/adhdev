// @vitest-environment jsdom
//
// The /mesh list used to await list_meshes from EVERY connected daemon
// (Promise.allSettled) before painting — live, 7+ s while the slowest daemon
// answered. It now paints as soon as a daemon answers with meshes and merges
// later answers in, keeping host-first precedence and never flashing the empty
// state while answers are pending.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    collectMeshListAnswersProgressively,
    upsertPartialMeshList,
    useMeshList,
    type MeshListProgress,
} from '../../src/pages/repo-mesh/useMeshList'

const daemon = (id: string) => ({ id, type: 'adhdev-daemon' }) as any
const hostPinned = (name: string, id = 'mesh_1') => ({
    id,
    name,
    meshHost: { hostDaemonId: 'daemon_host', hostNodeId: 'node_host' },
    nodes: [{ id: 'node_host', daemon_id: 'daemon_host', workspace: '/r' }],
}) as any

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('collectMeshListAnswersProgressively', () => {
    it('reports the member copy first, then the host copy replaces it; a late member answer never displaces the host', async () => {
        const daemons = [daemon('daemon_member'), daemon('daemon_host'), daemon('daemon_member2')]
        const pending = new Map(daemons.map(d => [d.id, deferred<any>()]))
        const progress: MeshListProgress[] = []
        const done = collectMeshListAnswersProgressively(
            daemons,
            d => pending.get(d.id)!.promise,
            p => progress.push(p),
        )

        pending.get('daemon_member')!.resolve({ daemonId: 'daemon_member', meshes: [hostPinned('member copy')] })
        await flush()
        expect(progress.at(-1)).toMatchObject({ settled: 1, total: 3 })
        expect(progress.at(-1)!.merged.map(m => m.name)).toEqual(['member copy'])

        pending.get('daemon_host')!.resolve({ daemonId: 'daemon_host', meshes: [hostPinned('host copy'), hostPinned('host only', 'mesh_2')] })
        await flush()
        expect(progress.at(-1)!.merged.map(m => m.name)).toEqual(['host copy', 'host only'])

        pending.get('daemon_member2')!.resolve({ daemonId: 'daemon_member2', meshes: [hostPinned('late member copy')] })
        const final = await done
        expect(final.map(m => m.name)).toEqual(['host copy', 'host only'])
        expect(progress.at(-1)).toMatchObject({ settled: 3, total: 3 })
    })

    it('merges in daemon order regardless of arrival order, and a failed daemon just settles', async () => {
        const daemons = [daemon('daemon_a'), daemon('daemon_b'), daemon('daemon_c')]
        const pending = new Map(daemons.map(d => [d.id, deferred<any>()]))
        const done = collectMeshListAnswersProgressively(daemons, d => pending.get(d.id)!.promise)
        pending.get('daemon_c')!.resolve({ daemonId: 'daemon_c', meshes: [{ id: 'mesh_c', name: 'c', nodes: [] }] })
        pending.get('daemon_b')!.reject(new Error('offline'))
        pending.get('daemon_a')!.resolve({ daemonId: 'daemon_a', meshes: [{ id: 'mesh_a', name: 'a', nodes: [] }] })
        expect((await done).map(m => m.id)).toEqual(['mesh_a', 'mesh_c'])
    })

    it('upsertPartialMeshList replaces answered entries and keeps not-yet-answered ones', () => {
        const prev = [{ id: 'x', name: 'old x' }, { id: 'y', name: 'old y' }] as any[]
        const next = upsertPartialMeshList(prev, [{ id: 'y', name: 'new y' }, { id: 'z', name: 'z' }] as any[])
        expect(next.map(m => `${m.id}:${m.name}`)).toEqual(['x:old x', 'y:new y', 'z:z'])
    })
})

describe('useMeshList progressive load', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    function mount(daemonIds: string[], sendCommand: (daemonId: string) => Promise<any>) {
        const state: { current: ReturnType<typeof useMeshList> | null } = { current: null }
        const daemons = daemonIds.map(daemon)
        function Harness() {
            state.current = useMeshList({
                daemons,
                primaryDaemonId: daemonIds[0],
                sendCommand: ((daemonId: string) => sendCommand(daemonId)) as any,
                unwrapResult: (raw: any) => raw,
                normalizeMesh: (mesh: any) => mesh,
                features: { createDaemonPicker: true },
            })
            return null
        }
        act(() => root.render(<Harness />))
        return state
    }

    it('paints on the first answer with meshes and upgrades to the host copy when the host answers', async () => {
        const answers = { daemon_member: deferred<any>(), daemon_host: deferred<any>() } as Record<string, ReturnType<typeof deferred<any>>>
        const state = mount(['daemon_member', 'daemon_host'], id => answers[id].promise)

        let load!: Promise<void>
        act(() => { load = state.current!.loadMeshes() })
        expect(state.current!.loading).toBe(true)

        await act(async () => {
            answers.daemon_member.resolve({ success: true, meshes: [hostPinned('member copy')] })
            await flush()
        })
        // Host still pending, but the list is already on screen.
        expect(state.current!.loading).toBe(false)
        expect(state.current!.meshes.map(m => m.name)).toEqual(['member copy'])

        await act(async () => {
            answers.daemon_host.resolve({ success: true, meshes: [hostPinned('host copy')] })
            await load
        })
        expect(state.current!.loading).toBe(false)
        expect(state.current!.meshes.map(m => m.name)).toEqual(['host copy'])
    })

    it('keeps the loading state (no empty-state flash) while only empty answers have arrived', async () => {
        const answers = { daemon_a2: deferred<any>(), daemon_b2: deferred<any>() } as Record<string, ReturnType<typeof deferred<any>>>
        const state = mount(['daemon_a2', 'daemon_b2'], id => answers[id].promise)

        let load!: Promise<void>
        act(() => { load = state.current!.loadMeshes() })
        await act(async () => {
            answers.daemon_a2.resolve({ success: true, meshes: [] })
            await flush()
        })
        expect(state.current!.loading).toBe(true)
        expect(state.current!.meshes).toEqual([])

        await act(async () => {
            answers.daemon_b2.resolve({ success: true, meshes: [] })
            await load
        })
        // All settled: now the empty state is the truth.
        expect(state.current!.loading).toBe(false)
        expect(state.current!.meshes).toEqual([])
    })

    it('stays on the loading state (never "no meshes") before any daemon can answer, and loads once one appears', async () => {
        const calls: string[] = []
        const state = mount([], id => { calls.push(id); return Promise.resolve({ success: true, meshes: [] }) })
        expect(state.current!.loading).toBe(true)
        await act(async () => { await state.current!.loadMeshes() })
        // Nobody was asked, so nothing loaded: still loading, no empty list rendered as truth.
        expect(calls).toEqual([])
        expect(state.current!.loading).toBe(true)

        // A daemon connects: the first real answer ends the loading state.
        const later = mount(['daemon_late'], id => { calls.push(id); return Promise.resolve({ success: true, meshes: [hostPinned('late', 'mesh_late')] }) })
        await act(async () => { await later.current!.loadMeshes(true) })
        expect(calls).toEqual(['daemon_late'])
        expect(later.current!.loading).toBe(false)
        expect(later.current!.meshes.map(m => m.id)).toEqual(['mesh_late'])
    })
})
