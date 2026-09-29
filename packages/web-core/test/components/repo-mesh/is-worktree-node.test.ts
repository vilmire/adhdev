import { describe, expect, it } from 'vitest'
import { isWorktreeNode } from '../../../src/pages/repo-mesh/MeshNodeList'

// isWorktreeNode is the guard MeshNodeList uses to filter worktree nodes out of
// the mesh settings list entirely.
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
