import { describe, expect, it } from 'vitest'

import { resolveFirstSetupSeedDaemonId, readAuthoritativeMeshHostPin } from '../../src/pages/repo-mesh/host-seed'

// HOST-MISSEED-FIRSTSETUP / -FALLBACK-REMOVAL: a two-daemon mesh where the host (M4,
// coordinator) is at index 1 and an unrelated member (M1, moltbot) sits at daemons[0]
// by P2P insertion order — the exact shape that previously seeded M1 as the host
// candidate and flashed "Will host on moltbot" on cold entry.
//
// The seed now uses ONLY authoritative host signals (mesh_status resolved host pin, or
// a node flagged role:'host'). With neither present it returns '' — it must NEVER fall
// back to self / primaryDaemonId / daemons[0], because on cloud those all collapse to
// the arbitrary first-connected peer.
const M4_HOST = { id: 'daemon_mach_1b46842a15d3409d96ad33e767a916dd' } as any
const M1_MEMBER = { id: 'daemon_mach_b6c8' } as any
const DAEMONS = [M1_MEMBER, M4_HOST] as any[]

describe('HOST-MISSEED-FIRSTSETUP first-setup host seed priority (authoritative-only)', () => {
    it('step 0: the mesh_status resolved host pin wins over daemons[0]', () => {
        const nodes: any[] = []
        // Only the pin is present (no role:host node); it must select M4, not M1.
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, undefined, undefined, M4_HOST.id)
        expect(seed).toBe(M4_HOST.id)
        expect(seed).not.toBe(M1_MEMBER.id)
    })

    it('step 0: the resolved host pin matches across daemon-id forms (mach_ vs daemon_mach_)', () => {
        const nodes: any[] = []
        const seed = resolveFirstSetupSeedDaemonId(
            DAEMONS,
            nodes,
            undefined,
            undefined,
            'mach_1b46842a15d3409d96ad33e767a916dd', // bare form of M4
        )
        expect(seed).toBe(M4_HOST.id)
    })

    it('step 0: an OFFLINE resolved host pin still seeds the pinned id, never daemons[0]', () => {
        // The daemon named a host that is not in the connected list — seed its id as-is
        // so the header points at the real host, not an arbitrary connected member.
        const offlineHost = 'daemon_mach_offlinehost'
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, [], undefined, undefined, offlineHost)
        expect(seed).toBe(offlineHost)
        expect(seed).not.toBe(M1_MEMBER.id)
    })

    it('step 1: prefers the role:host node daemon over daemons[0] (no M1 misseed)', () => {
        const nodes = [
            // node added with role:'host' bound to M4 — must win over daemons[0]=M1.
            { id: 'node-m4', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd', role: 'host' },
            { id: 'node-m1', daemonId: 'daemon_mach_b6c8', role: 'member' },
        ] as any[]
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, undefined, undefined)
        expect(seed).toBe(M4_HOST.id)
        expect(seed).not.toBe(M1_MEMBER.id)
    })

    it('FALLBACK REMOVED: returns "" when no host pin and no role:host node — never self', () => {
        const nodes = [
            { id: 'node-m4', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd' },
            { id: 'node-m1', daemonId: 'daemon_mach_b6c8' },
        ] as any[]
        // Even though "self" resolves to M4 here, self is NOT an authoritative host
        // signal on cloud (it collapses to daemons[0]); the seed must be empty.
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, M4_HOST.id, M1_MEMBER.id)
        expect(seed).toBe('')
    })

    it('FALLBACK REMOVED: returns "" instead of the legacy daemons[0] fallback', () => {
        const nodes: any[] = []
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, undefined, undefined)
        expect(seed).toBe('')
        expect(seed).not.toBe(M1_MEMBER.id)
    })

    it('FALLBACK REMOVED: primaryDaemonId / selfDaemonId args are ignored (not authoritative)', () => {
        const nodes: any[] = []
        // Passing both self and primary as M1 must NOT seed M1 — no authoritative signal.
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, M1_MEMBER.id, M1_MEMBER.id)
        expect(seed).toBe('')
    })

    it('standalone: a role:host node on the sole daemon still seeds it (no regression)', () => {
        // Note: on standalone the seed effect never runs (meshHostDaemonSection=false);
        // this only asserts that an explicit role:'host' declaration still resolves.
        const SELF = { id: 'standalone_mach_self' } as any
        const standaloneDaemons = [SELF] as any[]
        const nodes = [{ id: 'n', daemonId: 'standalone_mach_self', role: 'host' }] as any[]
        const seed = resolveFirstSetupSeedDaemonId(standaloneDaemons, nodes, SELF.id, SELF.id)
        expect(seed).toBe(SELF.id)
    })

    it('returns empty string when there are no connected daemons', () => {
        expect(resolveFirstSetupSeedDaemonId([], [], 'x', 'y', 'z')).toBe('')
    })
})

/**
 * HOST-SELF-SYNTHESIS-GUARD — dashboard-side demotion of a synthesized host pin.
 *
 * The observed defect: the host badge showed M1-Server (moltbot) and, after a refresh,
 * flipped to the local Mac — under UI copy claiming the host "cannot be reassigned".
 * The daemon-side resolver filled hostDaemonId with whichever daemon was asked, so the
 * badge reflected P2P arrival order, and the same id was the Launch target that would
 * have pinned that wrong machine permanently.
 */
describe('HOST-SELF-SYNTHESIS-GUARD synthesized-pin demotion', () => {
    it('strips a synthesized pin so the caller renders the neutral first-setup state', () => {
        const pin = readAuthoritativeMeshHostPin({
            hostDaemonId: M1_MEMBER.id,
            hostNodeId: 'node-m1',
            hostSynthesized: true,
        })
        expect(pin.hostDaemonId).toBe('')
        expect(pin.hostNodeId).toBe('')
    })

    it('passes an authoritative (persisted) pin through untouched', () => {
        const pin = readAuthoritativeMeshHostPin({ hostDaemonId: M4_HOST.id, hostNodeId: 'node-m4' })
        expect(pin.hostDaemonId).toBe(M4_HOST.id)
        expect(pin.hostNodeId).toBe('node-m4')
    })

    it('treats an explicitly false flag as authoritative (not demoted)', () => {
        const pin = readAuthoritativeMeshHostPin({ hostDaemonId: M4_HOST.id, hostSynthesized: false })
        expect(pin.hostDaemonId).toBe(M4_HOST.id)
    })

    it('returns an empty pin for a missing meshHost payload', () => {
        expect(readAuthoritativeMeshHostPin(undefined)).toEqual({ hostDaemonId: '', hostNodeId: '' })
    })

    it('a demoted pin cannot seed the first-setup Launch target', () => {
        // End-to-end of the launch-risk path: synthesized pin → stripped → seed '' →
        // coordinatorDaemonId '' → Launch button disabled until the operator picks.
        const synthesized = { hostDaemonId: M1_MEMBER.id, hostSynthesized: true }
        const seedInput = readAuthoritativeMeshHostPin(synthesized).hostDaemonId || undefined
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, [], undefined, undefined, seedInput)
        expect(seed).toBe('')
        expect(seed).not.toBe(M1_MEMBER.id)
    })

    it('an authoritative pin still seeds the Launch target (no regression)', () => {
        const seedInput = readAuthoritativeMeshHostPin({ hostDaemonId: M4_HOST.id }).hostDaemonId || undefined
        expect(resolveFirstSetupSeedDaemonId(DAEMONS, [], undefined, undefined, seedInput)).toBe(M4_HOST.id)
    })
})
