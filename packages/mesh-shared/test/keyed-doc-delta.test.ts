import { describe, expect, it } from 'vitest'
import { DAEMON_METADATA_DOC_SPEC, diffKeyedDoc, digestKeyedDoc, foldKeyedDoc, MESH_STATUS_DOC_SPEC, type KeyedDocSpec } from '../src/keyed-doc-delta'

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

// The SAME engine serves the daemon.metadata lane (DAEMON_METADATA_DOC_SPEC):
// `status` split field by field, sessions keyed by id, envelope identity and
// the build clock never diffed, a session's lastUpdated stamp not a change.
describe('keyed document delta — daemon.metadata spec', () => {
    const M = DAEMON_METADATA_DOC_SPEC
    function body(sessions: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
        return {
            daemonId: 'd1',
            userName: 'u',
            ...extra,
            status: {
                instanceId: 'd1',
                timestamp: Math.random(),
                machine: { hostname: 'h', platform: 'darwin' },
                sessions,
            },
        } as Record<string, unknown>
    }
    const a = { id: 'a', status: 'idle', title: 'A', lastUpdated: 1 }
    const b = { id: 'b', status: 'generating', title: 'B', lastUpdated: 1 }
    const diff = (p: Record<string, unknown>, n: Record<string, unknown>) => diffKeyedDoc(digestKeyedDoc(p, M), digestKeyedDoc(n, M), M)

    it('an unchanged state (clock / lastUpdated only) diffs to null', () => {
        expect(diff(body([a, b]), body([{ ...a, lastUpdated: 99 }, { ...b, lastUpdated: 99 }]))).toBeNull()
    })

    it('sends only the changed session, its changed fields, and lets the stamp ride along', () => {
        expect(diff(body([a, b]), body([a, { ...b, status: 'idle', lastUpdated: 5 }]))).toEqual({
            collections: { 'status.sessions': { upsert: [{ id: 'b', status: 'idle', lastUpdated: 5 }] } },
        })
    })

    it('a daemon-level status field travels alone (the rest of status is not re-sent)', () => {
        const next = body([a, b])
        ;(next.status as any).machine = { hostname: 'h2', platform: 'darwin' }
        expect(diff(body([a, b]), next)).toEqual({ objects: { status: { set: { machine: { hostname: 'h2', platform: 'darwin' } } } } })
    })

    it('removals, field unsets, additions and reorders fold back to the latest body', () => {
        const states = [
            body([a, b]),
            body([a, { ...b, status: 'idle' }], { meshStateRevisions: { m: 1 } }),
            body([{ ...a, title: 'A2', extra: { n: 1 } }], { meshStateRevisions: { m: 2 } }),
            body([{ id: 'c', status: 'error' }, { id: 'a', status: 'idle', lastUpdated: 1 }], { userName: 'v' }),
        ]
        let held = states[0]
        for (let i = 1; i < states.length; i += 1) {
            const delta = diff(states[i - 1], states[i])
            if (delta) held = foldKeyedDoc(held, delta, M)
            const strip = (x: Record<string, unknown>) => ({ ...x, status: { ...(x.status as any), timestamp: 0 } })
            expect(strip(held), `step ${i}`).toEqual(strip(states[i]))
        }
    })
})

describe('keyed document delta — both lanes round-trip through one engine', () => {
    it('mesh.status and daemon.metadata docs fold to the latest snapshot', () => {
        const meshSteps = [
            { meshId: 'm', refreshedAt: 't0', nodes: [{ nodeId: 'n1', health: 'online', lastSeenAt: 1 }], queue: { tasks: [{ id: 't1', status: 'pending' }] }, missions: [] },
            { meshId: 'm', refreshedAt: 't1', nodes: [{ nodeId: 'n1', health: 'dirty', lastSeenAt: 2 }], queue: { tasks: [] }, missions: [{ id: 'mi', status: 'active' }] },
        ]
        const md = foldKeyedDoc(meshSteps[0], diffKeyedDoc(digestKeyedDoc(meshSteps[0], MESH_STATUS_DOC_SPEC), digestKeyedDoc(meshSteps[1], MESH_STATUS_DOC_SPEC), MESH_STATUS_DOC_SPEC)!, MESH_STATUS_DOC_SPEC)
        expect(md).toEqual(meshSteps[1])
        const metaSteps = [
            { daemonId: 'd', status: { timestamp: 1, sessions: [{ id: 's', status: 'idle' }] } },
            { daemonId: 'd', status: { timestamp: 1, sessions: [{ id: 's', status: 'generating' }], machine: { cpus: 8 } } },
        ]
        const dd = foldKeyedDoc(metaSteps[0], diffKeyedDoc(digestKeyedDoc(metaSteps[0], DAEMON_METADATA_DOC_SPEC), digestKeyedDoc(metaSteps[1], DAEMON_METADATA_DOC_SPEC), DAEMON_METADATA_DOC_SPEC)!, DAEMON_METADATA_DOC_SPEC)
        expect(dd).toEqual(metaSteps[1])
    })
})
