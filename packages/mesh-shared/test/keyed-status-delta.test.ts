/**
 * Keyed status delta — the `daemon.metadata` lane's diff/fold pair.
 *
 * Pins the two properties the lane depends on: an unchanged state diffs to
 * nothing (zero bytes), and folding every delta since a snapshot reproduces
 * the latest snapshot exactly.
 */
import { describe, expect, it } from 'vitest'
import { diffKeyedStatus, digestKeyedStatus, foldKeyedStatus, type KeyedStatusBody } from '../src/keyed-status-delta'

const OPTS = { ignoreTopLevel: ['daemonId'], ignoreStatus: ['timestamp'], volatileSessionFields: ['lastUpdated'] }

function body(sessions: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): KeyedStatusBody {
    return {
        daemonId: 'd1',
        userName: 'u',
        ...extra,
        status: {
            instanceId: 'd1',
            timestamp: Math.random(),
            machine: { hostname: 'h', platform: 'darwin' },
            sessions: sessions as KeyedStatusBody['status']['sessions'],
        },
    }
}

const a = { id: 'a', status: 'idle', title: 'A', lastUpdated: 1 }
const b = { id: 'b', status: 'generating', title: 'B', lastUpdated: 1 }

describe('keyed status delta', () => {
    it('diffs an unchanged state (timestamps / lastUpdated only) to null', () => {
        const prev = digestKeyedStatus(body([a, b]), OPTS)
        const next = digestKeyedStatus(body([{ ...a, lastUpdated: 99 }, { ...b, lastUpdated: 99 }]), OPTS)
        expect(diffKeyedStatus(prev, next)).toBeNull()
    })

    it('sends only the changed session and only its changed fields', () => {
        const prev = digestKeyedStatus(body([a, b]), OPTS)
        const next = digestKeyedStatus(body([a, { ...b, status: 'idle', lastUpdated: 5 }]), OPTS)
        expect(diffKeyedStatus(prev, next)).toEqual({ sessions: [{ id: 'b', status: 'idle', lastUpdated: 5 }] })
    })

    it('makes removals, field unsets, additions and reorders explicit', () => {
        const prev = digestKeyedStatus(body([a, b], { meshStateRevisions: { m: 1 } }), OPTS)
        const c = { id: 'c', status: 'idle' }
        const next = digestKeyedStatus(body([c, { id: 'a', status: 'idle', lastUpdated: 1 }]), OPTS)
        expect(diffKeyedStatus(prev, next)).toEqual({
            unset: ['meshStateRevisions'],
            sessions: [c],
            sessionUnset: { a: ['title'] },
            removedSessionIds: ['b'],
            sessionOrder: ['c', 'a'],
        })
    })

    it('folding every delta since a snapshot reproduces the latest body', () => {
        const states = [
            body([a, b]),
            body([a, { ...b, status: 'idle' }]),
            body([{ ...a, title: 'A2', extra: { n: 1 } }], { meshStateRevisions: { m: 2 } }),
            body([{ id: 'c', status: 'error' }, { ...a, title: 'A2' }], { userName: 'v' }),
        ]
        let held = states[0]
        let prev = digestKeyedStatus(states[0], OPTS)
        for (const state of states.slice(1)) {
            const next = digestKeyedStatus(state, OPTS)
            const delta = diffKeyedStatus(prev, next)
            if (delta) held = foldKeyedStatus(held, delta)
            prev = next
            const { timestamp: _t1, ...heldStatus } = held.status
            const { timestamp: _t2, ...wantStatus } = state.status
            expect(heldStatus).toEqual(wantStatus)
            expect({ ...held, status: undefined }).toEqual({ ...state, status: undefined })
        }
    })
})
