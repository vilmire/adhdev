import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pullRemoteNodeQueues,
  pullPendingEventsFromNode,
  resolveRemotePullBackoffMs,
  REDRIVE_PULL_MIN_INTERVAL_MS,
  REMOTE_PULL_BACKOFF_MAX_MS,
  __resetRemoteEventPullPacingForTests,
} from '../../src/mesh/mesh-remote-event-pull.js'

/**
 * RECONCILE-PULL-FLOOD (M-MESH-INFRA-0829 follow-up, live 2026-08-30):
 * the 4s reconcile tick issued get_pending_mesh_events ONCE PER NODE ENTRY
 * (config ∪ inline-cache) — and remote-cloned worktree nodes alias the SAME
 * remote daemon many times over — with no empty-response backoff. Live
 * measurement on the preview coordinator: ~90 pulls/tick (~25 req/s, 82% to a
 * single daemon), all empty, CPU 114%.
 *
 * Fix contract asserted here (real path: pullRemoteNodeQueues →
 * pullPendingEventsFromNode → dispatchMeshCommand stub):
 *   1. one pull-set per remote DAEMON per tick (node aliases deduped);
 *   2. consecutive all-empty rounds back the daemon off (cap ≤ 30s, never
 *      minutes — skip = delay, never loss: the remote queue keeps the rows);
 *   3. a non-empty round resets pacing immediately (full 4s cadence resumes);
 *   4. the redrive gate's last-chance pull is throttled per daemon so N
 *      stranded rows on one daemon cannot multiply into N pull-sets per tick.
 */

const MESH_ID = 'mesh_pace'

function makeComponents(dispatch: ReturnType<typeof vi.fn>) {
  // No getMeshPeerConnectionStatus: getter unwired → fall through (standalone
  // semantics), so the stub transport is always exercised.
  return { dispatchMeshCommand: dispatch } as any
}

const EMPTY = { success: true, events: [] }
const ONE_EVENT = {
  success: true,
  events: [{ event: 'agent:generating_completed', meshId: MESH_ID, nodeId: 'node_w1' }],
}

function meshWithNodes(nodes: Array<{ id: string; daemonId?: string }>) {
  return { id: MESH_ID, nodes } as any
}

beforeEach(() => {
  __resetRemoteEventPullPacingForTests()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-30T03:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pullRemoteNodeQueues — per-daemon dedup (fix 1)', () => {
  it('pulls each remote daemon once per candidate id, not once per node entry', async () => {
    const dispatch = vi.fn(async () => EMPTY)
    // Three worktree-clone aliases of the SAME remote daemon + one other daemon.
    const mesh = meshWithNodes([
      { id: 'node_base_b', daemonId: 'mach_b' },
      { id: 'node_wt1_b', daemonId: 'daemon_mach_b' },
      { id: 'node_wt2_b', daemonId: 'standalone_mach_b' },
      { id: 'node_c', daemonId: 'mach_c' },
    ])
    await pullRemoteNodeQueues(makeComponents(dispatch), mesh, 'daemon_self', ['daemon_self', 'mach_self'])
    // 2 unique daemons × 2 candidate ids — NOT (3+1) nodes × 2 ids = 8.
    expect(dispatch).toHaveBeenCalledTimes(4)
    const perDaemon = new Map<string, number>()
    for (const [target] of dispatch.mock.calls) perDaemon.set(target, (perDaemon.get(target) ?? 0) + 1)
    expect(perDaemon.get('mach_b')).toBe(2)
    expect(perDaemon.get('mach_c')).toBe(2)
    // Every pull carries a candidate coordinator id form.
    for (const [, command, args] of dispatch.mock.calls) {
      expect(command).toBe('get_pending_mesh_events')
      expect(args).toMatchObject({ meshId: MESH_ID })
      expect(['daemon_self', 'mach_self']).toContain((args as any).coordinatorDaemonId)
    }
  })
})

describe('pullRemoteNodeQueues — empty-response backoff (fix 2/3)', () => {
  const mesh = meshWithNodes([{ id: 'node_b', daemonId: 'daemon_b' }])
  const ids = ['daemon_self']

  it('keeps full cadence for the first empty rounds, then skips the backed-off daemon', async () => {
    const dispatch = vi.fn(async () => EMPTY)
    const components = makeComponents(dispatch)
    // Three consecutive all-empty rounds at full cadence (no skip yet).
    for (let round = 0; round < 3; round++) {
      await pullRemoteNodeQueues(components, mesh, 'daemon_self', ids)
      vi.setSystemTime(Date.now() + 4_000)
    }
    expect(dispatch).toHaveBeenCalledTimes(3)
    // Fourth round: backoff has engaged → the daemon is skipped entirely.
    await pullRemoteNodeQueues(components, mesh, 'daemon_self', ids)
    expect(dispatch).toHaveBeenCalledTimes(3)
  })

  it('resumes pulling after the backoff elapses, and a non-empty round resets pacing', async () => {
    const dispatch = vi.fn(async () => EMPTY)
    const components = makeComponents(dispatch)
    for (let round = 0; round < 4; round++) {
      await pullRemoteNodeQueues(components, mesh, 'daemon_self', ids)
      vi.setSystemTime(Date.now() + 4_000)
    }
    const callsAfterBackoff = dispatch.mock.calls.length
    expect(callsAfterBackoff).toBe(3) // 4th round skipped
    // Let the backoff lapse; the daemon is polled again (events queued on the
    // remote during the skip are recovered — skip = delay, never loss).
    vi.setSystemTime(Date.now() + REMOTE_PULL_BACKOFF_MAX_MS + 1_000)
    dispatch.mockImplementationOnce(async () => ONE_EVENT)
    await pullRemoteNodeQueues(components, mesh, 'daemon_self', ids)
    expect(dispatch).toHaveBeenCalledTimes(callsAfterBackoff + 1)
    // Non-empty round reset the streak → the very next tick pulls again.
    vi.setSystemTime(Date.now() + 4_000)
    await pullRemoteNodeQueues(components, mesh, 'daemon_self', ids)
    expect(dispatch).toHaveBeenCalledTimes(callsAfterBackoff + 2)
  })

  it('never backs off past the cap (delivery delay stays seconds, never minutes)', () => {
    expect(resolveRemotePullBackoffMs(1)).toBeLessThanOrEqual(REMOTE_PULL_BACKOFF_MAX_MS)
    expect(resolveRemotePullBackoffMs(100)).toBe(REMOTE_PULL_BACKOFF_MAX_MS)
    expect(REMOTE_PULL_BACKOFF_MAX_MS).toBeLessThanOrEqual(30_000)
  })

  it('does not treat a partial candidate-id round as confirmed empty', async () => {
    const dispatch = vi.fn(async (_daemonId: string, _command: string, args: any) => {
      if (args.coordinatorDaemonId === 'mach_self') throw new Error('second id form unreachable')
      return EMPTY
    })
    const components = makeComponents(dispatch)
    for (let round = 0; round < 5; round++) {
      await pullRemoteNodeQueues(components, mesh, 'daemon_self', ['daemon_self', 'mach_self'])
      vi.setSystemTime(Date.now() + 4_000)
    }
    // Every tick retries both forms; the successful first half must not create
    // empty-queue evidence that backs off the failed second half.
    expect(dispatch).toHaveBeenCalledTimes(10)
  })
})

describe('pullPendingEventsFromNode — redrive-gate throttle (fix 4)', () => {
  const node = { id: 'node_b', daemonId: 'daemon_b' }
  const ids = ['daemon_self']
  const pulls = ids.map(id => ({ meshId: MESH_ID, coordinatorDaemonId: id }))

  it('a second pull of the same daemon inside the throttle window is skipped', async () => {
    const dispatch = vi.fn(async () => EMPTY)
    const components = makeComponents(dispatch)
    const first = await pullPendingEventsFromNode(components, MESH_ID, node, 'daemon_self', ids, pulls,
      { minIntervalSinceLastPullMs: REDRIVE_PULL_MIN_INTERVAL_MS })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(first.reached).toBe(true)
    // A second stranded row pointing at the SAME daemon in the same tick:
    // PHASE 1 / the first row already drained it — no second round-trip.
    await pullPendingEventsFromNode(components, MESH_ID, node, 'daemon_self', ids, pulls,
      { minIntervalSinceLastPullMs: REDRIVE_PULL_MIN_INTERVAL_MS })
    expect(dispatch).toHaveBeenCalledTimes(1)
    // After the window lapses the last-chance pull is fresh again.
    vi.setSystemTime(Date.now() + REDRIVE_PULL_MIN_INTERVAL_MS + 1)
    await pullPendingEventsFromNode(components, MESH_ID, node, 'daemon_self', ids, pulls,
      { minIntervalSinceLastPullMs: REDRIVE_PULL_MIN_INTERVAL_MS })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('without the throttle opt the helper pulls every time (back-compat)', async () => {
    const dispatch = vi.fn(async () => EMPTY)
    const components = makeComponents(dispatch)
    await pullPendingEventsFromNode(components, MESH_ID, node, 'daemon_self', ids, pulls)
    await pullPendingEventsFromNode(components, MESH_ID, node, 'daemon_self', ids, pulls)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})
