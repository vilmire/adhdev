import { describe, expect, it } from 'vitest'
import { meshesEqual } from '../../src/pages/repo-mesh/useMeshList'
import type { MeshEntry } from '../../src/pages/repo-mesh/types'

/**
 * meshesEqual regression — see create-probe-flicker.test.tsx for the full
 * end-to-end repro. Root cause: useMeshList's loadMeshes() handed setMeshes a
 * brand-new array on every call, even when list_meshes returned identical
 * content, which cascaded into any effect keying off `meshes` (e.g. the setup
 * wizard's create probe) re-running for no reason — the "Checking the
 * workspace..." flicker. meshesEqual is the content-equality check loadMeshes
 * now runs before calling setMeshes, mirroring DaemonContext's
 * injectEntries/daemonArraysEqual pattern.
 */
function mesh(id: string, overrides: Partial<MeshEntry> = {}): MeshEntry {
    return { id, name: `${id}-name`, repoIdentity: `github.com/acme/${id}`, nodes: [], createdAt: '2026-01-01', ...overrides }
}

describe('meshesEqual', () => {
    it('is true for the same reference', () => {
        const list = [mesh('a')]
        expect(meshesEqual(list, list)).toBe(true)
    })

    it('is true for two different array references with identical content', () => {
        const a = [mesh('a'), mesh('b')]
        const b = [mesh('a'), mesh('b')]
        expect(a).not.toBe(b)
        expect(meshesEqual(a, b)).toBe(true)
    })

    it('is false when a mesh field differs', () => {
        const a = [mesh('a', { name: 'old-name' })]
        const b = [mesh('a', { name: 'new-name' })]
        expect(meshesEqual(a, b)).toBe(false)
    })

    it('is false when list length differs', () => {
        expect(meshesEqual([mesh('a')], [mesh('a'), mesh('b')])).toBe(false)
    })

    it('is false when a nested node field differs', () => {
        const a = [mesh('a', { nodes: [{ id: 'n1', workspace: '/repo' }] })]
        const b = [mesh('a', { nodes: [{ id: 'n1', workspace: '/repo-renamed' }] })]
        expect(meshesEqual(a, b)).toBe(false)
    })
})
