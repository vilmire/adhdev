// @vitest-environment jsdom
/**
 * The mesh view is PUSHED: coordinator-only subscriptions, no automatic reads.
 *
 *  - useCoordinatorMeshStatus subscribes to the coordinator's `mesh.status`
 *    topic; the snapshot and the keyed deltas land in the shared store. It
 *    never reads on mount / on a timer; `refresh()` (refresh:true) is the only read.
 *  - Two surfaces mounted on the same mesh share ONE subscription.
 *  - useMeshGraphMetadataSubscription subscribes to the COORDINATOR daemon only,
 *    never to the member daemons that serve the mesh's other nodes.
 *
 * Break-once: re-add a mount / revision / backstop read (or member-daemon
 * subscriptions) and the matching case goes red.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCoordinatorMeshStatus } from '../../src/hooks/useCoordinatorMeshStatus'
import { useMeshGraphMetadataSubscription } from '../../src/hooks/useMeshGraphMetadataSubscription'
import { subscriptionManager } from '../../src/managers/SubscriptionManager'
import { resetCoordinatorMeshStatusStore } from '../../src/utils/coordinator-mesh-status-store'
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function statusResponse(meshId: string) {
    return {
        meshId,
        meshName: 'Mesh',
        repoIdentity: 'repo',
        refreshedAt: '2026-09-27T00:00:00.000Z',
        nodes: [
            { nodeId: 'node_coord', workspace: '/repo', machineLabel: 'coord', health: 'online', providers: [], activeSessions: [], daemonId: 'coord-daemon', connection: { state: 'self' } },
            { nodeId: 'node_member', workspace: '/remote', machineLabel: 'member', health: 'online', providers: [], activeSessions: [], daemonId: 'member-daemon' },
        ],
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    resetCoordinatorMeshStatusStore()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

describe('useCoordinatorMeshStatus — pushed, never polled', () => {
    it('the mesh.status snapshot and a one-node delta land in the store; no automatic read; refresh() is the only read', async () => {
        const daemonId = 'coord-trigger-1'
        const meshId = 'mesh-trigger-1'
        const load = vi.fn(async (_d: string, m: string, _o: { refresh: boolean }) => statusResponse(m))
        const sendData = vi.fn((_d: string, _data: any) => true)
        let api: ReturnType<typeof useCoordinatorMeshStatus> | null = null
        function Harness() {
            api = useCoordinatorMeshStatus({ meshId, daemonId, load, sendData })
            return null
        }
        vi.useFakeTimers()
        try {
            await act(async () => { root.render(<Harness />) })
            // ONE subscribe to the coordinator, no command read.
            expect(sendData.mock.calls.map(call => [call[0], call[1].topic, call[1].params])).toEqual([[daemonId, 'mesh.status', { meshId }]])
            expect(load).not.toHaveBeenCalled()
            expect(api!.loading).toBe(true)

            const key = `mesh:status:${meshId}`
            await act(async () => {
                subscriptionManager.publish({ topic: 'mesh.status', key, mode: 'snapshot', wireVersion: DASHBOARD_WIRE_VERSION, meshId, status: statusResponse(meshId), seq: 1, timestamp: 1 } as any)
            })
            expect(api!.status?.nodes.map(n => n.health)).toEqual(['online', 'online'])
            expect(api!.loading).toBe(false)
            await act(async () => {
                subscriptionManager.publish({
                    topic: 'mesh.status', key, mode: 'delta', meshId, seq: 2, timestamp: 2,
                    delta: { collections: { nodes: { upsert: [{ nodeId: 'node_member', health: 'offline' }] } } },
                } as any)
            })
            expect(api!.status?.nodes.map(n => [n.nodeId, n.health])).toEqual([['node_coord', 'online'], ['node_member', 'offline']])

            // Minutes of silence: nothing is read (no backstop, no poll).
            await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
            expect(load).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
        await act(async () => { await api!.refresh(); await flush() })
        expect(load.mock.calls.map(call => call[2])).toEqual([{ refresh: true }])
    })

    it('a delta with a seq gap re-subscribes for a fresh snapshot instead of folding blindly', async () => {
        const daemonId = 'coord-gap'
        const meshId = 'mesh-gap'
        const sendData = vi.fn((_d: string, _data: any) => true)
        function Harness() { useCoordinatorMeshStatus({ meshId, daemonId, load: null, sendData }); return null }
        await act(async () => { root.render(<Harness />) })
        const key = `mesh:status:${meshId}`
        await act(async () => {
            subscriptionManager.publish({ topic: 'mesh.status', key, mode: 'snapshot', wireVersion: DASHBOARD_WIRE_VERSION, meshId, status: statusResponse(meshId), seq: 1, timestamp: 1 } as any)
            subscriptionManager.publish({ topic: 'mesh.status', key, mode: 'delta', meshId, seq: 3, timestamp: 3, delta: { set: { meshName: 'X' } } } as any)
        })
        expect(sendData.mock.calls.filter(call => call[1].type === 'subscribe')).toHaveLength(2)
    })

    it('two surfaces on the same mesh share ONE subscription', async () => {
        const daemonId = 'coord-shared'
        const meshId = 'mesh-shared'
        const sendData = vi.fn((_d: string, _data: any) => true)
        const load = vi.fn(async (_d: string, m: string) => statusResponse(m))
        function A() { useCoordinatorMeshStatus({ meshId, daemonId, load, sendData }); return null }
        function B() { useCoordinatorMeshStatus({ meshId, daemonId, load, sendData }); return null }
        await act(async () => { root.render(<><A /><B /></>) })
        await act(async () => { await flush() })
        expect(sendData.mock.calls.filter(call => call[1].topic === 'mesh.status')).toHaveLength(1)
        expect(load).not.toHaveBeenCalled()
    })
})

describe('useMeshGraphMetadataSubscription — coordinator only', () => {
    it('subscribes daemon.metadata on the coordinator daemon and never on member daemons', async () => {
        const sendData = vi.fn((_daemonId: string, _data: any) => true)
        const status = statusResponse('mesh-sub-1') as any
        function Harness() {
            useMeshGraphMetadataSubscription({ status, daemonId: 'coord-sub-1', meshId: 'mesh-sub-1', sendData })
            return null
        }
        await act(async () => { root.render(<Harness />) })
        await act(async () => { await flush() })
        const targets = new Set(sendData.mock.calls.map(call => call[0]))
        expect(targets).toEqual(new Set(['coord-sub-1']))
        expect(targets.has('member-daemon')).toBe(false)
    })

    it("injects the coordinator's own unstamped session into ITS node, not the first listed node", async () => {
        const sendData = vi.fn(() => true)
        const status = {
            ...statusResponse('mesh-sub-2'),
            // Member node listed FIRST: the old "first node" guess put the coordinator here.
            nodes: [...statusResponse('mesh-sub-2').nodes].reverse(),
        } as any
        let displayed: any = null
        function Harness() {
            displayed = useMeshGraphMetadataSubscription({ status, daemonId: 'coord-sub-2', meshId: 'mesh-sub-2', sendData })
            return null
        }
        await act(async () => { root.render(<Harness />) })
        await act(async () => {
            subscriptionManager.publish({
                topic: 'daemon.metadata',
                wireVersion: DASHBOARD_WIRE_VERSION,
                key: 'daemon:metadata:coord-sub-2',
                daemonId: 'coord-sub-2',
                seq: 1,
                timestamp: 1,
                status: { sessions: [{ id: 'coord_sess', providerType: 'claude-cli', status: 'generating', settings: { meshCoordinatorFor: 'mesh-sub-2' }, coordinator: { meshId: 'mesh-sub-2' } }] },
            } as any)
            await flush()
        })
        const member = displayed.nodes.find((n: any) => n.nodeId === 'node_member')
        const coord = displayed.nodes.find((n: any) => n.nodeId === 'node_coord')
        expect(member.activeSessionDetails ?? []).toEqual([])
        expect(coord.activeSessionDetails.map((s: any) => s.sessionId)).toEqual(['coord_sess'])
    })
})
