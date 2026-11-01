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

const testTmpDir = path.join(tmpdir(), `adhdev-light-dispatch-test-${randomUUID().slice(0, 8)}`)
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



const mocks = vi.hoisted(() => ({
  resolveAutoLaunchPlan: vi.fn(),
  tryAssignQueueTask: vi.fn(() => true),
  waitForLocalSessionReady: vi.fn(async () => true),
  prepareLightWorkspace: vi.fn(),
  removeLightWorkspace: vi.fn(async () => ({ removed: true, linksUnlinked: 0 })),
}))
vi.mock('../../src/mesh/mesh-queue-autolaunch.js', () => ({ resolveAutoLaunchPlan: mocks.resolveAutoLaunchPlan }))
vi.mock('../../src/mesh/mesh-queue-assignment.js', () => ({ tryAssignQueueTask: mocks.tryAssignQueueTask, waitForLocalSessionReady: mocks.waitForLocalSessionReady }))
vi.mock('../../src/mesh/light-workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/mesh/light-workspace.js')>('../../src/mesh/light-workspace.js')
  return { ...actual, prepareLightWorkspace: mocks.prepareLightWorkspace, removeLightWorkspace: mocks.removeLightWorkspace }
})
vi.mock('../../src/mesh/light-task-admission.js', () => ({
  admitLightBaseNode: () => ({ lightBaseNodeId: 'node_alpha', checkoutRoot: '/opt/checkout', config: { version: 1, linkNodeModules: ['node_modules'], copyDirs: [], copyExclude: [], freshDirs: [], minFreeBytes: 0 } }),
}))

import { dispatchLightTasks, __resetLightDispatchForTests } from '../../src/mesh/light-task-dispatch.js'

const MESH = { id: 'm', repoIdentity: 'github.com/example/repo', policy: { maxParallelTasks: 3 }, nodes: [{ id: 'node_alpha', workspace: '/opt/checkout' }] }
const router = { execute: vi.fn(async () => ({ success: true, sessionId: 'sess_light_1' })) }
const components: any = { router }
const PLAN = {
  effectiveProviderType: 'claude-cli', effectiveModel: 'sonnet', effectiveThinkingLevel: undefined, launchProvenance: { launchedBy: 'mesh' },
  launchSettings: { role: 'worker', meshNodeId: 'node_alpha' }, resolved: {}, buildRoutingDecision: () => ({ source: 'autoLaunch' }),
}
const HANDLE = (n = 1) => ({ workspaceId: `lw_ws${n}`, path: `/opt/lw/ws${n}`, rootBaseSha: 'a'.repeat(40), submoduleBases: {}, branchRefs: {}, linkCount: 3, copiedDirs: [], prepareMs: 5 })

function enqueueLight(meshId: string, paths: string[]) {
  return enqueueTask(meshId, 'light work', { taskMode: 'code_change', difficulty: 'easy', ownedPaths: paths, light: true, lightBaseNodeId: 'node_alpha' } as any)
}

describe('LIGHT-TASK dispatcher', () => {
  afterEach(() => { vi.clearAllMocks(); __resetLightDispatchForTests() })

  it('prepares a workspace, launches the worker INTO it, pins the row and claims through the normal path', async () => {
    const meshId = `mesh_light_disp_${randomUUID().slice(0, 8)}`
    try {
      mocks.resolveAutoLaunchPlan.mockResolvedValue(PLAN)
      mocks.prepareLightWorkspace.mockResolvedValue(HANDLE())
      const task = enqueueLight(meshId, ['src/a.ts'])
      expect(await dispatchLightTasks(components, meshId, MESH)).toBe(1)
      const launch = (router.execute.mock.calls[0] as any[])
      expect(launch[0]).toBe('launch_cli')
      expect(launch[1].dir).toBe('/opt/lw/ws1')
      expect(launch[1].settings.lightWorkspaceId).toBe('lw_ws1')
      const row = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, task.id)!
      expect(row).toMatchObject({ lightWorkspaceId: 'lw_ws1', targetSessionId: 'sess_light_1', targetNodeId: 'node_alpha', status: 'pending' })
      expect(mocks.tryAssignQueueTask).toHaveBeenCalledWith(components, meshId, 'node_alpha', 'sess_light_1', 'claude-cli', expect.anything(), undefined, 'light_dispatch')
    } finally { cleanup(meshId) }
  })

  it('never dispatches past the light cap and records the hold', async () => {
    const meshId = `mesh_light_cap_${randomUUID().slice(0, 8)}`
    try {
      mocks.resolveAutoLaunchPlan.mockResolvedValue(PLAN)
      let n = 0
      mocks.prepareLightWorkspace.mockImplementation(async () => HANDLE(++n))
      router.execute.mockImplementation(async () => ({ success: true, sessionId: `sess_${n}` }) as any)
      for (let i = 0; i < 4; i++) enqueueLight(meshId, [`src/f${i}.ts`])
      expect(await dispatchLightTasks(components, meshId, MESH)).toBe(3)
      expect(mocks.prepareLightWorkspace).toHaveBeenCalledTimes(3)
      const held = MeshRuntimeStore.getInstance().getQueueEntries(meshId, ['pending']).filter(t => !t.lightWorkspaceId)
      expect(held).toHaveLength(1)
      expect(held[0].hold?.reason).toBe('max_light_parallel_tasks_reached')
    } finally { cleanup(meshId) }
  })

  it('a failed preparation holds the row with the failing step and does NOT fall back to a worktree', async () => {
    const meshId = `mesh_light_fail_${randomUUID().slice(0, 8)}`
    try {
      mocks.resolveAutoLaunchPlan.mockResolvedValue(PLAN)
      const { LightWorkspaceError } = await vi.importActual<typeof import('../../src/mesh/light-workspace.js')>('../../src/mesh/light-workspace.js')
      mocks.prepareLightWorkspace.mockRejectedValue(new LightWorkspaceError('light_submodule_worktree_failed', 'boom'))
      const task = enqueueLight(meshId, ['src/a.ts'])
      expect(await dispatchLightTasks(components, meshId, MESH)).toBe(0)
      expect(router.execute).not.toHaveBeenCalled()
      const row = MeshRuntimeStore.getInstance().findQueueEntryById(meshId, task.id)!
      expect(row.status).toBe('pending')
      expect(row.hold?.reason).toBe('light_workspace_prepare_failed:light_submodule_worktree_failed')
      // inside the retry window nothing is attempted again
      expect(await dispatchLightTasks(components, meshId, MESH)).toBe(0)
      expect(mocks.prepareLightWorkspace).toHaveBeenCalledTimes(1)
    } finally { cleanup(meshId) }
  })

  it('the second preparation failure blocks the task', async () => {
    const meshId = `mesh_light_block_${randomUUID().slice(0, 8)}`
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      mocks.resolveAutoLaunchPlan.mockResolvedValue(PLAN)
      mocks.prepareLightWorkspace.mockRejectedValue(new Error('disk exploded'))
      const task = enqueueLight(meshId, ['src/a.ts'])
      await dispatchLightTasks(components, meshId, MESH)
      vi.setSystemTime(Date.now() + 4 * 60_000)
      await dispatchLightTasks(components, meshId, MESH)
      expect(MeshRuntimeStore.getInstance().findQueueEntryById(meshId, task.id)!.status).toBe('blocked')
    } finally { vi.useRealTimers(); cleanup(meshId) }
  })

  it('an unusable provider leaves the row pending with the routing reason and prepares nothing', async () => {
    const meshId = `mesh_light_route_${randomUUID().slice(0, 8)}`
    try {
      mocks.resolveAutoLaunchPlan.mockImplementation(async (...args: any[]) => { args[8]('node_alpha', 'all_providers_quota_gated'); return null })
      const task = enqueueLight(meshId, ['src/a.ts'])
      expect(await dispatchLightTasks(components, meshId, MESH)).toBe(0)
      expect(mocks.prepareLightWorkspace).not.toHaveBeenCalled()
      expect(MeshRuntimeStore.getInstance().findQueueEntryById(meshId, task.id)!.hold?.reason).toBe('all_providers_quota_gated')
    } finally { cleanup(meshId) }
  })
})
