/**
 * Coordinator-held node state (mesh/mesh-node-git-state.ts): the dashboard's
 * mesh_status is answered from the coordinator's last-known per-node git state
 * immediately; remote freshness comes from member pushes only — the coordinator
 * never reads a member, it only asks one to push (nudge), never on the request path.
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
import { MeshNodeGitRefresher, MESH_NODE_STATE_STALE_MS } from '../../src/mesh/mesh-node-git-refresher'
import { kickMeshNodeGitRefreshes } from '../../src/commands/high-family/mesh-status-node-state'
import { applyInlineMeshBranchConvergence } from '../../src/mesh/mesh-branch-convergence'
import { MESH_SENDER_DAEMON_ID_ARG } from '../../src/commands/mesh-sender'
import { createDefaultGitCommandServices } from '../../src/git/git-commands'
// End-to-end with the dashboard's own normalizer + graph + badge (web-core source;
// type-only imports of daemon-core there, so no daemon barrel is pulled in).
import { extractRepoMeshStatus } from '../../../web-core/src/utils/repo-mesh-status'
import { buildMeshGraph } from '../../../web-core/src/utils/mesh-visualization'
import { getMeshGraphAttentionBadge } from '../../../web-core/src/components/MeshGraph/meshGraphViewModel'

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
  statusInstanceId?: string
  instanceStates?: any[]
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
      collectAllStates: () => opts.instanceStates ?? [],
      listInstanceIds: () => [],
      getInstance: () => null,
      getByCategory: () => [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    dispatchMeshCommand: opts.dispatchMeshCommand,
    onMeshStateChange: opts.onMeshStateChange,
    statusInstanceId: opts.statusInstanceId ?? 'daemon_local',
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
  it('answers an explicit refresh immediately while the first-contact nudge is still in flight (no request-path wait)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-no-wait-')
    try {
      // A peer that never answers (TURN-relayed / dead).
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
      expect(remote.heldRuntime).toMatchObject({ source: 'none', refreshing: true, sessions: [] })
      // ONE message to the member — the nudge (with the workspace it subscribes) — never a read.
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
      expect(dispatchMeshCommand.mock.calls[0]).toEqual([REMOTE_DAEMON, 'mesh_node_state_nudge', { meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE }])
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
      store.recordRuntimeObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, runtime: { sessions: [] }, source: 'member_push', observedAt })
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

  it("the member's push (answering the first-contact nudge) lands in the store and publishes a revision; the next read shows it", async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-bg-')
    try {
      const dispatchMeshCommand = vi.fn(async (_daemonId: string, cmd: string) => cmd === 'mesh_node_state_nudge'
        ? { success: true, subscribed: true }
        : { success: false })
      const onMeshStateChange = vi.fn()
      const router = createRouter({ dispatchMeshCommand, onMeshStateChange })

      const first: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      expect(remoteNodeOf(first).gitProbePending).toBe(true)
      await router.meshNodeGitRefresher.whenIdle()
      expect(onMeshStateChange).not.toHaveBeenCalled()

      const pushed: any = await router.execute('mesh_node_git_report', {
        meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE,
        git: remoteGit({ lastCheckedAt: Date.now() }), observedAt: Date.now(),
        runtime: { sessions: [] }, runtimeObservedAt: Date.now(),
        [MESH_SENDER_DAEMON_ID_ARG]: REMOTE_DAEMON,
      }, 'mesh')
      expect(pushed).toMatchObject({ success: true, accepted: true, changed: true })
      expect(onMeshStateChange).toHaveBeenCalledWith(MESH_ID)

      const second: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      const remote = remoteNodeOf(second)
      expect(remote.gitObservation).toMatchObject({ source: 'member_push', refreshing: false })
      expect(remote.git.submodules.map((s: any) => s.path)).toEqual(['adhdev-providers', 'oss'])
      expect(remote.heldRuntime).toMatchObject({ source: 'member_push', sessions: [] })
      // Held → no second message; the only thing ever sent was the nudge.
      expect(dispatchMeshCommand.mock.calls.map((call: any) => call[1])).toEqual(['mesh_node_state_nudge'])
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('an unreachable node keeps its last-known state and reports unreachableSince instead of failing the request', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-unreachable-')
    try {
      const dispatchMeshCommand = vi.fn(async () => { throw new Error('P2P timeout') })
      const store = new MeshNodeGitStateStore()
      const observedAt = Date.now() - 3_600_000 // an hour old
      store.recordObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: remoteGit(), source: 'member_push', observedAt })
      const router = createRouter({ dispatchMeshCommand, store })

      // An explicit refresh nudges the member; it is unreachable.
      const first: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot), refresh: true })
      expect(first.success).toBe(true)
      await router.meshNodeGitRefresher.whenIdle()

      const second: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      expect(second.success).toBe(true)
      const remote = remoteNodeOf(second)
      expect(remote.git.submodules).toHaveLength(2)
      expect(remote.gitObservation.observedAt).toBe(observedAt)
      expect(typeof remote.gitObservation.unreachableSince).toBe('number')
      // A default read never nudges a node it already holds state for; nothing is ever read from it.
      expect(dispatchMeshCommand.mock.calls.map((call: any) => call[1])).toEqual(['mesh_node_state_nudge'])
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

describe('store-served remote node — dashboard and MCP agree (rc.56 live regression)', () => {
  it('a clean main whose latest push was read without an upstream fetch stays merged_to_main end to end (no BLOCKED REVIEW)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-e2e-')
    try {
      const store = new MeshNodeGitStateStore()
      const now = Date.now()
      // 1. The coordinator probe (refreshUpstream:true) verified the upstream a minute ago.
      store.recordObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: remoteGit({ upstreamFetchedAt: now - 60_000, lastCheckedAt: now - 60_000 }), source: 'coordinator_probe', observedAt: now - 60_000 })
      const router = createRouter({ dispatchMeshCommand: vi.fn(() => new Promise<unknown>(() => {})), store })
      await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: inlineMesh(repoRoot) })
      // 2. The member then pushes a between-refresh read: same main/HEAD, upstream 'unchecked'.
      const pushed: any = await router.execute('mesh_node_git_report', {
        meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE,
        git: remoteGit({ upstreamStatus: 'unchecked', lastCheckedAt: now }), observedAt: now,
        [MESH_SENDER_DAEMON_ID_ARG]: REMOTE_DAEMON,
      }, 'mesh')
      expect(pushed).toMatchObject({ success: true, accepted: true, changed: false })

      // 3. The exact dashboard command shape (cloud loader, settled refresh) over P2P.
      const response: any = await router.execute('mesh_status', { meshId: MESH_ID, requireDirectPeerTruth: true, refresh: true }, 'p2p')
      const remote = remoteNodeOf(response)
      expect(remote.git.upstreamStatus).toBe('fresh')
      expect(remote.branchConvergence).toMatchObject({ status: 'merged_to_main', reason: 'clean_default_branch' })

      // 4. Through the dashboard normalizer → graph → attention badge.
      const status = extractRepoMeshStatus({ success: true, result: response } as any)!
      const graphNode = buildMeshGraph(status).nodes.find(node => node.id === REMOTE_NODE)!
      expect(graphNode.branchConvergence?.status).toBe('merged_to_main')
      expect(getMeshGraphAttentionBadge(graphNode)).toBeNull()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('the member pusher reports the verified freshness between upstream refreshes (no fresh↔unchecked churn)', async () => {
    let now = 1_000_000
    let refreshed: boolean[] = []
    const dispatch = vi.fn(async () => ({ success: true, accepted: true }))
    const pusher = new MeshNodeStatePusher({
      dispatch,
      readGit: async (_ws, opts) => {
        refreshed.push(opts.refreshUpstream)
        return opts.refreshUpstream
          ? remoteGit({ upstreamStatus: 'fresh', upstreamFetchedAt: now, headCommit: 'h2' })
          : remoteGit({ upstreamStatus: 'unchecked', headCommit: 'h2' })
      },
      now: () => now,
      startTimer: () => ({ stop() {} }),
    })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE })
    await pusher.tick() // first push verifies the upstream
    expect(refreshed).toEqual([true])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect((dispatch.mock.calls[0] as any)[2].git).toMatchObject({ headCommit: 'h2', upstreamStatus: 'fresh' })
    now += 60_000
    await pusher.tick() // no upstream refresh this tick: the read says 'unchecked'
    expect(refreshed).toEqual([true, false])
    expect(dispatch).toHaveBeenCalledTimes(1) // verified freshness carried → unchanged → quiet (no churn)
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

describe('mesh_node_git_report — held runtime (sessions / build / quota)', () => {
  const runtime = {
    daemonId: REMOTE_DAEMON,
    daemonBuild: { commit: 'abcdef0123456789', commitShort: 'abcdef0', version: '1.0.60-rc.2', track: 'preview' },
    sessions: [{ id: 'sess-r1', providerType: 'claude-cli', status: 'generating', lastMessagePreview: 'PRIVATE CHAT TEXT', title: 'PRIVATE TITLE' }],
    nodeFacts: { schemaVersion: 1, reportedAt: Date.now(), quota: { 'claude-cli': { status: 'ok', windows: [{ usedPercent: 42 }] } } },
  }

  it('ingests a runtime-only push from the owner, re-applies the allow-list, and mesh_status answers it for the remote node', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-runtime-ingest-')
    try {
      const onMeshStateChange = vi.fn()
      const router = createRouter({ dispatchMeshCommand: vi.fn(() => new Promise<unknown>(() => {})), onMeshStateChange })
      const mesh = inlineMesh(repoRoot)
      // A worktree node served by the same member daemon (runtime is daemon-wide).
      mesh.nodes.push({ id: 'node_remote_wt', daemonId: REMOTE_DAEMON, workspace: `${REMOTE_WORKSPACE}-wt`, repoRoot: `${REMOTE_WORKSPACE}-wt`, providers: [], policy: {} })
      await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: mesh })
      onMeshStateChange.mockClear()

      const pushed: any = await router.execute('mesh_node_git_report', {
        meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, runtime, runtimeObservedAt: Date.now(),
        [MESH_SENDER_DAEMON_ID_ARG]: REMOTE_DAEMON,
      }, 'mesh')
      expect(pushed).toMatchObject({ success: true, accepted: true, changed: false, runtimeChanged: true })
      // Quota changed → one revision (dashboards render it); no aggregate rebuild needed.
      expect(onMeshStateChange).toHaveBeenCalledTimes(1)

      const status: any = await router.execute('mesh_status', { meshId: MESH_ID }, 'p2p')
      expect(status.nodeRuntimeHeld).toBe(true)
      const remote = remoteNodeOf(status)
      expect(remote.heldRuntime).toMatchObject({ source: 'member_push', daemonId: REMOTE_DAEMON, daemonBuild: { commitShort: 'abcdef0', track: 'preview' } })
      expect(remote.heldRuntime.sessions).toEqual([{ id: 'sess-r1', providerType: 'claude-cli', status: 'generating' }])
      expect(remote.nodeFacts.quota['claude-cli'].windows[0].usedPercent).toBe(42)
      expect(JSON.stringify(status)).not.toContain('PRIVATE')
      // The sibling worktree node of the same daemon holds the same runtime (no extra probe needed).
      expect(status.nodes.find((node: any) => node.nodeId === 'node_remote_wt').heldRuntime).toMatchObject({ source: 'member_push', sessions: [{ id: 'sess-r1' }] })
      // The coordinator's own node is read directly, never stamped from held state.
      expect(status.nodes.find((node: any) => node.nodeId === 'node_local').heldRuntime).toBeUndefined()

      const intruder: any = await router.execute('mesh_node_git_report', {
        meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, runtime: { ...runtime, sessions: [] },
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_intruder',
      }, 'mesh')
      expect(intruder).toMatchObject({ success: false, code: 'mesh_sender_not_node_owner' })
      expect(router.meshNodeGitState.get(MESH_ID, REMOTE_NODE)!.runtime!.sessions).toHaveLength(1)
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it("the router's member pusher reads this daemon's runtime in-process and pushes it to the subscribing coordinator", async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-runtime-member-')
    try {
      const dispatch = vi.fn(async () => ({ success: true, accepted: true }))
      const router = createRouter({ dispatchMeshCommand: dispatch })
      const nudged: any = await router.execute('mesh_node_state_nudge', {
        meshId: MESH_ID, nodeId: 'node_member', workspace: repoRoot,
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_coordinator',
      }, 'mesh')
      expect(nudged).toMatchObject({ success: true, subscribed: true })
      await vi.waitFor(() => expect(dispatch.mock.calls.some((call: any) => call[1] === 'mesh_node_git_report')).toBe(true))
      router.meshNodeStatePusher.stop()
      const report = dispatch.mock.calls.find((call: any) => call[1] === 'mesh_node_git_report') as any
      expect(report[0]).toBe('daemon_coordinator')
      expect(report[2]).toMatchObject({ meshId: MESH_ID, nodeId: 'node_member', runtime: { daemonId: 'daemon_local', sessions: [] } })
      expect(report[2].git).toMatchObject({ isGitRepo: true })
    } finally {
      await cleanupTempDir(dir)
    }
  })
})

describe('held runtime — member daemon → coordinator daemon, end to end', () => {
  it("a member's session change reaches the coordinator's mesh_status without the coordinator asking", async () => {
    const coordRepo = await createTempGitRepo('node-runtime-e2e-coord-')
    const memberRepo = await createTempGitRepo('node-runtime-e2e-member-')
    try {
      const memberStates: any[] = []
      let coordinator!: DaemonCommandRouter
      // member → coordinator: the mesh channel stamps the authenticated sender.
      const memberDispatch = vi.fn(async (_daemonId: string, cmd: string, args: Record<string, unknown>) =>
        coordinator.execute(cmd, { ...args, [MESH_SENDER_DAEMON_ID_ARG]: REMOTE_DAEMON }, 'mesh'))
      const member = createRouter({ dispatchMeshCommand: memberDispatch, statusInstanceId: REMOTE_DAEMON, instanceStates: memberStates })
      const coordDispatch = vi.fn(() => new Promise<unknown>(() => {})) // the coordinator never gets an answer from the peer
      coordinator = createRouter({ dispatchMeshCommand: coordDispatch })
      const mesh = inlineMesh(coordRepo.repoRoot)
      mesh.nodes[1] = { ...mesh.nodes[1], workspace: memberRepo.repoRoot, repoRoot: memberRepo.repoRoot }
      await coordinator.execute('mesh_status', { meshId: MESH_ID, inlineMesh: mesh })

      // The coordinator's first-contact nudge reaches the member → push subscription + first push.
      await member.execute('mesh_node_state_nudge', {
        meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: memberRepo.repoRoot,
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_local',
      }, 'mesh')
      await vi.waitFor(() => expect(memberDispatch).toHaveBeenCalled())
      await member.meshNodeStatePusher.pushRuntimeChanges()

      // A worker session starts generating on the member (a lifecycle fact).
      memberStates.push({ category: 'cli', type: 'claude-cli', instanceId: 'sess-worker-1', status: 'generating', settings: {}, activeChat: { messages: [{ role: 'assistant', content: 'PRIVATE WORK' }] } })
      member.meshNodeStatePusher.noteRuntimeChanged()
      await member.meshNodeStatePusher.pushRuntimeChanges()
      member.meshNodeStatePusher.stop()

      const startedAt = Date.now()
      const status: any = await coordinator.execute('mesh_status', { meshId: MESH_ID }, 'p2p')
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      const remote = remoteNodeOf(status)
      expect(remote.heldRuntime).toMatchObject({ source: 'member_push', daemonId: REMOTE_DAEMON })
      expect(remote.heldRuntime.sessions.map((s: any) => [s.id, s.status])).toEqual([['sess-worker-1', 'generating']])
      expect(JSON.stringify(status)).not.toContain('PRIVATE WORK')
      // The coordinator only ever NUDGED the member (never read it), and awaited nothing for this answer.
      expect(coordDispatch.mock.calls.every((call: any) => call[1] === 'mesh_node_state_nudge')).toBe(true)
    } finally {
      await cleanupTempDir(coordRepo.dir)
      await cleanupTempDir(memberRepo.dir)
    }
  })
})

describe('member push subscription', () => {
  it("a coordinator's nudge carrying the workspace registers a push subscription; a git_status never does", async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-subscribe-')
    try {
      const router = createRouter({ dispatchMeshCommand: vi.fn(async () => ({ success: true, accepted: true })) })
      const result: any = await router.execute('mesh_node_state_nudge', {
        meshId: MESH_ID, nodeId: 'node_member', workspace: repoRoot,
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_coordinator',
      }, 'mesh')
      expect(result).toMatchObject({ success: true, subscribed: true })
      expect(router.meshNodeStatePusher.list()).toEqual([
        expect.objectContaining({ coordinatorDaemonId: 'daemon_coordinator', meshId: MESH_ID, nodeId: 'node_member', workspace: repoRoot }),
      ])
      router.meshNodeStatePusher.stop()

      // A workspace that is not on this machine is refused (never subscribed).
      const refused: any = await router.execute('mesh_node_state_nudge', {
        meshId: MESH_ID, nodeId: 'node_elsewhere', workspace: '/definitely/not/here',
        [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_coordinator',
      }, 'mesh')
      expect(refused).toMatchObject({ success: true, subscribed: false })

      // A (mesh-relayed) git_status never subscribes anyone — the probe path is gone.
      const plain = createRouter({ dispatchMeshCommand: vi.fn(async () => ({})) })
      await plain.execute('git_status', { workspace: repoRoot, meshStateSubscription: { meshId: MESH_ID, nodeId: 'x' }, [MESH_SENDER_DAEMON_ID_ARG]: 'daemon_coordinator' }, 'mesh')
      expect(plain.meshNodeStatePusher.list()).toEqual([])
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('pushes on change, stays quiet while unchanged, heartbeats, and drops on refusal', async () => {
    let now = 1_000_000
    let git: Record<string, unknown> = remoteGit()
    // A coordinator that holds what it was sent confirms a signature-only git report.
    const dispatch = vi.fn(async (_d: string, _c: string, args: any) => ({ success: true, accepted: true, ...(args?.gitSignature ? { gitHeld: true } : {}) }))
    const pusher = new MeshNodeStatePusher({
      dispatch,
      readGit: async () => ({ ...git, lastCheckedAt: now }),
      now: () => now,
      heartbeatMs: 300_000,
      ttlMs: 1_800_000,
      startTimer: () => ({ stop() {} }),
    })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE })

    now += 60_000
    await pusher.tick()
    // The first tick after registering pushes the full state once.
    expect(dispatch).toHaveBeenCalledTimes(1)
    now += 60_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(1) // unchanged since that push

    git = remoteGit({ headCommit: 'moved' })
    now += 60_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]).toEqual(['coord', 'mesh_node_git_report', expect.objectContaining({
      meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: expect.objectContaining({ headCommit: 'moved' }),
    })])

    now += 300_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(3) // heartbeat — the unchanged git as its signature only
    expect(dispatch.mock.calls[2]![2]).not.toHaveProperty('git')
    expect(dispatch.mock.calls[2]![2]).toMatchObject({ gitSignature: expect.any(String) })

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
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE })
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

// ★Regression (audit item 1 / data-path audit P1-2): a quiet subscribed member is
// never read by the coordinator — its heartbeat keeps the held observation live,
// and nothing on the coordinator side re-probes on a cadence.
describe('held-state freshness — a quiet subscribed member is never re-probed', () => {
  it('member heartbeats keep the held observation live across 20 minutes of silence, with zero coordinator messages', async () => {
    let now = 1_000_000
    const store = new MeshNodeGitStateStore(null, () => now)
    const nudge = vi.fn(async () => true)
    const refresher = new MeshNodeGitRefresher({ store, nudge, onSettled: vi.fn(), now: () => now })
    const pusher = new MeshNodeStatePusher({
      // The coordinator side of mesh_node_git_report, reduced to the store write.
      dispatch: async (_coordinator, _cmd, args: any) => {
        if (args.git) store.recordObservation({ meshId: args.meshId, nodeId: args.nodeId, workspace: args.workspace, git: args.git, source: 'member_push', observedAt: args.observedAt })
        const gitHeld = args.gitSignature
          ? store.confirmObservation({ meshId: args.meshId, nodeId: args.nodeId, signature: args.gitSignature, observedAt: args.observedAt, upstreamFetchedAt: args.upstreamFetchedAt }).held
          : undefined
        return { success: true, accepted: true, ...(gitHeld !== undefined ? { gitHeld } : {}) }
      },
      readGit: async () => ({ ...remoteGit(), lastCheckedAt: now }),
      now: () => now,
      startTimer: () => ({ stop() {} }),
    })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE })
    const mesh = { nodes: [{ id: REMOTE_NODE, daemonId: REMOTE_DAEMON, workspace: REMOTE_WORKSPACE }] }
    for (let minute = 1; minute <= 20; minute += 1) {
      now += 60_000
      await pusher.tick()
      const entry = store.get(MESH_ID, REMOTE_NODE)!
      expect(now - (entry.observedAt ?? 0), `minute ${minute}`).toBeLessThan(MESH_NODE_STATE_STALE_MS)
      kickMeshNodeGitRefreshes({ meshId: MESH_ID, mesh, store, refresher, locality: { localDaemonId: 'daemon_local' }, refresh: false, now })
    }
    expect(nudge).not.toHaveBeenCalled()
    expect(store.get(MESH_ID, REMOTE_NODE)?.source).toBe('member_push')
    pusher.stop()
  })

  it('a nudge outcome publishes a revision only on the transition into unreachable', async () => {
    let now = 9_000_000
    const store = new MeshNodeGitStateStore(null, () => now)
    const onSettled = vi.fn()
    let reachable = true
    const refresher = new MeshNodeGitRefresher({
      store,
      nudge: async () => { if (!reachable) throw new Error('unreachable'); return true },
      onSettled,
      now: () => now,
    })
    const target = { meshId: MESH_ID, nodeId: REMOTE_NODE, daemonId: REMOTE_DAEMON, workspace: REMOTE_WORKSPACE }
    store.recordObservation({ ...target, git: remoteGit(), source: 'member_push', observedAt: now - 3_600_000 })

    expect(refresher.nudge(target)).toBe(true)
    await refresher.whenIdle()
    expect(onSettled).not.toHaveBeenCalled() // the member's push settles what changed

    now += 60_000
    reachable = false
    refresher.nudge(target)
    await refresher.whenIdle()
    expect(onSettled).toHaveBeenCalledTimes(1) // into unreachable
    now += 60_000
    refresher.nudge(target)
    await refresher.whenIdle()
    expect(onSettled).toHaveBeenCalledTimes(1) // still unreachable — no news
    // A nudge within the minimum interval is never sent twice.
    expect(refresher.nudge(target)).toBe(false)
  })
})

// ★Regression (audit item 5): a node served by another daemon rendered its
// active sessions / git from the dashboard-echoed inline `cachedStatus`. The
// coordinator-held runtime (member push) is the only source now.
describe('foreign-daemon node — sessions / facts from the held runtime only', () => {
  function echoingMesh(localRepo: string) {
    const mesh: any = inlineMesh(localRepo)
    mesh.nodes[1] = {
      ...mesh.nodes[1],
      cachedStatus: {
        machineStatus: 'online',
        health: 'online',
        activeSession: { id: 'echo-sess', providerType: 'claude-cli', status: 'generating' },
        git: { isGitRepo: true, branch: 'echo-branch', headCommit: 'e0e0e0e0' },
      },
    }
    return mesh
  }

  it('renders activeSessions / details, version chips and the provider catalog from the member push, never the echo', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-held-sessions-')
    try {
      const now = Date.now()
      const store = new MeshNodeGitStateStore()
      store.recordObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, git: remoteGit(), source: 'member_push', observedAt: now })
      store.recordRuntimeObservation({
        meshId: MESH_ID,
        nodeId: REMOTE_NODE,
        workspace: REMOTE_WORKSPACE,
        source: 'member_push',
        observedAt: now,
        runtime: {
          sessions: [
            { id: 'held-sess', providerType: 'codex-cli', status: 'generating', turn: { attemptId: 'att-1', stage: 'generating' }, settings: { meshNodeFor: MESH_ID, meshNodeId: REMOTE_NODE } },
            { id: 'unrelated-sess', providerType: 'codex-cli', status: 'idle' },
          ],
          nodeFacts: { schemaVersion: 1, reportedAt: now, providerVersions: { 'codex-cli': '0.55.0' }, daemonBuild: { version: '1.0.61-rc.9' }, platform: 'linux' },
          providers: [{ type: 'codex-cli', category: 'cli', installed: true, enabled: true, version: '0.55.0', autoApproveModes: { default: 'ask', modes: [{ id: 'ask', label: 'Ask', strategy: 'none', risk: 'low' }, { id: 'yolo', label: 'Full auto', strategy: 'launch_args', risk: 'high', launchArgs: ['--yolo'] }] } }],
        },
      })
      const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
      const router = createRouter({ dispatchMeshCommand, store })

      const result: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: echoingMesh(repoRoot) })
      const remote = remoteNodeOf(result)
      expect(remote.activeSessions).toEqual(['held-sess'])
      expect(remote.activeSessionDetails).toEqual([expect.objectContaining({ sessionId: 'held-sess', providerType: 'codex-cli', state: 'generating', attemptId: 'att-1', isCached: true })])
      expect(JSON.stringify(remote.activeSessionDetails)).not.toContain('echo-sess')
      expect(remote.git).toMatchObject({ branch: 'main', headCommit: 'abc12345' })
      expect(remote.providerVersions).toEqual({ 'codex-cli': '0.55.0' })
      expect(remote.daemonBuildVersion).toBe('1.0.61-rc.9')
      expect(remote.heldRuntime.providers).toEqual([expect.objectContaining({ type: 'codex-cli', installed: true, version: '0.55.0', autoApproveModes: { default: 'ask', modes: [expect.objectContaining({ id: 'ask' }), expect.objectContaining({ id: 'yolo', risk: 'high' })] } })])
      // Launch args are not part of the held catalog.
      expect(JSON.stringify(remote.heldRuntime.providers)).not.toContain('--yolo')
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
    } finally {
      await cleanupTempDir(dir)
    }
  })

  it('with nothing held, an echoed session / git is NOT rendered as truth (sessions unknown, git pending)', async () => {
    const { dir, repoRoot } = await createTempGitRepo('node-state-no-held-')
    try {
      const router = createRouter({ dispatchMeshCommand: vi.fn(() => new Promise<unknown>(() => {})) })
      const result: any = await router.execute('mesh_status', { meshId: MESH_ID, inlineMesh: echoingMesh(repoRoot) })
      const remote = remoteNodeOf(result)
      expect(remote.activeSessions).toEqual([])
      expect(remote.activeSessionDetails).toEqual([])
      expect(remote.heldRuntime).toMatchObject({ source: 'none', sessions: [] })
      expect(remote.git?.branch).not.toBe('echo-branch')
      expect(remote.gitProbePending).toBe(true)
    } finally {
      await cleanupTempDir(dir)
    }
  })
})

describe('held runtime — owner resolution and the requeue guard', () => {
  it('resolves a remote session owner from the held runtime alone (no aggregate snapshot, no echoed session)', async () => {
    const store = new MeshNodeGitStateStore()
    store.recordRuntimeObservation({
      meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, source: 'member_push', observedAt: Date.now(), daemonId: REMOTE_DAEMON,
      runtime: { sessions: [{ id: 'held-only-sess', providerType: 'codex-cli', status: 'generating' }] },
    })
    const router = createRouter({ dispatchMeshCommand: vi.fn(async () => ({ success: true })), store })
    await router.execute('get_mesh', { meshId: MESH_ID, inlineMesh: inlineMesh('/tmp/adhdev-node-state-no-local') })
    expect(router.resolveRemoteMeshSessionOwnerDaemonId('held-only-sess')).toBe(REMOTE_DAEMON)
    expect(router.resolveRemoteMeshSessionOwnerDaemonId('unknown-sess')).toBeUndefined()
  })

  it('isHeldRemoteSessionGenerating trusts a live member push only', async () => {
    const { isHeldRemoteSessionGenerating } = await import('../../src/mesh/mesh-candidacy-predicates')
    const now = 7_000_000
    const store = new MeshNodeGitStateStore(null, () => now)
    store.recordRuntimeObservation({ meshId: MESH_ID, nodeId: REMOTE_NODE, workspace: REMOTE_WORKSPACE, source: 'member_push', observedAt: now - 30_000, runtime: { sessions: [{ id: 'busy', status: 'generating' }, { id: 'idle', status: 'idle' }] } })
    store.recordRuntimeObservation({ meshId: MESH_ID, nodeId: 'node_probe_only', workspace: '/w', source: 'coordinator_probe', observedAt: now - 1_000, runtime: { sessions: [{ id: 'probed-busy', status: 'generating' }] } })
    expect(isHeldRemoteSessionGenerating(store, MESH_ID, 'busy', now)).toBe(true)
    expect(isHeldRemoteSessionGenerating(store, MESH_ID, 'idle', now)).toBe(false)
    expect(isHeldRemoteSessionGenerating(store, MESH_ID, 'probed-busy', now)).toBe(false)
    expect(isHeldRemoteSessionGenerating(store, 'other_mesh', 'busy', now)).toBe(false)
  })
})
