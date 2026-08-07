import { describe, expect, it } from 'vitest'
import { isWorktreeNode } from '../../../src/pages/repo-mesh/MeshNodeList'

// isWorktreeNode is the SHARED guard behind two independent worktree-exclusion
// sites: MeshNodeList filters worktree nodes out of the mesh settings list
// entirely, and MagiKindPanelEditor disables them (rather than hiding them) as
// MAGI slot machine options so an ephemeral worktree can't be newly assigned.
// A regression here breaks both call sites identically.
describe('isWorktreeNode', () => {
    it('flags a node with isLocalWorktree true', () => {
        expect(isWorktreeNode({ isLocalWorktree: true })).toBe(true)
    })

    it('does not flag a regular machine node', () => {
        expect(isWorktreeNode({ isLocalWorktree: false })).toBe(false)
        expect(isWorktreeNode({})).toBe(false)
    })

    it('treats a non-boolean isLocalWorktree as not-worktree (strict === true check)', () => {
        expect(isWorktreeNode({ isLocalWorktree: 1 as unknown as boolean })).toBe(false)
        expect(isWorktreeNode({ isLocalWorktree: 'true' as unknown as boolean })).toBe(false)
    })
})
