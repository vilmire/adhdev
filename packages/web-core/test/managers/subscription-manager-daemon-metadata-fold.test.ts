/**
 * daemon.metadata keyed lane (data-path audit 2026-09-29 P0-3): the daemon
 * sends a snapshot, then deltas. SubscriptionManager folds each delta into the
 * held snapshot so handlers only ever see the materialized state, and a delta
 * it cannot apply (no base / seq gap) re-requests the subscription instead of
 * rendering a partial state.
 */
import { describe, expect, it, vi } from 'vitest'
import { SubscriptionManager } from '../../src/managers/SubscriptionManager'
import type { DaemonMetadataUpdate, SubscribeRequest } from '@adhdev/daemon-core'

const request: SubscribeRequest = { type: 'subscribe', topic: 'daemon.metadata', key: 'daemon:metadata:d1', params: { includeSessions: true } }

function snapshot(): any {
    return {
        topic: 'daemon.metadata',
        key: 'daemon:metadata:d1',
        mode: 'snapshot',
        daemonId: 'd1',
        userName: 'u',
        seq: 1,
        timestamp: 100,
        status: {
            instanceId: 'd1',
            timestamp: 100,
            machine: { hostname: 'h', platform: 'darwin' },
            sessions: [
                { id: 'a', status: 'idle', title: 'A' },
                { id: 'b', status: 'idle', title: 'B' },
            ],
        },
    }
}

describe('SubscriptionManager — daemon.metadata delta fold', () => {
    it('hands handlers the materialized state, never the delta', () => {
        const manager = new SubscriptionManager()
        const seen: DaemonMetadataUpdate[] = []
        manager.subscribe({ sendData: vi.fn().mockReturnValue(true) }, 'd1', request, (u: DaemonMetadataUpdate) => { seen.push(u) })
        manager.publish(snapshot())
        manager.publish({
            topic: 'daemon.metadata', key: 'daemon:metadata:d1', mode: 'delta', daemonId: 'd1', seq: 2, timestamp: 200,
            sessions: [{ id: 'b', status: 'generating' }],
            removedSessionIds: ['a'],
            sessionOrder: ['b'],
            set: { meshStateRevisions: { m: 3 } },
        } as any)
        expect(seen).toHaveLength(2)
        expect(seen[1]).toMatchObject({
            mode: 'snapshot',
            seq: 2,
            timestamp: 200,
            userName: 'u',
            meshStateRevisions: { m: 3 },
            status: { timestamp: 200, sessions: [{ id: 'b', status: 'generating', title: 'B' }] },
        })
        // A late subscriber on the same key is replayed the folded state.
        const late = vi.fn()
        manager.subscribe({ sendData: vi.fn().mockReturnValue(true) }, 'd1', request, late)
        expect(late).toHaveBeenCalledWith(expect.objectContaining({ seq: 2, status: expect.objectContaining({ sessions: [expect.objectContaining({ id: 'b' })] }) }))
    })

    it('re-requests a snapshot on a seq gap or a delta without a base', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)
        const handler = vi.fn()
        manager.subscribe({ sendData }, 'd1', request, handler)
        expect(sendData).toHaveBeenCalledTimes(1)

        manager.publish({ topic: 'daemon.metadata', key: 'daemon:metadata:d1', mode: 'delta', daemonId: 'd1', seq: 5, timestamp: 1 } as any)
        expect(handler).not.toHaveBeenCalled()
        expect(sendData).toHaveBeenCalledTimes(2)

        manager.publish(snapshot())
        manager.publish({ topic: 'daemon.metadata', key: 'daemon:metadata:d1', mode: 'delta', daemonId: 'd1', seq: 3, timestamp: 1, statusSet: { version: 'x' } } as any)
        expect(handler).toHaveBeenCalledTimes(1)
        expect(sendData).toHaveBeenCalledTimes(3)
        expect(sendData.mock.calls[2]?.[1]).toEqual(request)
    })
})
