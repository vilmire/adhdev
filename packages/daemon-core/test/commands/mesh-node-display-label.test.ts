import { describe, expect, it } from 'vitest'
import { buildMeshNodeDisplayLabel, resolveMeshNodeAttribution } from '../../src/commands/router.js'

describe('buildMeshNodeDisplayLabel', () => {
    it('shortens a Windows backslash workspace to its OS-agnostic basename', () => {
        // A Windows node reports `D:\gh\adhdev-cloud`. The coordinator building this
        // label may be POSIX (path.basename does not split `\`), so the label must
        // still collapse to the trailing segment.
        const label = buildMeshNodeDisplayLabel({ workspace: 'D:\\gh\\adhdev-cloud' }, 'node_win', [])
        expect(label).toBe('adhdev-cloud')
    })

    it('shortens a POSIX workspace to its basename', () => {
        const label = buildMeshNodeDisplayLabel({ workspace: '/Users/me/Work/adhdev' }, 'node_mac', [])
        expect(label).toBe('adhdev')
    })

    it('combines the workspace basename with host and provider context', () => {
        const label = buildMeshNodeDisplayLabel(
            { workspace: 'D:\\gh\\adhdev-cloud', hostname: 'dst-win' },
            'node_win',
            ['claude-code'],
        )
        expect(label).toBe('adhdev-cloud · dst-win · claude-code')
    })

    it('prefers an explicit machine label over the workspace basename', () => {
        const label = buildMeshNodeDisplayLabel(
            { machineLabel: 'My Windows Box', workspace: 'D:\\gh\\adhdev-cloud' },
            'node_win',
            [],
        )
        expect(label).toBe('My Windows Box')
    })

    it('prefers the machineNickname over the workspace/host fallback', () => {
        // The config.machineNickname propagated onto the node record (self node stamp
        // or a remote member's reporterMachineNickname) must win over the raw
        // workspace·host·provider fallback — the whole point of the propagation fix.
        const label = buildMeshNodeDisplayLabel(
            { machineNickname: 'moltbot', workspace: '/Users/me/Work/adhdev', hostname: 'mac-1' },
            'node_abcdef',
            ['claude-code'],
        )
        expect(label).toBe('moltbot')
    })

    it('reads the snake_case machine_nickname form', () => {
        const label = buildMeshNodeDisplayLabel(
            { machine_nickname: 'staging-box', workspace: '/Users/me/Work/adhdev' },
            'node_abcdef',
            [],
        )
        expect(label).toBe('staging-box')
    })

    it('falls back to the node id when no workspace/host/provider is known', () => {
        expect(buildMeshNodeDisplayLabel({}, 'node_abcdef', [])).toBe('node_abcdef')
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
