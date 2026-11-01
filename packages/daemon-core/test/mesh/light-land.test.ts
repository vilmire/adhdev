import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
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

const testTmpDir = path.join(tmpdir(), `adhdev-light-land-test-${randomUUID().slice(0, 8)}`)
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



import { execFileSync } from 'child_process'
import { captureLightTaskResult } from '../../src/mesh/light-task-result.js'
import { refineResolveLightRefsStage } from '../../src/commands/router-refine-light.js'
import { validateLightLandRequest, prepareLightLandBatch, removeLightLandBatch, applyLightResultsToCheckout } from '../../src/mesh/light-land.js'
import { setLightWorkspaceFingerprint } from '../../src/mesh/mesh-light-workspace-store.js'
import { prepareLightWorkspace } from '../../src/mesh/light-workspace.js'
import { takeLightCheckoutFingerprint } from '../../src/mesh/light-checkout-fingerprint.js'
import { validateLightWorkspaceConfig } from '../../src/mesh/light-workspace-config.js'
import { validateWorkerCompletionReport } from '../../src/mesh/worker-report-validation.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim()
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }


describe('LIGHT-TASK landing core (real git)', () => {
  let tmp: string, checkout: string, cfg: any, meshId: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'lw-land-')))
    const subSrc = path.join(tmp, 'sub-src'); fs.mkdirSync(subSrc); git(subSrc, 'init', '-q', '-b', 'main')
    write(path.join(subSrc, 'a.txt'), 'sub\n'); write(path.join(subSrc, 'b.txt'), 'sub-b\n'); git(subSrc, 'add', '.'); git(subSrc, 'commit', '-q', '-m', 'sub')
    checkout = path.join(tmp, 'checkout'); fs.mkdirSync(checkout); git(checkout, 'init', '-q', '-b', 'main')
    write(path.join(checkout, '.gitignore'), 'node_modules/\ndist/\n')
    write(path.join(checkout, 'one.txt'), '1\n'); write(path.join(checkout, 'two.txt'), '2\n')
    git(checkout, 'submodule', 'add', '-q', subSrc, 'oss'); git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'root')
    write(path.join(checkout, 'node_modules/leftpad/index.js'), 'x\n')
    const v = validateLightWorkspaceConfig({ version: 1, baseDir: path.join(tmp, 'lwbase'), linkNodeModules: ['node_modules'], minFreeBytes: 1 })
    if (!v.ok) throw new Error(v.message)
    cfg = v.config
    meshId = `mesh_light_land_${randomUUID().slice(0, 8)}`
    meshConfigMocks.getMesh.mockReturnValue({ id: meshId, repoIdentity: 'github.com/example/repo' })
  })
  afterEach(() => { cleanup(meshId); fs.rmSync(tmp, { recursive: true, force: true }) })

  async function lightTask(ownedPaths: string[], work: (wsPath: string) => void) {
    const row = enqueueTask(meshId, 'light work', { taskMode: 'code_change', difficulty: 'easy', ownedPaths, light: true, lightBaseNodeId: 'n' } as any)
    const store = MeshRuntimeStore.getInstance()
    const ws = await prepareLightWorkspace({ meshId, taskId: row.id, checkoutRoot: checkout, config: cfg, db: store.db })
    setLightWorkspaceFingerprint(store.db, ws.workspaceId, await takeLightCheckoutFingerprint(checkout, cfg.linkNodeModules, ['oss']))
    const fresh = store.findQueueEntryById(meshId, row.id)!
    Object.assign(fresh, { lightWorkspaceId: ws.workspaceId, targetSessionId: `s_${row.id}`, assignedSessionId: `s_${row.id}`, status: 'assigned' })
    store.updateQueueEntry(fresh)
    work(ws.path)
    const res = await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } })
    return { id: row.id, res: res!, store }
  }
  const commitIn = (dir: string, file: string, content: string, msg = 'work') => { write(path.join(dir, file), content); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', msg) }
  const bumpOss = (wsPath: string, file: string, content: string) => { commitIn(path.join(wsPath, 'oss'), file, content); git(wsPath, 'add', 'oss'); git(wsPath, 'commit', '-q', '-m', 'bump oss') }

  it('lands two results (each touching root + the submodule) as one land branch with a consistent submodule pointer', async () => {
    const a = await lightTask(['one.txt', 'oss/**'], w => { commitIn(w, 'one.txt', 'A\n'); bumpOss(w, 'a.txt', 'subA\n') })
    const b = await lightTask(['two.txt', 'oss/**'], w => { commitIn(w, 'two.txt', 'B\n'); bumpOss(w, 'b.txt', 'subB\n') })
    expect(a.res.landing).toBe('ready'); expect(b.res.landing).toBe('ready')
    const store = MeshRuntimeStore.getInstance()
    const v = validateLightLandRequest(store.db, { taskIds: [a.id, b.id] }, id => store.findQueueEntryById(meshId, id))
    expect(v.ok).toBe(true)
    const prep = await prepareLightLandBatch({ db: store.db, meshId, batchId: 'batch0001', checkoutRoot: checkout, config: cfg, candidates: (v as any).candidates })
    expect(prep.conflict).toBeUndefined()
    expect(prep.landed).toEqual([a.id, b.id])
    const land = prep.handle.path
    expect(fs.readFileSync(path.join(land, 'one.txt'), 'utf8')).toBe('A\n')
    expect(fs.readFileSync(path.join(land, 'two.txt'), 'utf8')).toBe('B\n')
    expect(fs.readFileSync(path.join(land, 'oss/a.txt'), 'utf8')).toBe('subA\n')
    expect(fs.readFileSync(path.join(land, 'oss/b.txt'), 'utf8')).toBe('subB\n')
    expect(git(land, 'rev-parse', 'HEAD:oss')).toBe(git(path.join(land, 'oss'), 'rev-parse', 'HEAD'))
    expect(git(land, 'status', '--porcelain')).toBe('')
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(prep.baseSha) // the checkout itself is untouched
    await removeLightLandBatch(prep, { db: store.db, checkoutRoot: checkout, config: cfg })
    expect(fs.existsSync(land)).toBe(false)
  })

  it('stops at the first conflicting result and reports where', async () => {
    const a = await lightTask(['one.txt'], w => commitIn(w, 'one.txt', 'A\n'))
    const b = await lightTask(['one.txt'], w => commitIn(w, 'one.txt', 'B\n'))
    const store = MeshRuntimeStore.getInstance()
    const v = validateLightLandRequest(store.db, { taskIds: [a.id, b.id] }, id => store.findQueueEntryById(meshId, id)) as any
    const prep = await prepareLightLandBatch({ db: store.db, meshId, batchId: 'batch0002', checkoutRoot: checkout, config: cfg, candidates: v.candidates })
    expect(prep.landed).toEqual([a.id])
    expect(prep.conflict).toMatchObject({ taskId: b.id, where: '.' })
    expect(prep.conflict!.paths).toContain('one.txt')
  })

  it('refuses blocked results and paths outside owned_paths unless accepted', async () => {
    const out = await lightTask(['one.txt'], w => { commitIn(w, 'one.txt', 'A\n'); commitIn(w, 'two.txt', 'X\n') })
    const store = MeshRuntimeStore.getInstance()
    const find = (id: string) => store.findQueueEntryById(meshId, id)
    expect(validateLightLandRequest(store.db, { taskIds: [out.id] }, find)).toMatchObject({ ok: false, refusal: { code: 'light_paths_outside_owned' } })
    expect(validateLightLandRequest(store.db, { taskIds: [out.id], acceptPathsOutsideOwned: true }, find).ok).toBe(true)
    const dirty = await lightTask(['one.txt'], w => write(path.join(w, 'one.txt'), 'dirty\n'))
    expect(validateLightLandRequest(store.db, { taskIds: [dirty.id] }, find)).toMatchObject({ ok: false, refusal: { code: 'light_not_landable' } })
    expect(validateLightLandRequest(store.db, { taskIds: ['nope'] }, find)).toMatchObject({ ok: false, refusal: { code: 'light_task_not_found' } })
  })

  it('apply_to_checkout applies staged-but-uncommitted, and refuses a dirty target path', async () => {
    const a = await lightTask(['one.txt', 'oss/**'], w => { commitIn(w, 'one.txt', 'A\n'); bumpOss(w, 'a.txt', 'subA\n') })
    const store = MeshRuntimeStore.getInstance()
    const v = validateLightLandRequest(store.db, { taskIds: [a.id] }, id => store.findQueueEntryById(meshId, id)) as any
    write(path.join(checkout, 'one.txt'), 'owner edit\n')
    expect(await applyLightResultsToCheckout(checkout, v.candidates)).toMatchObject({ ok: false, failed: { reason: 'checkout_paths_not_clean' } })
    git(checkout, 'checkout', '--', 'one.txt')
    const head = git(checkout, 'rev-parse', 'HEAD')
    expect(await applyLightResultsToCheckout(checkout, v.candidates)).toMatchObject({ ok: true, applied: [a.id] })
    expect(fs.readFileSync(path.join(checkout, 'one.txt'), 'utf8')).toBe('A\n')
    expect(fs.readFileSync(path.join(checkout, 'oss/a.txt'), 'utf8')).toBe('subA\n')
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head) // nothing committed
  })

  it('the refine pipeline resolves the land workspace as a branch worktree and carries the light target', async () => {
    const a = await lightTask(['one.txt'], w => commitIn(w, 'one.txt', 'A\n'))
    const store = MeshRuntimeStore.getInstance()
    const v = validateLightLandRequest(store.db, { taskIds: [a.id] }, id => store.findQueueEntryById(meshId, id)) as any
    const prep = await prepareLightLandBatch({ db: store.db, meshId, batchId: 'batch0003', checkoutRoot: checkout, config: cfg, candidates: v.candidates })
    const target = { profile: 'fast', cleanup: async () => ({ success: true }) }
    const node = { id: 'light-land-x', workspace: prep.handle.path, isLocalWorktree: true }
    const stages: Array<Record<string, unknown>> = []
    const out = await refineResolveLightRefsStage({} as any, meshId, 'light-land-x', {}, stages,
      { mesh: { id: meshId, nodes: [node] }, node, sourceNode: { id: 'base' }, repoRoot: checkout, target })
    expect(out.kind).toBe('continue')
    const ctx = (out as any).ctx
    expect(ctx).toMatchObject({ branch: prep.branch, baseBranch: 'main', lightTarget: target })
    expect(ctx.branchHead).toBe(git(prep.handle.path, 'rev-parse', 'HEAD'))
    expect(ctx.baseHead).toBe(prep.baseSha)
  })
})
