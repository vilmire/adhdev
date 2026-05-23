import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'
import { getMeshGraphInitialFocusNodeIds } from '../../src/utils/mesh-graph-viewport'

describe('mesh graph viewport heuristics', () => {
    it('focuses the default-branch anchor and same-branch primary worktrees before wider topology tails', () => {
        const graph = buildMeshGraph({
            meshId: 'mesh_focus',
            meshName: 'Focus Mesh',
            repoIdentity: 'repo',
            refreshedAt: '2026-05-18T00:00:00.000Z',
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
                        submodules: [
                            {
                                path: 'oss',
                                commit: '1234567890abcdef',
                                repoPath: '/repo/main/oss',
                                dirty: false,
                                outOfSync: true,
                            },
                        ],
                    },
                },
                {
                    nodeId: 'node_peer',
                    machineLabel: 'Peer',
                    workspace: '/repo/peer',
                    health: 'online',
                    providers: ['claude-cli'],
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
                    nodeId: 'node_feature',
                    machineLabel: 'Feature',
                    workspace: '/repo/feature',
                    health: 'online',
                    providers: ['codex-cli'],
                    activeSessions: [],
                    git: {
                        isGitRepo: true,
                        branch: 'feat/mesh',
                        upstream: 'origin/feat/mesh',
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
                    nodeId: 'node_detached',
                    machineLabel: 'Detached',
                    workspace: '/repo/detached',
                    health: 'dirty',
                    providers: ['gemini-cli'],
                    activeSessions: [],
                    git: {
                        isGitRepo: true,
                        branch: null,
                        upstream: null,
                        headCommit: 'abc123',
                        ahead: 0,
                        behind: 0,
                        staged: 0,
                        modified: 1,
                        untracked: 0,
                        deleted: 0,
                        renamed: 0,
                        hasConflicts: false,
                    },
                },
            ],
        } as any)

        expect(getMeshGraphInitialFocusNodeIds(graph)).toEqual([
            '__branch_main',
            'node_main',
            'node_peer',
        ])
    })
})
