import { describe, expect, it } from 'vitest'

import {
    buildMeshGraphElkInput,
    buildMeshGraphLayout,
    estimateMeshGraphEdgeLabelBounds,
    estimateMeshGraphEdgeLabelWidth,
    estimateMeshGraphNodeHeight,
    getMeshGraphNodeCardWidth,
    MESH_GRAPH_EDGE_LABEL,
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

function boxesOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
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

    it('keeps long clone and branch edge labels inside the inter-column channel in compact constrained graphs', async () => {
        const longBranch = 'fix/mesh-graph-overlap-followup-with-extremely-long-branch-name-that-used-to-render-across-node-cards'
        const graph = {
            meshId: 'mesh-constrained',
            meshName: 'Constrained mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-06-01T00:00:00.000Z',
            nodes: [
                node('__branch_main', { type: 'defaultBranchNode', label: 'main', machineLabel: 'default branch' }),
                node('node_local', {
                    label: 'Local coordinator with long label',
                    machineLabel: 'm1-local-coordinator-with-long-visible-name',
                    activeSessionCount: 2,
                    activeSessions: ['sess-local-a', 'sess-local-b'],
                    dirty: true,
                    dirtyFiles: 4,
                }),
                node('node_remote', {
                    label: 'Remote worker with long label',
                    machineLabel: 'remote-worker-with-long-visible-name',
                    locality: 'remote',
                    health: 'dirty',
                    dirty: true,
                    dirtyFiles: 3,
                    activeSessionCount: 1,
                    activeSessions: ['sess-remote'],
                }),
                node('node_clone', {
                    label: 'Clone worktree with long branch',
                    machineLabel: 'clone-worktree-host',
                    branch: longBranch,
                    upstream: `origin/${longBranch}`,
                    upstreamStatus: 'unverified',
                    clonedFromNodeId: 'node_local',
                    worktreeBranch: longBranch,
                    isOrphan: true,
                    nextStepHint: 'Run mesh_refine_node or explicitly classify this worktree branch before ending coordination.',
                    branchConvergence: {
                        status: 'blocked_review',
                        needsConvergence: true,
                        reason: 'upstream_unverified',
                        nextStep: 'Verify upstream and refine this worktree branch.',
                        branch: longBranch,
                        defaultBranch: 'main',
                        upstream: `origin/${longBranch}`,
                        upstreamStatus: 'unverified',
                        ahead: 1,
                        behind: 1,
                        dirty: false,
                        hasConflicts: false,
                    },
                }),
                node('node_local::submodule::oss/packages/web-core-with-long-path', {
                    type: 'submoduleNode',
                    label: 'web-core-with-long-path',
                    branch: null,
                    parentNodeId: 'node_local',
                    submodulePath: 'oss/packages/web-core-with-long-path',
                    submoduleCommit: '1234567890abcdef',
                    dirty: true,
                    dirtyFiles: 1,
                    outOfSync: true,
                    health: 'degraded',
                }),
            ],
            edges: [
                { id: 'edge_local', source: '__branch_main', target: 'node_local', type: 'parentBranch', label: 'checked out', direction: 'undirected' },
                { id: 'edge_remote', source: '__branch_main', target: 'node_remote', type: 'parentBranch', label: 'checked out', direction: 'undirected' },
                { id: 'edge_clone_branch', source: '__branch_main', target: 'node_clone', type: 'orphanLink', label: longBranch, direction: 'undirected' },
                { id: 'edge_session', source: 'node_local', target: 'node_remote', type: 'sessionLink', label: 'active session', direction: 'undirected' },
                { id: 'edge_clone', source: 'node_local', target: 'node_clone', type: 'cloneLink', label: `cloned · ${longBranch}`, direction: 'directed' },
                { id: 'edge_submodule', source: 'node_local', target: 'node_local::submodule::oss/packages/web-core-with-long-path', type: 'submoduleLink', label: 'submodule out of sync', direction: 'directed' },
            ],
            warnings: [],
            stats: {} as any,
        }

        const layout = await buildMeshGraphLayout(graph as any, true)
        const nodeBoxes = layout.nodes.map(entry => ({
            id: entry.id,
            x: entry.position.x,
            y: entry.position.y,
            width: getMeshGraphNodeCardWidth(entry.graphNode, true),
            height: estimateMeshGraphNodeHeight(entry.graphNode, true),
        }))

        for (let i = 0; i < nodeBoxes.length; i += 1) {
            for (let j = i + 1; j < nodeBoxes.length; j += 1) {
                expect(boxesOverlap(nodeBoxes[i], nodeBoxes[j]), `${nodeBoxes[i].id} overlaps ${nodeBoxes[j].id}`).toBe(false)
            }
        }

        expect(estimateMeshGraphEdgeLabelWidth(`cloned · ${longBranch}`)).toBe(MESH_GRAPH_EDGE_LABEL.maxWidth)

        for (const edge of graph.edges) {
            const source = layout.nodes.find(entry => entry.id === edge.source)
            const target = layout.nodes.find(entry => entry.id === edge.target)
            const labelBounds = estimateMeshGraphEdgeLabelBounds(edge, layout.nodes, true)
            if (!source || !target || !labelBounds || source.position.x >= target.position.x) continue

            const sourceRight = source.position.x + getMeshGraphNodeCardWidth(source.graphNode, true)
            const targetLeft = target.position.x
            const channelWidth = targetLeft - sourceRight
            expect(labelBounds.width, `${edge.id} label width`).toBeLessThanOrEqual(channelWidth - 20)
        }
    })
})

describe('badge row estimation (overlap guard)', () => {
    it('accounts for wide badges like "upstream unverified" that force extra row wrapping', () => {
        const heavyNode = node('heavy', {
            health: 'dirty',
            dirty: true,
            dirtyFiles: 3,
            isOrphan: true,
            upstream: 'origin/main',
            upstreamStatus: 'unverified',
            branch: 'feature/my-branch-name-that-is-somewhat-long',
            locality: 'remote',
        })
        const defaultHeight = estimateMeshGraphNodeHeight(heavyNode, false)
        const minHeight = MESH_GRAPH_LAYOUT.minWorktreeCardHeight
        // A node with upstream unverified + orphan + long branch + dirty should estimate
        // more than the minimum height since it has many wide badges that wrap
        expect(defaultHeight).toBeGreaterThan(minHeight)
    })

    it('gives taller height estimate when badges include wide labels like "upstream unverified"', () => {
        const withWide = node('wide', {
            upstream: 'origin/main',
            upstreamStatus: 'unverified',
            isOrphan: true,
        })
        const withoutWide = node('narrow', {
            upstream: null,
            upstreamStatus: null,
            isOrphan: false,
        })
        const heightWithWide = estimateMeshGraphNodeHeight(withWide, false)
        const heightWithoutWide = estimateMeshGraphNodeHeight(withoutWide, false)
        expect(heightWithWide).toBeGreaterThanOrEqual(heightWithoutWide)
    })

    it('estimated node height exceeds ELK-reported node gap for nodes with many badges', () => {
        const n = node('many-badges', {
            dirty: true,
            dirtyFiles: 2,
            isOrphan: true,
            upstream: 'origin/feature',
            upstreamStatus: 'unverified',
            branch: 'feature/some-work',
        })
        const height = estimateMeshGraphNodeHeight(n, false)
        // The height estimate must be larger than the nodeGap so ELK places this node
        // with enough vertical clearance to avoid overlap with its same-column neighbors
        expect(height).toBeGreaterThan(MESH_GRAPH_LAYOUT.nodeGap)
    })
})
