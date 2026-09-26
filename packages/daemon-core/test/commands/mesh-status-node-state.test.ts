/**
 * Coordinator-held node state (mesh/mesh-node-git-state.ts): the dashboard's
 * mesh_status is answered from the coordinator's last-known per-node git state
 * immediately; remote freshness happens in the background (member pushes + the
 * coordinator's own stale-state probe), never on the request path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { DaemonCommandRouter } from '../../src/commands/router'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import {
  MeshNodeGitStateStore,
  createDbMeshNodeGitStatePersistence,
  ensureMeshNodeGitStateSchema,
} from '../../src/mesh/mesh-node-git-state'
import { MeshNodeStatePusher } from '../../src/mesh/mesh-node-state-pusher'
import { applyInlineMeshBranchConvergence } from '../../src/mesh/mesh-branch-convergence'
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender'
import { createDefaultGitCommandServices } from '../../src/git/git-commands'

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

const REMOTE_WORKSPACE = '/Users/remote/work/adhdev'
const MESH_ID = 'mesh_node_state'
const REMOTE_NODE = 'node_remote'
const REMOTE_DAEMON = 'daemon_remote'

function remoteGit(overrides: Record<string, unknown> = {}) {
  return {
    isGitRepo: true,
    workspace: REMOTE_WORKSPACE,
    repoRoot: REMOTE_WORKSPACE,
    branch: 'main',
    headCommit: 'abc12345',
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
    stashCount: 0,
    submodules: [
      { path: 'adhdev-providers', commit: 'prov-sha', dirty: false, outOfSync: false },
      { path: 'oss', commit: 'oss-sha', dirty: false, outOfSync: false },
    ],
    ...overrides,
  }
}

function inlineMesh(localRepo: string) {
  return {
    id: MESH_ID,
    name: 'Node state mesh',
    repoIdentity: 'github.com/acme/node-state',
    defaultBranch: 'main',
    coordinator: { preferredNodeId: 'node_local' },
    policy: {},
    nodes: [
      { id: 'node_local', daemonId: 'daemon_local', workspace: localRepo, repoRoot: localRepo, providers: [], policy: {} },
      { id: REMOTE_NODE, daemonId: REMOTE_DAEMON, workspace: REMOTE_WORKSPACE, repoRoot: REMOTE_WORKSPACE, providers: [], policy: {} },
    ],
  }
}

function createRouter(opts: {
  dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>
  onMeshStateChange?: (meshId: string) => void
  store?: MeshNodeGitStateStore
} = {}) {
  return new DaemonCommandRouter({
    commandHandler: {
      handle: vi.fn(async () => ({ success: false })),
      // git-family specs run through the handler with the real git services.
      handleSpec: vi.fn(async (spec: any, args: any) => spec.run(createDefaultGitCommandServices(), args)),
    } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
      getByCategory: () => [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    dispatchMeshCommand: opts.dispatchMeshCommand,
    onMeshStateChange: opts.onMeshStateChange,
    statusInstanceId: 'daemon_local',
    meshNodeGitStateStore: opts.store,
  })
}

function remoteNodeOf(result: any) {
  return result.nodes.find((node: any) => node.nodeId === REMOTE_NODE)
}

async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`did not resolve within ${ms}ms`)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

afterEach(resetMeshRuntimeStore)

describe('mesh_status — coordinator-held node state', () => {
  it('answers an explicit refresh immediately while the remote probe is still in flight (no request-path wait)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-no-wait-')
    try {
      // A peer that never answers (TURN-relayed / dead): the old refresh path
      // waited on it past the dashboard's 30s P2P command deadline.
      const dispatchMeshCommand = vi.fn(() => new Promise<unknown>(() => {}))
      const router = createRouter({ dispatchMeshCommand })

      const result: any = await withinMs(router.execute('mesh_status', {
        meshId: MESH_ID,
        inlineMesh: inlineMesh(repoRoot),
        requireDirectPeerTruth: true,
        refresh: true,
      }), 5_000)

      expect(result.success).toBe(true)
      const remote = remoteNodeOf(result)
      expect(remote.gitProbePending).toBe(true)
      expect(remote.gitObservation).toMatchObject({ source: 'none', observedAt: null, refreshing: true })
      // Kicked exactly once, in the background, carrying the push subscription.
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
      expect(dispatchMeshCommand.mock.calls[0][1]).toBe('git_status')
      expect(dispatchMeshCommand.mock.calls[0][2]).toMatchObject({
        workspace: REMOTE_WORKSPACE,
        meshStateSubscription: { meshId: MESH_ID, nodeId: REMOTE_NODE },
      })
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('renders the held remote git + submodules at once with their age, and does not re-probe a fresh observation', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-held-')
    try {
      const dispatchMeshCommand = vi.fn(async () => { throw new Error('fresh held state must not be re-probed') })
      const store = new MeshNodeGitStateStore()
      const observedAt = Date.now() - 60_000
      store.recordObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: remoteGit(), source: 'member_push', observedAt })
      const router = createRouter({ dispatchMeshCommand, store })

      const result: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })

      expect(result.success).toBe(true)
      const remote = remoteNodeOf(result)
      expect(remote.gitProbePending).toBeUndefined()
      expect(remote.git).toMatchObject({ branch: 'main', headCommit: 'abc12345' })
      expect(remote.git.submodules.map((s: any) => s.path)).toEqual(['adhdev-providers', 'oss'])
      expect(remote.gitObservation).toMatchObject({ source: 'member_push', observedAt, refreshing: false, unreachableSince: null })
      expect(remote.dataFreshness).toMatchObject({ dataSource: 'cached' })
      expect(remote.branchConvergence.status).toBe('merged_to_main')
      // Held truth is not a live peer confirmation.
      expect(remote.connection).toMatchObject({ authority: 'coordinator_node_state', cached: true })
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('background refresh result lands in the store and publishes a mesh-state revision; the next read shows it', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-bg-')
    try {
      let answer: (value: unknown) => void = () => {}
      const dispatchMeshCommand = vi.fn(() => new Promise<unknown>((resolve) => { answer = resolve }))
      const onMeshStateChange = vi.fn()
      const router = createRouter({ dispatchMeshCommand, onMeshStateChange })

      const first: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      expect(remoteNodeOf(first).gitObservation.refreshing).toBe(true)
      expect(onMeshStateChange).not.toHaveBeenCalled()

      answer({ success: true, status: remoteGit({ lastCheckedAt: Date.now() }) })
      await router.meshNodeGitRefresher.whenIdle()
      expect(onMeshStateChange).toHaveBeenCalledWith(MESH_ID)

      const second: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      const remote = remoteNodeOf(second)
      expect(remote.gitObservation).toMatchObject({ source: 'coordinator_probe', refreshing: false })
      expect(remote.git.submodules.map((s: any) => s.path)).toEqual(['adhdev-providers', 'oss'])
      // Fresh → no second probe.
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('an unreachable node keeps its last-known state and reports unreachableSince instead of failing the request', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-unreachable-')
    try {
      const dispatchMeshCommand = vi.fn(async () => { throw new Error('P2P timeout') })
      const store = new MeshNodeGitStateStore()
      const observedAt = Date.now() - 3_600_000 // an hour old → stale → background probe
      store.recordObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: remoteGit(), source: 'member_push', observedAt })
      const router = createRouter({ dispatchMeshCommand, store })

      const first: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      expect(first.success).toBe(true)
      await router.meshNodeGitRefresher.whenIdle()

      const second: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      expect(second.success).toBe(true)
      const remote = remoteNodeOf(second)
      expect(remote.git.submodules).toHaveLength(2)
      expect(remote.gitObservation.observedAt).toBe(observedAt)
      expect(typeof remote.gitObservation.unreachableSince).toBe('number')
      // The failure backoff holds: no immediate re-probe storm.
      expect(dispatchMeshCommand.mock.calls.length).toBeLessThanOrEqual(3)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('unknown git never renders as blocked_review', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-unknown-')
    try {
      const router = createRouter({ dispatchMeshCommand: vi.fn(() => new Promise<unknown>(() => {})) })
      const result: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      const remote = remoteNodeOf(result)
      expect(remote.gitProbePending).toBe(true)
      expect(remote.branchConvergence?.status).not.toBe('blocked_review')
    } finally {
      await cleanupTempDir(dir)
    }
  })
})

describe('branch convergence — unknown vs verdict', () => {
  function classify(git: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const status: Record<string, unknown> = { nodeId: 'n', git, ...extra }
    applyInlineMeshBranchConvergence({ defaultBranch: 'main' }, { id: 'n', workspace: '/remote/x' }, status)
    return status.branchConvergence as Record<string, unknown> | undefined
  }

  it('no git evidence (probe pending) → unknown, no follow-up', () => {
    const convergence = classify({}, { gitProbePending: true })
    expect(convergence).toMatchObject({ status: 'unknown', needsConvergence: false, reason: 'git_status_unavailable' })
  })

  it('skeletal git (no branch, no HEAD) → unknown', () => {
    expect(classify({ isGitRepo: true, workspace: '/remote/x' })).toMatchObject({ status: 'unknown', reason: 'branch_unknown' })
  })

  it('a real isGitRepo:false observation keeps its blocked_review verdict', () => {
    expect(classify({ isGitRepo: false })).toMatchObject({ status: 'blocked_review', reason: 'git_status_unavailable' })
  })

  it('a real detached HEAD (commit known, no branch) keeps blocked_review/branch_unknown', () => {
    expect(classify({ isGitRepo: true, headCommit: 'abc' })).toMatchObject({ status: 'blocked_review', reason: 'branch_unknown' })
  })
})

describe('mesh_node_git_report — member push ingest', () => {
  it('accepts the owning member daemon, records the state and publishes a revision only on change', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-ingest-')
    try {
      const onMeshStateChange = vi.fn()
      const router = createRouter({ dispatchMeshCommand: vi.fn(() => new Promise<unknown>(() => {})), onMeshStateChange })
      // Warm the coordinator's roster for the mesh.
      await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      onMeshStateChange.mockClear()

      const report = (git: Record<string, unknown>) => router.execute('mesh_node_git_report', {
        meshId: MESH_ID,
        nodeId: REMOTE_NODE,
        workspace: REMOTE_WORKSPACE,
        git,
        observedAt: Date.now(),
        [MESH_SENDER_DAEMON_ID_ARG]: REMOTE_DAEMON,
      }, 'mesh') as Promise<any>

      const first = await report(remoteGit())
      expect(first).toMatchObject({ success: true, accepted: true, changed: true })
      expect(onMeshStateChange).toHaveBeenCalledTimes(1)
      expect(router.meshNodeGitState.get(MESH_ID, REMOTE_NODE)).toMatchObject({ source: 'member_push' })

      const heartbeat = await report(remoteGit())
      expect(heartbeat).toMatchObject({ success: true, accepted: true, changed: false })
      expect(onMeshStateChange).toHaveBeenCalledTimes(1)

      const moved = await report(remoteGit({ headCommit: 'def67890', ahead: 1 }))
      expect(moved).toMatchObject({ changed: true })
      expect(onMeshStateChange).toHaveBeenCalledTimes(2)

      const status: any = await router.execute('mesh_status', { meshId: MESH_ID })
      expect(remoteNodeOf(status).git).toMatchObject({ headCommit: 'def67890', ahead: 1 })
      expect(remoteNodeOf(status).gitObservation.source).toBe('member_push')
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('refuses a daemon that does not own the node', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-ingest-refuse-')
    try {
      const router = createRouter({ dispatchMeshCommand: vi.fn(() => new Promise<unknown>(() => {})) })
      await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      const result: any = await router.execute('mesh_node_git_report', {
        meshId: MESH_ID,
        nodeId: REMOTE_NODE,
        workspace: REMOTE_WORKSPACE,
        git: remoteGit(),
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_intruder',
      }, 'mesh')
      expect(result.success).toBe(false)
      expect(result.code).toBe('mesh_sender_not_node_owner')
      // Nothing observed (the warm-up read only started a background probe).
      expect(router.meshNodeGitState.get(MESH_ID, REMOTE_NODE)?.git ?? null).toBeNull()
    } finally {
      await cleanupTempDir(dir)
    }
  })
})

describe('member push subscription', () => {
  it('a coordinator git_status probe carrying meshStateSubscription registers a push subscription', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-subscribe-')
    try {
      const router = createRouter({ dispatchMeshCommand: vi.fn(async () => ({ success: true, accepted: true })) })
      const result: any = await router.execute('git_status', {
        workspace: repoRoot,
        meshStateSubscription: { meshId: MESH_ID, nodeId: 'node_member' },
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_coordinator',
      }, 'mesh')
      expect(result.success).toBe(true)
      expect(router.meshNodeStatePusher.list()).toEqual([
        expect.objectContaining({ coordinatorDaemonId: 'daemon_coordinator', meshId: MESH_ID, nodeId: 'node_member', workspace: repoRoot }),
      ])
      router.meshNodeStatePusher.stop()

      // A dashboard / local git_status never subscribes anyone.
      const plain = createRouter({ dispatchMeshCommand: vi.fn(async () => ({})) })
      await plain.execute('git_status', { workspace: repoRoot, meshStateSubscription: { meshId: MESH_ID, nodeId: 'x' } }, 'p2p')
      expect(plain.meshNodeStatePusher.list()).toEqual([])
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('pushes on change, stays quiet while unchanged, heartbeats, and drops on refusal', async () => {
    let now = 1_000_000
    let git: Record<string, unknown> = remoteGit()
    const dispatch = vi.fn(async () => ({ success: true, accepted: true }))
    const pusher = new MeshNodeStatePusher({
      dispatch,
      readGit: async () => ({ ...git, lastCheckedAt: now }),
      now: () => now,
      heartbeatMs: 300_000,
      ttlMs: 1_800_000,
      startTimer: () => ({ stop() {} }),
    })
    pusher.register({ coordinatorDaemonId: 'coord', meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git })

    now += 60_000
    await pusher.tick()
    expect(dispatch).not.toHaveBeenCalled() // unchanged since the probe answer

    git = remoteGit({ headCommit: 'moved' })
    now += 60_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]).toEqual(['coord', 'mesh_node_git_report', expect.objectContaining({
      meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: expect.objectContaining({ headCommit: 'moved' }),
    })])

    now += 300_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(2) // heartbeat

    dispatch.mockResolvedValueOnce({ success: false, code: 'mesh_sender_not_node_owner' } as any)
    git = remoteGit({ headCommit: 'again' })
    now += 60_000
    await pusher.tick()
    expect(pusher.list()).toEqual([])
  })

  it('lapses when the coordinator never acks within the TTL', async () => {
    let now = 0
    const pusher = new MeshNodeStatePusher({
      dispatch: vi.fn(async () => { throw new Error('unreachable') }),
      readGit: async () => remoteGit({ headCommit: String(now) }),
      now: () => now,
      ttlMs: 600_000,
      startTimer: () => ({ stop() {} }),
    })
    pusher.register({ coordinatorDaemonId: 'coord', meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE })
    now = 300_000
    await pusher.tick()
    expect(pusher.list()).toHaveLength(1)
    now = 700_000
    await pusher.tick()
    expect(pusher.list()).toEqual([])
  })
})

describe('node state persistence', () => {
  it('survives a coordinator restart through the mesh-runtime.db table', () => {
    const db = new Database(':memory:')
    ensureMeshNodeGitStateSchema(db as any)
    const persistence = createDbMeshNodeGitStatePersistence(() => db as any)
    const before = new MeshNodeGitStateStore(persistence)
    before.recordObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: { ...remoteGit(), reporterPlatform: 'win32' }, source: 'member_push', observedAt: 123 })
    before.recordProbeFailure(MESH_ID, 'node_other', '/x', 'P2P timeout', 456)

    const after = new MeshNodeGitStateStore(persistence)
    const entry = after.get(MESH_ID, REMOTE_NODE)!
    expect(entry).toMatchObject({ source: 'member_push', observedAt: 123 })
    expect((entry.git as any).submodules).toHaveLength(2)
    expect(entry.git).not.toHaveProperty('reporterPlatform')
    expect(after.get(MESH_ID, 'node_other')).toMatchObject({ unreachableSince: 456, lastFailureReason: 'P2P timeout' })
    db.close()
  })
})
