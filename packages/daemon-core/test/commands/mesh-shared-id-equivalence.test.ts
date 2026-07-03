import { describe, expect, it } from 'vitest'
import { daemonIdsEquivalent, meshNodeIdMatches, sessionIdsEquivalent } from '@adhdev/mesh-shared'

/**
 * CANON-RAW3 regression: the remaining raw daemon-id / node-id comparison sites
 * (mesh-events-coordinator isLocalAutoLaunchNode + the auto-launch node lookup,
 * mesh-reconcile-loop self-dial guards) were routed through these canonical
 * helpers. A bare `mach_<hex>` form and its `daemon_` / `standalone_` prefixed
 * forms describe the SAME machine, so an exact-string `===` between two forms is
 * the self-dial trap these helpers close. This pins the legacy-form equivalence
 * so a future raw `===` re-introduction fails here.
 */
describe('CANON-RAW3 legacy daemon-id / node-id equivalence', () => {
    const core = 'mach_deadbeef'
    const bare = core
    const cloud = `daemon_${core}`
    const standalone = `standalone_${core}`

    it('treats all three daemon-id forms of one machine as equivalent', () => {
        expect(daemonIdsEquivalent(bare, cloud)).toBe(true)
        expect(daemonIdsEquivalent(bare, standalone)).toBe(true)
        expect(daemonIdsEquivalent(cloud, standalone)).toBe(true)
        // Symmetric.
        expect(daemonIdsEquivalent(cloud, bare)).toBe(true)
    })

    it('does NOT collapse two different machine cores together', () => {
        expect(daemonIdsEquivalent(bare, 'daemon_mach_feedface')).toBe(false)
        expect(daemonIdsEquivalent('mach_a', 'mach_b')).toBe(false)
    })

    it('returns false when either side is empty (never matches an absent id)', () => {
        expect(daemonIdsEquivalent(bare, '')).toBe(false)
        expect(daemonIdsEquivalent('', cloud)).toBe(false)
        expect(daemonIdsEquivalent(undefined, cloud)).toBe(false)
        expect(daemonIdsEquivalent(bare, null)).toBe(false)
    })

    it('matches a mesh node regardless of which id field carries its identity', () => {
        // A node's stable id can arrive as id / nodeId / node_id depending on the
        // serialization path; meshNodeIdMatches absorbs all three. This is the
        // raw `n.id === autoNodeId` form replaced in the auto-launch lookup.
        expect(meshNodeIdMatches({ id: 'node_x' }, 'node_x')).toBe(true)
        expect(meshNodeIdMatches({ nodeId: 'node_x' }, 'node_x')).toBe(true)
        expect(meshNodeIdMatches({ node_id: 'node_x' }, 'node_x')).toBe(true)
        expect(meshNodeIdMatches({ id: 'node_y' }, 'node_x')).toBe(false)
        expect(meshNodeIdMatches(null, 'node_x')).toBe(false)
        expect(meshNodeIdMatches({ id: 'node_x' }, '')).toBe(false)
    })
})

/**
 * A1 (UNIFY-REFACTOR-EXEC-AB): raw sessionId `===` sites across daemon-core's
 * mesh matching/lookup paths were routed through sessionIdsEquivalent. Session
 * ids are single-form (one canonical crypto.randomUUID carried verbatim), so the
 * helper is an exact match after trimming that never matches empty-vs-empty —
 * this pins that contract so the centralized predicate cannot silently drift.
 */
describe('A1 sessionIdsEquivalent single-form contract', () => {
    it('matches identical non-empty ids and trims whitespace', () => {
        expect(sessionIdsEquivalent('cli_abc', 'cli_abc')).toBe(true)
        expect(sessionIdsEquivalent(' cli_abc ', 'cli_abc')).toBe(true)
    })

    it('never matches absent/empty ids — even against each other', () => {
        expect(sessionIdsEquivalent(undefined, undefined)).toBe(false)
        expect(sessionIdsEquivalent('', '')).toBe(false)
        expect(sessionIdsEquivalent(null, 'cli_abc')).toBe(false)
        expect(sessionIdsEquivalent('cli_abc', '')).toBe(false)
    })

    it('does NOT apply daemon-id form expansion (session ids are single-form)', () => {
        expect(sessionIdsEquivalent('mach_x', 'daemon_mach_x')).toBe(false)
        expect(sessionIdsEquivalent('cli_a', 'cli_b')).toBe(false)
    })
})
