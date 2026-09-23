// ---------------------------------------------------------------------------
// mesh-runtime.db 자동 GC (SoT 1-11 / gaps I-9, I-10)
//
//  (a) assigned-zombie sweep — RETIRED 2026-09-23 with the reconcile loop
//      (wiring-unification C4): a stuck assigned row cannot exist once the queue
//      status is a ledger commit effect; a dead session reaches the ledger as
//      liveness{dead} (scheduler probe) → R31 reclaim.
//  (b) retention sweeps — pruneEventLedger / pruneToolCallLog /
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
  MESH_EVENT_LEDGER_RETENTION_MS,
  MESH_TOOL_CALL_LOG_RETENTION_MS,
  MESH_TERMINAL_QUEUE_RETENTION_MS,
} from '../../src/mesh/mesh-runtime-store.js'
import { __resetMeshRuntimeStoreForTests, getQueue } from '../../src/mesh/mesh-work-queue.js'
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue.js'
import { appendLedgerEntry } from '../../src/mesh/mesh-ledger.js'

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
  it('pruneEventLedger deletes aged rows but retains recent rows and operating notes', () => {
    const store = MeshRuntimeStore.getInstance()
    const oldIso = isoAgo(40 * DAY_MS) // past the 30-day window
    store.appendLedgerEntry({ id: 'led-old', meshId: MESH, timestamp: oldIso, kind: 'task_completed', payload: { taskId: 't1' } })
    store.appendLedgerEntry({ id: 'led-recent', meshId: MESH, timestamp: new Date().toISOString(), kind: 'task_completed', payload: { taskId: 't2' } })
    // Operating notes (and their tombstones) survive forever by design.
    store.appendLedgerEntry({ id: 'led-note', meshId: MESH, timestamp: oldIso, kind: 'coordinator_operating_note', payload: { text: 'old lesson' } })
    store.appendLedgerEntry({ id: 'led-tomb', meshId: MESH, timestamp: oldIso, kind: 'coordinator_operating_note_tombstone', payload: { targetNoteId: 'led-note' } })

    const removed = store.pruneEventLedger(MESH_EVENT_LEDGER_RETENTION_MS)
    expect(removed).toBe(1)

    const remainingIds = store.readLedgerEntries(MESH, { tail: 50 }).map(e => e.id)
    expect(remainingIds).not.toContain('led-old')
    expect(remainingIds).toContain('led-recent')
    expect(remainingIds).toContain('led-note')
    expect(remainingIds).toContain('led-tomb')
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

  it('pruneMeshRuntimeRetention runs all three sweeps and reports counts (no VACUUM, best-effort)', () => {
    const store = MeshRuntimeStore.getInstance()
    const oldIso = isoAgo(40 * DAY_MS)
    store.appendLedgerEntry({ id: 'led-old-2', meshId: MESH, timestamp: oldIso, kind: 'session_stopped', payload: {} })
    store.insertQueueEntry(queueEntry({ id: 'old-done-2', status: 'completed', createdAt: oldIso, updatedAt: oldIso }))

    const result = pruneMeshRuntimeRetention()
    expect(result.ledger).toBe(1)
    expect(result.terminalQueue).toBe(1)
    expect(result.toolCalls).toBe(0)
  })
})
