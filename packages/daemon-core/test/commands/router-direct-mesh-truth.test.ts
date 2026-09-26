import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withStatusProbeMarker } from '@adhdev/mesh-shared'
import { DaemonCommandRouter } from '../../src/commands/router.js'
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender.js'
import { LOG } from '../../src/logging/logger.js'

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initRepo(path: string) {
  mkdirSync(path, { recursive: true })
  git(['init', '-b', 'main'], path)
  git(['config', 'user.name', 'Test User'], path)
  git(['config', 'user.email', 'test@example.com'], path)
  writeFileSync(join(path, 'README.md'), '# test\n', 'utf-8')
  git(['add', 'README.md'], path)
  git(['commit', '-m', 'init'], path)
}

function createRouter(
  dispatchMeshCommand?: (daemonId: string, command: string, args: Record<string, unknown>) => Promise<unknown>,
  getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null,
) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { handleCliCommand: vi.fn(async () => ({ success: false })) } as any,
    cdpManagers: new Map(),
    providerLoader: {
      resolve: vi.fn(() => null),
      getMeta: vi.fn(() => null),
    } as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: {
      listSessions: vi.fn(async () => []),
    } as any,
    dispatchMeshCommand,
    getMeshPeerConnectionStatus,
    packageName: 'adhdev',
    statusVersion: '0.9.71',
  })
}

const REMOTE_GIT_STATUS = {
  isGitRepo: true,
  workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
  repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
  branch: 'main',
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  deleted: 0,
  renamed: 0,
  conflicted: 0,
  headCommit: 'cafe1234',
} as const

/** A member's push landed in the coordinator-held store (mesh-node-git-state.ts). */
function seedHeldGit(router: DaemonCommandRouter, meshId: string, nodeId: string, git: Record<string, unknown>, observedAt = Date.now()) {
  router.meshNodeGitState.recordObservation({
    meshId, nodeId, workspace: String(git.workspace ?? ''), git: { ...git, lastCheckedAt: observedAt }, source: 'member_push', observedAt,
  })
}

function gitStatusCalls(dispatch: { mock: { calls: any[] } }) {
  return dispatch.mock.calls.filter((call: any[]) => call[1] === 'git_status')
}

describe('DaemonCommandRouter direct Repo Mesh truth', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true })
    }
  })

  it('hydrates bootstrap get_mesh responses with local truth and the HELD remote truth (incl. submodules like oss) — no peer probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-direct-mesh-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    const router = createRouter(dispatchMeshCommand)
    seedHeldGit(router, 'mesh_303', 'node_303', {
      isGitRepo: true,
      workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      branch: 'main',
      ahead: 0,
      behind: 6,
      staged: 0,
      modified: 0,
      untracked: 0,
      deleted: 0,
      renamed: 0,
      conflicted: 0,
      headCommit: '710e11de',
      submodules: [{
        path: 'oss',
        repoPath: '/Users/moltbot/.openclaw/workspace/projects/adhdev/oss',
        commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a',
        dirty: false,
        outOfSync: false,
      }],
    })
    const inlineMesh = {
      id: 'mesh_303',
      name: 'ADHDev',
      coordinator: { preferredNodeId: 'node_local' },
      nodes: [
        {
          id: 'node_local',
          daemonId: 'daemon-local',
          machineId: 'machine-local',
          workspace: localRepo,
          repoRoot: localRepo,
          policy: {},
        },
        {
          id: 'node_303',
          daemonId: 'daemon-remote',
          machineId: 'machine-remote',
          workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          policy: {},
        },
      ],
    }

    // Even an explicit refresh never fans out to the peer: the coordinator
    // answers from what the member pushed.
    const result: any = await router.execute('get_mesh', {
      meshId: 'mesh_303',
      inlineMesh,
      requireDirectPeerTruth: true,
      refresh: true,
    })

    expect(result.success).toBe(true)
    expect(result.sourceOfTruth).toMatchObject({
      membership: 'inline_bootstrap_snapshot',
      coordinatorOwnsLiveTruth: true,
      directPeerTruth: {
        required: true,
        satisfied: true,
        localConfirmedCount: 1,
        peerAttemptedCount: 0,
        peerConfirmedCount: 0,
      },
    })
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    const remoteNode = result.mesh.nodes.find((node: any) => node.id === 'node_303')
    expect(remoteNode.lastGit.source).toBe('coordinator_node_state')
    expect(remoteNode.lastGit.status).toMatchObject({ headCommit: '710e11de' })
    expect(remoteNode.lastGit.status.submodules).toMatchObject([
      {
        path: 'oss',
        dirty: false,
        outOfSync: false,
      },
    ])
  })

  it('stamps a remote member platform/arch (from its PUSHED facts bundle) and the local coordinator self-platform onto userOverrides', async () => {
    const { buildMeshNodeCapabilityTags } = await import('../../src/mesh/mesh-work-queue.js')
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-platform-stamp-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    const router = createRouter(dispatchMeshCommand)
    const inlineMesh = {
      id: 'mesh_stamp',
      name: 'ADHDev',
      coordinator: { preferredNodeId: 'node_local' },
      nodes: [
        {
          id: 'node_local',
          daemonId: 'daemon-local',
          machineId: 'machine-local',
          workspace: localRepo,
          repoRoot: localRepo,
          policy: { providerPriority: ['claude-cli'] },
        },
        {
          id: 'node_win',
          daemonId: 'daemon-remote',
          machineId: 'machine-remote',
          workspace: REMOTE_GIT_STATUS.workspace,
          repoRoot: REMOTE_GIT_STATUS.repoRoot,
          policy: { providerPriority: ['claude-cli'] },
        },
      ],
    }
    await router.execute('get_mesh', { meshId: 'mesh_stamp', inlineMesh, requireDirectPeerTruth: true })

    // A win32 member pushes its runtime summary; its facts bundle carries the
    // platform/arch buildLocalNodeFacts stamps.
    const pushed: any = await router.execute('mesh_node_git_report', {
      meshId: 'mesh_stamp',
      nodeId: 'node_win',
      workspace: REMOTE_GIT_STATUS.workspace,
      runtime: { sessions: [], nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), platform: 'win32', arch: 'x64', machineNickname: 'win-box' } },
      [MESH_SENDER_DAEMON_ID_ARG]: 'daemon-remote',
    }, 'mesh')
    expect(pushed).toMatchObject({ success: true, accepted: true })
    await new Promise((resolve) => setTimeout(resolve, 0)) // the self-heal is fire-and-forget

    const result: any = await router.execute('get_mesh', { meshId: 'mesh_stamp', inlineMesh, requireDirectPeerTruth: true })
    expect(result.success).toBe(true)

    // Remote member: the win32 it reported is stamped onto the node record's
    // userOverrides (the exact field buildMeshNodeCapabilityTags reads), so the
    // coordinator (running on this test's process.platform) advertises os=win32.
    const winNode = result.mesh.nodes.find((node: any) => node.id === 'node_win')
    expect(winNode.userOverrides).toMatchObject({ platform: 'win32', arch: 'x64' })
    expect(winNode.machineNickname).toBe('win-box')
    const winTags = buildMeshNodeCapabilityTags(winNode)
    expect(winTags).toContain('os=win32')
    expect(winTags).toContain('arch=x64')
    expect(gitStatusCalls(dispatchMeshCommand)).toEqual([])

    // Local coordinator node: its git was computed locally, so it self-stamps
    // process.platform/process.arch.
    const localNode = result.mesh.nodes.find((node: any) => node.id === 'node_local')
    expect(localNode.userOverrides).toMatchObject({ platform: process.platform, arch: process.arch })
  })

  it('never overwrites an operator-set platform override with a pushed report', async () => {
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    const router = createRouter(dispatchMeshCommand)
    const inlineMesh = {
      id: 'mesh_keep',
      name: 'ADHDev',
      coordinator: { preferredNodeId: 'node_local' },
      nodes: [
        { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: '/tmp/adhdev-missing-local', policy: {} },
        {
          id: 'node_win',
          daemonId: 'daemon-remote',
          machineId: 'machine-remote',
          workspace: REMOTE_GIT_STATUS.workspace,
          repoRoot: REMOTE_GIT_STATUS.repoRoot,
          // Operator pinned this node to linux — a live win32 report must NOT win.
          userOverrides: { platform: 'linux', arch: 'arm64' },
          policy: {},
        },
      ],
    }
    await router.execute('get_mesh', { meshId: 'mesh_keep', inlineMesh })
    await router.execute('mesh_node_git_report', {
      meshId: 'mesh_keep',
      nodeId: 'node_win',
      workspace: REMOTE_GIT_STATUS.workspace,
      runtime: { sessions: [], nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), platform: 'win32', arch: 'x64' } },
      [MESH_SENDER_DAEMON_ID_ARG]: 'daemon-remote',
    }, 'mesh')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const result: any = await router.execute('get_mesh', { meshId: 'mesh_keep', inlineMesh })
    expect(result.success).toBe(true)
    const winNode = result.mesh.nodes.find((node: any) => node.id === 'node_win')
    expect(winNode.userOverrides).toMatchObject({ platform: 'linux', arch: 'arm64' })
    expect(winNode.reportedPlatform).toBe('win32')
  })

  it('fails closed when bootstrap get_mesh cannot confirm any direct truth', async () => {
    const router = createRouter()
    const result: any = await router.execute('get_mesh', {
      meshId: 'mesh_unavailable',
      inlineMesh: {
        id: 'mesh_unavailable',
        nodes: [
          {
            id: 'node_missing',
            daemonId: 'daemon-missing',
            workspace: '/path/that/does/not/exist',
          },
        ],
      },
      requireDirectPeerTruth: true,
    })

    expect(result).toMatchObject({
      success: false,
      code: 'mesh_direct_peer_truth_unavailable',
      sourceOfTruth: {
        membership: 'inline_bootstrap_snapshot',
        coordinatorOwnsLiveTruth: false,
        directPeerTruth: {
          required: true,
          satisfied: false,
          directEvidenceCount: 0,
        },
      },
    })
  })

  it('prefers persisted local mesh membership over a stale inline bootstrap snapshot when no cached live mesh exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-local-mesh-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    const configDir = join(root, 'config')
    initRepo(localRepo)

    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = configDir

    try {
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')
      const localMesh = createMesh({
        name: 'Persisted Mesh',
        repoIdentity: 'github.com/vilmire/adhdev',
      })
      const localNode = addNode(localMesh.id, {
        workspace: localRepo,
        repoRoot: localRepo,
        daemonId: 'daemon-local',
        machineId: 'machine-local',
        policy: {},
      })
      const remoteNodeEntry = addNode(localMesh.id, {
        workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
        repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
        daemonId: 'daemon-remote',
        machineId: 'machine-remote',
        policy: {},
      })

      const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
      const router = createRouter(dispatchMeshCommand)
      seedHeldGit(router, localMesh.id, remoteNodeEntry!.id, {
          isGitRepo: true,
          workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: 0,
          modified: 0,
          untracked: 0,
          deleted: 0,
          renamed: 0,
          conflicted: 0,
          headCommit: '5aa1284d',
          submodules: [{
            path: 'oss',
            repoPath: '/Users/moltbot/.openclaw/workspace/projects/adhdev/oss',
            commit: '2ec6a14d6668b75318da109413505b92749d4f7c',
            dirty: false,
            outOfSync: false,
          }],
      })

      const result: any = await router.execute('get_mesh', {
        meshId: localMesh.id,
        inlineMesh: {
          id: localMesh.id,
          name: localMesh.name,
          coordinator: { preferredNodeId: localNode?.id },
          nodes: [
            {
              id: localNode?.id,
              daemonId: 'daemon-local',
              machineId: 'machine-local',
              workspace: localRepo,
              repoRoot: localRepo,
              policy: {},
            },
          ],
        },
        requireDirectPeerTruth: true,
        // Even an explicit refresh answers from the held store (no peer probe).
        refresh: true,
      })

      expect(result.success).toBe(true)
      expect(result.sourceOfTruth).toMatchObject({
        membership: 'local_mesh_config',
        coordinatorOwnsLiveTruth: true,
        directPeerTruth: {
          required: true,
          satisfied: true,
          localConfirmedCount: 1,
          peerAttemptedCount: 0,
          peerConfirmedCount: 0,
        },
      })
      expect(gitStatusCalls(dispatchMeshCommand)).toEqual([])
      expect(result.mesh.nodes).toHaveLength(2)
      expect(result.mesh.nodes.map((node: any) => node.workspace)).toEqual([
        localRepo,
        '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      ])
      const remoteNode = result.mesh.nodes.find((node: any) => node.id === remoteNodeEntry?.id)
      expect(remoteNode?.lastGit?.status?.submodules).toMatchObject([
        {
          path: 'oss',
          dirty: false,
          outOfSync: false,
        },
      ])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
    }
  })

  it('★renders a remote node\'s git from the HELD store, never from a dashboard-echoed cachedStatus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-mesh-status-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    const remoteGit = {
      isGitRepo: true,
      workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      branch: 'main',
      ahead: 0,
      behind: 6,
      staged: 0,
      modified: 0,
      untracked: 0,
      deleted: 0,
      renamed: 0,
      conflicted: 0,
      headCommit: '710e11de',
      submodules: [{
        path: 'oss',
        repoPath: '/Users/moltbot/.openclaw/workspace/projects/adhdev/oss',
        commit: 'c3c722f858bd0a01652ed7d9d5de25b27d233b8a',
        dirty: false,
        outOfSync: false,
      }],
    }
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    const router = createRouter(dispatchMeshCommand)
    seedHeldGit(router, 'mesh_303', 'node_303', remoteGit)
    router.meshNodeGitState.recordRuntimeObservation({ meshId: 'mesh_303', nodeId: 'node_303', workspace: remoteGit.workspace, runtime: { sessions: [] }, source: 'member_push', observedAt: Date.now() })
    const inlineMesh = {
      id: 'mesh_303',
      name: 'ADHDev',
      coordinator: { preferredNodeId: 'node_local' },
      nodes: [
        {
          id: 'node_local',
          daemonId: 'daemon-local',
          machineId: 'machine-local',
          workspace: localRepo,
          repoRoot: localRepo,
          policy: {},
        },
        {
          id: 'node_303',
          daemonId: 'daemon-remote',
          machineId: 'machine-remote',
          workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
          policy: {},
        },
      ],
    }

    // The dashboard echoes a stale git view (and a newer-looking lastGit) back in
    // its inlineMesh. Neither is truth for a node another daemon serves.
    const status: any = await router.execute('mesh_status', {
      meshId: 'mesh_303',
      inlineMesh: {
        ...inlineMesh,
        nodes: [
          inlineMesh.nodes[0],
          {
            ...inlineMesh.nodes[1],
            cachedStatus: {
              git: {
                isGitRepo: true,
                branch: 'stale-bootstrap-branch',
                headCommit: 'deadbeef',
              },
            },
            lastGit: { source: 'dashboard_echo', checkedAt: Date.now() + 60_000, status: { isGitRepo: true, branch: 'echo-branch', headCommit: 'e0e0e0e0' } },
          },
        ],
      },
    })

    expect(status.success).toBe(true)
    // Fresh held state: the remote member is neither probed nor nudged.
    expect(dispatchMeshCommand.mock.calls.filter((call: any[]) => call[0] === 'daemon-remote')).toEqual([])
    const remoteNode = status.nodes.find((node: any) => node.nodeId === 'node_303')
    expect(remoteNode.git).toMatchObject({
      branch: 'main',
      headCommit: '710e11de',
      submodules: [{ path: 'oss', dirty: false, outOfSync: false }],
    })
    // The echo never flowed back INTO the store either.
    expect(router.meshNodeGitState.get('mesh_303', 'node_303')?.git).toMatchObject({ headCommit: '710e11de' })
  })

  it('preserves branch convergence summary and peer upstream freshness in browser-facing mesh_status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-mesh-convergence-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    const remoteGit = {
      isGitRepo: true,
      workspace: '/Users/moltbot/Documents/Work/adhdev',
      repoRoot: '/Users/moltbot/Documents/Work/adhdev',
      branch: 'main',
      upstream: 'origin/main',
      upstreamStatus: 'fresh',
      upstreamFetchedAt: Date.now(),
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      deleted: 0,
      renamed: 0,
      conflicted: 0,
      headCommit: '4909dcbf',
      submodules: [{
        path: 'oss',
        repoPath: '/Users/moltbot/Documents/Work/adhdev/oss',
        commit: '3fbbafedb5ad21ce1fcae815b5909873bb176fdf',
        dirty: false,
        outOfSync: false,
      }],
    }
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    const logInfo = vi.spyOn(LOG, 'info').mockImplementation(() => undefined)
    const router = createRouter(dispatchMeshCommand)
    seedHeldGit(router, 'mesh_browser_payload', 'node_117', remoteGit)
    router.meshNodeGitState.recordRuntimeObservation({ meshId: 'mesh_browser_payload', nodeId: 'node_117', workspace: remoteGit.workspace, runtime: { sessions: [] }, source: 'member_push', observedAt: Date.now() })
    const inlineMesh = {
      id: 'mesh_browser_payload',
      name: 'ADHDev',
      defaultBranch: 'main',
      coordinator: { preferredNodeId: 'node_7' },
      nodes: [
        {
          id: 'node_7',
          daemonId: 'daemon-local',
          machineId: 'machine-local',
          workspace: localRepo,
          repoRoot: localRepo,
          policy: {},
        },
        {
          id: 'node_117',
          daemonId: 'daemon-remote',
          machineId: 'machine-remote',
          workspace: '/Users/moltbot/Documents/Work/adhdev',
          repoRoot: '/Users/moltbot/Documents/Work/adhdev',
          policy: {},
        },
      ],
    }

    const status: any = await router.execute('mesh_status', {
      meshId: 'mesh_browser_payload',
      inlineMesh,
      requireDirectPeerTruth: true,
      refresh: true,
    })

    // The member's push is seconds old: an explicit refresh neither probes nor nudges it.
    expect(dispatchMeshCommand.mock.calls.filter((call: any[]) => call[0] === 'daemon-remote')).toEqual([])
    const debugMessage = logInfo.mock.calls
      .filter(([category]) => category === 'MeshStatusDebug')
      .map(([, message]) => String(message))
      .find(message => message.includes('"event":"return_live"'))
    expect(debugMessage).toBeTruthy()
    const debugPayload = JSON.parse(debugMessage!.slice(debugMessage!.indexOf('{')))
    const debugRemoteNode = debugPayload.summary.nodes.find((node: any) => node.nodeId === 'node_117')
    expect(debugRemoteNode.git.upstreamStatus).toBe('fresh')
    expect(debugRemoteNode.branchConvergence).toMatchObject({
      status: 'merged_to_main',
      upstreamStatus: 'fresh',
      needsConvergence: false,
    })
    expect(debugPayload.summary.branchConvergenceSummary).toMatchObject({
      needsFollowUp: false,
      unresolvedCount: 0,
      followUps: [],
    })
    expect(status.success).toBe(true)
    expect(status.sourceOfTruth.directPeerTruth).toMatchObject({
      required: true,
      satisfied: true,
      localConfirmedCount: 1,
      peerAttemptedCount: 0,
      peerConfirmedCount: 0,
      unavailableNodeIds: [],
    })
    expect(status.branchConvergenceSummary).toMatchObject({
      needsFollowUp: false,
      unresolvedCount: 0,
      followUps: [],
    })
    const localNode = status.nodes.find((node: any) => node.nodeId === 'node_7')
    const remoteNode = status.nodes.find((node: any) => node.nodeId === 'node_117')
    expect(localNode.branchConvergence).toMatchObject({
      status: 'merged_to_main',
      reason: 'clean_default_branch',
      needsConvergence: false,
    })
    expect(remoteNode.git).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      upstreamStatus: 'fresh',
      ahead: 0,
      behind: 0,
      headCommit: '4909dcbf',
    })
    expect(remoteNode.branchConvergence).toMatchObject({
      status: 'merged_to_main',
      reason: 'clean_default_branch',
      upstreamStatus: 'fresh',
      ahead: 0,
      behind: 0,
      needsConvergence: false,
    })
  })

  it('the background handshake probe retries a slow-but-connected peer and lands its answer in the store', async () => {
    // First probe fails (slow peer), the retry succeeds. The peer stays
    // 'connected' throughout so the bounded retry budget is spent.
    let calls = 0
    const dispatchMeshCommand = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('timeout')
      return { status: REMOTE_GIT_STATUS }
    })
    const getMeshPeerConnectionStatus = vi.fn(() => ({ state: 'connected', reported: true }))
    const router = createRouter(dispatchMeshCommand, getMeshPeerConnectionStatus)

    expect(router.meshNodeGitRefresher.kick({ meshId: 'mesh_retry', nodeId: 'node_slow', daemonId: 'daemon-slow', workspace: REMOTE_GIT_STATUS.workspace })).toBe(true)
    await router.meshNodeGitRefresher.whenIdle()

    // More than one git_status dispatch proves the retry actually fired.
    expect(gitStatusCalls(dispatchMeshCommand).length).toBeGreaterThan(1)
    // A status-origin probe carries the _statusProbe marker (short connect-wait)
    // and the push subscription the member registers on answering.
    expect(gitStatusCalls(dispatchMeshCommand)[0][2]).toMatchObject({
      ...withStatusProbeMarker({ workspace: REMOTE_GIT_STATUS.workspace, refreshUpstream: true }),
      meshStateSubscription: { meshId: 'mesh_retry', nodeId: 'node_slow' },
    })
    expect(router.meshNodeGitState.get('mesh_retry', 'node_slow')).toMatchObject({
      source: 'coordinator_probe',
      git: expect.objectContaining({ headCommit: 'cafe1234' }),
      unreachableSince: null,
    })
  })

  it('a refresh burst sends at most one nudge per node and never a git_status to a member that is pushing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-probe-reuse-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    const dispatchMeshCommand = vi.fn(async (_daemonId: string, cmd: string) => (
      cmd === 'mesh_node_state_nudge' ? { success: true, subscribed: true } : { success: true }
    ))
    const getMeshPeerConnectionStatus = vi.fn(() => ({ state: 'connected', reported: true }))
    const router = createRouter(dispatchMeshCommand, getMeshPeerConnectionStatus)
    // The member pushed a minute ago (older than the refresh threshold, far below stale).
    seedHeldGit(router, 'mesh_reuse', 'node_slow', { ...REMOTE_GIT_STATUS }, Date.now() - 60_000)
    router.meshNodeGitState.recordRuntimeObservation({ meshId: 'mesh_reuse', nodeId: 'node_slow', workspace: REMOTE_GIT_STATUS.workspace, runtime: { sessions: [] }, source: 'member_push', observedAt: Date.now() - 60_000 })
    const inlineMesh = {
      id: 'mesh_reuse',
      coordinator: { preferredNodeId: 'node_local' },
      nodes: [
        { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: localRepo, repoRoot: localRepo, policy: {} },
        { id: 'node_slow', daemonId: 'daemon-slow', machineId: 'machine-slow', workspace: REMOTE_GIT_STATUS.workspace, repoRoot: REMOTE_GIT_STATUS.repoRoot, policy: {} },
      ],
    }

    for (let i = 0; i < 3; i += 1) {
      const result: any = await router.execute('mesh_status', { meshId: 'mesh_reuse', inlineMesh, requireDirectPeerTruth: true, refresh: true })
      expect(result.success).toBe(true)
      const remoteNode = result.nodes.find((node: any) => node.nodeId === 'node_slow')
      expect(remoteNode.git).toMatchObject({ branch: 'main', headCommit: 'cafe1234' })
    }
    await router.meshNodeGitRefresher.whenIdle()

    expect(gitStatusCalls(dispatchMeshCommand)).toEqual([])
    expect(dispatchMeshCommand.mock.calls.filter((call: any[]) => call[1] === 'get_status_metadata' && call[0] === 'daemon-slow')).toEqual([])
    const nudges = dispatchMeshCommand.mock.calls.filter((call: any[]) => call[1] === 'mesh_node_state_nudge')
    expect(nudges).toHaveLength(1)
    expect(nudges[0]).toEqual(['daemon-slow', 'mesh_node_state_nudge', { meshId: 'mesh_reuse', nodeId: 'node_slow' }])
  })

  it('a member that does not know the nudge (older build) gets the handshake probe instead', async () => {
    const dispatchMeshCommand = vi.fn(async (_daemonId: string, cmd: string) => (
      cmd === 'mesh_node_state_nudge' ? { success: false, error: 'Unknown command' } : { status: REMOTE_GIT_STATUS }
    ))
    const router = createRouter(dispatchMeshCommand, () => ({ state: 'connected', reported: true }))
    seedHeldGit(router, 'mesh_old', 'node_old', { ...REMOTE_GIT_STATUS }, Date.now() - 60_000)
    const target = { meshId: 'mesh_old', nodeId: 'node_old', daemonId: 'daemon-old', workspace: REMOTE_GIT_STATUS.workspace }
    expect(router.meshNodeGitRefresher.nudge(target)).toBe(true)
    await router.meshNodeGitRefresher.whenIdle()
    expect(gitStatusCalls(dispatchMeshCommand)).toHaveLength(1)
    expect(router.meshNodeGitState.get('mesh_old', 'node_old')?.source).toBe('coordinator_probe')
  })

  for (const [label, connection] of [
    ['a peer that is definitively down', { state: 'disconnected', reported: true }],
    ['an offline peer with no live connection entry', null],
  ] as const) {
    it(`the handshake probe never dispatches to ${label}, records it unreachable, and mesh_status still answers`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'adhdev-router-probe-down-'))
      roots.push(root)
      const localRepo = join(root, 'local')
      initRepo(localRepo)

      const dispatchMeshCommand = vi.fn(async () => { throw new Error('timeout') })
      const router = createRouter(dispatchMeshCommand, vi.fn(() => connection as any))

      const result: any = await router.execute('mesh_status', {
        meshId: 'mesh_down',
        inlineMesh: {
          id: 'mesh_down',
          coordinator: { preferredNodeId: 'node_local' },
          nodes: [
            { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: localRepo, repoRoot: localRepo, policy: {} },
            { id: 'node_down', daemonId: 'daemon-down', machineId: 'machine-down', workspace: REMOTE_GIT_STATUS.workspace, repoRoot: REMOTE_GIT_STATUS.repoRoot, policy: {} },
          ],
        },
        requireDirectPeerTruth: true,
        refresh: true,
      })
      await router.meshNodeGitRefresher.whenIdle()

      // No held truth yet → the node renders pending; no hard failure any more
      // (nothing is probed on the request path, so nothing can fail there).
      expect(result.success).toBe(true)
      const remoteNode = result.nodes.find((node: any) => node.nodeId === 'node_down')
      expect(remoteNode.git?.headCommit).toBeUndefined()
      expect(remoteNode.gitObservation.source).toBe('none')
      expect(gitStatusCalls(dispatchMeshCommand)).toEqual([])
      expect(typeof router.meshNodeGitState.get('mesh_down', 'node_down')?.unreachableSince).toBe('number')
    })
  }
})
