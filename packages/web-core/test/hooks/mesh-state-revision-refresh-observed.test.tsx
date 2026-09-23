// @vitest-environment jsdom
/**
 * P-II item 4 — useMeshStateRevisionRefresh gains `onRevisionObserved`, fired on
 * EVERY meshStateRevisions push for the viewed mesh (advance or not), so a caller
 * (RepoMesh.tsx) can track push-channel liveness for a WARN-only backstop instead
 * of trusting an always-on interval. `onRevisionAdvance` keeps its existing
 * advance-only contract.
 *
 * Break-once: comment out the `onRevisionObservedRef.current?.()` call in
 * useMeshStateRevisionRefresh.ts and the "observed on non-advancing push" case
 * below goes red (0 calls instead of 1) while onRevisionAdvance assertions stay
 * green — proving the two callbacks are wired independently, not one derived from
 * the other's call count.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMeshStateRevisionRefresh } from '../../src/hooks/useMeshStateRevisionRefresh'
import { subscriptionManager } from '../../src/managers/SubscriptionManager'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const DAEMON_ID = 'daemon-1'
const MESH_ID = 'mesh-1'
const METADATA_KEY = `daemon:metadata:${DAEMON_ID}`

const sendData = vi.fn<(daemonId: string, data: any) => boolean>()

function Harness(props: { onRevisionAdvance: () => void; onRevisionObserved: () => void }) {
    useMeshStateRevisionRefresh({
        daemonIds: [DAEMON_ID],
        meshId: MESH_ID,
        sendData,
        onRevisionAdvance: props.onRevisionAdvance,
        onRevisionObserved: props.onRevisionObserved,
    })
    return null
}

function publishRevision(seq: number, meshStateRevisions: Record<string, number>) {
    subscriptionManager.publish({
        topic: 'daemon.metadata',
        key: METADATA_KEY,
        daemonId: DAEMON_ID,
        seq,
        timestamp: seq * 1000,
        status: { sessions: [] },
        meshStateRevisions,
    } as any)
}

async function flush(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
}

let container: HTMLDivElement
let root: Root

describe('useMeshStateRevisionRefresh — onRevisionObserved liveness signal', () => {
    beforeEach(() => {
        sendData.mockReset()
        sendData.mockReturnValue(true)
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    it('fires onRevisionObserved on the FIRST push even though it seeds the baseline without advancing', async () => {
        const onRevisionAdvance = vi.fn()
        const onRevisionObserved = vi.fn()
        act(() => { root.render(<Harness onRevisionAdvance={onRevisionAdvance} onRevisionObserved={onRevisionObserved} />) })
        await flush()

        await act(async () => {
            publishRevision(1, { [MESH_ID]: 5 })
            await flush()
        })

        expect(onRevisionObserved).toHaveBeenCalledTimes(1)
        expect(onRevisionAdvance).not.toHaveBeenCalled()
    })

    it('fires onRevisionObserved on a REPEATED (non-advancing) push — the case onRevisionAdvance does NOT cover', async () => {
        const onRevisionAdvance = vi.fn()
        const onRevisionObserved = vi.fn()
        act(() => { root.render(<Harness onRevisionAdvance={onRevisionAdvance} onRevisionObserved={onRevisionObserved} />) })
        await flush()

        await act(async () => {
            publishRevision(1, { [MESH_ID]: 5 })
            await flush()
        })
        await act(async () => {
            // Same revision number again — the daemon still pushed, but nothing advanced.
            publishRevision(2, { [MESH_ID]: 5 })
            await flush()
        })

        expect(onRevisionObserved).toHaveBeenCalledTimes(2)
        expect(onRevisionAdvance).not.toHaveBeenCalled()
    })

    it('fires BOTH callbacks when the revision genuinely advances', async () => {
        const onRevisionAdvance = vi.fn()
        const onRevisionObserved = vi.fn()
        act(() => { root.render(<Harness onRevisionAdvance={onRevisionAdvance} onRevisionObserved={onRevisionObserved} />) })
        await flush()

        await act(async () => {
            publishRevision(1, { [MESH_ID]: 5 })
            await flush()
        })
        await act(async () => {
            publishRevision(2, { [MESH_ID]: 6 })
            await flush()
        })

        expect(onRevisionObserved).toHaveBeenCalledTimes(2)
        expect(onRevisionAdvance).toHaveBeenCalledTimes(1)
    })

    it('does not fire either callback for a push carrying no meshStateRevisions field', async () => {
        const onRevisionAdvance = vi.fn()
        const onRevisionObserved = vi.fn()
        act(() => { root.render(<Harness onRevisionAdvance={onRevisionAdvance} onRevisionObserved={onRevisionObserved} />) })
        await flush()

        await act(async () => {
            subscriptionManager.publish({
                topic: 'daemon.metadata',
                key: METADATA_KEY,
                daemonId: DAEMON_ID,
                seq: 1,
                timestamp: 1000,
                status: { sessions: [] },
            } as any)
            await flush()
        })

        expect(onRevisionObserved).not.toHaveBeenCalled()
        expect(onRevisionAdvance).not.toHaveBeenCalled()
    })
})
