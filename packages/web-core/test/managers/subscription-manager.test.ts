import { describe, expect, it, vi } from 'vitest'
import { SubscriptionManager } from '../../src/managers/SubscriptionManager'
import type { SubscribeRequest } from '@adhdev/daemon-core'

function createSubscribeRequest(): SubscribeRequest {
    return {
        type: 'subscribe',
        topic: 'session_host.diagnostics',
        key: 'session_host:daemon-1',
        params: {
            includeSessions: true,
            limit: 12,
        },
    }
}

describe('SubscriptionManager', () => {
    it('exposes whether the initial subscribe send was accepted by the transport', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(false)
        const unsubscribe = manager.subscribe(
            { sendData },
            'daemon-1',
            createSubscribeRequest(),
            vi.fn(),
        )

        expect(sendData).toHaveBeenCalledOnce()
        expect(unsubscribe.initialSendAccepted).toBe(false)
    })

    it('marks the initial subscribe send as accepted when the transport sends successfully', () => {
        const manager = new SubscriptionManager()
        const unsubscribe = manager.subscribe(
            { sendData: vi.fn().mockReturnValue(true) },
            'daemon-1',
            createSubscribeRequest(),
            vi.fn(),
        )

        expect(unsubscribe.initialSendAccepted).toBe(true)
    })

    it('re-sends an existing subscription when its params change under the same topic key', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)
        const first = createSubscribeRequest()
        const second: SubscribeRequest = {
            ...first,
            params: {
                ...first.params,
                limit: 30,
            },
        }

        manager.subscribe({ sendData }, 'daemon-1', first, vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', second, vi.fn())

        expect(sendData).toHaveBeenCalledTimes(2)
        expect(sendData.mock.calls[1]?.[1]).toEqual(second)
    })
})
