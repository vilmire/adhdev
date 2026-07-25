import { describe, expect, it } from 'vitest'
import { buildLocalNodeFacts } from '../../src/mesh/node-facts.js'
import { normalizeMeshNodeFacts } from '@adhdev/mesh-shared'

// The single producer for BOTH the reporter envelope and the self-node stamp —
// the de-mirroring core of the deploy-lag visibility design (§a).
describe('buildLocalNodeFacts', () => {
    it('always emits a v1 bundle with platform/arch and a timestamp', () => {
        const facts = buildLocalNodeFacts()
        expect(facts.schemaVersion).toBe(1)
        expect(facts.reportedAt).toBeGreaterThan(0)
        expect(facts.platform).toBe(process.platform)
        expect(facts.arch).toBe(process.arch)
        // Round-trips through the shared normalizer (what remote ingest applies).
        expect(normalizeMeshNodeFacts(facts)).toEqual(facts)
    })

    it('carries provider versions and nickname only when non-empty', () => {
        const withDeps = buildLocalNodeFacts({
            providerVersions: { 'claude-cli': '2.1.0' },
            machineNickname: '  coordinator-mac  ',
        })
        expect(withDeps.providerVersions).toEqual({ 'claude-cli': '2.1.0' })
        expect(withDeps.machineNickname).toBe('coordinator-mac')

        const withoutDeps = buildLocalNodeFacts({ providerVersions: {}, machineNickname: '  ' })
        expect(withoutDeps.providerVersions).toBeUndefined()
        expect(withoutDeps.machineNickname).toBeUndefined()
    })

    it('omits daemonBuild identity fields that are unknown (tsx/dev runs)', () => {
        // Under vitest the tsup define is absent → build-info falls back to
        // 'unknown'; the bundle must not ship 'unknown' literals.
        const facts = buildLocalNodeFacts()
        if (facts.daemonBuild) {
            expect(facts.daemonBuild.commit).not.toBe('unknown')
            expect(facts.daemonBuild.version).not.toBe('unknown')
        }
    })
})
