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

const testTmpDir = path.join(tmpdir(), `adhdev-light-claim-test-${randomUUID().slice(0, 8)}`)
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
import { evaluateTaskOwnedPathsAdmission } from '../../src/mesh/mesh-runtime-store-claim.js'

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


const LIGHT_SESSION = 'session_light_1'
const LIGHT_WS = 'lw_test_ws1'

function enqueueLight(meshId: string, extra: Record<string, unknown> = {}) {
  return enqueueTask(meshId, 'fix the thing', {
    taskMode: 'code_change', difficulty: 'easy', ownedPaths: ['src/a.ts'], light: true, lightBaseNodeId: NODE_A, ...extra,
  } as any)
}
function pin(meshId: string, id: string, sessionId = LIGHT_SESSION, ws = LIGHT_WS) {
  const store = MeshRuntimeStore.getInstance()
  const row = store.findQueueEntryById(meshId, id)!
  Object.assign(row, { targetSessionId: sessionId, targetNodeId: NODE_A, lightWorkspaceId: ws })
  store.updateQueueEntry(row)
}

describe('LIGHT-TASK enqueue shape', () => {
  it('requires owned_paths and a code_change write mode', () => {
    const meshId = `mesh_light_shape_${randomUUID().slice(0, 8)}`
    try {
      expect(() => enqueueTask(meshId, 'x', { taskMode: 'code_change', difficulty: 'easy', light: true } as any)).toThrow(/light_requires_owned_paths/)
      expect(() => enqueueTask(meshId, 'x', { taskMode: 'code_change', difficulty: 'easy', light: true, readonly: true, ownedPaths: ['a'] } as any)).toThrow(/light_mode_conflict/)
      expect(() => enqueueTask(meshId, 'x', { taskMode: 'validation', difficulty: 'easy', light: true, ownedPaths: ['a'] } as any)).toThrow(/light_mode_conflict/)
      expect(() => enqueueTask(meshId, 'x', { taskMode: 'code_change', difficulty: 'medium', light: true, ownedPaths: ['a'], review: true } as any)).toThrow(/light_review_unsupported/)
      const ok = enqueueLight(meshId)
      expect(ok.light).toBe(true)
      expect(ok.lightBaseNodeId).toBe(NODE_A)
    } finally { cleanup(meshId) }
  })
})

describe('LIGHT-TASK central claim rule', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('a regular session (base-node idle worker) never claims a light row', () => {
    const meshId = `mesh_light_excl_${randomUUID().slice(0, 8)}`
    try {
      enqueueLight(meshId)
      expect(claim(meshId).task).toBeNull()
      // even when the row is pinned to that very session id, a session without the light binding is refused
      const row = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, MeshRuntimeStore.getInstance().getQueueEntries(meshId)[0].id)!
      pin(meshId, row.id, SESSION_A)
      expect(claim(meshId).task).toBeNull()
    } finally { cleanup(meshId) }
  })

  it('a light session claims only its own pinned light row — not unpinned light rows, not regular rows', () => {
    const meshId = `mesh_light_own_${randomUUID().slice(0, 8)}`
    try {
      const unpinned = enqueueLight(meshId)
      const regular = enqueueTask(meshId, 'regular', { taskMode: 'code_change', difficulty: 'easy' })
      expect(claim(meshId, { lightWorkspaceId: LIGHT_WS }, { sessionId: LIGHT_SESSION }).task).toBeNull()
      const mine = enqueueLight(meshId, { ownedPaths: ['src/b.ts'] })
      pin(meshId, mine.id)
      const got = claim(meshId, { lightWorkspaceId: LIGHT_WS }, { sessionId: LIGHT_SESSION })
      expect(got.task?.id).toBe(mine.id)
      expect(unpinned.id).not.toBe(got.task?.id)
      expect(regular.id).not.toBe(got.task?.id)
    } finally { cleanup(meshId) }
  })

  it('a light session bound to another workspace is refused', () => {
    const meshId = `mesh_light_ws_${randomUUID().slice(0, 8)}`
    try {
      const row = enqueueLight(meshId)
      pin(meshId, row.id)
      expect(claim(meshId, { lightWorkspaceId: 'lw_other' }, { sessionId: LIGHT_SESSION }).task).toBeNull()
    } finally { cleanup(meshId) }
  })

  it('is exempt from the dirty and stale-behind gates and never makes the node write-busy', () => {
    const meshId = `mesh_light_gates_${randomUUID().slice(0, 8)}`
    try {
      const light = enqueueLight(meshId)
      pin(meshId, light.id)
      const got = claim(meshId, { lightWorkspaceId: LIGHT_WS, nodeGitGate: { dirty: true, staleBehind: true, behind: 3, maxBehind: 0 } }, { sessionId: LIGHT_SESSION })
      expect(got.refusal).toEqual({})
      expect(got.task?.id).toBe(light.id)
      expect(MeshRuntimeStore.getInstance().assignedRowsMeshWide(meshId)).toHaveLength(1)
      expect(MeshRuntimeStore.getInstance().hasActiveNodeWriteAssignment(meshId, NODE_A)).toBe(false)
      // a second light on the same node is not serialized by the one-writer-per-node rule
      const second = enqueueLight(meshId, { ownedPaths: ['src/z.ts'] })
      pin(meshId, second.id, 'session_light_2', 'lw_test_ws2')
      const got2 = claim(meshId, { lightWorkspaceId: 'lw_test_ws2' }, { sessionId: 'session_light_2' })
      expect(got2.refusal.reason).not.toBe('node_busy_with_active_assignment')
    } finally { cleanup(meshId) }
  })

  it('a regular write assigned on the node does not block a light claim on node_busy', () => {
    const meshId = `mesh_light_busy_${randomUUID().slice(0, 8)}`
    try {
      const regular = enqueueTask(meshId, 'regular write', { taskMode: 'code_change', difficulty: 'easy', ownedPaths: ['docs/x.md'] })
      expect(claim(meshId, {}, { sessionId: 'session_regular' }).task?.id).toBe(regular.id)
      const light = enqueueLight(meshId)
      pin(meshId, light.id)
      const got = claim(meshId, { lightWorkspaceId: LIGHT_WS }, { sessionId: LIGHT_SESSION })
      // Scope-less regular writers fence every candidate physically (existing fail-closed rule); what
      // matters here is that the refusal is the ownership fence, never the light-exempt node-busy rule.
      expect(got.refusal.reason).not.toBe('node_busy_with_active_assignment')
    } finally { cleanup(meshId) }
  })

  it('light rows are isolated from in-flight writers (own private worktree), overlapping owned_paths or not', () => {
    const meshId = `mesh_light_overlap_${randomUUID().slice(0, 8)}`
    try {
      const writer = enqueueTask(meshId, 'regular', { taskMode: 'code_change', difficulty: 'easy', ownedPaths: ['src/a.ts'] })
      expect(claim(meshId, {}, { sessionId: 'session_regular' }).task?.id).toBe(writer.id)
      const light = enqueueLight(meshId)
      pin(meshId, light.id)
      const got = claim(meshId, { lightWorkspaceId: LIGHT_WS }, { sessionId: LIGHT_SESSION })
      expect(got.refusal.reason).not.toBe('owned_paths_conflict')
      expect(got.task).not.toBeNull()
    } finally { cleanup(meshId) }
  })
})

describe('node_busy hold names its blocker', () => {
  it('a write claim refused as node_busy records the busy writer id in the hold', () => {
    const meshId = `mesh_busy_names_${randomUUID().slice(0, 8)}`
    try {
      const first = enqueueTask(meshId, 'first write', { taskMode: 'code_change', difficulty: 'easy', ownedPaths: ['docs/a.md'] })
      expect(claim(meshId, {}, { sessionId: 'session_first' }).task?.id).toBe(first.id)
      const second = enqueueTask(meshId, 'second write', { taskMode: 'code_change', difficulty: 'easy', ownedPaths: ['docs/b.md'] })
      const got = claim(meshId, {}, { sessionId: 'session_second' })
      expect(got.task).toBeNull()
      expect(MeshRuntimeStore.getInstance().activeNodeWriteAssignmentIds(meshId, NODE_A)).toEqual([first.id])
      const held = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, second.id) as any
      if (held?.hold?.reason === 'node_busy_with_active_assignment') expect(held.hold.blockingTaskIds).toEqual([first.id])
    } finally { cleanup(meshId) }
  })
})

// Path-ownership gate is opt-in (default 'off'); this suite pins the legacy mesh-wide fence.
import { setPathOwnershipGateForTests as __setGate } from '../../src/mesh/mesh-path-ownership-gate.js'
import { beforeEach as __gateBefore, afterEach as __gateAfter } from 'vitest'
__gateBefore(() => __setGate('mesh_wide'))
__gateAfter(() => __setGate(undefined))
