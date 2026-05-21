import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'

const execFileAsync = promisify(execFile)

async function createTempGitRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(dir, 'repo')
  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  return { dir, repoRoot }
}

async function createTempGitRepoWithSubmodule(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const submoduleRoot = join(dir, 'submodule')
  const repoRoot = join(dir, 'repo')

  await execFileAsync('git', ['init', submoduleRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: submoduleRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: submoduleRoot })
  await writeFile(join(submoduleRoot, 'submodule.txt'), 'submodule\n')
  await execFileAsync('git', ['add', 'submodule.txt'], { cwd: submoduleRoot })
  await execFileAsync('git', ['commit', '-m', 'submodule init'], { cwd: submoduleRoot })

  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRoot, 'oss'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: repoRoot })

  return { dir, repoRoot, submoduleRoot }
}

function createRouter(overrides: Record<string, unknown> = {}) {
  const { getMeshPeerConnectionStatus, dispatchMeshCommand, ...sessionHostOverrides } = overrides as Record<string, unknown>
  const sessionHostControl = {
    listSessions: vi.fn(async () => []),
    ...sessionHostOverrides,
  }

  const router = new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: sessionHostControl as any,
    dispatchMeshCommand: typeof dispatchMeshCommand === 'function'
      ? dispatchMeshCommand as (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>
      : undefined,
    getMeshPeerConnectionStatus: typeof getMeshPeerConnectionStatus === 'function'
      ? getMeshPeerConnectionStatus as (daemonId: string) => Record<string, unknown> | null
      : undefined,
  })

  return { router, sessionHostControl }
}

describe('mesh_status', () => {
  it('reports live local runtimes and cached remote active sessions', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-')
    try {
      const { router, sessionHostControl } = createRouter({
        listSessions: vi.fn(async () => [
          { sessionId: 'sess-live', workspace: repoRoot, lifecycle: 'running', providerType: 'hermes-cli', meta: { meshNodeId: 'node-local' } },
          { sessionId: 'sess-stopped', workspace: repoRoot, lifecycle: 'stopped', providerType: 'hermes-cli', meta: { meshNodeId: 'node-local' } },
        ]),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-1',
        inlineMesh: {
          id: 'mesh-1',
          name: 'Mesh',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node-remote',
              daemonId: 'machine-remote',
              machineLabel: 'Remote',
              workspace: '/missing/remote',
              providers: ['codex-cli'],
              policy: { providerPriority: ['codex-cli'] },
              cachedStatus: {
                machineStatus: 'online',
                lastSeenAt: '2026-05-17T05:00:00.000Z',
                updatedAt: '2026-05-17T05:01:00.000Z',
                activeSession: { id: 'sess-remote', provider: 'codex-cli', status: 'running' },
                git: {
                  workspace: '/missing/remote',
                  repoRoot: '/missing/remote',
                  isGitRepo: true,
                  branch: 'main',
                  ahead: 0,
                  behind: 0,
                  staged: 0,
                  modified: 0,
                  untracked: 0,
                  deleted: 0,
                  renamed: 0,
                  hasConflicts: false,
                  conflictFiles: [],
                  stashCount: 0,
                  submodules: [
                    {
                      path: 'oss',
                      commit: 'abc1234',
                      repoPath: '/missing/remote/oss',
                      dirty: false,
                      outOfSync: true,
                      lastCheckedAt: 1715882400000,
                    },
                  ],
                },
              },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(sessionHostControl.listSessions).toHaveBeenCalledTimes(1)
      expect(result.nodes.find((node: any) => node.nodeId === 'node-local')).toEqual(expect.objectContaining({
        activeSessions: ['sess-live'],
        health: 'online',
        launchReady: true,
        providerPriority: ['hermes-cli'],
        connection: expect.objectContaining({
          state: 'self',
          transport: 'local',
        }),
      }))
      expect(result.nodes.find((node: any) => node.nodeId === 'node-remote')).toEqual(expect.objectContaining({
        activeSessions: ['sess-remote'],
        health: 'unknown',
        gitProbePending: true,
        launchReady: true,
        providerPriority: ['codex-cli'],
        machineStatus: 'online',
        lastSeenAt: '2026-05-17T05:00:00.000Z',
        updatedAt: '2026-05-17T05:01:00.000Z',
        connection: expect.objectContaining({
          source: 'not_reported',
          state: 'unknown',
          transport: 'unknown',
          reported: false,
        }),
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores unrelated live sessions that only share a workspace with the mesh node', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-unrelated-workspace-')
    try {
      const { router } = createRouter({
        listSessions: vi.fn(async () => [
          {
            sessionId: 'sess-mesh',
            workspace: repoRoot,
            lifecycle: 'running',
            providerType: 'hermes-cli',
            meta: { meshNodeId: 'node-local', meshNodeFor: 'mesh-1' },
          },
          {
            sessionId: 'sess-unrelated',
            workspace: repoRoot,
            lifecycle: 'running',
            providerType: 'codex-cli',
            meta: {},
          },
        ]),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-1',
        inlineMesh: {
          id: 'mesh-1',
          name: 'Mesh',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes[0]).toEqual(expect.objectContaining({
        nodeId: 'node-local',
        activeSessions: ['sess-mesh'],
      }))
      expect(result.nodes[0].activeSessionDetails).toEqual([
        expect.objectContaining({
          sessionId: 'sess-mesh',
          providerType: 'hermes-cli',
        }),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces selected-coordinator mesh connection telemetry when reported', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-telemetry-')
    try {
      const { router } = createRouter({
        getMeshPeerConnectionStatus: vi.fn((daemonId: string) => daemonId === 'machine-remote'
          ? {
              perspective: 'selected_coordinator',
              source: 'mesh_peer_status',
              state: 'connected',
              transport: 'relay',
              reported: true,
              reason: 'Connected over TURN relay.',
              lastStateChangeAt: '2026-05-17T06:00:00.000Z',
              lastConnectedAt: '2026-05-17T06:00:00.000Z',
              lastCommandAt: '2026-05-17T06:00:30.000Z',
            }
          : null),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-telemetry',
        inlineMesh: {
          id: 'mesh-telemetry',
          name: 'Mesh Telemetry',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node-remote',
              daemonId: 'machine-remote',
              machineLabel: 'Remote',
              workspace: '/missing/remote',
              providers: ['codex-cli'],
              policy: { providerPriority: ['codex-cli'] },
              cachedStatus: {
                machineStatus: 'online',
                health: 'online',
                git: {
                  workspace: '/missing/remote',
                  repoRoot: '/missing/remote',
                  isGitRepo: true,
                  branch: 'main',
                  ahead: 0,
                  behind: 0,
                  staged: 0,
                  modified: 0,
                  untracked: 0,
                  deleted: 0,
                  renamed: 0,
                  hasConflicts: false,
                  conflictFiles: [],
                  stashCount: 0,
                },
              },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      const remoteNode = result.nodes.find((node: any) => node.nodeId === 'node-remote')
      expect(remoteNode).toEqual(expect.objectContaining({
        health: 'unknown',
        gitProbePending: true,
        launchReady: true,
        lastSeenAt: '2026-05-17T06:00:30.000Z',
        updatedAt: '2026-05-17T06:00:30.000Z',
        machineStatus: 'online',
      }))
      expect(remoteNode?.connection).toEqual(expect.objectContaining({
        source: 'mesh_peer_status',
        state: 'connected',
        transport: 'relay',
        reported: true,
        reason: 'Connected over TURN relay.',
        lastConnectedAt: '2026-05-17T06:00:00.000Z',
        lastCommandAt: '2026-05-17T06:00:30.000Z',
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('retries remote git probe after peer telemetry flips to connected and surfaces live remote git truth', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-retry-')
    try {
      const dispatchMeshCommand = vi.fn(async () => {
        if (dispatchMeshCommand.mock.calls.length === 1) {
          throw new Error('timeout')
        }
        return {
          status: {
            workspace: '/missing/remote',
            repoRoot: '/missing/remote',
            isGitRepo: true,
            branch: 'main',
            head: '710e11de',
            upstream: 'origin/main',
            ahead: 0,
            behind: 5,
            staged: 0,
            modified: 0,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            conflictFiles: [],
            stashCount: 0,
            branchConvergence: {
              status: 'blocked_review',
              reason: 'default_branch_not_even_with_upstream',
            },
            lastCheckedAt: Date.parse('2026-05-20T07:02:58.779Z'),
            submodules: [
              {
                path: 'oss',
                commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a',
                repoPath: '/missing/remote/oss',
                dirty: false,
                outOfSync: false,
                lastCheckedAt: Date.parse('2026-05-20T07:02:58.779Z'),
              },
            ],
          },
        }
      })
      const getMeshPeerConnectionStatus = vi.fn((daemonId: string) => daemonId === 'machine-remote'
        ? {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: getMeshPeerConnectionStatus.mock.calls.length >= 2 ? 'connected' : 'connecting',
            transport: 'direct',
            reported: true,
            reason: getMeshPeerConnectionStatus.mock.calls.length >= 2
              ? 'Connected directly peer-to-peer.'
              : 'Waiting for mesh DataChannel to open.',
            lastStateChangeAt: '2026-05-20T07:00:06.000Z',
            lastConnectedAt: '2026-05-20T07:00:06.000Z',
            lastCommandAt: '2026-05-20T07:00:23.000Z',
          }
        : null)

      const { router } = createRouter({
        dispatchMeshCommand,
        getMeshPeerConnectionStatus,
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-retry',
        inlineMesh: {
          id: 'mesh-retry',
          name: 'Mesh Retry',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node-remote',
              daemonId: 'machine-remote',
              machineLabel: 'Remote',
              workspace: '/missing/remote',
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
              cachedStatus: {
                machineStatus: 'online',
                lastSeenAt: '2026-05-20T06:59:00.000Z',
                updatedAt: '2026-05-20T06:59:00.000Z',
              },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(2)
      expect(getMeshPeerConnectionStatus).toHaveBeenCalledTimes(2)
      const remoteNode = result.nodes.find((node: any) => node.nodeId === 'node-remote')
      expect(remoteNode?.gitProbePending).toBeUndefined()
      expect(remoteNode).toEqual(expect.objectContaining({
        health: 'online',
        launchReady: true,
        machineStatus: 'online',
        providers: ['hermes-cli'],
        lastSeenAt: '2026-05-20T07:00:23.000Z',
        updatedAt: '2026-05-20T07:02:58.779Z',
      }))
      expect(remoteNode?.connection).toEqual(expect.objectContaining({
        source: 'mesh_peer_status',
        state: 'connected',
        transport: 'direct',
        reported: true,
        reason: 'Connected directly peer-to-peer.',
        lastConnectedAt: '2026-05-20T07:00:06.000Z',
        lastCommandAt: '2026-05-20T07:00:23.000Z',
      }))
      expect(remoteNode?.git).toEqual(expect.objectContaining({
        workspace: '/missing/remote',
        repoRoot: '/missing/remote',
        isGitRepo: true,
        branch: 'main',
        head: '710e11de',
        upstream: 'origin/main',
        ahead: 0,
        behind: 5,
        branchConvergence: expect.objectContaining({
          status: 'blocked_review',
          reason: 'default_branch_not_even_with_upstream',
        }),
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns connected peer git truth from one aggregate mesh_status call and isolates failed peers', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-single-aggregate-')
    try {
      const remoteWorkspace = '/Users/moltbot/.openclaw/workspace/projects/adhdev'
      const failedDaemonId = '9f061b89ce435a06666a3e70db28d6230b1b3081b370fbd5766e631ea0a6e78d'
      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string, args: Record<string, unknown>) => {
        expect(command).toBe('git_status')
        if (daemonId === 'daemon_303') {
          expect(args).toMatchObject({ workspace: remoteWorkspace })
          return {
            success: true,
            status: {
              isGitRepo: true,
              workspace: remoteWorkspace,
              repoRoot: remoteWorkspace,
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
              lastCheckedAt: Date.parse('2026-05-21T13:24:47.000Z'),
              submodules: [
                { path: 'adhdev-providers', repoPath: `${remoteWorkspace}/adhdev-providers`, commit: 'provider-sha', dirty: false, outOfSync: false },
                { path: 'oss', repoPath: `${remoteWorkspace}/oss`, commit: 'oss-sha', dirty: false, outOfSync: false },
              ],
            },
          }
        }
        if (daemonId === failedDaemonId) {
          throw new Error('P2P state changed to failed after remote_desc_duplicate_ignored on mesh_p2p_answer')
        }
        throw new Error(`unexpected daemon ${daemonId}`)
      })
      const getMeshPeerConnectionStatus = vi.fn((daemonId: string) => {
        if (daemonId === 'daemon_303') {
          return {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: 'connected',
            transport: 'direct',
            reported: true,
            reason: 'Connected directly peer-to-peer.',
            lastConnectedAt: '2026-05-21T13:22:47.000Z',
            lastCommandAt: '2026-05-21T13:24:47.000Z',
          }
        }
        if (daemonId === failedDaemonId) {
          return {
            perspective: 'selected_coordinator',
            source: 'mesh_peer_status',
            state: 'failed',
            transport: 'unknown',
            reported: true,
            reason: 'P2P state changed to failed after remote_desc_duplicate_ignored on mesh_p2p_answer',
            lastCommandAt: '2026-05-21T13:21:07.119Z',
          }
        }
        return null
      })
      const { router } = createRouter({ dispatchMeshCommand, getMeshPeerConnectionStatus })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh_303',
        requireDirectPeerTruth: true,
        inlineMesh: {
          id: 'mesh_303',
          name: 'ADHDev',
          repoIdentity: 'github.com/vilmire/adhdev',
          defaultBranch: 'main',
          coordinator: { preferredNodeId: 'node_7' },
          policy: {},
          nodes: [
            {
              id: 'node_7',
              daemonId: 'daemon_7',
              machineLabel: 'Local',
              workspace: repoRoot,
              repoRoot,
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
            {
              id: 'node_303',
              daemonId: 'daemon_303',
              machineLabel: 'Remote',
              workspace: remoteWorkspace,
              repoRoot: remoteWorkspace,
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
              cachedStatus: {
                health: 'unknown',
                gitProbePending: true,
                error: 'waiting for live peer git snapshot',
              },
            },
            {
              id: 'node_9f061_timeout_peer',
              daemonId: failedDaemonId,
              machineLabel: 'Failed peer',
              workspace: '/missing/9f061/Prefex',
              repoRoot: '/missing/9f061/Prefex',
              providers: [],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result).toMatchObject({
        success: true,
        sourceOfTruth: {
          membership: 'inline_bootstrap_snapshot',
          coordinatorOwnsLiveTruth: true,
          currentStatus: 'live_git_and_session_probes',
          directPeerTruth: expect.objectContaining({
            required: true,
            satisfied: true,
            peerAttemptedCount: 2,
            peerConfirmedCount: 1,
          }),
        },
      })
      const node303 = result.nodes.find((node: any) => node.nodeId === 'node_303')
      expect(node303).toMatchObject({
        health: 'dirty',
        launchReady: true,
        providerPriority: ['hermes-cli'],
        connection: expect.objectContaining({ state: 'connected', transport: 'direct', source: 'mesh_peer_status' }),
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
      const failedPeer = result.nodes.find((node: any) => node.nodeId === 'node_9f061_timeout_peer')
      expect(failedPeer).toMatchObject({
        health: 'unknown',
        connection: expect.objectContaining({ state: 'failed' }),
      })
      expect(failedPeer?.git).toBeUndefined()
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats local submodule drift as parent dirty health for local workspaces', async () => {
    const { dir, repoRoot } = await createTempGitRepoWithSubmodule('mesh-status-submodule-')
    try {
      await writeFile(join(repoRoot, 'oss', 'submodule.txt'), 'submodule changed\n')

      const { router } = createRouter()
      const result = await router.execute('mesh_status', {
        meshId: 'mesh-1',
        inlineMesh: {
          id: 'mesh-1',
          name: 'Mesh',
          repoIdentity: 'repo',
          policy: {},
          nodes: [
            {
              id: 'node-local',
              machineLabel: 'Local',
              workspace: repoRoot,
              providers: ['hermes-cli'],
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes[0]).toEqual(expect.objectContaining({
        nodeId: 'node-local',
        health: 'dirty',
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prefers the live coordinator runtime workspace over stale node.workspace', async () => {
    const { dir, repoRoot } = await createTempGitRepo('mesh-status-live-workspace-')
    try {
      const { router } = createRouter({
        listSessions: vi.fn(async () => [
          {
            sessionId: 'coord-live',
            workspace: repoRoot,
            lifecycle: 'running',
            providerType: 'hermes-cli',
            meta: { meshCoordinatorFor: 'mesh-live-workspace' },
          },
        ]),
      })

      const result = await router.execute('mesh_status', {
        meshId: 'mesh-live-workspace',
        inlineMesh: {
          id: 'mesh-live-workspace',
          name: 'Mesh Live Workspace',
          repoIdentity: 'repo',
          policy: {},
          coordinator: { preferredNodeId: 'node-local' },
          nodes: [
            {
              id: 'node-local',
              daemonId: 'machine-local',
              machineLabel: 'Local',
              workspace: '/missing/deleted-worktree',
              repoRoot: '/missing/deleted-worktree',
              providers: ['hermes-cli'],
              policy: { providerPriority: ['hermes-cli'] },
            },
          ],
        },
      }) as any

      expect(result.success).toBe(true)
      expect(result.nodes[0]).toEqual(expect.objectContaining({
        nodeId: 'node-local',
        workspace: repoRoot,
        activeSessions: ['coord-live'],
      }))
      expect(result.nodes[0].git).toEqual(expect.objectContaining({
        workspace: repoRoot,
        isGitRepo: true,
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
