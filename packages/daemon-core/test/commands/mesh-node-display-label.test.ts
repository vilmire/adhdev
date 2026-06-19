import { describe, expect, it } from 'vitest'
import { buildMeshNodeDisplayLabel } from '../../src/commands/router.js'

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

    it('falls back to the node id when no workspace/host/provider is known', () => {
        expect(buildMeshNodeDisplayLabel({}, 'node_abcdef', [])).toBe('node_abcdef')
    })
})
