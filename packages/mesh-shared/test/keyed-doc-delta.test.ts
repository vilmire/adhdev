import { describe, expect, it } from 'vitest'
import { diffKeyedDoc, digestKeyedDoc, foldKeyedDoc, type KeyedDocSpec } from '../src/keyed-doc-delta'

const SPEC: KeyedDocSpec = {
    collections: { nodes: 'nodeId', 'queue.tasks': 'id', missions: 'id' },
    volatileTopLevel: ['refreshedAt', 'counters'],
}

function doc(overrides: Record<string, unknown> = {}) {
    return {
        meshId: 'm1',
        meshName: 'Mesh',
        refreshedAt: '2026-09-29T00:00:00.000Z',
        counters: { a: 1 },
        nodes: [
            { nodeId: 'n1', health: 'online', git: { branch: 'main', headCommit: 'aaa' }, sessions: 1 },
            { nodeId: 'n2', health: 'online', git: { branch: 'main', headCommit: 'bbb' }, sessions: 0 },
        ],
        queue: { summary: { pending: 1 }, tasks: [{ id: 't1', status: 'pending' }] },
        missions: [{ id: 'mi1', status: 'active' }],
        ...overrides,
    }
}

function roundTrip(prev: Record<string, unknown>, next: Record<string, unknown>) {
    const delta = diffKeyedDoc(digestKeyedDoc(prev, SPEC), digestKeyedDoc(next, SPEC), SPEC)
    return { delta, folded: delta ? foldKeyedDoc(prev, delta, SPEC) : prev }
}

describe('keyed document delta', () => {
    it('an unchanged document — even with a new build stamp / counters — diffs to null (0 bytes)', () => {
        const { delta } = roundTrip(doc(), doc({ refreshedAt: '2026-09-29T00:00:05.000Z', counters: { a: 9 } }))
        expect(delta).toBeNull()
    })

    it('one node change yields a delta for that node only (changed fields only)', () => {
        const next = doc()
        ;(next.nodes as any[])[1] = { ...(next.nodes as any[])[1], git: { branch: 'main', headCommit: 'ccc' } }
        const { delta, folded } = roundTrip(doc(), next)
        expect(delta).toEqual({ collections: { nodes: { upsert: [{ nodeId: 'n2', git: { branch: 'main', headCommit: 'ccc' } }] } } })
        expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(next).length / 3)
        expect(folded).toEqual({ ...next, refreshedAt: doc().refreshedAt, counters: doc().counters })
    })

    it('volatile fields ride along when something else changed', () => {
        const next = doc({ refreshedAt: 'later', meshName: 'Renamed' })
        const { delta, folded } = roundTrip(doc(), next)
        expect(delta?.set).toEqual({ refreshedAt: 'later', meshName: 'Renamed' })
        expect(folded).toEqual(next)
    })

    it('nested task rows, removals, lost fields, reorders and absent collections fold back to the snapshot', () => {
        const steps: Record<string, unknown>[] = [
            doc(),
            doc({ queue: { summary: { pending: 2 }, tasks: [{ id: 't1', status: 'running' }, { id: 't2', status: 'pending' }] } }),
            doc({ nodes: [{ nodeId: 'n2', health: 'offline', git: { branch: 'main', headCommit: 'bbb' } }, { nodeId: 'n1', health: 'online', git: { branch: 'main', headCommit: 'aaa' }, sessions: 1 }] }),
            doc({ queue: undefined, missions: [] }),
            doc({ nodes: [], missions: [{ id: 'mi2', status: 'completed' }] }),
            doc(),
        ].map((d) => JSON.parse(JSON.stringify(d)))
        let held = steps[0]
        for (let i = 1; i < steps.length; i += 1) {
            const delta = diffKeyedDoc(digestKeyedDoc(steps[i - 1], SPEC), digestKeyedDoc(steps[i], SPEC), SPEC)
            if (delta) held = foldKeyedDoc(held, delta, SPEC)
            expect(held, `step ${i}`).toEqual(steps[i])
        }
    })

    it('never mutates the held document', () => {
        const held = doc()
        const frozen = JSON.stringify(held)
        const next = doc({ nodes: [{ nodeId: 'n1', health: 'offline' }] })
        const delta = diffKeyedDoc(digestKeyedDoc(held, SPEC), digestKeyedDoc(next, SPEC), SPEC)!
        foldKeyedDoc(held, delta, SPEC)
        expect(JSON.stringify(held)).toBe(frozen)
    })
})
