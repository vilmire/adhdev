import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'

function baseGit(branch: string) {
    return {
        isGitRepo: true,
        branch,
        upstream: `origin/${branch}`,
        upstreamStatus: 'fresh',
        ahead: 0,
        behind: 0,
        staged: 0,
        modified: 0,
        untracked: 0,
        deleted: 0,
        renamed: 0,
        hasConflicts: false,
    }
}

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

    it('links same-branch nodes to the default branch anchor via parentBranch edges (no peer-to-peer worktreeLink)', () => {
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

        // Both nodes connect to the synthetic default branch anchor, not each other
        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: '__branch_main', target: 'node_a', type: 'parentBranch' }),
            expect.objectContaining({ source: '__branch_main', target: 'node_b', type: 'parentBranch' }),
        ]))
        // No peer-to-peer worktreeLink between same-branch nodes
        expect(graph.edges.find(e => e.type === 'worktreeLink' && e.label === 'main peers')).toBeUndefined()
    })

    it('links sibling submodules directly to their repo node instead of chaining them together', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_submodules',
            meshName: 'Submodule Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-16T18:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_parent',
                    machineLabel: 'Parent',
                    workspace: '/repo/parent',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: {
                        ...baseGit('main'),
                        submodules: [
                            { path: 'modules/a', repoPath: '/repo/parent/modules/a', commit: 'aaa111', dirty: false, outOfSync: false },
                            { path: 'modules/b', repoPath: '/repo/parent/modules/b', commit: 'bbb222', dirty: false, outOfSync: false },
                            { path: 'modules/c', repoPath: '/repo/parent/modules/c', commit: 'ccc333', dirty: false, outOfSync: false },
                        ],
                    },
                },
            ],
        } as any)

        const submoduleEdges = graph.edges.filter(edge => edge.type === 'submoduleLink')

        expect(submoduleEdges).toHaveLength(3)
        expect(new Set(submoduleEdges.map(edge => edge.source))).toEqual(new Set(['node_parent']))
        expect(submoduleEdges.map(edge => edge.target).sort()).toEqual([
            'node_parent::submodule::modules/a',
            'node_parent::submodule::modules/b',
            'node_parent::submodule::modules/c',
        ])
    })

    it('preserves machine identity and local-vs-remote hints when daemon metadata is present', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_machine_identity',
            meshName: 'Machine Identity Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-16T18:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_local',
                    daemonId: 'daemon_local',
                    machineId: 'mach_local',
                    machineLabel: 'Local Mac',
                    workspace: '/repo/local',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    connection: { state: 'self', reported: true, source: 'reported' },
                    git: baseGit('main'),
                },
                {
                    nodeId: 'node_remote',
                    daemonId: 'daemon_remote',
                    machineId: 'mach_remote',
                    machineLabel: 'Remote Linux',
                    workspace: '/repo/remote',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    connection: { state: 'connected', transport: 'relay', reported: true, source: 'reported' },
                    git: baseGit('main'),
                },
            ],
        } as any)

        expect(graph.nodes.find(node => node.id === 'node_local')).toMatchObject({
            daemonId: 'daemon_local',
            machineId: 'mach_local',
            machineLabel: 'Local Mac',
            locality: 'local',
        })
        expect(graph.nodes.find(node => node.id === 'node_remote')).toMatchObject({
            daemonId: 'daemon_remote',
            machineId: 'mach_remote',
            machineLabel: 'Remote Linux',
            locality: 'remote',
        })
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
                    branchConvergence: {
                        status: 'blocked_review',
                        needsConvergence: true,
                        reason: 'default_branch_not_even_with_upstream',
                        nextStep: 'Bring main even with origin/main before declaring convergence complete.',
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

    it('preserves daemon-provided branch convergence instead of overriding it from local graph heuristics', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_live_git_stale_convergence',
            meshName: 'Live Git Stale Convergence Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-24T12:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_1171c7758bbdb3f751295c9ba844e289',
                    machineLabel: 'node_117',
                    workspace: '/repo/main-peer',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    connection: { state: 'connected', transport: 'direct', reported: true, source: 'mesh_peer_status' },
                    git: {
                        ...baseGit('main'),
                        upstream: 'origin/main',
                        headCommit: '6a16d844',
                        submodules: [
                            { path: 'oss', commit: 'b24fd8e70e28f7f12889de7ce60ff7836efd8634', repoPath: '/repo/main-peer/oss', dirty: false, outOfSync: false },
                            { path: 'adhdev-providers', commit: 'f68d59da547cd56bee59fd912b7b2f493cf09102', repoPath: '/repo/main-peer/adhdev-providers', dirty: false, outOfSync: false },
                        ],
                    },
                    branchConvergence: {
                        status: 'blocked_review',
                        needsConvergence: true,
                        reason: 'previous_snapshot_default_branch_not_even',
                        nextStep: 'stale previous follow-up must not survive live git truth',
                    },
                },
            ],
        } as any)

        const graphNode = graph.nodes.find(node => node.id === 'node_1171c7758bbdb3f751295c9ba844e289')
        expect(graphNode).toEqual(expect.objectContaining({
            branch: 'main',
            upstream: 'origin/main',
            snapshotCompleteness: 'complete',
            branchConvergence: expect.objectContaining({
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'previous_snapshot_default_branch_not_even',
            }),
        }))
        expect(graph.stats.blockedReviewNodes).toBe(1)
    })

    it('does not invent feature branch convergence when daemon convergence fields are missing', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_feature_upstream_fresh',
            meshName: 'Feature Upstream Fresh Mesh',
            repoIdentity: 'repo',
            defaultBranch: 'main',
            refreshedAt: '2026-05-24T12:02:00.000Z',
            nodes: [
                {
                    nodeId: 'node_feature_fresh',
                    machineLabel: 'feature',
                    workspace: '/repo/feature',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: {
                        ...baseGit('fix/mesh-graph-upstream-unverified-stale-after-refresh'),
                        upstream: 'origin/fix/mesh-graph-upstream-unverified-stale-after-refresh',
                    },
                },
            ],
        } as any)

        expect(graph.nodes.find(node => node.id === 'node_feature_fresh')).toEqual(expect.objectContaining({
            branchConvergence: null,
        }))
        expect(graph.stats.blockedReviewNodes).toBe(0)
        expect(graph.stats.mergeReadyNodes).toBe(0)
        expect(graph.warnings.join('\n')).not.toContain('blocked on branch convergence')
    })

    it('recomputes the synthetic default branch aggregate from current clean members when follow-ups are empty', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_b8b65f3d055abf3fd934bd02aa39490e',
            meshName: 'Converged Main Mesh',
            repoIdentity: 'github.com/vilmire/adhdev',
            refreshedAt: '2026-05-24T12:05:00.000Z',
            branchConvergenceSummary: {
                needsFollowUp: false,
                unresolvedCount: 0,
                followUps: [],
            },
            nodes: [
                {
                    nodeId: 'node_7',
                    machineLabel: 'node_7',
                    workspace: '/Users/vilmire/Work/adhdev',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    connection: { state: 'self', transport: 'direct', reported: true, source: 'mesh_peer_status' },
                    git: { ...baseGit('main'), upstream: 'origin/main', headCommit: '6a16d844' },
                    branchConvergence: {
                        status: 'merged_to_main',
                        needsConvergence: false,
                        reason: 'live_mesh_truth_merged',
                        branch: 'main',
                        defaultBranch: 'main',
                        upstream: 'origin/main',
                        upstreamStatus: 'fresh',
                        ahead: 0,
                        behind: 0,
                        dirty: false,
                        hasConflicts: false,
                    },
                },
                {
                    nodeId: 'node_1171c7758bbdb3f751295c9ba844e289',
                    machineLabel: 'node_117',
                    workspace: '/Users/moltbot/Documents/Work/adhdev',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    connection: { state: 'connected', transport: 'direct', reported: true, source: 'mesh_peer_status' },
                    git: { ...baseGit('main'), upstream: 'origin/main', headCommit: '6a16d844' },
                    branchConvergence: {
                        status: 'merged_to_main',
                        needsConvergence: false,
                        reason: 'live_mesh_truth_merged',
                        branch: 'main',
                        defaultBranch: 'main',
                        upstream: 'origin/main',
                        upstreamStatus: 'fresh',
                        ahead: 0,
                        behind: 0,
                        dirty: false,
                        hasConflicts: false,
                    },
                },
            ],
        } as any)

        const defaultBranchNode = graph.nodes.find(node => node.id === '__branch_main')
        expect(defaultBranchNode).toEqual(expect.objectContaining({
            type: 'defaultBranchNode',
            branch: 'main',
            branchConvergence: expect.objectContaining({
                status: 'merged_to_main',
                needsConvergence: false,
                reason: 'clean_default_branch_aggregate',
            }),
        }))
        expect(graph.nodes.filter(node => node.type !== 'submoduleNode').every(node => node.branchConvergence?.status !== 'blocked_review')).toBe(true)
        expect(graph.stats.followUpNodes).toBe(0)
        expect(graph.stats.blockedReviewNodes).toBe(0)
        expect(graph.warnings.join('\n')).not.toContain('blocked on branch convergence')
    })

    it('marks online nodes with pending peer git probes as pending instead of blocked review', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_pending_probe',
            meshName: 'Pending Probe Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-20T05:25:23.442Z',
            nodes: [
                {
                    nodeId: 'node_main',
                    machineLabel: 'Coordinator',
                    workspace: '/repo/main',
                    health: 'online',
                    providers: ['hermes-cli'],
                    activeSessions: [],
                    git: baseGit('main'),
                },
                {
                    nodeId: 'node_peer',
                    machineLabel: 'Peer',
                    workspace: '/remote/repo',
                    health: 'unknown',
                    machineStatus: 'online',
                    launchReady: true,
                    gitProbePending: true,
                    providers: [],
                    activeSessions: [],
                    connection: {
                        state: 'unknown',
                        source: 'not_reported',
                        transport: 'unknown',
                        reported: false,
                    },
                },
            ],
        } as any)

        const peerNode = graph.nodes.find(node => node.id === 'node_peer')
        expect(peerNode).toEqual(expect.objectContaining({
            snapshotCompleteness: 'pending_git',
            branchConvergence: null,
        }))
        expect(peerNode?.snapshotWarnings.join(' ')).toContain('waiting for a live peer git snapshot')
        expect(graph.warnings.join(' ')).not.toContain('blocked on branch convergence')
    })

    it('models default branch member and same-branch peer links as undirected relation lines', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_peer_edges',
            meshName: 'Peer Edge Mesh',
            repoIdentity: 'repo',
            defaultBranch: 'main',
            refreshedAt: '2026-05-24T12:10:00.000Z',
            branchConvergenceSummary: { needsFollowUp: false, unresolvedCount: 0, followUps: [] },
            nodes: [
                {
                    nodeId: 'node_7',
                    machineLabel: 'node_7',
                    workspace: '/repo/a',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: { ...baseGit('main'), headCommit: 'd53b899b' },
                    branchConvergence: { status: 'merged_to_main', needsConvergence: false, reason: 'live', branch: 'main', defaultBranch: 'main' },
                },
                {
                    nodeId: 'node_117',
                    machineLabel: 'node_117',
                    workspace: '/repo/b',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: { ...baseGit('main'), headCommit: 'd53b899b' },
                    branchConvergence: { status: 'merged_to_main', needsConvergence: false, reason: 'live', branch: 'main', defaultBranch: 'main' },
                },
            ],
        } as any)

        expect(graph.edges.filter(edge => edge.type === 'parentBranch')).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: '__branch_main', target: 'node_7', direction: 'undirected' }),
            expect.objectContaining({ source: '__branch_main', target: 'node_117', direction: 'undirected' }),
        ]))
        expect(graph.edges.find(edge => edge.type === 'worktreeLink' && edge.label === 'main peers')).toBeUndefined()
    })

    it('emits cloneLink edges for nodes with clonedFromNodeId and exposes worktreeBranch on the node', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_clone',
            meshName: 'Clone Test',
            repoIdentity: 'git@github.com:test/repo.git',
            refreshedAt: '2026-06-01T00:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_main',
                    machineLabel: 'Main',
                    workspace: '/repo/main',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: baseGit('main'),
                },
                {
                    nodeId: 'node_feature',
                    machineLabel: 'Feature',
                    workspace: '/repo/feature-branch',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    // clonedFromNodeId is on LocalMeshNodeEntry but surfaced via mesh status
                    ...(({ clonedFromNodeId: 'node_main', worktreeBranch: 'feature/my-task' }) as any),
                    git: baseGit('feature/my-task'),
                },
            ],
        } as any)

        const featureNode = graph.nodes.find(node => node.id === 'node_feature')
        expect(featureNode?.clonedFromNodeId).toBe('node_main')
        expect(featureNode?.worktreeBranch).toBe('feature/my-task')

        const cloneEdge = graph.edges.find(edge => edge.type === 'cloneLink')
        expect(cloneEdge).toBeDefined()
        expect(cloneEdge?.source).toBe('node_main')
        expect(cloneEdge?.target).toBe('node_feature')
        expect(cloneEdge?.direction).toBe('directed')
        expect(cloneEdge?.label).toContain('cloned')
        expect(cloneEdge?.label).toContain('feature/my-task')
    })

    it('does not emit cloneLink when clonedFromNodeId points to a non-existent node', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_dangling',
            meshName: 'Dangling Clone',
            repoIdentity: 'git@github.com:test/repo.git',
            refreshedAt: '2026-06-01T00:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_feature',
                    machineLabel: 'Feature',
                    workspace: '/repo/feature',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    ...(({ clonedFromNodeId: 'node_that_does_not_exist' }) as any),
                    git: baseGit('feature/work'),
                },
            ],
        } as any)

        expect(graph.edges.filter(edge => edge.type === 'cloneLink')).toHaveLength(0)
    })

    it('maps asyncRefineJobs onto nodes and aggregates refine stats', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_refine',
            meshName: 'Refine Mesh',
            repoIdentity: 'git@github.com:test/repo.git',
            refreshedAt: '2026-06-14T00:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_running',
                    machineLabel: 'Running',
                    workspace: '/repo/running',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: baseGit('feat/running'),
                },
                {
                    nodeId: 'node_failed',
                    machineLabel: 'Failed',
                    workspace: '/repo/failed',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: baseGit('feat/failed'),
                },
            ],
            asyncRefineJobs: [
                { jobId: 'job_run', status: 'running', nodeId: 'node_running', branch: 'feat/running', into: 'main', lastUpdatedAt: '2026-06-14T00:01:00.000Z' },
                // older completed on the same node — in-progress should win
                { jobId: 'job_done', status: 'completed', nodeId: 'node_running', lastUpdatedAt: '2026-06-13T00:00:00.000Z' },
                // node_failed only addressed via targetNodeId fallback
                { jobId: 'job_fail', status: 'failed', targetNodeId: 'node_failed', lastUpdatedAt: '2026-06-14T00:00:30.000Z' },
            ],
        } as any)

        const runningNode = graph.nodes.find(node => node.id === 'node_running')
        expect(runningNode?.refineJobStatus).toBe('running')
        expect(runningNode?.refineJobId).toBe('job_run')
        expect(runningNode?.refineJobBranch).toBe('feat/running')
        expect(runningNode?.refineJobInto).toBe('main')

        const failedNode = graph.nodes.find(node => node.id === 'node_failed')
        expect(failedNode?.refineJobStatus).toBe('failed')
        expect(failedNode?.refineJobId).toBe('job_fail')

        expect(graph.stats.activeRefineNodes).toBe(1)
        expect(graph.stats.failedRefineNodes).toBe(1)
    })

    it('prefers failed over completed when no in-progress refine job exists', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_refine_priority',
            meshName: 'Refine Priority',
            repoIdentity: 'git@github.com:test/repo.git',
            refreshedAt: '2026-06-14T00:00:00.000Z',
            nodes: [
                {
                    nodeId: 'node_mixed',
                    machineLabel: 'Mixed',
                    workspace: '/repo/mixed',
                    health: 'online',
                    providers: [],
                    activeSessions: [],
                    git: baseGit('feat/mixed'),
                },
            ],
            asyncRefineJobs: [
                // completed is newer, but failed should win over completed
                { jobId: 'job_done', status: 'completed', nodeId: 'node_mixed', lastUpdatedAt: '2026-06-14T00:05:00.000Z' },
                { jobId: 'job_fail', status: 'failed', nodeId: 'node_mixed', lastUpdatedAt: '2026-06-14T00:01:00.000Z' },
            ],
        } as any)

        const mixedNode = graph.nodes.find(node => node.id === 'node_mixed')
        expect(mixedNode?.refineJobStatus).toBe('failed')
        expect(graph.stats.failedRefineNodes).toBe(1)
        expect(graph.stats.activeRefineNodes).toBe(0)
    })

})
