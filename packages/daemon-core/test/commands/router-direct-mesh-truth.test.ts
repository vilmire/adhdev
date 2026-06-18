import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonCommandRouter } from '../../src/commands/router.js'
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

describe('DaemonCommandRouter direct Repo Mesh truth', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true })
    }
  })

  it('hydrates bootstrap get_mesh responses with direct local and peer truth, including remote submodules like oss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-direct-mesh-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    const dispatchMeshCommand = vi.fn(async () => ({
      status: {
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
      },
    }))
    const router = createRouter(dispatchMeshCommand)
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

    // Standing-state model: a non-local peer's git is only fanned out on an
    // explicit refresh. The default load returns held truth without probing.
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
        peerAttemptedCount: 1,
        peerConfirmedCount: 1,
      },
    })
    expect(dispatchMeshCommand).toHaveBeenCalledWith('daemon-remote', 'git_status', {
      workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev',
      refreshUpstream: true,
    })
    const remoteNode = result.mesh.nodes.find((node: any) => node.id === 'node_303')
    expect(remoteNode.lastGit.status.submodules).toMatchObject([
      {
        path: 'oss',
        dirty: false,
        outOfSync: false,
      },
    ])
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

      const dispatchMeshCommand = vi.fn(async () => ({
        status: {
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
        },
      }))
      const router = createRouter(dispatchMeshCommand)

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
        // Explicit refresh fans out the remote peer git probe (default load
        // would return held standing-state truth without probing).
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
          peerAttemptedCount: 1,
          peerConfirmedCount: 1,
        },
      })
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

  it('keeps direct live git truth ahead of stale cached fallback when mesh_status runs after get_mesh', async () => {
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
    const dispatchMeshCommand = vi.fn(async () => ({ status: remoteGit }))
    const router = createRouter(dispatchMeshCommand)
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

    // Explicit refresh records direct peer truth into the standing cache.
    await router.execute('get_mesh', {
      meshId: 'mesh_303',
      inlineMesh,
      requireDirectPeerTruth: true,
      refresh: true,
    })

    dispatchMeshCommand.mockClear()
    dispatchMeshCommand.mockImplementation(async () => {
      throw new Error('mesh_status should reuse cached direct truth instead of re-probing')
    })

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
          },
        ],
      },
    })

    expect(status.success).toBe(true)
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    const remoteNode = status.nodes.find((node: any) => node.nodeId === 'node_303')
    expect(remoteNode.git).toMatchObject({
      branch: 'main',
      headCommit: '710e11de',
      submodules: [{ path: 'oss', dirty: false, outOfSync: false }],
    })
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
    const dispatchMeshCommand = vi.fn(async () => ({ status: remoteGit }))
    const logInfo = vi.spyOn(LOG, 'info').mockImplementation(() => undefined)
    const router = createRouter(dispatchMeshCommand)
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

    expect(dispatchMeshCommand).toHaveBeenCalledWith('daemon-remote', 'git_status', {
      workspace: '/Users/moltbot/Documents/Work/adhdev',
      refreshUpstream: true,
    })
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
      peerAttemptedCount: 1,
      peerConfirmedCount: 1,
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

  it('retries a slow-but-connected peer git probe and confirms it on a later attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-probe-retry-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

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

    const result: any = await router.execute('get_mesh', {
      meshId: 'mesh_retry',
      inlineMesh: {
        id: 'mesh_retry',
        coordinator: { preferredNodeId: 'node_local' },
        nodes: [
          { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: localRepo, repoRoot: localRepo, policy: {} },
          { id: 'node_slow', daemonId: 'daemon-slow', machineId: 'machine-slow', workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev', repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev', policy: {} },
        ],
      },
      requireDirectPeerTruth: true,
      refresh: true,
    })

    expect(result.success).toBe(true)
    // More than one git_status dispatch proves the retry actually fired.
    expect(dispatchMeshCommand.mock.calls.length).toBeGreaterThan(1)
    expect(result.sourceOfTruth.directPeerTruth).toMatchObject({
      satisfied: true,
      peerAttemptedCount: 1,
      peerConfirmedCount: 1,
      unavailableNodeIds: [],
    })
  })

  it('reuses a recently-probed peer git_status across refreshes instead of re-probing (cache-age gate)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-probe-reuse-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    let probeCount = 0
    const dispatchMeshCommand = vi.fn(async () => {
      probeCount += 1
      return { status: REMOTE_GIT_STATUS }
    })
    const getMeshPeerConnectionStatus = vi.fn(() => ({ state: 'connected', reported: true }))
    const router = createRouter(dispatchMeshCommand, getMeshPeerConnectionStatus)
    const inlineMesh = {
      id: 'mesh_reuse',
      coordinator: { preferredNodeId: 'node_local' },
      nodes: [
        { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: localRepo, repoRoot: localRepo, policy: {} },
        { id: 'node_slow', daemonId: 'daemon-slow', machineId: 'machine-slow', workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev', repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev', policy: {} },
      ],
    }

    // First explicit refresh probes the peer once and records its truth.
    const first: any = await router.execute('mesh_status', {
      meshId: 'mesh_reuse',
      inlineMesh,
      requireDirectPeerTruth: true,
      refresh: true,
    })
    expect(first.success).toBe(true)
    expect(probeCount).toBe(1)

    // A second refresh seconds later (the dashboard auto-retry loop) must NOT
    // start a fresh refreshUpstream probe — the cache-age gate reuses the
    // recent result, so the storm cannot happen.
    const second: any = await router.execute('mesh_status', {
      meshId: 'mesh_reuse',
      inlineMesh,
      requireDirectPeerTruth: true,
      refresh: true,
    })
    expect(second.success).toBe(true)
    expect(probeCount).toBe(1)
    const remoteNode = second.nodes.find((node: any) => node.nodeId === 'node_slow')
    expect(remoteNode.git).toMatchObject({ branch: 'main', headCommit: 'cafe1234' })
  })

  it('dedups a concurrent bootstrap + per-node probe for the same peer within one refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-probe-dedup-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    // A single explicit refresh runs hydrateInlineMeshDirectTruth AND the
    // per-node render loop, both of which probe the same remote peer. Before the
    // shared probe cache this fired git_status twice per refresh; now the second
    // reuses the first's cached result, so exactly one git_status is dispatched.
    let probeCount = 0
    const dispatchMeshCommand = vi.fn(async () => {
      probeCount += 1
      return { status: REMOTE_GIT_STATUS }
    })
    const getMeshPeerConnectionStatus = vi.fn(() => ({ state: 'connected', reported: true }))
    const router = createRouter(dispatchMeshCommand, getMeshPeerConnectionStatus)

    const result: any = await router.execute('mesh_status', {
      meshId: 'mesh_dedup',
      inlineMesh: {
        id: 'mesh_dedup',
        coordinator: { preferredNodeId: 'node_local' },
        nodes: [
          { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: localRepo, repoRoot: localRepo, policy: {} },
          { id: 'node_slow', daemonId: 'daemon-slow', machineId: 'machine-slow', workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev', repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev', policy: {} },
        ],
      },
      requireDirectPeerTruth: true,
      refresh: true,
    })

    expect(result.success).toBe(true)
    expect(probeCount).toBe(1)
  })

  it('does not probe at all — and marks unavailable — a peer that is definitively down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-probe-disconnected-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    // The peer reports `disconnected` (a definitively-down transport, like a
    // powered-off machine). The probe must be SKIPPED entirely — not even the
    // initial attempt runs — so the mesh graph cold-open never waits the full
    // MESH_DIRECT_PROBE_TIMEOUT_MS window on a dead node. It is still classified
    // unavailable so the explicit-refresh hard-fail is driven exactly as before.
    const dispatchMeshCommand = vi.fn(async () => { throw new Error('timeout') })
    const getMeshPeerConnectionStatus = vi.fn(() => ({ state: 'disconnected', reported: true }))
    const router = createRouter(dispatchMeshCommand, getMeshPeerConnectionStatus)

    // Exercise the mesh_status path, whose explicit-refresh hard-fail is driven
    // by unavailableNodeIds (the browser-facing graph bootstrap).
    const result: any = await router.execute('mesh_status', {
      meshId: 'mesh_disconnected',
      inlineMesh: {
        id: 'mesh_disconnected',
        coordinator: { preferredNodeId: 'node_local' },
        nodes: [
          { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: localRepo, repoRoot: localRepo, policy: {} },
          { id: 'node_down', daemonId: 'daemon-down', machineId: 'machine-down', workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev', repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev', policy: {} },
        ],
      },
      requireDirectPeerTruth: true,
      refresh: true,
    })

    // No probe ran at all (definitively-down peer is skipped before the first
    // attempt) and the peer is classified unavailable — driving the
    // explicit-refresh hard-fail.
    expect(dispatchMeshCommand.mock.calls.length).toBe(0)
    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_direct_peer_truth_unavailable')
    expect(result.sourceOfTruth.directPeerTruth.unavailableNodeIds).toContain('node_down')
  })

  it('does not probe at all — and marks unavailable — an offline peer with no live connection entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-router-probe-offline-'))
    roots.push(root)
    const localRepo = join(root, 'local')
    initRepo(localRepo)

    // A powered-off machine that never established a peer: getMeshPeerConnectionStatus
    // returns null. This is the canonical "node turned off" case — the probe must be
    // skipped entirely (0 dispatches) so the graph cold-open paints immediately, while
    // the node is still classified unavailable on the explicit refresh.
    const dispatchMeshCommand = vi.fn(async () => { throw new Error('timeout') })
    const getMeshPeerConnectionStatus = vi.fn(() => null)
    const router = createRouter(dispatchMeshCommand, getMeshPeerConnectionStatus)

    const result: any = await router.execute('mesh_status', {
      meshId: 'mesh_offline',
      inlineMesh: {
        id: 'mesh_offline',
        coordinator: { preferredNodeId: 'node_local' },
        nodes: [
          { id: 'node_local', daemonId: 'daemon-local', machineId: 'machine-local', workspace: localRepo, repoRoot: localRepo, policy: {} },
          { id: 'node_down', daemonId: 'daemon-down', machineId: 'machine-down', workspace: '/Users/moltbot/.openclaw/workspace/projects/adhdev', repoRoot: '/Users/moltbot/.openclaw/workspace/projects/adhdev', policy: {} },
        ],
      },
      requireDirectPeerTruth: true,
      refresh: true,
    })

    expect(dispatchMeshCommand.mock.calls.length).toBe(0)
    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_direct_peer_truth_unavailable')
    expect(result.sourceOfTruth.directPeerTruth.unavailableNodeIds).toContain('node_down')
  })
})
