import { describe, expect, it } from 'vitest'

import {
    buildMeshGraphElkInput,
    buildMeshGraphLayout,
    estimateMeshGraphNodeHeight,
    getMeshGraphNodeCardWidth,
    MESH_GRAPH_ELK_OPTIONS,
    MESH_GRAPH_ELK_OPTIONS_COMPACT,
    MESH_GRAPH_LAYOUT,
    MESH_GRAPH_LAYOUT_COMPACT,
} from '../../src/components/MeshGraph/meshGraphLayout'
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
    it('builds concrete ELK input with deterministic layered options and measured node boxes', () => {
        const graph = {
            meshId: 'mesh',
            meshName: 'Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-27T00:00:00.000Z',
            nodes: [
                node('__branch_main', { type: 'defaultBranchNode', label: 'main', machineLabel: 'default branch' }),
                node('node_a', { label: 'A' }),
                node('sub_a', { type: 'submoduleNode', label: 'A', branch: null, parentNodeId: 'node_a', submodulePath: 'modules/a' }),
            ],
            edges: [
                { id: 'edge_anchor', source: '__branch_main', target: 'node_a', type: 'parentBranch', direction: 'undirected' },
                { id: 'edge_submodule', source: 'node_a', target: 'sub_a', type: 'submoduleLink', direction: 'directed' },
                { id: 'edge_missing', source: 'node_a', target: 'missing', type: 'worktreeLink', direction: 'undirected' },
            ],
            warnings: [],
            stats: {} as any,
        }

        const elkInput = buildMeshGraphElkInput(graph as any)
        const worktree = graph.nodes[1]
        const submodule = graph.nodes[2]

        expect(elkInput.layoutOptions).toEqual(MESH_GRAPH_ELK_OPTIONS)
        expect(elkInput.layoutOptions?.['elk.algorithm']).toBe('layered')
        expect(elkInput.layoutOptions?.['elk.direction']).toBe('RIGHT')
        expect(elkInput.children?.find(child => child.id === 'node_a')).toMatchObject({
            width: getMeshGraphNodeCardWidth(worktree as MeshGraphNode),
            height: estimateMeshGraphNodeHeight(worktree as MeshGraphNode),
        })
        expect(elkInput.children?.find(child => child.id === 'sub_a')).toMatchObject({
            width: MESH_GRAPH_LAYOUT.submoduleCardWidth,
            height: estimateMeshGraphNodeHeight(submodule as MeshGraphNode),
        })
        expect(elkInput.edges?.map(edge => edge.id)).toEqual(['edge_anchor', 'edge_submodule'])
    })

    it('positions same-branch worktrees deterministically in one ELK layer', async () => {
        const layout = await buildMeshGraphLayout({
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
            edges: [
                { id: 'edge_a', source: '__branch_main', target: 'node_a', type: 'parentBranch', direction: 'undirected' },
                { id: 'edge_b', source: '__branch_main', target: 'node_b', type: 'parentBranch', direction: 'undirected' },
                { id: 'edge_c', source: '__branch_main', target: 'node_c', type: 'parentBranch', direction: 'undirected' },
            ],
            warnings: [],
            stats: {} as any,
        })

        const peers = ['node_a', 'node_b', 'node_c'].map(id => layout.nodes.find(entry => entry.id === id))
        expect(layout.layoutOptions).toEqual(MESH_GRAPH_ELK_OPTIONS)
        expect(new Set(peers.map(entry => entry?.position.y)).size).toBe(3)
        expect(new Set(peers.map(entry => entry?.position.x)).size).toBe(1)
        expect(peers[1]!.position.y).toBeGreaterThan(peers[0]!.position.y)
        expect(peers[2]!.position.y).toBeGreaterThan(peers[1]!.position.y)
        expect(layout.columnGap).toBeGreaterThanOrEqual(MESH_GRAPH_LAYOUT.layerGap)
    })

    it('preserves graph node status/style data and edge source/target integrity through ELK layout', async () => {
        const graph = {
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
            edges: [
                { id: 'edge_parent', source: '__branch_main', target: 'node_parent', type: 'parentBranch', direction: 'undirected' },
                { id: 'edge_sub_a', source: 'node_parent', target: 'sub_a', type: 'submoduleLink', direction: 'directed' },
                { id: 'edge_sub_b', source: 'node_parent', target: 'sub_b', type: 'submoduleLink', direction: 'directed' },
                { id: 'edge_sub_c', source: 'node_parent', target: 'sub_c', type: 'submoduleLink', direction: 'directed' },
            ],
            warnings: [],
            stats: {} as any,
        }

        const layout = await buildMeshGraphLayout(graph as any)
        const elkInput = buildMeshGraphElkInput(graph as any)

        const parent = layout.nodes.find(entry => entry.id === 'node_parent')
        const submodules = ['sub_a', 'sub_b', 'sub_c'].map(id => layout.nodes.find(entry => entry.id === id))

        expect(parent).toBeTruthy()
        expect(new Set(submodules.map(entry => entry?.position.y)).size).toBe(3)
        expect(new Set(submodules.map(entry => entry?.position.x)).size).toBe(1)
        expect(submodules[0]?.position.x).toBeGreaterThan(parent?.position.x ?? 0)
        expect(submodules[1]?.position.y).toBeGreaterThan(submodules[0]?.position.y ?? 0)
        expect(submodules[2]?.position.y).toBeGreaterThan(submodules[1]?.position.y ?? 0)
        expect(submodules[0]?.graphNode.type).toBe('submoduleNode')
        expect(submodules[0]?.graphNode.submodulePath).toBe('modules/a')
        expect(layout.nodes.every(entry => entry.draggable === false && entry.selected === false)).toBe(true)
        expect(elkInput.edges?.map(edge => [edge.sources[0], edge.targets[0]])).toEqual([
            ['__branch_main', 'node_parent'],
            ['node_parent', 'sub_a'],
            ['node_parent', 'sub_b'],
            ['node_parent', 'sub_c'],
        ])
    })
})

describe('compact mode layout', () => {
    it('uses smaller card dimensions and tighter spacing compared to default mode', () => {
        const n = node('n')
        const sub = node('s', { type: 'submoduleNode', branch: null })
        expect(getMeshGraphNodeCardWidth(n, true)).toBe(MESH_GRAPH_LAYOUT_COMPACT.worktreeCardWidth)
        expect(getMeshGraphNodeCardWidth(sub, true)).toBe(MESH_GRAPH_LAYOUT_COMPACT.submoduleCardWidth)
        expect(getMeshGraphNodeCardWidth(n, false)).toBe(MESH_GRAPH_LAYOUT.worktreeCardWidth)
        expect(getMeshGraphNodeCardWidth(n, true)).toBeLessThan(getMeshGraphNodeCardWidth(n, false))
        expect(estimateMeshGraphNodeHeight(n, true)).toBeLessThan(estimateMeshGraphNodeHeight(n, false))
    })

    it('uses compact ELK spacing options that produce a smaller inter-node gap than default', () => {
        expect(Number(MESH_GRAPH_ELK_OPTIONS_COMPACT['elk.spacing.nodeNode']))
            .toBeLessThan(Number(MESH_GRAPH_ELK_OPTIONS['elk.spacing.nodeNode']))
        expect(Number(MESH_GRAPH_ELK_OPTIONS_COMPACT['elk.layered.spacing.nodeNodeBetweenLayers']))
            .toBeLessThan(Number(MESH_GRAPH_ELK_OPTIONS['elk.layered.spacing.nodeNodeBetweenLayers']))
    })

    it('returns compact layout options when compact=true is passed to buildMeshGraphLayout', async () => {
        const graph = {
            meshId: 'mesh',
            meshName: 'Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-30T00:00:00.000Z',
            nodes: [
                node('anchor', { type: 'defaultBranchNode', label: 'main' }),
                ...Array.from({ length: 7 }, (_, i) => node(`wt_${i}`, { label: `wt ${i}`, branch: `feature-${i}` })),
            ],
            edges: Array.from({ length: 7 }, (_, i) => ({
                id: `e${i}`, source: 'anchor', target: `wt_${i}`, type: 'parentBranch' as const, direction: 'undirected' as const,
            })),
            warnings: [],
            stats: {} as any,
        }

        const compactLayout = await buildMeshGraphLayout(graph as any, true)
        const normalLayout = await buildMeshGraphLayout(graph as any, false)

        const compactSpan = Math.max(...compactLayout.nodes.map(n => n.position.x))
        const normalSpan = Math.max(...normalLayout.nodes.map(n => n.position.x))
        expect(compactSpan).toBeLessThan(normalSpan)
        expect(compactLayout.layoutOptions['elk.spacing.nodeNode'])
            .toBe(MESH_GRAPH_ELK_OPTIONS_COMPACT['elk.spacing.nodeNode'])
    })

    it('compact node height is bounded by MESH_GRAPH_LAYOUT_COMPACT.maxEstimatedCardHeight', () => {
        const n = node('n', {
            health: 'dirty',
            dirty: true,
            dirtyFiles: 5,
            isOrphan: true,
            outOfSync: true,
            hasConflicts: true,
            label: 'very long feature branch worktree name that would overflow',
        })
        const h = estimateMeshGraphNodeHeight(n, true)
        expect(h).toBeLessThanOrEqual(MESH_GRAPH_LAYOUT_COMPACT.maxEstimatedCardHeight)
        expect(h).toBeGreaterThanOrEqual(MESH_GRAPH_LAYOUT_COMPACT.minWorktreeCardHeight)
    })
})
