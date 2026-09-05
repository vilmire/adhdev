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

import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js'
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
