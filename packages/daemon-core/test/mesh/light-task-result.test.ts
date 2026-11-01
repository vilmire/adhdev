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

const testTmpDir = path.join(tmpdir(), `adhdev-light-result-test-${randomUUID().slice(0, 8)}`)
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
import { setLightWorkspaceFingerprint } from '../../src/mesh/mesh-light-workspace-store.js'
import { prepareLightWorkspace } from '../../src/mesh/light-workspace.js'
import { takeLightCheckoutFingerprint } from '../../src/mesh/light-checkout-fingerprint.js'
import { validateLightWorkspaceConfig } from '../../src/mesh/light-workspace-config.js'
import { validateWorkerCompletionReport } from '../../src/mesh/worker-report-validation.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim()
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }

describe('LIGHT-TASK result capture (real git)', () => {
  let tmp: string, checkout: string, cfg: any, meshId: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'lw-result-')))
    const subSrc = path.join(tmp, 'sub-src'); fs.mkdirSync(subSrc); git(subSrc, 'init', '-q', '-b', 'main')
    write(path.join(subSrc, 'a.txt'), 'sub\n'); git(subSrc, 'add', '.'); git(subSrc, 'commit', '-q', '-m', 'sub')
    checkout = path.join(tmp, 'checkout'); fs.mkdirSync(checkout); git(checkout, 'init', '-q', '-b', 'main')
    write(path.join(checkout, '.gitignore'), 'node_modules/\ndist/\n')
    write(path.join(checkout, 'package.json'), '{"name":"root","dependencies":{"a":"1.0.0"}}\n')
    write(path.join(checkout, 'src.txt'), 'line1\nline2\nline3\n'); write(path.join(checkout, 'other.txt'), 'other\n')
    git(checkout, 'submodule', 'add', '-q', subSrc, 'oss'); git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'root')
    write(path.join(checkout, 'node_modules/leftpad/index.js'), 'x\n')
    const v = validateLightWorkspaceConfig({ version: 1, baseDir: path.join(tmp, 'lwbase'), linkNodeModules: ['node_modules'], minFreeBytes: 1 })
    if (!v.ok) throw new Error(v.message)
    cfg = v.config
    meshId = `mesh_light_result_${randomUUID().slice(0, 8)}`
    meshConfigMocks.getMesh.mockReturnValue({ id: meshId, repoIdentity: 'github.com/example/repo' })
  })
  afterEach(() => { cleanup(meshId); fs.rmSync(tmp, { recursive: true, force: true }) })

  async function setup(ownedPaths = ['src.txt', 'oss/**']) {
    const row = enqueueTask(meshId, 'light work', { taskMode: 'code_change', difficulty: 'easy', ownedPaths, light: true, lightBaseNodeId: 'node_alpha' } as any)
    const store = MeshRuntimeStore.getInstance()
    const ws = await prepareLightWorkspace({ meshId, taskId: row.id, checkoutRoot: checkout, config: cfg, db: store.db })
    setLightWorkspaceFingerprint(store.db, ws.workspaceId, await takeLightCheckoutFingerprint(checkout, cfg.linkNodeModules, ['oss']))
    const fresh = store.findQueueEntryById(meshId, row.id)!
    Object.assign(fresh, { lightWorkspaceId: ws.workspaceId, targetSessionId: `sess_${row.id}`, assignedSessionId: `sess_${row.id}`, status: 'assigned' })
    store.updateQueueEntry(fresh)
    return { row, ws, store }
  }
  const commitIn = (dir: string, file: string, content: string) => { write(path.join(dir, file), content); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'work') }
  const resultOf = (store: MeshRuntimeStore, id: string) => store.findQueueEntryById(meshId, id)!

  it('a committed root + submodule change is ready: artifacts, apply-check clean, source candidate', async () => {
    const { row, ws, store } = await setup()
    commitIn(ws.path, 'src.txt', 'line1\nCHANGED\nline3\n')
    commitIn(path.join(ws.path, 'oss'), 'a.txt', 'sub2\n')
    git(ws.path, 'add', 'oss'); git(ws.path, 'commit', '-q', '-m', 'bump oss')
    const res = await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed', testsRun: [{ command: 'vitest run a', exit: 0, passed: 3 }] } })
    expect(res).toMatchObject({ landing: 'ready', branch: expect.stringMatching(/^mesh\/light\//) })
    expect(res!.touchedPaths).toEqual(['oss', 'oss/a.txt', 'src.txt'])
    expect(res!.applyCheck?.head.status).toBe('clean')
    expect(res!.patchArtifactIds.length).toBe(2)
    expect(res!.sourceCandidate).toMatchObject({ readiness: 'verified_source_candidate', rootBaseSha: ws.rootBaseSha, repoIdentity: 'github.com/example/repo' })
    expect(res!.sourceCandidate!.tests).toEqual([{ command: 'vitest run a', exit: 0, logSha256: '' }])
    expect(resultOf(store, row.id).lightResult?.landing).toBe('ready')
    const art = store.db.prepare('SELECT producer_role AS r, kind FROM session_artifacts WHERE task_id = ?').all(row.id) as any[]
    expect(art.every(a => a.r === 'pipeline' && a.kind === 'diff')).toBe(true)
  })

  it('uncommitted changes block the result and keep the diff as an artifact; the task row becomes blocked', async () => {
    const { row, ws, store } = await setup()
    write(path.join(ws.path, 'src.txt'), 'dirty\n')
    const res = await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } })
    expect(res).toMatchObject({ landing: 'blocked', blockedReason: 'light_uncommitted_changes' })
    expect(res!.patchArtifactIds).toHaveLength(1)
    expect(resultOf(store, row.id).status).toBe('blocked')
  })

  it('a dependency change (package.json dependencies) blocks but preserves the patch', async () => {
    const { row, ws } = await setup(['package.json'])
    commitIn(ws.path, 'package.json', '{"name":"root","dependencies":{"a":"2.0.0"}}\n')
    const res = await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } })
    expect(res).toMatchObject({ landing: 'blocked', blockedReason: 'light_dependency_change', blockedDetail: 'package.json' })
    expect(res!.patchArtifactIds).toHaveLength(1)
  })

  it('a non-dependency package.json edit (description) does not block', async () => {
    const { row, ws } = await setup(['package.json'])
    commitIn(ws.path, 'package.json', '{"name":"root","description":"x","dependencies":{"a":"1.0.0"}}\n')
    expect((await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } }))!.landing).toBe('ready')
  })

  it('reports merge-tree conflict paths when the base moved under the same lines', async () => {
    const { row, ws } = await setup()
    commitIn(ws.path, 'src.txt', 'line1\nWORKER\nline3\n')
    commitIn(checkout, 'src.txt', 'line1\nCOORDINATOR\nline3\n')
    const res = await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } })
    expect(res).toMatchObject({ landing: 'conflict' })
    expect(res!.applyCheck?.head).toMatchObject({ status: 'conflict', conflictPaths: ['src.txt'] })
  })

  it('shared checkout edits overlapping the task block it; unrelated edits only warn', async () => {
    const a = await setup()
    commitIn(a.ws.path, 'src.txt', 'line1\nWORKER\nline3\n')
    write(path.join(checkout, 'src.txt'), 'edited behind our back\n') // uncommitted edit of an owned path
    const blocked = await captureLightTaskResult({ meshId, taskId: a.row.id, report: { outcome: 'completed' } })
    expect(blocked).toMatchObject({ landing: 'blocked', blockedReason: 'shared_checkout_mutated' })
    git(checkout, 'checkout', '--', 'src.txt')

    const b = await setup(['other.txt'])
    commitIn(b.ws.path, 'other.txt', 'worker\n')
    write(path.join(checkout, 'src.txt'), 'owner edit elsewhere\n') // not owned, not touched
    const warned = await captureLightTaskResult({ meshId, taskId: b.row.id, report: { outcome: 'completed' } })
    expect(warned).toMatchObject({ landing: 'ready', warnings: ['shared_checkout_changed_during_task'] })
  })

  it('a changed node_modules top level blocks the result', async () => {
    const { row, ws } = await setup()
    commitIn(ws.path, 'src.txt', 'line1\nWORKER\nline3\n')
    write(path.join(checkout, 'node_modules/newpkg/index.js'), 'x\n')
    expect(await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } })).toMatchObject({ landing: 'blocked', blockedReason: 'shared_checkout_mutated' })
  })

  it('a deleted baseline fails closed and keeps the patch artifacts', async () => {
    const { row, ws, store } = await setup()
    commitIn(ws.path, 'src.txt', 'line1\nWORKER\nline3\n')
    store.db.prepare('UPDATE mesh_light_workspaces SET fingerprint_json = NULL WHERE workspace_id = ?').run(ws.workspaceId)
    const res = await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } })
    expect(res).toMatchObject({ landing: 'blocked', blockedReason: 'shared_checkout_mutated', blockedDetail: 'baseline_missing' })
    expect(res!.patchArtifactIds.length).toBeGreaterThan(0)
  })

  it('files a worker plants next to the workspace cannot supply or alter the baseline', async () => {
    const { row, ws, store } = await setup()
    commitIn(ws.path, 'src.txt', 'line1\nWORKER\nline3\n')
    store.db.prepare('UPDATE mesh_light_workspaces SET fingerprint_json = NULL WHERE workspace_id = ?').run(ws.workspaceId)
    const forged = JSON.stringify(await takeLightCheckoutFingerprint(checkout, cfg.linkNodeModules, ['oss']))
    fs.writeFileSync(`${ws.path}.adhdev-light-fp.json`, forged)
    expect((await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'completed' } }))).toMatchObject({ landing: 'blocked', blockedDetail: 'baseline_missing' })
  })

  it('a non-completed report records no result and marks the workspace failed', async () => {
    const { row, ws, store } = await setup()
    expect(await captureLightTaskResult({ meshId, taskId: row.id, report: { outcome: 'blocked' } })).toBeNull()
    expect((store.db.prepare('SELECT state FROM mesh_light_workspaces WHERE workspace_id = ?').get(ws.workspaceId) as any).state).toBe('failed')
  })
})

describe('worker report testsRun', () => {
  it('accepts a bounded testsRun list and rejects malformed entries', () => {
    const ok = validateWorkerCompletionReport({ outcome: 'completed', summary: 's', touchedFiles: [], testsRun: [{ command: 'vitest run x', exit: 0, passed: 2 }] })
    expect(ok.report?.testsRun).toEqual([{ command: 'vitest run x', exit: 0, passed: 2 }])
    expect(validateWorkerCompletionReport({ outcome: 'completed', summary: 's', testsRun: [{ command: '', exit: 'x' }] }).errors.map(e => e.field)).toEqual(expect.arrayContaining(['testsRun[0].command', 'testsRun[0].exit']))
    expect(validateWorkerCompletionReport({ outcome: 'completed', summary: 's', testsRun: Array.from({ length: 21 }, () => ({ command: 'c', exit: 0 })) }).errors[0].field).toBe('testsRun')
  })
})
