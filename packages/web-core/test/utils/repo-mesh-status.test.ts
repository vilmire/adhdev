import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'
import { extractRepoMeshStatus } from '../../src/utils/repo-mesh-status'

describe('extractRepoMeshStatus', () => {
  const status = {
    meshId: 'mesh_1',
    meshName: 'ADHDev',
    repoIdentity: 'github.com/vilmire/adhdev',
    defaultBranch: 'main',
    refreshedAt: '2026-01-01T00:00:00Z',
    nodes: [],
    queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
    ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
  }

  it('accepts raw standalone mesh_status payloads', () => {
    expect(extractRepoMeshStatus(status as any)).toEqual(status)
  })

  it('accepts wrapped transport payloads', () => {
    expect(extractRepoMeshStatus({ success: true, result: status } as any)).toEqual(status)
    expect(extractRepoMeshStatus({ success: true, result: { status } } as any)).toEqual(status)
  })

  it('normalizes raw node payloads so live git probe truth outranks stale cached orphan snapshots on the client path', () => {
    const response = {
      success: true,
      result: {
        meshId: 'mesh_live_truth',
        meshName: 'Live Truth Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        refreshedAt: '2026-01-01T00:00:00Z',
        nodes: [
          {
            id: 'node_303a1ded96a859540d7bf608448d1fcc',
            machineLabel: 'worker',
            workspace: '/Users/remote/.worktrees/adhdev',
            machineStatus: 'online',
            cachedStatus: {
              machineStatus: 'online',
              health: 'degraded',
              error: 'Workspace must be an existing directory',
              git: {
                workspace: '/Users/remote/.worktrees/adhdev',
                repoRoot: '/Users/remote/.worktrees/adhdev',
                isGitRepo: false,
                branch: null,
                headCommit: null,
              },
            },
            lastGit: {
              status: {
                workspace: '/Users/remote/.worktrees/adhdev',
                repoRoot: '/Users/remote/.worktrees/adhdev',
                isGitRepo: true,
                branch: 'main',
                upstream: 'origin/main',
                upstreamStatus: 'fresh',
                headCommit: 'abc1234',
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
          },
        ],
      },
    }

    const normalized = extractRepoMeshStatus(response as any)
    expect(normalized).toBeTruthy()
    expect(normalized?.nodes[0]).toMatchObject({
      nodeId: 'node_303a1ded96a859540d7bf608448d1fcc',
      health: 'online',
      git: expect.objectContaining({
        isGitRepo: true,
        branch: 'main',
        upstream: 'origin/main',
        upstreamStatus: 'fresh',
        headCommit: 'abc1234',
      }),
    })
    expect(normalized?.nodes[0]?.error).toBeUndefined()

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303a1ded96a859540d7bf608448d1fcc')
    expect(graphNode).toMatchObject({
      type: 'worktreeNode',
      isOrphan: false,
      branch: 'main',
      health: 'online',
    })
    expect(graphNode?.orphanReasons).toEqual([])
  })

  it('hydrates remote submodule repo paths from live repoRoot so graph/detail do not drop them', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const response = {
      success: true,
      result: {
        meshId: 'mesh_remote_submodule',
        meshName: 'Remote Submodule Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-20T00:00:00Z',
        nodes: [
          {
            id: 'node_303a1ded96a859540d7bf608448d1fcc',
            machineLabel: 'remote',
            workspace: repoRoot,
            machineStatus: 'online',
            lastGit: {
              status: {
                workspace: repoRoot,
                repoRoot,
                isGitRepo: true,
                branch: 'main',
                upstream: 'origin/main',
                upstreamStatus: 'fresh',
                headCommit: '710e11de',
                headMessage: 'Update oss for mesh live detail/status alignment',
                ahead: 0,
                behind: 6,
                staged: 0,
                modified: 0,
                untracked: 0,
                deleted: 0,
                renamed: 0,
                hasConflicts: false,
                submodules: [
                  {
                    path: 'oss',
                    commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a',
                    dirty: false,
                    outOfSync: false,
                    lastCheckedAt: 1716163200000,
                  },
                ],
              },
            },
          },
        ],
        queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
        ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
      },
    }

    const normalized = extractRepoMeshStatus(response as any)
    expect(normalized?.nodes[0]).toMatchObject({
      nodeId: 'node_303a1ded96a859540d7bf608448d1fcc',
      git: expect.objectContaining({
        repoRoot,
        submodules: [
          expect.objectContaining({
            path: 'oss',
            repoPath: `${repoRoot}/oss`,
          }),
        ],
      }),
    })

    const graph = buildMeshGraph(normalized as any)
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'node_303a1ded96a859540d7bf608448d1fcc::submodule::oss',
        type: 'submoduleNode',
        workspace: `${repoRoot}/oss`,
      }),
    ]))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'node_303a1ded96a859540d7bf608448d1fcc',
        target: 'node_303a1ded96a859540d7bf608448d1fcc::submodule::oss',
        type: 'submoduleLink',
      }),
    ]))
    expect(graph.stats).toMatchObject({
      totalNodes: 2,
      onlineNodes: 2,
      incompleteSnapshotNodes: 0,
      missingSubmoduleSnapshotNodes: 0,
    })
    expect(graph.snapshotWarnings).toEqual([])
  })

  it('clears pending git and derives health when direct mesh peer status coexists with live git fields', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        meshId: 'mesh_direct_live_git',
        meshName: 'Direct Live Git Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-21T01:03:51Z',
        sourceOfTruth: { currentStatus: 'live_git_and_session_probes' },
        nodes: [
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            daemonId: '67cf05aed2496f7ed6b261391e9e15bae893bd08ed633c155e9c866b18cbf96a',
            machineStatus: 'online',
            health: 'unknown',
            launchReady: true,
            providers: [],
            providerPriority: ['hermes-cli', 'antigravity-cli'],
            activeSessions: [],
            gitProbePending: true,
            connection: {
              state: 'connected',
              transport: 'direct',
              reported: true,
              source: 'mesh_peer_status',
            },
            git: {
              isGitRepo: true,
              workspace: repoRoot,
              repoRoot,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: '083fe011',
              ahead: 0,
              behind: 1,
              staged: 0,
              modified: 0,
              untracked: 0,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              lastCheckedAt: Date.parse('2026-05-21T00:52:50Z'),
              submodules: [
                {
                  path: 'oss',
                  commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a',
                  repoPath: `${repoRoot}/oss`,
                  dirty: false,
                  outOfSync: false,
                  lastCheckedAt: Date.parse('2026-05-21T00:52:50Z'),
                },
              ],
            },
          },
        ],
        queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
        ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
      },
    } as any)

    const node303 = normalized?.nodes.find(node => node.nodeId === 'node_303')
    expect(node303).toMatchObject({
      health: 'online',
      providerPriority: ['hermes-cli', 'antigravity-cli'],
      connection: expect.objectContaining({
        transport: 'direct',
        source: 'mesh_peer_status',
      }),
      git: expect.objectContaining({
        branch: 'main',
        headCommit: '083fe011',
        upstream: 'origin/main',
        behind: 1,
      }),
    })
    expect(node303).not.toHaveProperty('gitProbePending')

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303')
    expect(graphNode).toMatchObject({
      branch: 'main',
      health: 'online',
    })
    expect(graphNode?.snapshotCompleteness).not.toBe('pending_git')
    expect(graphNode?.snapshotWarnings.join('\n')).not.toContain('waiting for a live peer git snapshot')
    expect(graphNode?.snapshotWarnings.join('\n')).not.toContain('no peer git snapshot')
  })

  it('returns null for unrelated payloads', () => {
    expect(extractRepoMeshStatus({ success: true, result: { ok: true } } as any)).toBeNull()
  })
})
