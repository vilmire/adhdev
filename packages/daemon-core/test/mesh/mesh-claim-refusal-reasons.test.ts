import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// A6-SILENT-REFUSAL. `claimNextQueueTask` evaluates nine independent per-candidate predicates
// plus two pre-checks, and every one of them used to funnel into a single bare `return null`.
// The caller then did `if (!task) return false` — also silent. So a task that could NEVER claim
// (wrong tags, unmet difficulty floor, a node pinned busy by a stale assigned row) was
// indistinguishable from an empty queue: no log, no ledger entry, no reason anywhere.
//
// Live cost: on 2026-08-20 a task sat pending against an idle zero-message session while the
// drain silently refused it every ~4s. Nothing in the logs named the gate, so diagnosis meant
// re-deriving all nine predicates by hand against live state.
//
// This suite pins that each gate is now individually ATTRIBUTABLE. The refusal reason is
// diagnostic only — it must never change whether a claim succeeds — so each case also asserts
// the claim still returns null exactly as before.

const testTmpDir = path.join(tmpdir(), `adhdev-claim-refusal-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
  getMachineNickname: () => ({ machineId: 'test-machine' } as any).machineNickname ?? null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, recordDirectDispatchTask } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import type { MeshClaimRefusal } from '../../src/mesh/mesh-runtime-store.js'

const NODE_A = 'node_alpha'
const SESSION_A = 'session_alpha'

function claim(meshId: string, opts: Parameters<MeshRuntimeStore['claimNextQueueTask']>[4] = {}, args?: {
  nodeId?: string; sessionId?: string; tags?: string[];
}) {
  const refusal: MeshClaimRefusal = {}
  const task = MeshRuntimeStore.getInstance().claimNextQueueTask(
    meshId,
    args?.nodeId ?? NODE_A,
    args?.sessionId ?? SESSION_A,
    args?.tags ?? [],
    { ...opts, outRefusal: refusal },
  )
  return { task, refusal }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('A6-SILENT-REFUSAL — every claim gate is individually attributable', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('an empty queue reports no_pending_candidates (the ordinary idle case, not a gate)', () => {
    const meshId = `mesh_refuse_empty_${randomUUID().slice(0, 8)}`
    try {
      const { task, refusal } = claim(meshId)
      expect(task).toBeNull()
      expect(refusal.reason).toBe('no_pending_candidates')
    } finally {
      cleanup(meshId)
    }
  })

  it('required_tags_unsatisfied — a task tagged for capabilities this node lacks', () => {
    const meshId = `mesh_refuse_tags_${randomUUID().slice(0, 8)}`
    try {
      enqueueTask(meshId, 'tagged work', {
        taskMode: 'code_change',
        difficulty: 'medium',
        requiredTags: ['converge=refine'],
      })
      // Node advertises a different converge capability, so no candidate satisfies the tag.
      const { task, refusal } = claim(meshId, {}, { tags: ['converge=fast_forward'] })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('required_tags_unsatisfied')
    } finally {
      cleanup(meshId)
    }
  })

  it('not_before_delayed — a task still held by its notBefore gate', () => {
    const meshId = `mesh_refuse_notbefore_${randomUUID().slice(0, 8)}`
    try {
      enqueueTask(meshId, 'scheduled work', {
        taskMode: 'code_change',
        difficulty: 'medium',
        notBefore: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      const { task, refusal } = claim(meshId)
      expect(task).toBeNull()
      expect(refusal.reason).toBe('not_before_delayed')
    } finally {
      cleanup(meshId)
    }
  })

  it('difficulty_floor_unmet — a difficult task against a session allowed only easy work', () => {
    const meshId = `mesh_refuse_difficulty_${randomUUID().slice(0, 8)}`
    try {
      const enqueued = enqueueTask(meshId, 'hard work', { taskMode: 'code_change', difficulty: 'difficult' })
      const { task, refusal } = claim(meshId, { allowedTaskDifficulties: ['easy'] })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('difficulty_floor_unmet')
      // Structural id/difficulty (not just the free-form `detail` string) — the claim-path
      // difficulty-floor pager (mesh-queue-assignment.ts tryAssignQueueTask) needs the real
      // taskId to call handleDifficultyFloorSkip without parsing it out of prose.
      expect(refusal.taskId).toBe(enqueued.id)
      expect(refusal.difficulty).toBe('difficult')
    } finally {
      cleanup(meshId)
    }
  })

  it('parallel_cap_reached — the (daemon, provider) maxParallel budget is already spent', () => {
    const meshId = `mesh_refuse_cap_${randomUUID().slice(0, 8)}`
    try {
      enqueueTask(meshId, 'capped work', { taskMode: 'code_change', difficulty: 'medium' })
      // A zero cap refuses everything — the sharp edge called out in the cap accounting.
      const { task, refusal } = claim(meshId, { providerType: 'codex-cli', providerMaxParallel: 0 })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('parallel_cap_reached')
    } finally {
      cleanup(meshId)
    }
  })

  it('node_busy_with_active_assignment — a stale assigned row silently pins the node', () => {
    const meshId = `mesh_refuse_busy_${randomUUID().slice(0, 8)}`
    try {
      const first = enqueueTask(meshId, 'first work', { taskMode: 'code_change', difficulty: 'medium' })
      // Claim it, so the node now holds an active assignment.
      const claimed = claim(meshId)
      expect(claimed.task?.id).toBe(first.id)

      // A SECOND write task cannot claim the same node while that row is active. This is the
      // shape that, with a STRANDED assigned row, blocks every later claim indefinitely —
      // previously with no diagnostic whatsoever.
      enqueueTask(meshId, 'second work', { taskMode: 'code_change', difficulty: 'medium' })
      const { task, refusal } = claim(meshId, {}, { sessionId: 'session_beta' })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('node_busy_with_active_assignment')
    } finally {
      cleanup(meshId)
    }
  })

  it('session_already_assigned — one task per session, refused before any candidate scan', () => {
    const meshId = `mesh_refuse_session_${randomUUID().slice(0, 8)}`
    try {
      enqueueTask(meshId, 'first work', { taskMode: 'code_change', difficulty: 'medium' })
      expect(claim(meshId).task).not.toBeNull()

      // The SAME session tries again while still holding its assignment.
      enqueueTask(meshId, 'second work', { taskMode: 'code_change', difficulty: 'medium' })
      const { task, refusal } = claim(meshId)
      expect(task).toBeNull()
      expect(refusal.reason).toBe('session_already_assigned')
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths_conflict — a second code_change task overlapping an in-flight declaration on a SIBLING node is refused', () => {
    // H1 (path ownership). Deliberately TWO DIFFERENT nodes (not the same node twice —
    // that would just hit node_busy_with_active_assignment first): this is exactly the
    // gap the design doc calls out — node_busy only ever compares a candidate against
    // ITS OWN node's busy bit, so two worktrees of the same daemon racing on the same
    // file were previously invisible to every existing gate.
    const meshId = `mesh_refuse_ownedpaths_${randomUUID().slice(0, 8)}`
    const NODE_B = 'node_beta'
    const daemonNodeIds = [NODE_A, NODE_B]
    try {
      const first = enqueueTask(meshId, 'first work', {
        taskMode: 'code_change', difficulty: 'medium', ownedPaths: ['src/mesh/mesh-work-queue.ts'],
      })
      const claimed = claim(meshId, { daemonNodeIds })
      expect(claimed.task?.id).toBe(first.id)

      // Second task on a DIFFERENT node, overlapping subtree declaration.
      const second = enqueueTask(meshId, 'second work', {
        taskMode: 'code_change', difficulty: 'medium', ownedPaths: ['src/mesh/**'],
      })
      const { task, refusal } = claim(meshId, { daemonNodeIds }, { nodeId: NODE_B, sessionId: 'session_beta' })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('owned_paths_conflict')
      // Names the conflicting task id — not just "closest candidate N of M" prose.
      expect(refusal.detail).toContain(first.id)
      void second
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths_conflict — MESH-WIDE: overlap across two DIFFERENT DAEMONS (no shared daemonNodeIds) is refused', () => {
    // Live finding (preview rc.41, runs 3–7): T1 (direct dispatch, owned_paths
    // ["docs/CONCEPTS.md"], assigned on node MainPC) did not stop T2 (enqueued with
    // the same owned_paths, pinned to node MoltBook on a DIFFERENT daemon) from being
    // claimed immediately. The old gate built inFlightOwnership from
    // assignedRowsForDaemon — scoped to the CLAIMING node's own daemonNodeIds — so a
    // row `assigned` on a completely different machine was invisible. Neither claim
    // here passes a `daemonNodeIds` that includes the other's node: this is the
    // cross-daemon case the capacity gates correctly do NOT widen to, but path
    // ownership must.
    const meshId = `mesh_refuse_ownedpaths_crossdaemon_${randomUUID().slice(0, 8)}`
    const NODE_MAINPC = 'node_mainpc'
    const NODE_MOLTBOOK = 'node_moltbook'
    try {
      // T1: direct dispatch, already `assigned` on MainPC — mirrors the live repro,
      // which used mesh_direct (recordDirectDispatchTask), not the enqueue+claim path.
      const t1 = recordDirectDispatchTask(meshId, 'T1 direct dispatch', {
        id: `t1_${randomUUID().slice(0, 8)}`,
        assignedNodeId: NODE_MAINPC,
        assignedSessionId: 'session_mainpc',
        taskMode: 'code_change',
        difficulty: 'medium',
        ownedPaths: ['docs/CONCEPTS.md'],
      })
      expect(t1).not.toBeNull()

      // T2: enqueued, pinned to MoltBook, on a DIFFERENT daemon than MainPC. No
      // daemonNodeIds passed for either side — each node's own capacity scope, exactly
      // as the live claim call sites resolve it.
      const t2 = enqueueTask(meshId, 'T2 enqueued', {
        taskMode: 'code_change', difficulty: 'medium', targetNodeId: NODE_MOLTBOOK,
        ownedPaths: ['docs/CONCEPTS.md'],
      })
      const { task, refusal } = claim(meshId, {}, { nodeId: NODE_MOLTBOOK, sessionId: 'session_moltbook' })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('owned_paths_conflict')
      expect(refusal.detail).toContain(t1!.id)
      void t2
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths non-overlapping declarations across DIFFERENT daemons both claim fine', () => {
    const meshId = `mesh_refuse_ownedpaths_crossdaemon_ok_${randomUUID().slice(0, 8)}`
    const NODE_MAINPC = 'node_mainpc'
    const NODE_MOLTBOOK = 'node_moltbook'
    try {
      const t1 = recordDirectDispatchTask(meshId, 'T1 direct dispatch', {
        id: `t1_${randomUUID().slice(0, 8)}`,
        assignedNodeId: NODE_MAINPC,
        assignedSessionId: 'session_mainpc',
        taskMode: 'code_change',
        difficulty: 'medium',
        ownedPaths: ['docs/CONCEPTS.md'],
      })
      expect(t1).not.toBeNull()

      const t2 = enqueueTask(meshId, 'T2 enqueued', {
        taskMode: 'code_change', difficulty: 'medium', targetNodeId: NODE_MOLTBOOK,
        ownedPaths: ['docs/OTHER.md'],
      })
      const { task, refusal } = claim(meshId, {}, { nodeId: NODE_MOLTBOOK, sessionId: 'session_moltbook' })
      expect(task?.id).toBe(t2.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths_conflict — MESH-WIDE gate never refuses a READONLY in-flight task across daemons', () => {
    const meshId = `mesh_refuse_ownedpaths_crossdaemon_readonly_${randomUUID().slice(0, 8)}`
    const NODE_MAINPC = 'node_mainpc'
    const NODE_MOLTBOOK = 'node_moltbook'
    try {
      const t1 = recordDirectDispatchTask(meshId, 'T1 direct dispatch readonly', {
        id: `t1_${randomUUID().slice(0, 8)}`,
        assignedNodeId: NODE_MAINPC,
        assignedSessionId: 'session_mainpc',
        taskMode: 'live_debug_readonly',
        readonly: true,
        difficulty: 'medium',
        ownedPaths: ['docs/CONCEPTS.md'],
      })
      expect(t1).not.toBeNull()

      const t2 = enqueueTask(meshId, 'T2 enqueued', {
        taskMode: 'code_change', difficulty: 'medium', targetNodeId: NODE_MOLTBOOK,
        ownedPaths: ['docs/CONCEPTS.md'],
      })
      const { task, refusal } = claim(meshId, {}, { nodeId: NODE_MOLTBOOK, sessionId: 'session_moltbook' })
      expect(task?.id).toBe(t2.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths_conflict across daemons is OPT-IN — an in-flight task with no declaration never conflicts', () => {
    const meshId = `mesh_refuse_ownedpaths_crossdaemon_optin_${randomUUID().slice(0, 8)}`
    const NODE_MAINPC = 'node_mainpc'
    const NODE_MOLTBOOK = 'node_moltbook'
    try {
      const t1 = recordDirectDispatchTask(meshId, 'T1 direct dispatch, no declaration', {
        id: `t1_${randomUUID().slice(0, 8)}`,
        assignedNodeId: NODE_MAINPC,
        assignedSessionId: 'session_mainpc',
        taskMode: 'code_change',
        difficulty: 'medium',
      })
      expect(t1).not.toBeNull()

      const t2 = enqueueTask(meshId, 'T2 enqueued', {
        taskMode: 'code_change', difficulty: 'medium', targetNodeId: NODE_MOLTBOOK,
        ownedPaths: ['docs/CONCEPTS.md'],
      })
      const { task, refusal } = claim(meshId, {}, { nodeId: NODE_MOLTBOOK, sessionId: 'session_moltbook' })
      expect(task?.id).toBe(t2.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths non-overlapping declarations on sibling nodes both claim fine', () => {
    const meshId = `mesh_refuse_ownedpaths_ok_${randomUUID().slice(0, 8)}`
    const NODE_B = 'node_beta'
    const daemonNodeIds = [NODE_A, NODE_B]
    try {
      const first = enqueueTask(meshId, 'first work', {
        taskMode: 'code_change', difficulty: 'medium', ownedPaths: ['src/a.ts'],
      })
      expect(claim(meshId, { daemonNodeIds }).task?.id).toBe(first.id)

      const second = enqueueTask(meshId, 'second work', {
        taskMode: 'code_change', difficulty: 'medium', ownedPaths: ['src/b.ts'],
      })
      const { task, refusal } = claim(meshId, { daemonNodeIds }, { nodeId: NODE_B, sessionId: 'session_beta' })
      expect(task?.id).toBe(second.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths_conflict is OPT-IN — a candidate or in-flight task with no declaration never conflicts', () => {
    const meshId = `mesh_refuse_ownedpaths_optin_${randomUUID().slice(0, 8)}`
    const NODE_B = 'node_beta'
    const daemonNodeIds = [NODE_A, NODE_B]
    try {
      // First task declares ownership; second declares NONE — must not conflict even
      // though (hypothetically) they could touch the same files. Absent declaration
      // performs no overlap check, by design (backward compat).
      const first = enqueueTask(meshId, 'first work', {
        taskMode: 'code_change', difficulty: 'medium', ownedPaths: ['src/shared.ts'],
      })
      expect(claim(meshId, { daemonNodeIds }).task?.id).toBe(first.id)

      const second = enqueueTask(meshId, 'second work', { taskMode: 'code_change', difficulty: 'medium' })
      const { task } = claim(meshId, { daemonNodeIds }, { nodeId: NODE_B, sessionId: 'session_beta' })
      expect(task?.id).toBe(second.id)
    } finally {
      cleanup(meshId)
    }
  })

  it('owned_paths overlap on a live_debug_readonly (non-write) task never refuses — H1 only gates writes', () => {
    const meshId = `mesh_refuse_ownedpaths_readonly_${randomUUID().slice(0, 8)}`
    const NODE_B = 'node_beta'
    const daemonNodeIds = [NODE_A, NODE_B]
    try {
      const first = enqueueTask(meshId, 'first work', {
        taskMode: 'code_change', difficulty: 'medium', ownedPaths: ['src/shared.ts'],
      })
      expect(claim(meshId, { daemonNodeIds }).task?.id).toBe(first.id)

      // A read-only candidate overlapping the in-flight write's declaration must still
      // claim fine — read-only tasks are exempt from the node-busy family of gates and
      // owned_paths_conflict is a refinement of that same family.
      const second = enqueueTask(meshId, 'second work', {
        taskMode: 'live_debug_readonly', difficulty: 'medium', ownedPaths: ['src/shared.ts'],
      })
      const { task, refusal } = claim(meshId, { daemonNodeIds }, { nodeId: NODE_B, sessionId: 'session_beta' })
      expect(task?.id).toBe(second.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('dirty_workspace — a write candidate cannot be claimed by a node whose git gate reports dirty', () => {
    // GIT-GATE (owner-requested follow-up to H1). The gate is resolved by the CALLER
    // (mesh-queue-assignment.ts, via isDirtyNode) and threaded in as a plain opt — this
    // suite exercises the store-level candidate filter's reaction to that opt directly,
    // mirroring how the H1 tests exercise ownedPathsAllows without going through the
    // caller that resolves node records.
    const meshId = `mesh_refuse_dirty_${randomUUID().slice(0, 8)}`
    try {
      enqueueTask(meshId, 'write work', { taskMode: 'code_change', difficulty: 'medium' })
      const { task, refusal } = claim(meshId, { nodeGitGate: { dirty: true, staleBehind: false } })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('dirty_workspace')
    } finally {
      cleanup(meshId)
    }
  })

  it('node_stale_behind_upstream — a write candidate cannot be claimed by a node whose git gate reports stale-behind', () => {
    const meshId = `mesh_refuse_stale_${randomUUID().slice(0, 8)}`
    try {
      enqueueTask(meshId, 'write work', { taskMode: 'code_change', difficulty: 'medium' })
      const { task, refusal } = claim(meshId, { nodeGitGate: { dirty: false, staleBehind: true, behind: 7, maxBehind: 0 } })
      expect(task).toBeNull()
      expect(refusal.reason).toBe('node_stale_behind_upstream')
      // Names the concrete evidence (behind count / maxBehind), not generic prose.
      expect(refusal.detail).toContain('7')
    } finally {
      cleanup(meshId)
    }
  })

  it('git gate: behind within threshold (staleBehind:false) still claims fine', () => {
    // The caller (isMeshNodeFreshEnoughToLaunch) already decided behind<=maxBehind is
    // fresh and reports staleBehind:false — the store gate must not re-derive or
    // second-guess that verdict.
    const meshId = `mesh_refuse_stale_within_threshold_${randomUUID().slice(0, 8)}`
    try {
      const first = enqueueTask(meshId, 'write work', { taskMode: 'code_change', difficulty: 'medium' })
      const { task, refusal } = claim(meshId, { nodeGitGate: { dirty: false, staleBehind: false, behind: 2, maxBehind: 5 } })
      expect(task?.id).toBe(first.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('git gate: missing telemetry (nodeGitGate omitted) never refuses — fail-open', () => {
    const meshId = `mesh_refuse_no_git_telemetry_${randomUUID().slice(0, 8)}`
    try {
      const first = enqueueTask(meshId, 'write work', { taskMode: 'code_change', difficulty: 'medium' })
      const { task, refusal } = claim(meshId, {})
      expect(task?.id).toBe(first.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('git gate: a READONLY candidate claims fine on a dirty/stale node — write-only gate', () => {
    const meshId = `mesh_refuse_dirty_readonly_${randomUUID().slice(0, 8)}`
    try {
      const first = enqueueTask(meshId, 'readonly work', { taskMode: 'live_debug_readonly', difficulty: 'medium' })
      const { task, refusal } = claim(meshId, { nodeGitGate: { dirty: true, staleBehind: true, behind: 12, maxBehind: 0 } })
      expect(task?.id).toBe(first.id)
      expect(refusal.reason).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('reasons are DISTINCT — no two gates collapse onto the same string', () => {
    const meshId = `mesh_refuse_distinct_${randomUUID().slice(0, 8)}`
    try {
      const seen = new Set<string>()

      enqueueTask(meshId, 'tagged', { taskMode: 'code_change', difficulty: 'medium', requiredTags: ['converge=refine'] })
      seen.add(claim(meshId, {}, { tags: ['converge=fast_forward'] }).refusal.reason!)
      __clearMeshQueueForTests(meshId)

      enqueueTask(meshId, 'hard', { taskMode: 'code_change', difficulty: 'difficult' })
      seen.add(claim(meshId, { allowedTaskDifficulties: ['easy'] }).refusal.reason!)
      __clearMeshQueueForTests(meshId)

      enqueueTask(meshId, 'capped', { taskMode: 'code_change', difficulty: 'medium' })
      seen.add(claim(meshId, { providerType: 'codex-cli', providerMaxParallel: 0 }).refusal.reason!)
      __clearMeshQueueForTests(meshId)

      enqueueTask(meshId, 'delayed', {
        taskMode: 'code_change',
        difficulty: 'medium',
        notBefore: new Date(Date.now() + 3_600_000).toISOString(),
      })
      seen.add(claim(meshId).refusal.reason!)

      // Four different gates ⇒ four different reasons. A single shared string here would mean
      // the diagnostic is no better than the bare `return null` it replaced.
      expect(seen.size).toBe(4)
      expect(seen.has('no_pending_candidates')).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})
