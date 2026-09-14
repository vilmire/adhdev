// @vitest-environment jsdom
/**
 * D1#2 regression — useDaemonMetadataLoader must release the subscription handle
 * it opens.
 *
 * The loader is an imperative callback, so subscribe() used to be called with its
 * returned handle read only for `initialSendAccepted` and then dropped. Nothing
 * ever called it, so every daemon the dashboard touched left a live handler in the
 * module-global SubscriptionManager plus a live daemon-side subscription — for the
 * whole page lifetime, across every mount/unmount cycle.
 *
 * These assert on observable wire traffic (an `unsubscribe` frame reaching the
 * transport) and on the manager no longer delivering to the unmounted handler,
 * not on internals.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscribeRequest, UnsubscribeRequest } from '@adhdev/daemon-core'
import { useDaemonMetadataLoader } from '../../src/hooks/useDaemonMetadataLoader'
import { subscriptionManager } from '../../src/managers/SubscriptionManager'

const sendData = vi.fn<(daemonId: string, data: SubscribeRequest | UnsubscribeRequest) => boolean>()
const sendCommand = vi.fn<(daemonId: string, command: string) => Promise<unknown>>()
const injectEntries = vi.fn()
const getIdes = vi.fn(() => [] as any[])

vi.mock('../../src/context/TransportContext', () => ({
    useTransport: () => ({ sendCommand, sendData }),
}))

vi.mock('../../src/context/BaseDaemonContext', () => ({
    useBaseDaemonActions: () => ({ injectEntries, getIdes }),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const DAEMON_ID = 'daemon-1'
const METADATA_KEY = `daemon:metadata:${DAEMON_ID}`

function Harness() {
    const load = useDaemonMetadataLoader()
    useEffect(() => {
        void load(DAEMON_ID, { force: true })
    }, [load])
    return null
}

function subscribeFrames() {
    return sendData.mock.calls.filter(([, data]) => data.type === 'subscribe' && data.key === METADATA_KEY)
}

function unsubscribeFrames() {
    return sendData.mock.calls.filter(([, data]) => data.type === 'unsubscribe' && data.key === METADATA_KEY)
}

async function flush(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

let container: HTMLDivElement
let root: Root

async function mountHarness(): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
        root.render(<Harness />)
        await flush()
    })
}

async function unmountHarness(): Promise<void> {
    await act(async () => {
        root.unmount()
        await flush()
    })
    container.remove()
}

describe('useDaemonMetadataLoader subscription cleanup (D1#2)', () => {
    beforeEach(() => {
        sendData.mockReset()
        sendData.mockReturnValue(true)
        sendCommand.mockReset()
        sendCommand.mockResolvedValue({ status: {} })
        injectEntries.mockReset()
        getIdes.mockReset()
        getIdes.mockReturnValue([])
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('sends an unsubscribe frame for the metadata topic when the consumer unmounts', async () => {
        await mountHarness()

        expect(subscribeFrames()).toHaveLength(1)
        expect(unsubscribeFrames()).toHaveLength(0)

        await unmountHarness()

        expect(unsubscribeFrames()).toHaveLength(1)
        expect(unsubscribeFrames()[0]?.[1]).toEqual({
            type: 'unsubscribe',
            topic: 'daemon.metadata',
            key: METADATA_KEY,
        })
    })

    it('stops delivering metadata pushes to the unmounted consumer', async () => {
        await mountHarness()

        await act(async () => {
            subscriptionManager.publish({
                topic: 'daemon.metadata',
                key: METADATA_KEY,
                daemonId: DAEMON_ID,
                seq: 1,
                timestamp: 1_000,
                status: { sessions: [{ id: 's1', providerType: 'codex', status: 'idle' }] },
            } as any)
            await flush()
        })
        const deliveredWhileMounted = getIdes.mock.calls.length
        expect(deliveredWhileMounted).toBeGreaterThan(0)

        await unmountHarness()

        await act(async () => {
            subscriptionManager.publish({
                topic: 'daemon.metadata',
                key: METADATA_KEY,
                daemonId: DAEMON_ID,
                seq: 2,
                timestamp: 2_000,
                status: { sessions: [{ id: 's1', providerType: 'codex', status: 'generating' }] },
            } as any)
            await flush()
        })

        // The handler is gone, so the push must not reach it.
        expect(getIdes.mock.calls.length).toBe(deliveredWhileMounted)
    })

    it('does not accumulate subscriptions across repeated mount/unmount cycles', async () => {
        for (let i = 0; i < 3; i++) {
            await mountHarness()
            expect(subscribeFrames()).toHaveLength(i + 1)
            await unmountHarness()
            expect(unsubscribeFrames()).toHaveLength(i + 1)
        }
    })
})
