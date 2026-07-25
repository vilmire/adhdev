import { describe, expect, it } from 'vitest'
import { normalizeMeshNodeFacts } from '../src/node-facts'

describe('normalizeMeshNodeFacts', () => {
    it('passes a valid bundle through wholesale, including unknown future fields', () => {
        const raw = {
            schemaVersion: 1,
            reportedAt: 1_753_000_000_000,
            daemonBuild: { commit: 'a'.repeat(40), commitShort: 'aaaaaaa', version: '1.0.27' },
            providerVersions: { 'claude-cli': '2.1.0' },
            platform: 'darwin',
            arch: 'arm64',
            futureField: { nested: true },
        }
        const facts = normalizeMeshNodeFacts(raw)
        expect(facts).toEqual(raw)
        // Opaque contract: the unknown field must survive.
        expect((facts as Record<string, unknown>).futureField).toEqual({ nested: true })
    })

    it('accepts a future schemaVersion (forward-compat ride-through)', () => {
        expect(normalizeMeshNodeFacts({ schemaVersion: 3, reportedAt: 5 })?.schemaVersion).toBe(3)
    })

    it('rejects non-bundles', () => {
        expect(normalizeMeshNodeFacts(undefined)).toBeUndefined()
        expect(normalizeMeshNodeFacts(null)).toBeUndefined()
        expect(normalizeMeshNodeFacts('stale')).toBeUndefined()
        expect(normalizeMeshNodeFacts([])).toBeUndefined()
        expect(normalizeMeshNodeFacts({})).toBeUndefined()
        expect(normalizeMeshNodeFacts({ schemaVersion: 0, reportedAt: 5 })).toBeUndefined()
        expect(normalizeMeshNodeFacts({ schemaVersion: 1 })).toBeUndefined()
        expect(normalizeMeshNodeFacts({ schemaVersion: 1, reportedAt: -1 })).toBeUndefined()
    })
})
