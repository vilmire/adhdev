import { describe, expect, it } from 'vitest'

import { resolveFirstSetupSeedDaemonId } from '../../src/pages/repo-mesh/host-seed'

// HOST-MISSEED-FIRSTSETUP: a two-daemon mesh where the host (M4, coordinator) is at
// index 1 and an unrelated member (M1, moltbot) sits at daemons[0] by P2P insertion
// order — the exact shape that previously seeded M1 as the host candidate.
const M4_HOST = { id: 'daemon_mach_1b46842a15d3409d96ad33e767a916dd' } as any
const M1_MEMBER = { id: 'daemon_mach_b6c8' } as any
const DAEMONS = [M1_MEMBER, M4_HOST] as any[]

describe('HOST-MISSEED-FIRSTSETUP first-setup host seed priority', () => {
    it('prefers the role:host node daemon over daemons[0] (no M1 misseed)', () => {
        const nodes = [
            // node added with role:'host' bound to M4 — must win over daemons[0]=M1.
            { id: 'node-m4', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd', role: 'host' },
            { id: 'node-m1', daemonId: 'daemon_mach_b6c8', role: 'member' },
        ] as any[]
        // self resolves to M4 too here; pass undefined to prove step (1) alone fixes it.
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, undefined, M1_MEMBER.id)
        expect(seed).toBe(M4_HOST.id)
        expect(seed).not.toBe(M1_MEMBER.id)
    })

    it('falls back to self (active daemon) when no node is flagged role:host', () => {
        const nodes = [
            { id: 'node-m4', daemonId: 'mach_1b46842a15d3409d96ad33e767a916dd' },
            { id: 'node-m1', daemonId: 'daemon_mach_b6c8' },
        ] as any[]
        // Operator is viewing from M4 (self) — seed must be M4, not daemons[0]=M1.
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, M4_HOST.id, M1_MEMBER.id)
        expect(seed).toBe(M4_HOST.id)
    })

    it('matches self across daemon-id forms (mach_ vs daemon_mach_)', () => {
        const nodes: any[] = []
        const seed = resolveFirstSetupSeedDaemonId(
            DAEMONS,
            nodes,
            'mach_1b46842a15d3409d96ad33e767a916dd', // bare form of M4
            M1_MEMBER.id,
        )
        expect(seed).toBe(M4_HOST.id)
    })

    it('preserves the legacy daemons[0] fallback when neither host node nor self resolves', () => {
        const nodes: any[] = []
        const seed = resolveFirstSetupSeedDaemonId(DAEMONS, nodes, undefined, undefined)
        expect(seed).toBe(M1_MEMBER.id) // daemons[0]
    })

    it('standalone (daemons[0] === self) keeps daemons[0] — no regression', () => {
        const SELF = { id: 'standalone_mach_self' } as any
        const standaloneDaemons = [SELF] as any[]
        const nodes = [{ id: 'n', daemonId: 'standalone_mach_self', role: 'host' }] as any[]
        const seed = resolveFirstSetupSeedDaemonId(standaloneDaemons, nodes, SELF.id, SELF.id)
        expect(seed).toBe(SELF.id)
    })

    it('returns empty string when there are no connected daemons', () => {
        expect(resolveFirstSetupSeedDaemonId([], [], 'x', 'y')).toBe('')
    })
})
