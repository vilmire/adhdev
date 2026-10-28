// @vitest-environment jsdom
//
// Standalone page load: the first list_meshes call fires before the WS command
// channel is open and throws "WS command channel unavailable". The list must stay
// on its loading state (no empty state, no raw error) and re-fetch once the
// transport is ready.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTransportNotReadyError, useMeshList } from '../../src/pages/repo-mesh/useMeshList'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('isTransportNotReadyError', () => {
    it('recognises the standalone channel-unavailable error and ignores real failures', () => {
        expect(isTransportNotReadyError(new Error('WS command channel unavailable: list_meshes'))).toBe(true)
        expect(isTransportNotReadyError(new Error('Permission denied'))).toBe(false)
        expect(isTransportNotReadyError(null)).toBe(false)
    })
})

describe('useMeshList transport-not-ready retry', () => {
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

    function mount(ids: string[], picker: boolean, sendCommand: () => Promise<any>) {
        const state: { current: ReturnType<typeof useMeshList> | null } = { current: null }
        const daemons = ids.map(id => ({ id, type: 'adhdev-daemon' }) as any)
        function Harness() {
            state.current = useMeshList({
                daemons,
                primaryDaemonId: ids[0]!,
                sendCommand: sendCommand as any,
                unwrapResult: (raw: any) => raw,
                normalizeMesh: (mesh: any) => mesh,
                features: { createDaemonPicker: picker },
            })
            return null
        }
        act(() => root.render(<Harness />))
        return state
    }

    for (const picker of [false, true]) {
        it(`${picker ? 'multi-daemon' : 'single-daemon'}: stays loading, then lists meshes once the channel is ready`, async () => {
            let ready = false
            const calls = { n: 0 }
            const state = mount([picker ? 'retry_daemon_p' : 'retry_daemon_s'], picker, async () => {
                calls.n += 1
                if (!ready) throw new Error('WS command channel unavailable: list_meshes')
                return { success: true, meshes: [{ id: 'mesh_1', name: 'Recovered', nodes: [] }] }
            })
            await act(async () => { await state.current!.loadMeshes() })
            // Transport not ready: loading, not empty, and no raw error.
            expect(state.current!.loading).toBe(true)
            expect(state.current!.error).toBeNull()
            expect(state.current!.meshes).toEqual([])
            ready = true
            await act(async () => { await wait(450) })
            expect(calls.n).toBeGreaterThan(1)
            expect(state.current!.meshes.map(m => m.name)).toEqual(['Recovered'])
            expect(state.current!.loading).toBe(false)
            expect(state.current!.error).toBeNull()
        })
    }

    it('real (non-transport) errors still surface immediately', async () => {
        const state = mount(['retry_daemon_err'], false, async () => { throw new Error('boom') })
        await act(async () => { await state.current!.loadMeshes() })
        expect(state.current!.error).toBe('boom')
        expect(state.current!.loading).toBe(false)
    })
})
