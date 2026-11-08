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

const testTmpDir = path.join(tmpdir(), `adhdev-path-gate-test-${randomUUID().slice(0, 8)}`)
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
import { evaluateTaskOwnedPathsAdmission, findTaskOwnedPathsConflicts } from '../../src/mesh/mesh-runtime-store-claim.js'

const NODE_A = 'node_alpha'
const NODE_B = 'node_beta'

function claim(meshId: string, nodeId: string, sessionId: string) {
  const refusal: MeshClaimRefusal = {}
  const task = MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, nodeId, sessionId, [], { outRefusal: refusal })
  return { task, refusal }
}
function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}
function policy(gate?: string) {
  meshConfigMocks.getMesh.mockReturnValue(gate ? { policy: { pathOwnershipGate: gate } } : { policy: {} })
}
const code = (paths?: string[]) => ({ taskMode: 'code_change' as const, difficulty: 'medium' as const, ...(paths ? { ownedPaths: paths } : {}) })

describe('pathOwnershipGate policy (default off) — owned_paths are advisory', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('default: live case — writer WITHOUT owned_paths in one node does not hold a task in another node', () => {
    const meshId = `mesh_pg_live_${randomUUID().slice(0, 8)}`
    try {
      policy()
      enqueueTask(meshId, 'f7e7cb04-like fix without scope', { ...code(), targetNodeId: NODE_A })
      expect(claim(meshId, NODE_A, 's_a').task).not.toBeNull()
      enqueueTask(meshId, 'a9497cce-like fix', { ...code(['src/mesh/**']), targetNodeId: NODE_B })
      const { task, refusal } = claim(meshId, NODE_B, 's_b')
      expect(refusal.reason).toBeUndefined()
      expect(task).not.toBeNull()
    } finally { cleanup(meshId) }
  })

  it('default: overlapping owned_paths in two different checkouts both claim', () => {
    const meshId = `mesh_pg_overlap_${randomUUID().slice(0, 8)}`
    try {
      policy()
      enqueueTask(meshId, 'first', { ...code(['src/mesh/mesh-work-queue.ts']), targetNodeId: NODE_A })
      expect(claim(meshId, NODE_A, 's_a').task).not.toBeNull()
      enqueueTask(meshId, 'second', { ...code(['src/mesh/**']), targetNodeId: NODE_B })
      expect(claim(meshId, NODE_B, 's_b').task).not.toBeNull()
      const second = MeshRuntimeStore.getInstance().getQueueEntries(meshId, ['assigned']).find(t => t.assignedNodeId === NODE_B)!
      expect(second.hold).toBeUndefined()
      expect(evaluateTaskOwnedPathsAdmission(MeshRuntimeStore.getInstance(), meshId, { ...code(['src/mesh/**']) }).allowed).toBe(true)
    } finally { cleanup(meshId) }
  })

  it('default: the same checkout still runs ONE writer (node_busy_with_active_assignment stays)', () => {
    const meshId = `mesh_pg_samenode_${randomUUID().slice(0, 8)}`
    try {
      policy()
      enqueueTask(meshId, 'first', code(['a.ts']))
      expect(claim(meshId, NODE_A, 's_a').task).not.toBeNull()
      enqueueTask(meshId, 'second', code(['b.ts']))
      const { task, refusal } = claim(meshId, NODE_A, 's_a2')
      expect(task).toBeNull()
      expect(refusal.reason).toBe('node_busy_with_active_assignment')
    } finally { cleanup(meshId) }
  })

  it('mesh_wide: the legacy fence — sibling node overlap is refused with owned_paths_conflict', () => {
    const meshId = `mesh_pg_wide_${randomUUID().slice(0, 8)}`
    try {
      policy('mesh_wide')
      const first = enqueueTask(meshId, 'first', { ...code(['src/mesh/mesh-work-queue.ts']), targetNodeId: NODE_A })
      expect(claim(meshId, NODE_A, 's_a').task?.id).toBe(first.id)
      enqueueTask(meshId, 'second', { ...code(['src/mesh/**']), targetNodeId: NODE_B })
      const { task, refusal } = claim(meshId, NODE_B, 's_b')
      expect(task).toBeNull()
      expect(refusal.reason).toBe('owned_paths_conflict')
      expect(refusal.detail).toContain(first.id)
    } finally { cleanup(meshId) }
  })

  it('same_checkout: a writer in another checkout never blocks, even without a scope', () => {
    const meshId = `mesh_pg_same_${randomUUID().slice(0, 8)}`
    try {
      policy('same_checkout')
      enqueueTask(meshId, 'first no scope', { ...code(), targetNodeId: NODE_A })
      expect(claim(meshId, NODE_A, 's_a').task).not.toBeNull()
      enqueueTask(meshId, 'second', { ...code(['src/**']), targetNodeId: NODE_B })
      expect(claim(meshId, NODE_B, 's_b').task).not.toBeNull()
    } finally { cleanup(meshId) }
  })
})

describe('findTaskOwnedPathsConflicts — gate modes', () => {
  const writerA = { taskId: 'wa', paths: { paths: [{ path: 'src', subtree: true }] }, checkout: { nodeId: NODE_A } }
  const unscopedA = { taskId: 'ua', paths: { paths: [{ path: '', subtree: true }] }, checkout: { nodeId: NODE_A } }
  const cand = { id: 'c', taskMode: 'code_change' as const, ownedPaths: { paths: [{ path: 'src/x.ts', subtree: false }] } } as any

  it('off: never a conflict', () => {
    expect(findTaskOwnedPathsConflicts(cand, [writerA, unscopedA], undefined, { nodeId: NODE_A, gate: 'off' })).toEqual([])
  })
  it('same_checkout: only the same checkout blocks (unscoped writer included)', () => {
    expect(findTaskOwnedPathsConflicts(cand, [unscopedA], undefined, { nodeId: NODE_A, gate: 'same_checkout' }).length).toBeGreaterThan(0)
    expect(findTaskOwnedPathsConflicts(cand, [writerA, unscopedA], undefined, { nodeId: NODE_B, gate: 'same_checkout' })).toEqual([])
  })
  it('mesh_wide: any checkout blocks', () => {
    expect(findTaskOwnedPathsConflicts(cand, [unscopedA], undefined, { nodeId: NODE_B, gate: 'mesh_wide' }).length).toBeGreaterThan(0)
  })
  it('a light workspace is private in every mode', () => {
    const light = { taskId: 'l', paths: { paths: [{ path: '', subtree: true }] }, checkout: { light: 'ws1' } }
    expect(findTaskOwnedPathsConflicts(cand, [light], undefined, { nodeId: NODE_B, gate: 'mesh_wide' })).toEqual([])
  })
})
