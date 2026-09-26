// @vitest-environment jsdom
/**
 * One shared loader, coordinator-only subscriptions, refresh:false on every
 * automatic trigger.
 *
 *  - useCoordinatorMeshStatus reads refresh:false on mount and on a coordinator
 *    revision advance; refresh:true only via its explicit `refresh()`.
 *  - Two surfaces mounted on the same mesh share one request (store dedupe).
 *  - useMeshGraphMetadataSubscription subscribes to the COORDINATOR daemon only,
 *    never to the member daemons that serve the mesh's other nodes.
 *
 * Break-once: re-add `extraDaemonIds` member subscriptions (or pass `refresh`
 * true from the revision handler) and the matching case goes red.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCoordinatorMeshStatus } from '../../src/hooks/useCoordinatorMeshStatus'
import { useMeshGraphMetadataSubscription } from '../../src/hooks/useMeshGraphMetadataSubscription'
import { subscriptionManager } from '../../src/managers/SubscriptionManager'
import { resetCoordinatorMeshStatusStore } from '../../src/utils/coordinator-mesh-status-store'

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

describe('useCoordinatorMeshStatus triggers', () => {
    it('mount and coordinator revision advance read refresh:false; only refresh() reads refresh:true', async () => {
        const daemonId = 'coord-trigger-1'
        const meshId = 'mesh-trigger-1'
        const load = vi.fn(async (_d: string, m: string, _o: { refresh: boolean }) => statusResponse(m))
        const sendData = vi.fn(() => true)
        let api: ReturnType<typeof useCoordinatorMeshStatus> | null = null
        function Harness() {
            api = useCoordinatorMeshStatus({ meshId, daemonId, load, sendData, backstopMs: 0 })
            return null
        }
        await act(async () => { root.render(<Harness />) })
        await act(async () => { await flush() })
        expect(load.mock.calls.map(call => call[2])).toEqual([{ refresh: false }])

        const publish = (seq: number, rev: number) => subscriptionManager.publish({
            topic: 'daemon.metadata',
            key: `daemon:metadata:${daemonId}`,
            daemonId,
            seq,
            timestamp: seq,
            status: { sessions: [] },
            meshStateRevisions: { [meshId]: rev },
        } as any)
        await act(async () => { publish(1, 1); await flush() }) // seeds baseline
        await act(async () => { publish(2, 2); await flush() }) // advance
        expect(load.mock.calls.map(call => call[2])).toEqual([{ refresh: false }, { refresh: false }])

        await act(async () => { await api!.refresh(); await flush() })
        expect(load.mock.calls.map(call => call[2])).toEqual([{ refresh: false }, { refresh: false }, { refresh: true }])
        expect(api!.status?.meshId).toBe(meshId)
    })

    it('two surfaces on the same mesh share ONE coordinator request', async () => {
        const daemonId = 'coord-shared'
        const meshId = 'mesh-shared'
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const load = vi.fn(async (_d: string, m: string) => { await gate; return statusResponse(m) })
        function A() { useCoordinatorMeshStatus({ meshId, daemonId, load, backstopMs: 0 }); return null }
        function B() { useCoordinatorMeshStatus({ meshId, daemonId, load, backstopMs: 0 }); return null }
        await act(async () => { root.render(<><A /><B /></>) })
        await act(async () => { release(); await flush() })
        expect(load).toHaveBeenCalledTimes(1)
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
