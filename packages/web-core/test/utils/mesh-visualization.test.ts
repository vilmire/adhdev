import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'

describe('buildMeshGraph', () => {
    it('builds a live graph with a synthetic default branch anchor and orphan warnings', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_test',
            meshName: 'Test Mesh',
            repoIdentity: 'git@github.com:adhdev/example.git',
            refreshedAt: '2026-05-16T18:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_main',
                    machineLabel: 'Coordinator',
                    workspace: '/repo/main',
                    health: 'online',
                    providers: ['hermes-cli'],
                    activeSessions: ['sess-main'],
                    git: {
                        isGitRepo: true,
                        branch: 'main',
                        upstream: 'origin/main',
                        ahead: 0,
                        behind: 0,
                        staged: 0,
                        modified: 0,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: false,
                    },
                },
                {
                    nodeId: 'node_feature',
                    machineLabel: 'Feature worker',
                    workspace: '/repo/feature',
                    health: 'dirty',
                    providers: ['claude-cli'],
                    activeSessions: ['sess-feature'],
                    git: {
                        isGitRepo: true,
                        branch: 'feat/mesh-graph',
                        upstream: undefined,
                        ahead: 2,
                        behind: 1,
                        staged: 1,
                        modified: 2,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: false,
                    },
                },
                {
                    nodeId: 'node_detached',
                    machineLabel: 'Detached worker',
                    workspace: '/repo/detached',
                    health: 'offline',
                    providers: ['codex-cli'],
                    activeSessions: [],
                    error: 'Needs rebase',
                    git: {
                        isGitRepo: true,
                        branch: null,
                        upstream: null,
                        headCommit: 'abc123',
                        ahead: 0,
                        behind: 0,
                        staged: 0,
                        modified: 0,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: true,
                    },
                },
            ],
        } as any)

        const defaultAnchor = graph.nodes.find(node => node.type === 'defaultBranchNode')
        const featureNode = graph.nodes.find(node => node.id === 'node_feature')
        const detachedNode = graph.nodes.find(node => node.id === 'node_detached')

        expect(defaultAnchor).toEqual(expect.objectContaining({
            branch: 'main',
            label: 'main',
            activeSessionCount: 1,
            type: 'defaultBranchNode',
        }))
        expect(graph.stats).toEqual(expect.objectContaining({
            totalNodes: 3,
            orphanNodes: 2,
            offlineNodes: 1,
            totalActiveSessions: 2,
        }))
        expect(featureNode).toEqual(expect.objectContaining({
            isOrphan: true,
            dirty: true,
            dirtyFiles: 3,
            ahead: 2,
            behind: 1,
        }))
        expect(detachedNode?.orphanReasons).toEqual(expect.arrayContaining([
            'Detached HEAD',
            'Merge conflicts need resolution',
            'Needs rebase',
        ]))
        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: '__branch_main',
                target: 'node_main',
                type: 'parentBranch',
            }),
            expect.objectContaining({
                source: '__branch_main',
                target: 'node_feature',
            }),
        ]))
        expect(graph.warnings).toEqual(expect.arrayContaining([
            '2 workspace(s) need attention before safe coordination',
            '1 workspace(s) report merge conflicts',
            '1 node(s) are currently offline',
        ]))
    })

    it('links same-branch peers as worktree siblings', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_peers',
            meshName: 'Peer Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-16T18:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_a',
                    machineLabel: 'A',
                    workspace: '/repo/a',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: {
                        isGitRepo: true,
                        branch: 'main',
                        upstream: 'origin/main',
                        ahead: 0,
                        behind: 0,
                        staged: 0,
                        modified: 0,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: false,
                    },
                },
                {
                    nodeId: 'node_b',
                    machineLabel: 'B',
                    workspace: '/repo/b',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: {
                        isGitRepo: true,
                        branch: 'main',
                        upstream: 'origin/main',
                        ahead: 0,
                        behind: 0,
                        staged: 0,
                        modified: 0,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: false,
                    },
                },
            ],
        } as any)

        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'node_a',
                target: 'node_b',
                type: 'worktreeLink',
                label: 'main peers',
            }),
        ]))
    })

    it('surfaces unverified upstream freshness in mesh graph node metadata instead of implying 0/0 certainty', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_freshness',
            meshName: 'Freshness Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-16T18:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_main',
                    machineLabel: 'Coordinator',
                    workspace: '/repo/main',
                    health: 'online',
                    providers: ['hermes-cli'],
                    activeSessions: [],
                    git: {
                        isGitRepo: true,
                        branch: 'main',
                        upstream: 'origin/main',
                        upstreamStatus: 'stale',
                        ahead: 0,
                        behind: 0,
                        staged: 0,
                        modified: 0,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: false,
                    },
                },
            ],
        } as any)

        const node = graph.nodes.find(entry => entry.id === 'node_main')
        expect(node).toEqual(expect.objectContaining({
            upstream: 'origin/main',
            upstreamStatus: 'stale',
            isOrphan: true,
        }))
        expect(node?.orphanReasons).toContain('Upstream freshness unverified for main')
    })

    it('surfaces submodules as child graph nodes with explicit links and warnings', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_submodule',
            meshName: 'Submodule Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-16T18:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_main',
                    machineLabel: 'Coordinator',
                    workspace: '/repo/main',
                    health: 'online',
                    providers: ['hermes-cli'],
                    activeSessions: ['sess-main'],
                    git: {
                        isGitRepo: true,
                        branch: 'main',
                        upstream: 'origin/main',
                        upstreamStatus: 'fresh',
                        ahead: 0,
                        behind: 0,
                        staged: 0,
                        modified: 0,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: false,
                        submodules: [
                            {
                                path: 'oss',
                                commit: '1234567890abcdef',
                                repoPath: '/repo/main/oss',
                                dirty: false,
                                outOfSync: true,
                                lastCheckedAt: 1715882400000,
                            },
                        ],
                    },
                },
            ],
        } as any)

        const parentNode = graph.nodes.find(node => node.id === 'node_main')

        expect(parentNode).toEqual(expect.objectContaining({
            health: 'degraded',
            dirty: false,
            outOfSync: true,
        }))
        expect(graph.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'node_main::submodule::oss',
                type: 'submoduleNode',
                label: 'oss',
                workspace: '/repo/main/oss',
                parentNodeId: 'node_main',
                submodulePath: 'oss',
                outOfSync: true,
            }),
        ]))
        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'node_main',
                target: 'node_main::submodule::oss',
                type: 'submoduleLink',
                label: 'submodule out of sync',
            }),
        ]))
        expect(graph.stats).toEqual(expect.objectContaining({
            totalNodes: 2,
            errorNodes: 2,
            totalActiveSessions: 1,
        }))
        expect(graph.warnings).toContain('1 submodule(s) are out of sync with their parent checkout')
    })
})
