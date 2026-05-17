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

    it('maps branch convergence next steps into ordinary node callout hints when no orphan reason already exists', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_convergence',
            meshName: 'Convergence Mesh',
            repoIdentity: 'repo',
            defaultBranch: 'main',
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
                        upstreamStatus: 'fresh',
                        ahead: 0,
                        behind: 3,
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
            nextStepHint: 'Bring main even with origin/main before declaring convergence complete.',
            branchConvergence: expect.objectContaining({
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_not_even_with_upstream',
                nextStep: 'Bring main even with origin/main before declaring convergence complete.',
            }),
        }))
    })

    it('surfaces incomplete peer git and submodule snapshots explicitly in graph warnings and node metadata', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_snapshot_gaps',
            meshName: 'Snapshot Gap Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-16T18:10:00.000Z',
            nodes: [
                {
                    nodeId: 'node_self',
                    machineLabel: 'M4',
                    workspace: '/repo/main',
                    health: 'online',
                    machineStatus: 'online',
                    providers: ['hermes-cli'],
                    activeSessions: [],
                    connection: { state: 'self', reported: true, source: 'reported' },
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
                        lastCheckedAt: Date.parse('2026-05-16T18:10:00.000Z'),
                        submodules: [
                            {
                                path: 'oss',
                                commit: '1111111',
                                repoPath: '/repo/main/oss',
                                dirty: false,
                                outOfSync: false,
                                lastCheckedAt: Date.parse('2026-05-16T18:10:00.000Z'),
                            },
                        ],
                    },
                },
                {
                    nodeId: 'node_missing_submodule',
                    machineLabel: 'M1',
                    workspace: '/repo/m1',
                    health: 'online',
                    machineStatus: 'online',
                    providers: ['hermes-cli'],
                    activeSessions: [],
                    connection: { state: 'connected', transport: 'relay', reported: true, source: 'reported' },
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
                        lastCheckedAt: Date.parse('2026-05-16T18:09:30.000Z'),
                        submodules: [],
                    },
                },
                {
                    nodeId: 'node_missing_git',
                    machineLabel: 'M2',
                    workspace: '/repo/m2',
                    health: 'online',
                    machineStatus: 'online',
                    providers: ['codex-cli'],
                    activeSessions: [],
                    connection: { state: 'connected', transport: 'relay', reported: true, source: 'reported' },
                },
                {
                    nodeId: 'node_stale_git',
                    machineLabel: 'M3',
                    workspace: '/repo/m3',
                    health: 'online',
                    machineStatus: 'online',
                    providers: ['claude-cli'],
                    activeSessions: [],
                    connection: { state: 'connected', transport: 'relay', reported: true, source: 'reported' },
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
                        lastCheckedAt: Date.parse('2026-05-16T18:00:00.000Z'),
                        submodules: [
                            {
                                path: 'oss',
                                commit: '2222222',
                                repoPath: '/repo/m3/oss',
                                dirty: false,
                                outOfSync: false,
                                lastCheckedAt: Date.parse('2026-05-16T18:00:00.000Z'),
                            },
                        ],
                    },
                },
            ],
        } as any)

        expect(graph.stats).toEqual(expect.objectContaining({
            incompleteSnapshotNodes: 3,
            missingGitSnapshotNodes: 1,
            missingSubmoduleSnapshotNodes: 1,
            staleGitSnapshotNodes: 1,
        }))
        expect(graph.snapshotWarnings).toEqual(expect.arrayContaining([
            '1 node(s) have no visible peer git snapshot',
            '1 node(s) are missing peer submodule visibility reported elsewhere in the mesh',
            '1 node(s) rely on peer git snapshots older than 5m',
        ]))
        expect(graph.warnings).toEqual(expect.arrayContaining(graph.snapshotWarnings))
        expect(graph.nodes.find(node => node.id === 'node_missing_git')).toEqual(expect.objectContaining({
            snapshotCompleteness: 'missing_git',
            nextStepHint: 'M2 is online but no peer git snapshot is visible yet.',
            snapshotWarnings: expect.arrayContaining(['M2 is online but no peer git snapshot is visible yet.']),
        }))
        expect(graph.nodes.find(node => node.id === 'node_missing_submodule')).toEqual(expect.objectContaining({
            snapshotCompleteness: 'missing_submodule_report',
            snapshotWarnings: expect.arrayContaining(['M1 is missing submodule visibility for oss even though another peer reported it.']),
        }))
        expect(graph.nodes.find(node => node.id === 'node_stale_git')).toEqual(expect.objectContaining({
            snapshotCompleteness: 'stale',
            snapshotWarnings: expect.arrayContaining(['M3 is relying on a peer git snapshot older than 5m; re-probe before trusting convergence.']),
        }))
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
