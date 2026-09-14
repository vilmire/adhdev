/**
 * D1#1 regression — subscribers sharing one topic key must not downgrade each
 * other's params.
 *
 * A subscription id is `topic:key` with no params component, and the daemon
 * likewise keys its slot by (connectionId, topic, key) — so every subscriber on
 * a key shares exactly one server-side feed. The manager used to send whichever
 * params the newest caller happened to pass (last-writer-wins), so a subscriber
 * asking for less silently narrowed the feed for one already asking for more.
 *
 * Three hooks currently share `daemon.metadata` / `daemon:metadata:<id>` with
 * identical params, which is why this never surfaced. The tests below cover both
 * the divergent case (the actual fix) and the identical-params case (today's
 * behaviour, which must not regress).
 */
import { describe, expect, it, vi } from 'vitest'
import { SubscriptionManager } from '../../src/managers/SubscriptionManager'
import type { SubscribeRequest, UnsubscribeRequest } from '@adhdev/daemon-core'

const KEY = 'daemon:metadata:daemon-1'

function metadataRequest(params: Record<string, unknown>): SubscribeRequest {
    return { type: 'subscribe', topic: 'daemon.metadata', key: KEY, params } as SubscribeRequest
}

function sentParams(sendData: ReturnType<typeof vi.fn>) {
    return sendData.mock.calls
        .filter(([, data]: [string, SubscribeRequest | UnsubscribeRequest]) => data.type === 'subscribe')
        .map(([, data]) => (data as SubscribeRequest).params)
}

describe('SubscriptionManager param union on shared keys (D1#1)', () => {
    it('does not let a narrower subscriber downgrade an opt-in from an existing one', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: true }), vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: false }), vi.fn())

        // The second subscriber wants less; the union must keep the opt-in.
        const last = sentParams(sendData).at(-1)
        expect(last).toMatchObject({ includeSessions: true })
    })

    it('keeps the most frequent interval when subscribers disagree', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ intervalMs: 1_000 }), vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ intervalMs: 30_000 }), vi.fn())

        // 30s would starve the subscriber that asked for 1s; 1s satisfies both.
        expect(sentParams(sendData).at(-1)).toMatchObject({ intervalMs: 1_000 })
    })

    it('keeps the largest limit when subscribers disagree', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        // `limit` widens the OPPOSITE way from intervalMs: more rows serve the
        // subscriber who asked for fewer, so the union must take the max.
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ limit: 30 }), vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ limit: 12 }), vi.fn())

        expect(sentParams(sendData).at(-1)).toMatchObject({ limit: 30 })
    })

    it('unions disjoint fields instead of dropping the earlier subscriber\'s', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: true }), vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ limit: 12 }), vi.fn())

        expect(sentParams(sendData).at(-1)).toMatchObject({ includeSessions: true, limit: 12 })
    })

    it('narrows back to the survivors when a widening subscriber leaves', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ intervalMs: 30_000 }), vi.fn())
        const releaseFast = manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ intervalMs: 1_000 }), vi.fn())

        expect(sentParams(sendData).at(-1)).toMatchObject({ intervalMs: 1_000 })

        releaseFast()

        // The fast subscriber is gone — the daemon must stop doing 1s work, and
        // the remaining subscriber's own params must be restored.
        expect(sentParams(sendData).at(-1)).toMatchObject({ intervalMs: 30_000 })
    })

    it('sends no redundant re-subscribe when params are identical (today\'s 3-hook case)', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)

        // The three real daemon.metadata subscribers all pass exactly this.
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: true }), vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: true }), vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: true }), vi.fn())

        expect(sentParams(sendData)).toEqual([{ includeSessions: true }])
    })

    /**
     * Identity params must NOT merge. Re-pointing one is the entire purpose of a
     * re-subscribe (a Codex runtime session resolving its real provider history
     * id), so freezing the first writer's value would silently pin the subscriber
     * to a stale session forever — see the chat_tail controller's re-subscribe.
     */
    it('takes the newest value for identity params instead of freezing the first', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)
        const request = (historySessionId: string): SubscribeRequest => ({
            type: 'subscribe',
            topic: 'session.chat_tail',
            key: 'daemon:daemon-1:session:runtime-session-1',
            params: { targetSessionId: 'runtime-session-1', historySessionId, tailLimit: 60 },
        } as SubscribeRequest)

        manager.subscribe({ sendData }, 'daemon-1', request('runtime-session-1'), vi.fn())
        manager.subscribe({ sendData }, 'daemon-1', request('019ea459-712f-7eb2-84a5-d2e633c1ec45'), vi.fn())

        const sent = sentParams(sendData)
        expect(sent).toHaveLength(2)
        expect(sent.at(-1)).toMatchObject({
            targetSessionId: 'runtime-session-1',
            historySessionId: '019ea459-712f-7eb2-84a5-d2e633c1ec45',
        })
    })

    it('still delivers a published update to every sharing handler', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)
        const first = vi.fn()
        const second = vi.fn()

        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: true }), first)
        manager.subscribe({ sendData }, 'daemon-1', metadataRequest({ includeSessions: false }), second)

        manager.publish({ topic: 'daemon.metadata', key: KEY, seq: 1, timestamp: 1 } as any)

        expect(first).toHaveBeenCalledOnce()
        expect(second).toHaveBeenCalledOnce()
    })
})
