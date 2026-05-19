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

  it('returns null for unrelated payloads', () => {
    expect(extractRepoMeshStatus({ success: true, result: { ok: true } } as any)).toBeNull()
  })
})
