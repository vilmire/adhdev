import { describe, expect, it } from 'vitest'

import { buildMeshGraphLayout } from '../../src/components/MeshGraph/meshGraphLayout'
import type { MeshGraphNode } from '../../src/utils/mesh-visualization'

function node(id: string, overrides: Partial<MeshGraphNode> = {}): MeshGraphNode {
    return {
        id,
        type: 'worktreeNode',
        label: id,
        workspace: `/repo/${id}`,
        branch: 'main',
        upstream: 'origin/main',
        upstreamStatus: 'fresh',
        daemonId: null,
        machineId: null,
        machineLabel: id,
        locality: 'local',
        health: 'online',
        ahead: 0,
        behind: 0,
        dirty: false,
        dirtyFiles: 0,
        hasConflicts: false,
        activeSessionCount: 0,
        activeSessions: [],
        providers: [],
        isOrphan: false,
        orphanReasons: [],
        parentNodeId: null,
        submodulePath: null,
        submoduleCommit: null,
        outOfSync: false,
        snapshotCompleteness: 'complete',
        snapshotWarnings: [],
        branchConvergence: null,
        source: {} as any,
        ...overrides,
    }
}

describe('buildMeshGraphLayout', () => {
    it('places same-branch worktrees as peer children instead of a vertical chain', () => {
        const layout = buildMeshGraphLayout({
            meshId: 'mesh',
            meshName: 'Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-27T00:00:00.000Z',
            nodes: [
                node('__branch_main', { type: 'defaultBranchNode', label: 'main', machineLabel: 'default branch' }),
                node('node_a', { label: 'A' }),
                node('node_b', { label: 'B' }),
                node('node_c', { label: 'C' }),
            ],
            edges: [],
            warnings: [],
            stats: {} as any,
        })

        const peers = ['node_a', 'node_b', 'node_c'].map(id => layout.nodes.find(entry => entry.id === id))
        expect(new Set(peers.map(entry => entry?.position.y)).size).toBe(1)
        expect(new Set(peers.map(entry => entry?.position.x)).size).toBe(3)
    })

    it('places sibling submodules on the same child row under their parent', () => {
        const layout = buildMeshGraphLayout({
            meshId: 'mesh',
            meshName: 'Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-27T00:00:00.000Z',
            nodes: [
                node('__branch_main', { type: 'defaultBranchNode', label: 'main', machineLabel: 'default branch' }),
                node('node_parent', { label: 'Parent' }),
                node('sub_a', { type: 'submoduleNode', label: 'A', branch: null, parentNodeId: 'node_parent', submodulePath: 'modules/a' }),
                node('sub_b', { type: 'submoduleNode', label: 'B', branch: null, parentNodeId: 'node_parent', submodulePath: 'modules/b' }),
                node('sub_c', { type: 'submoduleNode', label: 'C', branch: null, parentNodeId: 'node_parent', submodulePath: 'modules/c' }),
            ],
            edges: [],
            warnings: [],
            stats: {} as any,
        })

        const parent = layout.nodes.find(entry => entry.id === 'node_parent')
        const submodules = ['sub_a', 'sub_b', 'sub_c'].map(id => layout.nodes.find(entry => entry.id === id))

        expect(parent).toBeTruthy()
        expect(new Set(submodules.map(entry => entry?.position.y)).size).toBe(1)
        expect(new Set(submodules.map(entry => entry?.position.x)).size).toBe(3)
        expect(submodules[0]?.position.y).toBeGreaterThan(parent?.position.y ?? 0)
    })
})
