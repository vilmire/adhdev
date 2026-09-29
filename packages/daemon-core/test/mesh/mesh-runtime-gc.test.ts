// ---------------------------------------------------------------------------
// mesh-runtime.db 자동 GC (SoT 1-11 / gaps I-9, I-10)
//
//  (a) assigned-zombie sweep — RETIRED 2026-09-23 with the reconcile loop
//      (wiring-unification C4): a stuck assigned row cannot exist once the queue
//      status is a ledger commit effect; a dead session reaches the ledger as
//      liveness{dead} (scheduler probe) → R31 reclaim.
//  (b) retention sweeps — local records / pruneToolCallLog /
//      pruneTerminalQueueEntries delete rows past their conservative windows,
//      with the documented exemptions (operating notes; live dependsOn anchors).
// ---------------------------------------------------------------------------
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (MeshRuntimeStore SQLite, ledger JSONL) to a per-run temp dir.
const testTmpDir = path.join(tmpdir(), `adhdev-mesh-gc-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-host-machine' }),
  getMachineId: () => (({ machineId: 'test-host-machine' }) as any).machineId,
  getMachineNickname: () => (({ machineId: 'test-host-machine' }) as any).machineNickname ?? null,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: vi.fn() }))
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({ fastForwardMeshNode: vi.fn() }))

import {
  MeshRuntimeStore,
  pruneMeshRuntimeRetention,
  MESH_LOCAL_RECORD_RETENTION_MS,
  MESH_TOOL_CALL_LOG_RETENTION_MS,
  MESH_TERMINAL_QUEUE_RETENTION_MS,
} from '../../src/mesh/mesh-runtime-store.js'
import { __resetMeshRuntimeStoreForTests, getQueue } from '../../src/mesh/mesh-work-queue.js'
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue.js'
import { insertLocalRecordRow } from '../helpers/local-records.js'
import { meshTopicIndexFor, MESH_RECORD_APPEND_KIND } from '../../src/mesh/mesh-topic-index.js'

const MESH = 'mesh_gc_test'
const DAY_MS = 24 * 60 * 60 * 1000

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

function queueEntry(overrides: Partial<MeshWorkQueueEntry> & { id: string }): MeshWorkQueueEntry {
  const nowIso = new Date().toISOString()
  return {
    meshId: MESH,
    message: 'gc test task',
    status: 'assigned',
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  } as MeshWorkQueueEntry
}

// Minimal DaemonComponents stub: only the CLI-instance surface the zombie sweep
// consults (resolveSessionBusyVerdict scans getByCategory('cli')).
function componentsWithCliSessions(sessionIds: string[]): any {
  const instances = sessionIds.map(id => ({
    category: 'cli',
    getState: () => ({ instanceId: id, status: 'idle', settings: {} }),
  }))
  return {
    instanceManager: {
      getByCategory: (category: string) => (category === 'cli' ? instances : []),
      getInstance: (id: string) => instances.find(i => i.getState().instanceId === id),
      onEvent: vi.fn(),
    },
  }
}

const SELF_IDS = ['daemon_test-host-machine', 'test-host-machine']
const LOCAL_NODE = 'daemon_test-host-machine'

beforeEach(() => {
  // Fresh store per test: close the singleton and wipe the on-disk DB + JSONL so
  // counts (e.g. the global terminal-queue prune) are deterministic.
  __resetMeshRuntimeStoreForTests()
  fs.rmSync(path.join(testConfigDir, 'mesh-ledger'), { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('(b) retention sweeps', () => {
  it('local-record retention deletes aged rows but retains recent rows (notes live in mesh_operating_notes)', () => {
    const store = MeshRuntimeStore.getInstance()
    const oldIso = isoAgo(40 * DAY_MS) // past the 30-day window
    insertLocalRecordRow({ id: 'led-old', meshId: MESH, timestamp: oldIso, kind: 'task_completed', payload: { taskId: 't1' } })
    insertLocalRecordRow({ id: 'led-recent', meshId: MESH, timestamp: new Date().toISOString(), kind: 'task_completed', payload: { taskId: 't2' } })

    const removed = store.localRecordStore().prune(MESH_LOCAL_RECORD_RETENTION_MS)
    expect(removed).toBe(1)

    const remainingIds = store.localRecordStore().query(MESH, { tail: 50 }).map(e => e.id)
    expect(remainingIds).not.toContain('led-old')
    expect(remainingIds).toContain('led-recent')
  })

  it('pruneToolCallLog deletes only rows past the retention window', () => {
    const realNow = Date.now()
    vi.useFakeTimers()
    // Backdate one call past the 14-day window, then one recent call.
    vi.setSystemTime(realNow - 15 * DAY_MS)
    const store = MeshRuntimeStore.getInstance()
    store.recordMeshToolCall({ meshId: MESH, tool: 'mesh_status' })
    vi.setSystemTime(realNow)
    store.recordMeshToolCall({ meshId: MESH, tool: 'mesh_status' })

    const removed = store.pruneToolCallLog(MESH_TOOL_CALL_LOG_RETENTION_MS)
    expect(removed).toBe(1)
  })

  it('pruneTerminalQueueEntries deletes aged terminal rows but protects live dependsOn anchors, recent and non-terminal rows', () => {
    const store = MeshRuntimeStore.getInstance()
    const oldIso = isoAgo(40 * DAY_MS)

    // Aged terminals → deletable.
    store.insertQueueEntry(queueEntry({ id: 'old-done', status: 'completed', createdAt: oldIso, updatedAt: oldIso }))
    store.insertQueueEntry(queueEntry({ id: 'old-failed', status: 'failed', createdAt: oldIso, updatedAt: oldIso }))
    store.insertQueueEntry(queueEntry({ id: 'old-cancelled', status: 'cancelled', createdAt: oldIso, updatedAt: oldIso }))
    // Aged terminal that a LIVE row depends on → protected (deleting it would strand the dependent).
    store.insertQueueEntry(queueEntry({ id: 'dep-anchor', status: 'completed', createdAt: oldIso, updatedAt: oldIso }))
    store.insertQueueEntry(queueEntry({ id: 'dependent-pending', status: 'pending', dependsOn: ['dep-anchor'] }))
    // Recent terminal and aged non-terminal → kept.
    store.insertQueueEntry(queueEntry({ id: 'recent-done', status: 'completed' }))
    store.insertQueueEntry(queueEntry({ id: 'old-assigned', status: 'assigned', createdAt: oldIso, updatedAt: oldIso }))

    const removed = store.pruneTerminalQueueEntries(MESH_TERMINAL_QUEUE_RETENTION_MS)
    expect(removed).toBe(3)

    const ids = getQueue(MESH).map(e => e.id)
    expect(ids).not.toContain('old-done')
    expect(ids).not.toContain('old-failed')
    expect(ids).not.toContain('old-cancelled')
    expect(ids).toContain('dep-anchor')
    expect(ids).toContain('dependent-pending')
    expect(ids).toContain('recent-done')
    expect(ids).toContain('old-assigned')
  })

  it('non-graph mesh_task_outputs leave WITH their terminal queue row, orphans past the window go too, and live/dependency/young outputs stay', () => {
    const store = MeshRuntimeStore.getInstance()
    const oldIso = isoAgo(40 * DAY_MS)
    const out = (taskId: string, opts: { graphId?: string; createdAt: string }) =>
      (store as any).db.prepare(
        `INSERT INTO mesh_task_outputs (task_id, version, mesh_id, graph_id, node_id, attempt, status, envelope_json, digest, created_at)
         VALUES (?, 1, ?, ?, NULL, 1, 'completed', '{}', 'd', ?)`,
      ).run(taskId, MESH, opts.graphId ?? null, opts.createdAt)
    const outputIds = (): string[] =>
      ((store as any).db.prepare('SELECT task_id FROM mesh_task_outputs ORDER BY task_id').all() as Array<{ task_id: string }>).map(r => r.task_id)

    // Terminal + aged queue row → its non-graph output goes with it.
    store.insertQueueEntry(queueEntry({ id: 'old-done', status: 'completed', createdAt: oldIso, updatedAt: oldIso }))
    out('old-done', { createdAt: oldIso })
    // Orphan (queue row already pruned) and older than the window → goes.
    out('orphan-old', { createdAt: oldIso })
    // Orphan but YOUNG (queue row not materialized yet) → stays.
    out('orphan-young', { createdAt: new Date().toISOString() })
    // Terminal queue row that is still inside the window → stays.
    store.insertQueueEntry(queueEntry({ id: 'recent-done', status: 'completed' }))
    out('recent-done', { createdAt: oldIso })
    // Live (assigned) task → stays regardless of age.
    store.insertQueueEntry(queueEntry({ id: 'live-assigned', status: 'assigned', createdAt: oldIso, updatedAt: oldIso }))
    out('live-assigned', { createdAt: oldIso })
    // A dependency anchor a LIVE row lists in dependsOn → stays (mesh-upstream-results reads it).
    store.insertQueueEntry(queueEntry({ id: 'dep-anchor', status: 'completed', createdAt: oldIso, updatedAt: oldIso }))
    store.insertQueueEntry(queueEntry({ id: 'dependent-pending', status: 'pending', dependsOn: ['dep-anchor'] }))
    out('dep-anchor', { createdAt: oldIso })
    // GRAPH-owned output: never touched by the queue prune, even for an aged terminal queue row.
    store.insertQueueEntry(queueEntry({ id: 'graph-task', status: 'completed', createdAt: oldIso, updatedAt: oldIso }))
    out('graph-task', { createdAt: oldIso, graphId: 'graph_x' })

    expect(outputIds()).toHaveLength(7)
    const detail = store.pruneTerminalQueue(MESH_TERMINAL_QUEUE_RETENTION_MS)
    expect(detail).toEqual({ queue: 2, taskOutputs: 2 })
    expect(outputIds()).toEqual(['dep-anchor', 'graph-task', 'live-assigned', 'orphan-young', 'recent-done'])
    // Idempotent.
    expect(store.pruneTerminalQueue(MESH_TERMINAL_QUEUE_RETENTION_MS)).toEqual({ queue: 0, taskOutputs: 0 })
  })

  it('pruneMeshRuntimeRetention also sweeps mesh_topic_index (30d) and reports it with the task-output count', () => {
    const store = MeshRuntimeStore.getInstance()
    const ingest = (seq: number, at: number) =>
      meshTopicIndexFor(store.db).ingest({
        meshId: MESH, writer: 'w1', seq, kind: MESH_RECORD_APPEND_KIND,
        payload: { id: `e${seq}`, eventId: `e${seq}`, timestamp: new Date(at).toISOString(), ledgerKind: 'task_dispatched', at, payload: {} },
      })
    ingest(1, Date.now() - 45 * DAY_MS)
    ingest(2, Date.now() - 31 * DAY_MS)
    ingest(3, Date.now() - 2 * DAY_MS)
    const result = pruneMeshRuntimeRetention()
    expect(result.topicIndex).toBe(2)
    expect(result.taskOutputs).toBe(0)
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM mesh_topic_index').get() as { n: number }).n).toBe(1)
  })

  it('pruneMeshRuntimeRetention runs all three sweeps and reports counts (no VACUUM, best-effort)', () => {
    const store = MeshRuntimeStore.getInstance()
    const oldIso = isoAgo(40 * DAY_MS)
    insertLocalRecordRow({ id: 'led-old-2', meshId: MESH, timestamp: oldIso, kind: 'session_stopped', payload: {} })
    store.insertQueueEntry(queueEntry({ id: 'old-done-2', status: 'completed', createdAt: oldIso, updatedAt: oldIso }))

    const result = pruneMeshRuntimeRetention()
    expect(result.localRecords).toBe(1)
    expect(result.terminalQueue).toBe(1)
    expect(result.toolCalls).toBe(0)
  })
})
