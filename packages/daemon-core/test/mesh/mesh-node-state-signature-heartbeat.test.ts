/**
 * Member → coordinator git push is proportional to change (data-path audit
 * 2026-09-29, owner principle ②): the 300 s heartbeat over an UNCHANGED
 * checkout carries only the git signature (+ the upstream fetch stamp), never
 * the body. The coordinator confirms it against what it holds (`gitHeld`); a
 * coordinator that does not hold it gets the body at once, from the SAME read.
 *
 * Also: the member's git-dir change detector — a watched workspace is not
 * re-read on the check tick (no git spawn when nothing moved); a detector
 * callback re-reads and pushes; this daemon's own read never re-triggers.
 */
import { describe, expect, it, vi } from 'vitest'
import { MeshNodeStatePusher, MESH_NODE_STATE_SELF_READ_QUIET_MS } from '../../src/mesh/mesh-node-state-pusher'
import { MeshNodeGitStateStore, computeMeshNodeGitSignature, digestMeshNodeStateSignature } from '../../src/mesh/mesh-node-git-state'
import { meshNodeStateHandlers } from '../../src/commands/high-family/mesh-node-state'

const MESH = 'mesh_sig'
const NODE = 'node_member'
const WS = '/Users/member/work/repo'

function git(overrides: Record<string, unknown> = {}) {
  return {
    isGitRepo: true, branch: 'main', headCommit: 'h1', upstream: 'origin/main', upstreamStatus: 'fresh',
    ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, deleted: 0, renamed: 0, hasConflicts: false, stashCount: 0,
    submodules: [{ path: 'oss', commit: 'oss-sha', dirty: false, outOfSync: false }],
    ...overrides,
  }
}

/** A coordinator reduced to its store + the report handler's git half. */
function fakeCoordinator(store: MeshNodeGitStateStore) {
  return vi.fn(async (_coord: string, _cmd: string, args: any) => {
    if (args.git) store.recordObservation({ meshId: args.meshId, nodeId: args.nodeId, workspace: args.workspace, git: args.git, source: 'member_push', observedAt: args.observedAt })
    const gitHeld = args.gitSignature
      ? store.confirmObservation({ meshId: args.meshId, nodeId: args.nodeId, signature: args.gitSignature, observedAt: args.observedAt, upstreamFetchedAt: args.upstreamFetchedAt }).held
      : undefined
    return { success: true, accepted: true, ...(gitHeld !== undefined ? { gitHeld } : {}) }
  })
}

describe('signature-only git heartbeat', () => {
  it('an unchanged heartbeat sends only the signature (+ upstream stamp) and renews the held observation', async () => {
    let now = 5_000_000
    const store = new MeshNodeGitStateStore(null, () => now)
    const dispatch = fakeCoordinator(store)
    const readGit = vi.fn(async () => ({ ...git({ upstreamFetchedAt: now }), lastCheckedAt: now }))
    const pusher = new MeshNodeStatePusher({ dispatch, readGit, now: () => now, heartbeatMs: 300_000, startTimer: () => ({ stop() {} }) })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH, nodeId: NODE, workspace: WS })

    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const first = dispatch.mock.calls[0]![2]
    expect(first.git).toMatchObject({ headCommit: 'h1' })
    expect(first.gitSignature).toBeUndefined()

    now += 300_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(2)
    const heartbeat = dispatch.mock.calls[1]![2]
    expect(heartbeat).not.toHaveProperty('git')
    expect(heartbeat.gitSignature).toBe(digestMeshNodeStateSignature(computeMeshNodeGitSignature(git())))
    expect(heartbeat.gitSignature).toHaveLength(32)
    expect(heartbeat.upstreamFetchedAt).toBe(now)
    // Measured: the heartbeat is a fraction of the full report.
    const full = JSON.stringify(first).length
    const sig = JSON.stringify(heartbeat).length
    expect(sig).toBeLessThan(full / 2)
    // The coordinator's observation age and the auto-ff upstream stamp moved forward.
    const held = store.get(MESH, NODE)!
    expect(held.observedAt).toBe(now)
    expect(held.git!.upstreamFetchedAt).toBe(now)
    expect(held.git!.headCommit).toBe('h1')
    pusher.stop()
  })

  it('a coordinator that does not hold the state (gitHeld:false / older coordinator) gets the body at once from the SAME read', async () => {
    let now = 6_000_000
    const readGit = vi.fn(async () => ({ ...git(), lastCheckedAt: now }))
    const dispatch = vi.fn(async (_c: string, _cmd: string, args: any) => ({ success: true, accepted: true, ...(args.gitSignature ? { gitHeld: true } : {}) }))
    const pusher = new MeshNodeStatePusher({ dispatch, readGit, now: () => now, heartbeatMs: 300_000, startTimer: () => ({ stop() {} }) })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH, nodeId: NODE, workspace: WS })
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(1)

    // The coordinator restarted without the row.
    dispatch.mockImplementationOnce(async () => ({ success: true, accepted: true, gitHeld: false }))
    now += 300_000
    const readsBefore = readGit.mock.calls.length
    await pusher.tick()
    expect(readGit.mock.calls.length - readsBefore).toBe(1)
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(dispatch.mock.calls[1]![2]).toHaveProperty('gitSignature')
    expect(dispatch.mock.calls[2]![2].git).toMatchObject({ headCommit: 'h1' })

    // An older coordinator refuses a body-less report ("git status required").
    dispatch.mockImplementationOnce(async () => ({ success: false, error: 'git status required' }) as any)
    now += 300_000
    await pusher.tick()
    expect(dispatch).toHaveBeenCalledTimes(5)
    expect(dispatch.mock.calls[4]![2].git).toMatchObject({ headCommit: 'h1' })
    pusher.stop()
  })

  it('store.confirmObservation: matches only the held member-pushed signature; a pending restart is not confirmed by git', () => {
    let now = 1_000
    const store = new MeshNodeGitStateStore(null, () => now)
    const sig = digestMeshNodeStateSignature(computeMeshNodeGitSignature(git()))
    expect(store.confirmObservation({ meshId: MESH, nodeId: NODE, signature: sig })).toEqual({ held: false, changed: false })
    store.recordObservation({ meshId: MESH, nodeId: NODE, workspace: WS, git: git(), source: 'member_push', observedAt: 900 })
    now = 2_000
    expect(store.confirmObservation({ meshId: MESH, nodeId: NODE, signature: 'other' }).held).toBe(false)
    // Only the digest names the held git (the raw signature form is not accepted).
    expect(store.confirmObservation({ meshId: MESH, nodeId: NODE, signature: computeMeshNodeGitSignature(git()) }).held).toBe(false)
    expect(store.confirmObservation({ meshId: MESH, nodeId: NODE, signature: sig, observedAt: 1_900 })).toEqual({ held: true, changed: false })
    expect(store.get(MESH, NODE)!.observedAt).toBe(1_900)
    // Recovery from unreachable is a visible change.
    store.recordProbeFailure(MESH, NODE, WS, 'P2P timeout', 1_950)
    expect(store.confirmObservation({ meshId: MESH, nodeId: NODE, signature: sig, observedAt: 1_990 })).toEqual({ held: true, changed: true })
    expect(store.get(MESH, NODE)!.unreachableSince).toBeNull()
    store.markHandshakePending(MESH, NODE, 'restart')
    expect(store.confirmObservation({ meshId: MESH, nodeId: NODE, signature: sig }).held).toBe(false)
  })

  it('mesh_node_git_report accepts a signature-only report and answers gitHeld', async () => {
    const store = new MeshNodeGitStateStore()
    const mesh = { id: MESH, nodes: [{ id: NODE, daemonId: 'daemon_member', workspace: WS }] }
    const invalidate = vi.fn()
    const ctx: any = {
      getMeshForCommand: async () => ({ mesh }),
      meshNodeGitState: store,
      invalidateAggregateMeshStatus: invalidate,
      deps: { onMeshStateChange: vi.fn() },
      meshCoordinatorBootId: 'boot-1',
    }
    const sig = digestMeshNodeStateSignature(computeMeshNodeGitSignature(git()))
    const miss: any = await meshNodeStateHandlers.mesh_node_git_report!(ctx, { meshId: MESH, nodeId: NODE, workspace: WS, gitSignature: sig, observedAt: 10 })
    expect(miss).toMatchObject({ success: true, accepted: true, gitHeld: false, changed: false })
    await meshNodeStateHandlers.mesh_node_git_report!(ctx, { meshId: MESH, nodeId: NODE, workspace: WS, git: git(), observedAt: 20 })
    expect(invalidate).toHaveBeenCalledTimes(1)
    const hit: any = await meshNodeStateHandlers.mesh_node_git_report!(ctx, { meshId: MESH, nodeId: NODE, workspace: WS, gitSignature: sig, observedAt: 30 })
    expect(hit).toMatchObject({ success: true, accepted: true, gitHeld: true, changed: false })
    // A confirming heartbeat publishes nothing.
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(store.get(MESH, NODE)!.observedAt).toBe(30)
  })
})

describe('git-dir change detector (member side)', () => {
  function watchedPusher(opts: { now: () => number }) {
    const watchers = new Map<string, { onChange: () => void; onError: () => void }>()
    let head = 'h1'
    const readGit = vi.fn(async () => ({ ...git({ headCommit: head }), lastCheckedAt: opts.now() }))
    const dispatch = vi.fn(async (_c: string, _cmd: string, args: any) => ({ success: true, accepted: true, ...(args.gitSignature ? { gitHeld: true } : {}) }))
    const pusher = new MeshNodeStatePusher({
      dispatch,
      readGit,
      now: opts.now,
      heartbeatMs: 300_000,
      startTimer: () => ({ stop() {} }),
      watchGit: (workspace, onChange, onError) => {
        watchers.set(workspace, { onChange, onError })
        return { stop: () => { watchers.delete(workspace) } }
      },
    })
    return { pusher, watchers, readGit, dispatch, setHead: (h: string) => { head = h } }
  }

  it('a watched, unmoved workspace is NOT re-read on the check tick; a detector callback re-reads and pushes', async () => {
    let now = 10_000_000
    const { pusher, watchers, readGit, dispatch, setHead } = watchedPusher({ now: () => now })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH, nodeId: NODE, workspace: WS })
    expect(pusher.isGitWatched(WS)).toBe(true)
    await pusher.tick()
    expect(readGit).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)

    for (let minute = 1; minute <= 4; minute += 1) {
      now += 60_000
      await pusher.tick()
    }
    expect(readGit).toHaveBeenCalledTimes(1) // zero git spawns on the tick while nothing moved
    expect(dispatch).toHaveBeenCalledTimes(1)

    // A commit from a terminal: the detector fires → one read → one full push.
    setHead('h2')
    now += 5_000
    watchers.get(WS)!.onChange()
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(readGit).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]![2].git).toMatchObject({ headCommit: 'h2' })

    // The heartbeat still re-reads (with the upstream fetch) and sends the signature only.
    now += 300_000
    await pusher.tick()
    expect(readGit).toHaveBeenCalledTimes(3)
    expect((readGit.mock.calls[2] as any)[1]).toEqual({ refreshUpstream: true })
    expect(dispatch.mock.calls[2]![2]).toHaveProperty('gitSignature')
    pusher.stop()
    expect(watchers.size).toBe(0)
  })

  it("this daemon's own read never re-triggers (the self-read quiet window); a session event owes one read", async () => {
    let now = 20_000_000
    const { pusher, watchers, readGit } = watchedPusher({ now: () => now })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH, nodeId: NODE, workspace: WS })
    await pusher.tick()
    expect(readGit).toHaveBeenCalledTimes(1)
    // The index refresh our own `git status` wrote lands inside the quiet window.
    now += MESH_NODE_STATE_SELF_READ_QUIET_MS - 1
    watchers.get(WS)!.onChange()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(readGit).toHaveBeenCalledTimes(1)

    // A session lifecycle change (an agent turn edited files the git dir does not show).
    pusher.noteRuntimeChanged()
    now += 60_000
    await pusher.tick()
    expect(readGit).toHaveBeenCalledTimes(2)
    pusher.stop()
  })

  it('an unwatchable workspace (or a watch that errors) keeps the per-tick re-read', async () => {
    let now = 30_000_000
    const readGit = vi.fn(async () => ({ ...git(), lastCheckedAt: now }))
    const pusher = new MeshNodeStatePusher({
      dispatch: vi.fn(async () => ({ success: true, accepted: true, gitHeld: true })),
      readGit,
      now: () => now,
      startTimer: () => ({ stop() {} }),
      watchGit: () => null,
    })
    pusher.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH, nodeId: NODE, workspace: WS })
    expect(pusher.isGitWatched(WS)).toBe(false)
    await pusher.tick()
    now += 60_000
    await pusher.tick()
    expect(readGit).toHaveBeenCalledTimes(2)
    pusher.stop()

    let errorOut: (() => void) | null = null
    const watched = new MeshNodeStatePusher({
      dispatch: vi.fn(async () => ({ success: true, accepted: true, gitHeld: true })),
      readGit,
      now: () => now,
      startTimer: () => ({ stop() {} }),
      watchGit: (_ws, _onChange, onError) => { errorOut = onError; return { stop() {} } },
    })
    watched.selfRegister({ coordinatorDaemonId: 'coord', meshId: MESH, nodeId: NODE, workspace: WS })
    expect(watched.isGitWatched(WS)).toBe(true)
    errorOut!()
    expect(watched.isGitWatched(WS)).toBe(false)
    watched.stop()
  })
})

describe("coordinator's own checkouts (local mesh nodes)", () => {
  it('a terminal commit in a watched local checkout flushes its mesh; the daemon\'s own read never does', async () => {
    const { LocalMeshNodeGitWatch, LOCAL_MESH_NODE_GIT_SELF_READ_QUIET_MS } = await import('../../src/mesh/local-mesh-node-git-watch')
    let now = 1_000
    const callbacks = new Map<string, () => void>()
    const onChange = vi.fn()
    const watch = new LocalMeshNodeGitWatch({
      now: () => now,
      onChange,
      watch: (workspace, cb) => { callbacks.set(workspace, cb); return { stop: () => { callbacks.delete(workspace) } } },
    })
    watch.track('mesh-a', '/ws/local')
    watch.track('mesh-b', '/ws/local') // one watch, two meshes
    expect(callbacks.size).toBe(1)
    expect(watch.isWatching('/ws/local')).toBe(true)

    // mesh_status's own git read (index refresh) — ignored during and just after.
    await watch.read('/ws/local', async () => { callbacks.get('/ws/local')!(); return null })
    now += LOCAL_MESH_NODE_GIT_SELF_READ_QUIET_MS - 1
    callbacks.get('/ws/local')!()
    expect(onChange).not.toHaveBeenCalled()

    now += 10_000
    callbacks.get('/ws/local')!() // a commit from a terminal
    expect(onChange.mock.calls.map((c) => c[0]).sort()).toEqual(['mesh-a', 'mesh-b'])
    watch.stop()
    expect(callbacks.size).toBe(0)
  })

  it('an unwatchable checkout is not tracked (the next render retries)', async () => {
    const { LocalMeshNodeGitWatch } = await import('../../src/mesh/local-mesh-node-git-watch')
    const watch = new LocalMeshNodeGitWatch({ onChange: vi.fn(), watch: () => null })
    watch.track('mesh-a', '/not/a/checkout')
    expect(watch.isWatching('/not/a/checkout')).toBe(false)
  })
})
