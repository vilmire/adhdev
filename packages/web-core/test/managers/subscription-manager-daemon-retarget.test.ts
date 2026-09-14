/**
 * D1#3 regression — unsubscribe must address the daemon the subscription is
 * CURRENTLY bound to, not the one captured when the handle was created.
 *
 * subscribe() retargets an existing topic-key entry when a later caller passes a
 * different daemonId (`existing.daemonId = daemonId`). The unsubscribe closure,
 * however, captured the daemonId from its own subscribe call. So after
 * A(daemonA) → B(daemonB), releasing B then A sent `unsubscribe` to daemonA —
 * which no longer held the subscription — while daemonB, the daemon actually
 * streaming, was never told to stop.
 */
import { describe, expect, it, vi } from 'vitest'
import { SubscriptionManager } from '../../src/managers/SubscriptionManager'
import type { SubscribeRequest, UnsubscribeRequest } from '@adhdev/daemon-core'

function createSubscribeRequest(): SubscribeRequest {
    return {
        type: 'subscribe',
        topic: 'daemon.metadata',
        key: 'daemon:metadata:shared',
        params: { includeSessions: true },
    }
}

function unsubscribeCalls(sendData: ReturnType<typeof vi.fn>) {
    return sendData.mock.calls.filter(([, data]: [string, SubscribeRequest | UnsubscribeRequest]) => data.type === 'unsubscribe')
}

describe('SubscriptionManager daemon retargeting (D1#3)', () => {
    it('sends the unsubscribe to the retargeted daemon, not the originally captured one', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        // Same topic key, two different daemons — the second retargets the entry.
        const releaseA = manager.subscribe({ sendData }, 'daemonA', createSubscribeRequest(), vi.fn())
        const releaseB = manager.subscribe({ sendData }, 'daemonB', createSubscribeRequest(), vi.fn())

        // Release in B-then-A order: the last release is the one that actually
        // tears the subscription down, and it is the stale-capture handle.
        releaseB()
        expect(unsubscribeCalls(sendData)).toHaveLength(0) // handlers remain

        releaseA()

        const unsubs = unsubscribeCalls(sendData)
        expect(unsubs).toHaveLength(1)
        expect(unsubs[0]?.[0]).toBe('daemonB')
        expect(unsubs[0]?.[1]).toEqual({
            type: 'unsubscribe',
            topic: 'daemon.metadata',
            key: 'daemon:metadata:shared',
        })
        // The daemon that no longer holds the subscription must not be told to stop.
        expect(unsubs.some(([target]) => target === 'daemonA')).toBe(false)
    })

    it('still addresses the owning daemon when no retargeting happened', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        const release = manager.subscribe({ sendData }, 'daemonA', createSubscribeRequest(), vi.fn())
        release()

        const unsubs = unsubscribeCalls(sendData)
        expect(unsubs).toHaveLength(1)
        expect(unsubs[0]?.[0]).toBe('daemonA')
    })

    it('addresses the newest daemon after several retargets', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        const releaseA = manager.subscribe({ sendData }, 'daemonA', createSubscribeRequest(), vi.fn())
        const releaseB = manager.subscribe({ sendData }, 'daemonB', createSubscribeRequest(), vi.fn())
        const releaseC = manager.subscribe({ sendData }, 'daemonC', createSubscribeRequest(), vi.fn())

        releaseA()
        releaseC()
        releaseB()

        const unsubs = unsubscribeCalls(sendData)
        expect(unsubs).toHaveLength(1)
        expect(unsubs[0]?.[0]).toBe('daemonC')
    })
})
