import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Dirty-workspace rule for write dispatches — fixed per node type, no policy knob
// (docs/design/2026-10-07-mesh-workspace-policy.md §B). One table; the claim store
// (nodeGitGate), auto-launch and the mcp-server direct send all decide through
// mesh-dirty-write-verdict.ts. This suite pins the table itself and replays the SAME
// rows through the atomic claim store, so the claim path cannot drift from it.

const testTmpDir = path.join(tmpdir(), `adhdev-dirty-verdict-test-${randomUUID().slice(0, 8)}`)
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

import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore, type MeshClaimRefusal } from '../../src/mesh/mesh-runtime-store.js'
import {
  dirtyWriteVerdict,
  readDirtyWriteGate,
  resolveDirtyWriteVerdict,
  buildBranchContinuationNotice,
  type DirtyWriteVerdict,
} from '../../src/mesh/mesh-dirty-write-verdict.js'

const NODE_ID = 'node_wt'
const BRANCH = 'feat/x'

const baseNode = (dirty: boolean) => ({ id: NODE_ID, workspace: '/repo', ...(dirty ? { git: { dirty: true } } : {}) })
const worktreeNode = (dirty: boolean) => ({
  id: NODE_ID, workspace: '/wt/feat-x', isLocalWorktree: true, worktreeBranch: BRANCH,
  ...(dirty ? { health: 'dirty', git: { dirty: true, modified: 2, untracked: 1 } } : {}),
})

type Binding = 'readonly' | 'target' | 'tag' | 'other_branch' | 'unbound'
const taskFor = (binding: Binding) => {
  switch (binding) {
    case 'readonly': return { readonly: true, taskMode: 'live_debug_readonly' }
    case 'target': return { taskMode: 'code_change', targetNodeId: NODE_ID }
    case 'tag': return { taskMode: 'code_change', requiredTags: [`worktree=${BRANCH}`] }
    case 'other_branch': return { taskMode: 'code_change', requiredTags: ['worktree=feat/other'] }
    case 'unbound': return { taskMode: 'code_change' }
  }
}

// The design table, row for row (node type × dirty × task binding).
const MATRIX: Array<{ node: 'base' | 'worktree'; dirty: boolean; binding: Binding; verdict: DirtyWriteVerdict }> = [
  ...(['readonly', 'target', 'tag', 'other_branch', 'unbound'] as Binding[]).flatMap(binding => [
    { node: 'base' as const, dirty: false, binding, verdict: 'proceed' as const },
    { node: 'worktree' as const, dirty: false, binding, verdict: 'proceed' as const },
  ]),
  { node: 'base', dirty: true, binding: 'readonly', verdict: 'proceed' },
  { node: 'base', dirty: true, binding: 'target', verdict: 'refuse' },
  { node: 'base', dirty: true, binding: 'tag', verdict: 'refuse' },
  { node: 'base', dirty: true, binding: 'other_branch', verdict: 'refuse' },
  { node: 'base', dirty: true, binding: 'unbound', verdict: 'refuse' },
  { node: 'worktree', dirty: true, binding: 'readonly', verdict: 'proceed' },
  { node: 'worktree', dirty: true, binding: 'target', verdict: 'branch_continuation' },
  { node: 'worktree', dirty: true, binding: 'tag', verdict: 'branch_continuation' },
  { node: 'worktree', dirty: true, binding: 'other_branch', verdict: 'refuse' },
  { node: 'worktree', dirty: true, binding: 'unbound', verdict: 'refuse' },
]

describe('resolveDirtyWriteVerdict — the fixed per-node-type table', () => {
  it.each(MATRIX)('$node dirty=$dirty task=$binding → $verdict', ({ node, dirty, binding, verdict }) => {
    const record = node === 'base' ? baseNode(dirty) : worktreeNode(dirty)
    expect(resolveDirtyWriteVerdict(record, taskFor(binding))).toBe(verdict)
  })

  it('a worktree flag without a branch is a base node (no branch to continue)', () => {
    expect(resolveDirtyWriteVerdict({ id: NODE_ID, isLocalWorktree: true, git: { dirty: true } }, taskFor('target'))).toBe('refuse')
  })

  it('takes no policy argument — a retired dirtyWorkspaceBehavior on the mesh cannot loosen or tighten it', () => {
    expect(resolveDirtyWriteVerdict.length).toBe(2)
  })

  it('the continuation notice names the branch, the count and the commit duty', () => {
    const notice = buildBranchContinuationNotice(BRANCH, 3)
    expect(notice).toContain(BRANCH)
    expect(notice).toContain('3 uncommitted')
    expect(notice).toMatch(/commit before you finish/)
  })
})

describe('claim store applies the same table (nodeGitGate)', () => {
  afterEach(() => {
    __resetMeshRuntimeStoreForTests()
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it.each(MATRIX.filter(row => row.dirty))('$node dirty task=$binding → claim ${verdict}', ({ node, binding, verdict }) => {
    const meshId = `mesh_dirty_verdict_${randomUUID().slice(0, 8)}`
    try {
      const task = taskFor(binding) as any
      enqueueTask(meshId, 'work', {
        difficulty: 'medium',
        ...(task.readonly ? { readonly: true, taskMode: 'live_debug_readonly' } : { taskMode: 'code_change' }),
        ...(task.targetNodeId ? { targetNodeId: task.targetNodeId } : {}),
        ...(task.requiredTags ? { requiredTags: task.requiredTags } : {}),
      } as any)
      const record = node === 'base' ? baseNode(true) : worktreeNode(true)
      const gate = readDirtyWriteGate(record)
      // Capability tags as the node advertises them (worktree=<branch> on a worktree),
      // so tag-bound rows reach the dirty gate instead of the tag filter.
      const tags = node === 'worktree' ? [`worktree=${BRANCH}`, 'worktree=feat/other'] : ['worktree=feat/x', 'worktree=feat/other']
      const refusal: MeshClaimRefusal = {}
      const claimed = MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, NODE_ID, 'session_1', tags, {
        nodeGitGate: { ...gate, staleBehind: false },
        outRefusal: refusal,
      })
      if (verdict === 'refuse') {
        expect(claimed).toBeNull()
        expect(refusal.reason).toBe('dirty_workspace')
        expect(refusal.detail).toContain(node === 'base' ? 'dirty base node' : `not bound to branch ${BRANCH}`)
      } else {
        expect(claimed?.status).toBe('assigned')
      }
      expect(dirtyWriteVerdict(gate, task)).toBe(verdict)
    } finally {
      __clearMeshQueueForTests(meshId)
    }
  })
})
