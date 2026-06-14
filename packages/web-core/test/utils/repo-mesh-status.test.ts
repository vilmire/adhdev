import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'
import { extractRepoMeshStatus } from '../../src/utils/repo-mesh-status'
import { describeProviders, summarizeNodeDrift, summarizeSelectedHead } from '../../src/components/MeshGraph/MeshObservabilitySurface'

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

  it('normalizes node sessions alias into graph session details with runtime metadata', () => {
    const normalized = extractRepoMeshStatus({
      ...status,
      nodes: [
        {
          nodeId: 'node_worker',
          machineLabel: 'Worker',
          workspace: '/repo/worker',
          health: 'online',
          providers: [],
          sessions: [
            {
              id: 'session-generating-full-id',
              providerType: 'codex-cli',
              chatStatus: 'generating',
              role: 'worker',
              startedAt: '2026-06-08T00:00:05.000Z',
            },
            {
              id: 'session-coordinator-full-id',
              providerType: 'hermes-cli',
              status: 'idle',
              isSelfCoordinator: true,
              statusNote: 'Coordinator self status is sampled.',
              createdAt: '2026-06-08T00:00:00.000Z',
            },
          ],
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
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

    const node = normalized?.nodes[0]
    expect(node?.activeSessions).toEqual(['session-generating-full-id', 'session-coordinator-full-id'])
    expect(node?.activeSessionDetails).toEqual([
      expect.objectContaining({
        sessionId: 'session-generating-full-id',
        providerType: 'codex-cli',
        chatStatus: 'generating',
        role: 'worker',
        startedAt: '2026-06-08T00:00:05.000Z',
      }),
      expect.objectContaining({
        sessionId: 'session-coordinator-full-id',
        providerType: 'hermes-cli',
        state: 'idle',
        isSelfCoordinator: true,
        statusNote: 'Coordinator self status is sampled.',
        createdAt: '2026-06-08T00:00:00.000Z',
      }),
    ])

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(item => item.id === 'node_worker')
    expect(graphNode?.sessionDetails).toEqual(node?.activeSessionDetails)
    expect(graphNode?.activeSessionCount).toBe(2)
  })

  it('attaches top-level coordinatorSessions to a matching node when activeWork is empty', () => {
    const normalized = extractRepoMeshStatus({
      ...status,
      queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
      activeWork: [],
      coordinatorSessions: [
        {
          id: 'self-coordinator-session',
          providerType: 'codex-cli',
          status: 'idle',
          chatStatus: 'idle',
          role: 'coordinator',
          isSelfCoordinator: true,
          workspace: '/repo/main',
        },
      ],
      nodes: [
        {
          nodeId: 'node_self',
          machineLabel: 'Self',
          workspace: '/repo/main',
          health: 'online',
          providers: [],
          activeSessions: [],
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
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

    const canonicalGraph = buildMeshGraph(normalized as any)
    const graphNode = canonicalGraph.nodes.find(item => item.id === 'node_self')

    expect(graphNode?.activeSessionCount).toBe(1)
    expect(graphNode?.sessionDetails[0]).toMatchObject({
      sessionId: 'self-coordinator-session',
      providerType: 'codex-cli',
      state: 'idle',
      chatStatus: 'idle',
      role: 'coordinator',
      isSelfCoordinator: true,
    })
    expect(canonicalGraph.stats.totalActiveSessions).toBe(1)
  })

  it('keeps every live node session when coordinatorSessions contains only the coordinator', () => {
    const coordinatorId = '46c156c9-6ed3-483f-acce-7ab06be025d0'
    const workerIds = [
      '57e74a69-97f8-4e97-9148-1c0c14d0c84b',
      '1d92b377-30d7-487b-b81a-691a77261003',
      'a104734b-8fbc-4ee9-b8ee-69beb1586ed8',
      '2082f407-e588-48c9-9f21-695be1662c31',
    ]
    const normalized = extractRepoMeshStatus({
      ...status,
      queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
      activeWork: [],
      coordinatorSessions: [
        {
          id: coordinatorId,
          providerType: 'codex-cli',
          status: 'idle',
          chatStatus: 'idle',
          role: 'coordinator',
          isSelfCoordinator: true,
          workspace: '/repo/main',
          statusNote: 'Coordinator self status is sampled.',
        },
      ],
      nodes: [
        {
          nodeId: 'node_self',
          machineLabel: 'Self',
          workspace: '/repo/main',
          health: 'online',
          providers: ['codex-cli'],
          sessions: [
            {
              id: coordinatorId,
              providerType: 'codex-cli',
              status: 'idle',
              chatStatus: 'idle',
              isSelfCoordinator: true,
            },
            ...workerIds.map(id => ({
              id,
              providerType: 'codex-cli',
              status: 'idle',
              chatStatus: 'idle',
            })),
          ],
          git: {
            isGitRepo: true,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
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

    const node = normalized?.nodes.find(item => item.nodeId === 'node_self')
    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(item => item.id === 'node_self')

    expect(node?.activeSessions).toEqual([coordinatorId, ...workerIds])
    expect(node?.activeSessionDetails?.map(session => session.sessionId)).toEqual([coordinatorId, ...workerIds])
    expect(node?.activeSessionDetails).toHaveLength(5)
    expect(node?.activeSessionDetails?.[0]).toMatchObject({
      sessionId: coordinatorId,
      role: 'coordinator',
      isSelfCoordinator: true,
      statusNote: 'Coordinator self status is sampled.',
    })
    expect(node?.activeSessionDetails?.slice(1)).toEqual(workerIds.map(id => expect.objectContaining({
      sessionId: id,
      providerType: 'codex-cli',
      state: 'idle',
      chatStatus: 'idle',
    })))
    expect(node?.activeSessionDetails?.slice(1).every(session => session.role === undefined && session.isSelfCoordinator === undefined)).toBe(true)
    expect(graphNode?.activeSessionCount).toBe(5)
    expect(graphNode?.activeSessions).toEqual([coordinatorId, ...workerIds])
    expect(graphNode?.sessionDetails.map(session => session.sessionId)).toEqual([coordinatorId, ...workerIds])
    expect(graph.stats.totalActiveSessions).toBe(5)
  })

  it('prefers fresh result status over stale upstream-unverified wrapper status', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const staleWrapperStatus = {
      ...status,
      meshId: 'mesh_upstream_freshness_precedence',
      meshName: 'Upstream Freshness Precedence Mesh',
      refreshedAt: '2026-05-23T00:00:00.000Z',
      sourceOfTruth: { currentStatus: 'live_git_and_session_probes' },
      nodes: [
        {
          nodeId: 'node_303',
          machineLabel: 'node_303',
          workspace: repoRoot,
          repoRoot,
          health: 'online',
          git: {
            isGitRepo: true,
            workspace: repoRoot,
            repoRoot,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'stale',
            upstreamFetchError: 'fetch timed out',
            headCommit: 'stale123',
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            lastCheckedAt: Date.parse('2026-05-23T00:00:00.000Z'),
          },
        },
      ],
    }
    const freshResultStatus = {
      ...staleWrapperStatus,
      refreshedAt: '2026-05-23T00:00:10.000Z',
      nodes: [
        {
          nodeId: 'node_303',
          machineLabel: 'node_303',
          workspace: repoRoot,
          repoRoot,
          health: 'online',
          connection: { state: 'connected', transport: 'direct', reported: true, source: 'mesh_peer_status' },
          git: {
            isGitRepo: true,
            workspace: repoRoot,
            repoRoot,
            branch: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'fresh',
            upstreamFetchedAt: Date.parse('2026-05-23T00:00:10.000Z'),
            headCommit: 'fresh456',
            ahead: 0,
            behind: 0,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            lastCheckedAt: Date.parse('2026-05-23T00:00:10.000Z'),
          },
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
    }

    const normalized = extractRepoMeshStatus({ success: true, status: staleWrapperStatus, result: freshResultStatus } as any)
    const node303 = normalized?.nodes[0]
    expect(node303?.git).toMatchObject({
      upstreamStatus: 'fresh',
      upstreamFetchedAt: Date.parse('2026-05-23T00:00:10.000Z'),
      headCommit: 'fresh456',
    })
    expect(node303?.git).not.toHaveProperty('upstreamFetchError')

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303')
    expect(graphNode?.branchConvergence).toMatchObject({
      status: 'merged_to_main',
      needsConvergence: false,
      reason: 'live_mesh_truth_merged',
    })
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
    expect(graph.nodes.filter(n => n.type === 'submoduleNode')).toHaveLength(1)
    expect(graph.edges.filter(e => e.type === 'submoduleLink')).toHaveLength(1)
    const parentNode = graph.nodes.find(n => n.id === 'node_303a1ded96a859540d7bf608448d1fcc')
    expect(parentNode).toBeDefined()
    expect(graph.stats).toMatchObject({
      totalNodes: 2,
      onlineNodes: 2,
      incompleteSnapshotNodes: 0,
      missingSubmoduleSnapshotNodes: 0,
    })
    expect(graph.snapshotWarnings).toEqual([])
  })

  it('keeps submodule graph nodes when cloud transit omits repoPath and repoRoot is not derivable', () => {
    const response = {
      success: true,
      result: {
        meshId: 'mesh_no_repopath',
        meshName: 'No RepoPath Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-06-15T00:00:00Z',
        nodes: [
          {
            id: 'node_no_repopath',
            machineLabel: 'remote',
            // No workspace/repoRoot here and none in the git object below, so
            // parentRepoRoot is undefined and joinRepoPath cannot synthesize a repoPath.
            machineStatus: 'online',
            lastGit: {
              status: {
                isGitRepo: true,
                branch: 'main',
                upstream: 'origin/main',
                upstreamStatus: 'fresh',
                headCommit: '710e11de',
                ahead: 0,
                behind: 0,
                submodules: [
                  { path: 'oss', commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a', dirty: false, outOfSync: false },
                  { path: 'adhdev-providers', commit: '1c29790fc14ad87f75fc6aed958fda8f36dbab0d', dirty: false, outOfSync: false },
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
    const submodules = normalized?.nodes[0]?.git?.submodules
    expect(submodules).toHaveLength(2)
    expect(submodules?.map(s => s.path).sort()).toEqual(['adhdev-providers', 'oss'])
    // repoPath stays undefined rather than being forced to a bogus value.
    expect(submodules?.every(s => s.repoPath === undefined)).toBe(true)
    expect(submodules?.map(s => s.commit)).toContain('c3c722f858bd0a01652ed7d9d5de25b27d233b8a')

    const graph = buildMeshGraph(normalized as any)
    expect(graph.nodes.filter(n => n.type === 'submoduleNode')).toHaveLength(2)
    expect(graph.edges.filter(e => e.type === 'submoduleLink')).toHaveLength(2)
  })

  it('round-trip regression: a transit-stripped node keeps its submodule AND its session (shared normalizers)', () => {
    // Cloud transit reshaped this node: the git object carries only repoRoot +
    // a repoPath-less submodule, and the session record lost its explicit id.
    // Both must survive normalization (evidence + submodule + synthetic-session
    // fixes from @adhdev/mesh-shared), not get silently dropped.
    const repoRoot = '/Users/x/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        meshId: 'mesh_transit_roundtrip',
        meshName: 'Transit Round-Trip Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-06-15T00:00:00Z',
        nodes: [
          {
            id: 'node_transit',
            machineLabel: 'remote',
            workspace: repoRoot,
            machineStatus: 'online',
            lastGit: {
              status: {
                // Branch/upstream/counters stripped in transit — only repoRoot + submodule remain.
                repoRoot,
                submodules: [
                  { path: 'oss', commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a', dirty: false, outOfSync: false },
                ],
              },
            },
            // Session record with NO explicit id field (stripped in transit).
            sessions: [
              { workspace: repoRoot, providerType: 'claude-code', state: 'generating', role: 'coordinator' },
            ],
          },
        ],
        queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
        ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
      },
    } as any)

    const node = normalized?.nodes[0]
    // git evidence survived on repoRoot alone, and the submodule was kept.
    expect(node?.git?.submodules).toHaveLength(1)
    expect(node?.git?.submodules?.[0].path).toBe('oss')
    // session survived via a deterministic synthetic id.
    expect(node?.activeSessionDetails).toHaveLength(1)
    expect(node?.activeSessionDetails?.[0].sessionId.startsWith('synthetic:')).toBe(true)
    expect(node?.activeSessionDetails?.[0].providerType).toBe('claude-code')

    const graph = buildMeshGraph(normalized as any)
    expect(graph.nodes.filter(n => n.type === 'submoduleNode')).toHaveLength(1)
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

  it('uses nested live git status when an outer pending wrapper is present', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        meshId: 'mesh_nested_live_git',
        meshName: 'Nested Live Git Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-21T01:51Z',
        nodes: [
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            health: 'unknown',
            activeSessions: [],
            gitProbePending: true,
            lastGit: {
              status: { isGitRepo: false, branch: null, upstream: null, headCommit: null, error: 'waiting for live peer git snapshot' },
              result: {
                status: {
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
                },
              },
            },
          },
        ],
      },
    } as any)

    const node303 = normalized?.nodes[0]
    expect(node303).toMatchObject({
      health: 'online',
      git: expect.objectContaining({ branch: 'main', upstream: 'origin/main', headCommit: '083fe011' }),
    })
    expect(node303).not.toHaveProperty('gitProbePending')
    const graph = buildMeshGraph(normalized as any)
    expect(graph.nodes[0]?.snapshotCompleteness).not.toBe('pending_git')
    expect(graph.nodes[0]?.snapshotWarnings.join('\n')).not.toContain('waiting for a live peer git snapshot')
  })

  it('keeps node-scoped live git evidence when another peer has failed mesh transport', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        meshId: 'mesh_direct_live_git',
        meshName: 'Direct Live Git Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-21T01:42:18Z',
        sourceOfTruth: { currentStatus: 'live_git_and_session_probes' },
        nodes: [
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            daemonId: '67cf05aed2496f7ed6b261391e9e15bae893bd08ed633c155e9c866b18cbf96a',
            machineId: 'mreg_3f4af21a2741a088a0c41835',
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
              lastConnectedAt: '2026-05-21T01:41:49Z',
              lastCommandAt: '2026-05-21T01:42:18Z',
            },
            git: {
              workspace: repoRoot,
              repoRoot,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: '083fe011',
              ahead: 0,
              behind: 3,
              staged: 0,
              modified: 0,
              untracked: 0,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              lastCheckedAt: Date.parse('2026-05-21T01:42:18Z'),
              submodules: [
                {
                  path: 'oss',
                  commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a',
                  repoPath: `${repoRoot}/oss`,
                  dirty: false,
                  outOfSync: false,
                  lastCheckedAt: Date.parse('2026-05-21T01:42:18Z'),
                },
              ],
            },
          },
          {
            nodeId: 'node_timeout_peer',
            machineLabel: 'node_timeout_peer',
            workspace: '/Users/other/project',
            daemonId: '9f061b89ce435a06666a3e70db28d6230b1b3081b370fbd5766e631ea0a6e78d',
            machineStatus: 'online',
            health: 'unknown',
            providers: [],
            providerPriority: ['hermes-cli'],
            activeSessions: [],
            gitProbePending: true,
            connection: {
              state: 'failed',
              transport: 'unknown',
              reported: true,
              source: 'mesh_peer_status',
              reason: 'Failed to set remote desc: Unexpected remote answer description in signaling state stable',
              lastCommandAt: '2026-05-21T01:42:46Z',
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
        upstream: 'origin/main',
        headCommit: '083fe011',
        ahead: 0,
        behind: 3,
      }),
    })
    expect(node303).not.toHaveProperty('gitProbePending')
    expect(describeProviders(node303 as any)).toBe('installed providers not reported; priority hermes-cli, antigravity-cli')
    expect(summarizeNodeDrift(node303 as any)).toBe('main · ↑0/↓3')
    expect(summarizeSelectedHead(node303 as any, [])).toBe('083fe01')

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303')
    expect(graphNode).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      snapshotCompleteness: 'complete',
    })
    expect(graphNode?.snapshotWarnings.join('\n')).not.toContain('waiting for a live peer git snapshot')
    expect(graphNode?.snapshotWarnings.join('\n')).not.toContain('no peer git snapshot')
  })

  it('normalizes live git and launch readiness over stale bootstrap pending snapshot fields', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        meshId: 'mesh_node303_bootstrap_pending',
        meshName: 'Node 303 Bootstrap Pending Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-21T04:24:47Z',
        sourceOfTruth: { currentStatus: 'live_git_and_session_probes' },
        nodes: [
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            daemonId: '67cf05aed2496f7ed6b261391e9e15bae893bd08ed633c155e9c866b18cbf96a',
            machineId: 'mreg_3f4af21a2741a088a0c41835',
            machineStatus: 'online',
            health: 'unknown',
            launchReady: true,
            providers: [],
            providerPriority: ['hermes-cli'],
            activeSessions: [],
            gitProbePending: true,
            cachedStatus: {
              health: 'unknown',
              launchReady: false,
              gitProbePending: true,
              error: 'waiting for live peer git snapshot',
              git: {
                isGitRepo: false,
                workspace: repoRoot,
                repoRoot,
                branch: null,
                upstream: null,
                headCommit: null,
              },
            },
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
              behind: 8,
              staged: 0,
              modified: 1,
              untracked: 1,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              stashCount: 2,
              lastCheckedAt: Date.parse('2026-05-21T04:24:47Z'),
              submodules: [
                {
                  path: 'adhdev-providers',
                  commit: 'provider-sha',
                  repoPath: `${repoRoot}/adhdev-providers`,
                  dirty: false,
                  outOfSync: false,
                },
                {
                  path: 'oss',
                  commit: 'oss-sha',
                  repoPath: `${repoRoot}/oss`,
                  dirty: false,
                  outOfSync: false,
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
      health: 'dirty',
      launchReady: true,
      git: expect.objectContaining({
        branch: 'main',
        upstream: 'origin/main',
        headCommit: '083fe011',
        behind: 8,
        modified: 1,
        untracked: 1,
        stashCount: 2,
        submodules: [
          expect.objectContaining({ path: 'adhdev-providers' }),
          expect.objectContaining({ path: 'oss' }),
        ],
      }),
    })
    expect(node303).not.toHaveProperty('gitProbePending')
    expect(node303?.error).toBeUndefined()
    expect(describeProviders(node303 as any)).toBe('installed providers not reported; priority hermes-cli')
    expect(summarizeNodeDrift(node303 as any)).toBe('main · ↑0/↓8 · 2 dirty')
    expect(summarizeSelectedHead(node303 as any, [])).toBe('083fe01')

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303')
    expect(graphNode).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      health: 'dirty',
      snapshotCompleteness: 'complete',
      submoduleCommit: '083fe011',
    })
    expect(graph.nodes.filter(n => n.type === 'submoduleNode')).toHaveLength(2)
    expect(graph.edges.filter(e => e.type === 'submoduleLink')).toHaveLength(2)
    expect(graphNode?.snapshotWarnings).toEqual([])
  })

  it('prefers live aggregate nodes over stale nested pending status wrappers', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        success: true,
        meshId: 'mesh_node303_wrapper_precedence',
        meshName: 'Node 303 Wrapper Precedence Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-21T13:24:47Z',
        sourceOfTruth: {
          currentStatus: 'live_git_and_session_probes',
          directPeerTruth: { required: true, satisfied: true },
        },
        status: {
          meshId: 'mesh_node303_wrapper_precedence',
          meshName: 'Node 303 Wrapper Precedence Mesh',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          refreshedAt: '2026-05-21T13:24:00Z',
          sourceOfTruth: { currentStatus: 'inline_bootstrap_snapshot' },
          nodes: [
            {
              nodeId: 'node_303a1ded96a859540d7bf608448d1fcc',
              machineLabel: 'node_303a1ded96a859540d7bf608448d1fcc',
              workspace: repoRoot,
              repoRoot,
              machineStatus: 'online',
              health: 'unknown',
              launchReady: true,
              gitProbePending: true,
              connection: { state: 'unknown', transport: 'unknown', source: 'not_reported' },
            },
          ],
        },
        nodes: [
          {
            nodeId: 'node_303a1ded96a859540d7bf608448d1fcc',
            machineLabel: 'node_303a1ded96a859540d7bf608448d1fcc',
            workspace: repoRoot,
            repoRoot,
            daemonId: '67cf05aed2496f7ed6b261391e9e15bae893bd08ed633c155e9c866b18cbf96a',
            machineId: 'mreg_3f4af21a2741a088a0c41835',
            machineStatus: 'online',
            health: 'online',
            launchReady: true,
            providers: [],
            providerPriority: ['hermes-cli'],
            activeSessions: [],
            connection: { state: 'connected', transport: 'direct', reported: true, source: 'mesh_peer_status' },
            git: {
              isGitRepo: true,
              workspace: repoRoot,
              repoRoot,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: 'a2dbec92',
              ahead: 0,
              behind: 0,
              staged: 0,
              modified: 0,
              untracked: 0,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              lastCheckedAt: Date.parse('2026-05-21T13:24:47Z'),
              submodules: [
                { path: 'oss', commit: 'oss-sha', repoPath: `${repoRoot}/oss`, dirty: false, outOfSync: false },
              ],
            },
          },
        ],
        queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
        ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
      },
    } as any)

    const node303 = normalized?.nodes.find(node => node.nodeId === 'node_303a1ded96a859540d7bf608448d1fcc')
    expect(node303).toMatchObject({
      health: 'online',
      launchReady: true,
      git: expect.objectContaining({
        branch: 'main',
        upstream: 'origin/main',
        headCommit: 'a2dbec92',
        ahead: 0,
        behind: 0,
        submodules: [expect.objectContaining({ path: 'oss', repoPath: `${repoRoot}/oss` })],
      }),
    })
    expect(node303).not.toHaveProperty('gitProbePending')

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303a1ded96a859540d7bf608448d1fcc')
    expect(graphNode).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      snapshotCompleteness: 'complete',
      branchConvergence: null,
    })
    expect(graphNode?.snapshotWarnings).toEqual([])
    expect(graph.snapshotWarnings).toEqual([])
  })

  it('deduplicates stale pending and live peer rows for the same node before graph/detail derivation', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        success: true,
        meshId: 'mesh_node303_duplicate_precedence',
        meshName: 'Node 303 Duplicate Precedence Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-22T00:00:00.000Z',
        sourceOfTruth: {
          currentStatus: 'live_git_and_session_probes',
          directPeerTruth: { required: true, satisfied: true },
        },
        nodes: [
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            machineStatus: 'online',
            health: 'unknown',
            launchReady: true,
            gitProbePending: true,
            connection: { state: 'unknown', transport: 'unknown', source: 'not_reported' },
          },
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            daemonId: 'daemon_303',
            machineId: 'machine_303',
            machineStatus: 'online',
            health: 'online',
            launchReady: true,
            providers: [],
            providerPriority: ['hermes-cli'],
            activeSessions: [],
            connection: { state: 'connected', transport: 'direct', reported: true, source: 'mesh_peer_status' },
            git: {
              isGitRepo: true,
              workspace: repoRoot,
              repoRoot,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: '3a71b5ad',
              headMessage: 'chore: sync cloud MCP server vendor',
              ahead: 0,
              behind: 0,
              staged: 0,
              modified: 0,
              untracked: 0,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              lastCheckedAt: Date.parse('2026-05-22T00:00:00.000Z'),
              submodules: [
                { path: 'oss', commit: '65d7f5dafc495ec4c24d378e3d12a01a2b09a3b2', repoPath: `${repoRoot}/oss`, dirty: false, outOfSync: false },
                { path: 'adhdev-providers', commit: '1c29790fc14ad87f75fc6aed958fda8f36dbab0d', repoPath: `${repoRoot}/adhdev-providers`, dirty: false, outOfSync: false },
              ],
            },
          },
        ],
        queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
        ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
      },
    } as any)

    expect(normalized?.nodes).toHaveLength(1)
    const node303 = normalized?.nodes[0]
    expect(node303).toMatchObject({
      nodeId: 'node_303',
      daemonId: 'daemon_303',
      machineId: 'machine_303',
      health: 'online',
      launchReady: true,
      connection: expect.objectContaining({ state: 'connected', transport: 'direct', source: 'mesh_peer_status' }),
      git: expect.objectContaining({
        branch: 'main',
        upstream: 'origin/main',
        headCommit: '3a71b5ad',
        submodules: [
          expect.objectContaining({ path: 'oss' }),
          expect.objectContaining({ path: 'adhdev-providers' }),
        ],
      }),
    })
    expect(node303).not.toHaveProperty('gitProbePending')

    const graph = buildMeshGraph(normalized as any)
    const graphNodes = graph.nodes.filter(node => node.id === 'node_303')
    expect(graphNodes).toHaveLength(1)
    expect(graphNodes[0]).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      snapshotCompleteness: 'complete',
      branchConvergence: null,
    })
    expect(graphNodes[0]?.snapshotWarnings).toEqual([])
    expect(graph.snapshotWarnings).toEqual([])
  })

  it('does not carry stale follow-up convergence from a lower-ranked duplicate node', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        success: true,
        meshId: 'mesh_node303_stale_followup_precedence',
        meshName: 'Node 303 Stale Follow-up Precedence Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-22T04:10:00.000Z',
        sourceOfTruth: {
          currentStatus: 'live_git_and_session_probes',
          directPeerTruth: { required: true, satisfied: true },
        },
        nodes: [
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            machineStatus: 'online',
            health: 'online',
            launchReady: true,
            providers: [],
            providerPriority: ['hermes-cli'],
            activeSessions: [],
            git: {
              isGitRepo: true,
              workspace: repoRoot,
              repoRoot,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: '3a71b5ad',
              headMessage: 'chore: sync cloud MCP server vendor',
              ahead: 0,
              behind: 2,
              staged: 0,
              modified: 0,
              untracked: 0,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              lastCheckedAt: Date.parse('2026-05-22T03:56:45.000Z'),
            },
            branchConvergence: {
              defaultBranch: 'main',
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              ahead: 0,
              behind: 2,
              isDefaultBranch: true,
              status: 'blocked_review',
              needsConvergence: true,
              reason: 'default_branch_not_even_with_upstream',
              nextStep: 'Bring main even with its upstream before declaring convergence complete.',
            },
          },
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            daemonId: 'daemon_303',
            machineId: 'machine_303',
            machineStatus: 'online',
            health: 'online',
            launchReady: true,
            providers: [],
            providerPriority: ['hermes-cli'],
            activeSessions: [],
            connection: { state: 'connected', transport: 'direct', reported: true, source: 'mesh_peer_status' },
            git: {
              isGitRepo: true,
              workspace: repoRoot,
              repoRoot,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: '4c91e62f',
              headMessage: 'Merge branch fix/mesh-followup-stale-ui',
              ahead: 0,
              behind: 0,
              staged: 0,
              modified: 0,
              untracked: 0,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              lastCheckedAt: Date.parse('2026-05-22T04:10:00.000Z'),
            },
          },
        ],
        queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
        ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
      },
    } as any)

    expect(normalized?.nodes).toHaveLength(1)
    const node303 = normalized?.nodes[0]
    expect(node303).toMatchObject({
      nodeId: 'node_303',
      daemonId: 'daemon_303',
      machineId: 'machine_303',
      git: expect.objectContaining({
        branch: 'main',
        upstream: 'origin/main',
        headCommit: '4c91e62f',
        ahead: 0,
        behind: 0,
      }),
    })

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303')
    expect(graphNode).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      branchConvergence: null,
    })
    expect(graph.stats.followUpNodes).toBe(0)
    expect(graph.warnings.join('\n')).not.toContain('follow-up')
  })

  it('does not let a failed mesh peer status row erase canonical live aggregate git truth', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const normalized = extractRepoMeshStatus({
      success: true,
      result: {
        success: true,
        meshId: 'mesh_node303_failed_connection_precedence',
        meshName: 'Node 303 Failed Connection Precedence Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
        defaultBranch: 'main',
        refreshedAt: '2026-05-22T03:56:45.000Z',
        sourceOfTruth: {
          currentStatus: 'live_git_and_session_probes',
          directPeerTruth: { required: true, satisfied: true },
        },
        nodes: [
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            machineStatus: 'online',
            health: 'online',
            launchReady: true,
            providers: [],
            providerPriority: ['hermes-cli'],
            activeSessions: [],
            git: {
              isGitRepo: true,
              workspace: repoRoot,
              repoRoot,
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              headCommit: '3a71b5ad',
              headMessage: 'chore: sync cloud MCP server vendor',
              ahead: 0,
              behind: 2,
              staged: 0,
              modified: 0,
              untracked: 0,
              deleted: 0,
              renamed: 0,
              hasConflicts: false,
              lastCheckedAt: Date.parse('2026-05-22T03:56:45.000Z'),
              submodules: [
                { path: 'oss', commit: '65d7f5dafc495ec4c24d378e3d12a01a2b09a3b2', repoPath: `${repoRoot}/oss`, dirty: false, outOfSync: false },
                { path: 'adhdev-providers', commit: '1c29790fc14ad87f75fc6aed958fda8f36dbab0d', repoPath: `${repoRoot}/adhdev-providers`, dirty: false, outOfSync: false },
              ],
            },
            branchConvergence: {
              defaultBranch: 'main',
              branch: 'main',
              upstream: 'origin/main',
              upstreamStatus: 'fresh',
              ahead: 0,
              behind: 2,
              isDefaultBranch: true,
              status: 'blocked_review',
              needsConvergence: true,
              reason: 'default_branch_not_even_with_upstream',
              nextStep: 'Bring main even with its upstream before declaring convergence complete.',
            },
          },
          {
            nodeId: 'node_303',
            machineLabel: 'node_303',
            workspace: repoRoot,
            repoRoot,
            machineStatus: 'offline',
            health: 'offline',
            launchReady: false,
            activeSessions: [],
            connection: {
              state: 'failed',
              transport: 'direct',
              reported: true,
              source: 'mesh_peer_status',
              reason: 'P2P DataChannel closed',
            },
          },
        ],
        queue: { tasks: [], summary: { active: 0, historical: 0, counts: {}, activeCounts: {}, historicalCounts: {} } },
        ledger: { entries: [], summary: { recentFailures: 0, taskCompleted: 0, taskFailed: 0, sessionLaunched: 0 } },
      },
    } as any)

    expect(normalized?.nodes).toHaveLength(1)
    const node303 = normalized?.nodes[0]
    expect(node303).toMatchObject({
      nodeId: 'node_303',
      health: 'online',
      launchReady: true,
      git: expect.objectContaining({
        branch: 'main',
        upstream: 'origin/main',
        headCommit: '3a71b5ad',
        behind: 2,
        submodules: [
          expect.objectContaining({ path: 'oss' }),
          expect.objectContaining({ path: 'adhdev-providers' }),
        ],
      }),
      branchConvergence: expect.objectContaining({
        status: 'blocked_review',
        reason: 'default_branch_not_even_with_upstream',
      }),
    })
    expect(node303).not.toHaveProperty('gitProbePending')

    const graph = buildMeshGraph(normalized as any)
    const graphNode = graph.nodes.find(node => node.id === 'node_303')
    expect(graphNode).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      submoduleCommit: '3a71b5ad',
      snapshotCompleteness: 'complete',
      branchConvergence: expect.objectContaining({ status: 'blocked_review', needsConvergence: true }),
    })
    expect(graph.nodes.filter(n => n.type === 'submoduleNode')).toHaveLength(2)
    expect(graph.edges.filter(e => e.type === 'submoduleLink')).toHaveLength(2)
    expect(graphNode?.snapshotWarnings).toEqual([])
    expect(graph.snapshotWarnings).toEqual([])
  })

  it('prefers the latest command result over stale top-level status even when the stale snapshot has more truthy fields', () => {
    const repoRoot = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
    const cleanNode = (nodeId: string, headCommit: string) => ({
      nodeId,
      machineLabel: nodeId,
      workspace: repoRoot,
      repoRoot,
      health: 'online',
      connection: { state: 'connected', transport: 'direct', reported: true, source: 'mesh_peer_status' },
      git: {
        isGitRepo: true,
        workspace: repoRoot,
        repoRoot,
        branch: 'main',
        upstream: 'origin/main',
        upstreamStatus: 'fresh',
        upstreamFetchedAt: Date.parse('2026-05-24T00:10:00.000Z'),
        headCommit,
        ahead: 0,
        behind: 0,
        staged: 0,
        modified: 0,
        untracked: 0,
        deleted: 0,
        renamed: 0,
        hasConflicts: false,
        lastCheckedAt: Date.parse('2026-05-24T00:10:00.000Z'),
      },
    })
    const staleNode = (nodeId: string) => ({
      nodeId,
      machineLabel: nodeId,
      workspace: `${repoRoot}/stale-${nodeId}`,
      repoRoot: `${repoRoot}/stale-${nodeId}`,
      health: 'online',
      git: {
        isGitRepo: true,
        workspace: `${repoRoot}/stale-${nodeId}`,
        repoRoot: `${repoRoot}/stale-${nodeId}`,
        branch: 'main',
        upstream: 'origin/main',
        upstreamStatus: 'stale',
        upstreamFetchError: 'fetch timed out',
        headCommit: `stale-${nodeId}`,
        ahead: 0,
        behind: 0,
        staged: 0,
        modified: 0,
        untracked: 0,
        deleted: 0,
        renamed: 0,
        hasConflicts: false,
        lastCheckedAt: Date.parse('2026-05-23T23:59:00.000Z'),
      },
      branchConvergence: {
        status: 'blocked_review',
        needsConvergence: true,
        reason: 'upstream_unverified',
        nextStep: 'Stale snapshot should not survive a newer command result.',
      },
    })

    const latestResult = {
      ...status,
      meshId: 'mesh_latest_command_result',
      refreshedAt: '2026-05-24T00:10:00.000Z',
      nodes: [cleanNode('node_7', 'fresh-node-7'), cleanNode('node_303', 'fresh-node-303')],
    }
    const staleTopLevelStatus = {
      ...status,
      meshId: 'mesh_stale_top_level_status',
      refreshedAt: '2026-05-23T23:59:00.000Z',
      sourceOfTruth: { currentStatus: 'live_git_and_session_probes' },
      nodes: ['node_old_1', 'node_old_2', 'node_old_3', 'node_old_4', 'node_old_5', 'node_old_6'].map(staleNode),
      followUps: [{ branch: 'main', count: 1, reason: 'upstream_unverified' }],
    }

    const normalized = extractRepoMeshStatus({ success: true, status: staleTopLevelStatus, result: latestResult } as any)
    expect(normalized?.refreshedAt).toBe('2026-05-24T00:10:00.000Z')
    expect(normalized?.nodes.map(node => node.nodeId)).toEqual(['node_7', 'node_303'])

    const graph = buildMeshGraph(normalized as any)
    expect(graph.nodes.map(node => node.id)).not.toContain('node_old_1')
    expect(graph.nodes.every(node => node.branchConvergence?.reason !== 'upstream_unverified')).toBe(true)
  })

  it('returns null for unrelated payloads', () => {
    expect(extractRepoMeshStatus({ success: true, result: { ok: true } } as any)).toBeNull()
  })
})
