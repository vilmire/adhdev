import { describe, expect, it } from 'vitest'
import {
    buildMeshNodeCheckoutLabel,
    buildMeshNodeDisplayLabel,
    buildMeshNodeMachineLabel,
    resolveMeshNodeAttribution,
} from '../../src/commands/router.js'

// Axis separation (owner axiom 2026-08-24: machine ⊃ nodes) —
// buildMeshNodeMachineLabel names the MACHINE and must be identical for every
// checkout the machine hosts; buildMeshNodeCheckoutLabel names the checkout
// (⎇ branch for worktrees, workspace basename otherwise). The old
// buildMeshNodeDisplayLabel mixed both axes plus a provider into one string,
// which titled every worktree like a separate machine.

describe('buildMeshNodeMachineLabel — machine axis only', () => {
    it('never derives from the workspace: two checkouts on one host share the label', () => {
        const base = buildMeshNodeMachineLabel({ workspace: '/Users/me/Work/adhdev', hostname: 'mac-1' }, 'node_base')
        const worktree = buildMeshNodeMachineLabel(
            { workspace: '/Users/me/.adhdev/worktrees/adhdev/fix-thing', worktreeBranch: 'fix/thing', hostname: 'mac-1' },
            'node_wt',
        )
        expect(base).toBe('mac-1')
        expect(worktree).toBe('mac-1')
    })

    it('never appends provider context', () => {
        const label = buildMeshNodeMachineLabel(
            { hostname: 'dst-win', policy: { slots: [{ provider: 'claude-cli' }] }, providers: ['claude-cli'] },
            'node_win',
        )
        expect(label).toBe('dst-win')
    })

    it('prefers an explicit machine label / nickname over host evidence', () => {
        expect(buildMeshNodeMachineLabel({ machineLabel: 'My Windows Box', hostname: 'dst-win' }, 'node_win')).toBe('My Windows Box')
        expect(buildMeshNodeMachineLabel({ machineNickname: 'moltbot', hostname: 'mac-1' }, 'node_a')).toBe('moltbot')
        expect(buildMeshNodeMachineLabel({ machine_nickname: 'staging-box' }, 'node_a')).toBe('staging-box')
    })

    it('strips the mDNS .local suffix from a raw hostname, but never from an explicit label', () => {
        expect(buildMeshNodeMachineLabel({ hostname: 'vilmire-MacBookAir.local' }, 'node_a')).toBe('vilmire-MacBookAir')
        expect(buildMeshNodeMachineLabel({ machineNickname: 'box.local' }, 'node_a')).toBe('box.local')
    })

    it('falls back to a compacted daemon/machine id, then the node id', () => {
        expect(buildMeshNodeMachineLabel({ daemonId: 'daemon_mach_0123456789abcdef0123' }, 'node_a')).toBe('daemon_mach_…')
        expect(buildMeshNodeMachineLabel({ machineId: 'mach_short' }, 'node_a')).toBe('mach_short')
        expect(buildMeshNodeMachineLabel({}, 'node_abcdef')).toBe('node_abcdef')
    })
})

describe('buildMeshNodeCheckoutLabel — node/checkout axis', () => {
    it('titles a worktree by its branch with the ⎇ glyph', () => {
        expect(buildMeshNodeCheckoutLabel(
            { worktreeBranch: 'fix/permission-mode-duplicate-args', workspace: '/x/worktrees/adhdev/fix-permission-mode-duplicate-args' },
            'node_wt',
        )).toBe('⎇ fix/permission-mode-duplicate-args')
    })

    it('titles a base checkout by its OS-agnostic workspace basename', () => {
        // A Windows node reports `D:\gh\adhdev-cloud`; the coordinator building
        // this label may be POSIX, so `\` must still split.
        expect(buildMeshNodeCheckoutLabel({ workspace: 'D:\\gh\\adhdev-cloud' }, 'node_win')).toBe('adhdev-cloud')
        expect(buildMeshNodeCheckoutLabel({ workspace: '/Users/me/Work/adhdev' }, 'node_mac')).toBe('adhdev')
    })

    it('falls back to a short node id with no workspace evidence', () => {
        expect(buildMeshNodeCheckoutLabel({}, 'node_abcdef123456')).toBe('node_abc')
    })
})

describe('buildMeshNodeDisplayLabel — deprecated alias', () => {
    it('delegates to the machine-axis builder and ignores the provider argument', () => {
        expect(buildMeshNodeDisplayLabel({ hostname: 'mac-1', workspace: '/Users/me/Work/adhdev' }, 'node_a', ['claude-code']))
            .toBe('mac-1')
    })
})

describe('resolveMeshNodeAttribution', () => {
    it('reads the owning daemon id and display machine name from a node record', () => {
        expect(resolveMeshNodeAttribution({
            daemonId: 'daemon_windows',
            machineName: 'Windows DST',
        })).toEqual({ daemonId: 'daemon_windows', machineName: 'Windows DST' })
    })

    it('reads snake_case / nested machine forms', () => {
        expect(resolveMeshNodeAttribution({
            daemon_id: 'daemon_windows',
            machine: { name: 'Windows DST' },
        })).toEqual({ daemonId: 'daemon_windows', machineName: 'Windows DST' })
    })

    it('falls back to hostname for the machine name when no explicit name is present', () => {
        expect(resolveMeshNodeAttribution({
            daemonId: 'daemon_windows',
            hostname: 'dst-win',
        })).toEqual({ daemonId: 'daemon_windows', machineName: 'dst-win' })
    })

    it('returns undefined fields for a node carrying no machine identity', () => {
        expect(resolveMeshNodeAttribution({ id: 'node_x' })).toEqual({ daemonId: undefined, machineName: undefined })
    })

    it('tolerates a non-object node', () => {
        expect(resolveMeshNodeAttribution(null)).toEqual({ daemonId: undefined, machineName: undefined })
    })
})
