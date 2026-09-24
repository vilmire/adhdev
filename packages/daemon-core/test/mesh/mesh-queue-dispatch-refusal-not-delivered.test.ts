import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// REFUSAL-BOOKED-AS-DELIVERED. `deliverTaskToSession` used to book ANY non-throwing
// `agent_command` answer as `delivered` — including a resolved `{success:false, code:…}`
// refusal. Two confirmed resolve-shaped (never-throwing) refusals on the REMOTE transport:
// the existing `mesh_node_bootstrap_pending` bootstrap-defer answer (commands/med-family/
// cli-agent.ts, `mesh_send_task` direct path) and the mesh-sender gate's
// `mesh_sender_not_session_coordinator` family (wave 15, `meshSenderRefusalResult` in
// commands/mesh-sender.ts — `DaemonCommandRouter.execute` RESOLVES this as `result`, it is
// never thrown, so it crosses the P2P RPC envelope as a genuine response). Both reached the
// `.then()` handler, which treated them as a successful delivery and recorded
// `kind: 'delivered'` evidence, leaving the refused dispatch sitting on the turn ledger as
// "delivered" until hold/timeout machinery eventually noticed and requeued it. (The worker's
// `session_busy_with_task` refusal — wave 13, cli-manager.ts — currently THROWS on both
// transports and was already caught by the pre-existing `.catch()`; it is exercised below
// only as a resolve-shaped fixture to pin the general contract for any refusal — current or
// future — that answers instead of throwing.)
//
// The fix unwraps the resolved answer (through the shared `unwrapMeshRelayResult`
// boundary reader, which also handles the mesh RPC / IPC envelope wrapping) and treats an
// explicit `success === false` exactly like a thrown rejection: `dispatch_failed` evidence
// with a typed `reason` (`rejected_by_worker`), the queue row returned to pending (or
// terminal, in the doubly-nested `{result:{success:false}}` case which the unwrap also
// classified as failure historically only for the throw path), never `delivered`.
//
// These tests pin the discrimination: a `{success:false}` answer must NOT be booked as
// delivered, a nested `{result:{success:false}}` answer must be unwrapped the same way, a
// `{success:true}` answer is untouched, and a genuine thrown rejection is unaffected
// (same code path as before, now shared via `handleDispatchFailure`).

const testTmpDir = path.join(tmpdir(), `adhdev-refusal-not-delivered-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

const LOCAL_MACHINE_ID = 'mach_1111111111111111111111111111aaaa'
const REMOTE_DAEMON_ID = 'daemon_mach_2222222222222222222222222222bbbb'

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: LOCAL_MACHINE_ID } as any),
  getMachineId: () => ({ machineId: LOCAL_MACHINE_ID } as any).machineId,
  getMachineNickname: () => ({ machineId: LOCAL_MACHINE_ID } as any).machineNickname ?? null,
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

import { tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'
import { wipeTurnTablesForTests } from './helpers/mesh-turn-ledger-fixture.js'

const REMOTE_NODE_ID = 'node_refusal_remote0000000000000000000000'
const LOCAL_NODE_ID = 'node_refusal_local00000000000000000000000'
const WS = '/repo/refusal-not-delivered'

function setMesh(meshId: string, nodeId: string, opts?: { remote?: boolean }) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Refusal Mesh',
    policy: {},
    nodes: [{
      id: nodeId,
      workspace: WS,
      repoRoot: WS,
      policy: {},
      ...(opts?.remote ? { daemonId: REMOTE_DAEMON_ID } : {}),
    }],
  })
}

function createComponents(meshId: string, nodeId: string, sessionId: string, dispatch: () => Promise<unknown>, opts?: { remote?: boolean }) {
  const state = {
    settings: { meshNodeFor: meshId, meshNodeId: nodeId, providerType: 'claude-cli' },
    status: 'idle',
    instanceId: sessionId,
    type: 'claude-cli',
    workspace: WS,
  }
  const instance = { getState: () => state, updateSettings: vi.fn() }
  return withMeshRouter({
    instanceManager: {
      getInstance: vi.fn(() => instance),
      getByCategory: vi.fn((c: string) => (c === 'cli' ? [instance] : [])),
      attachMeshAssignmentToInstance: vi.fn(() => ({ stamped: true })),
    },
    cliManager: opts?.remote
      ? { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) }
      : { adapters: new Map(), handleCliCommand: vi.fn(dispatch) },
    ...(opts?.remote ? { dispatchMeshCommand: vi.fn(dispatch), getMeshPeerConnectionStatus: vi.fn(() => ({ state: 'connected' })) } : {}),
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      getMeta: vi.fn(() => undefined),
      setCliDetectionResults: vi.fn(),
    },
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any)
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  wipeTurnTablesForTests()
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

/** Let deliverTaskToSession's fire-and-forget .then/.catch handlers settle. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }

function lastAttempt(meshId: string, taskId: string) {
  return MeshRuntimeStore.getInstance().turnStore().listAttemptsForTask(meshId, taskId).at(-1)
}

/** Event kinds recorded against a task's attempt(s) — used to assert `delivered` never fires. */
function eventKindsForTask(meshId: string, taskId: string): string[] {
  const attempts = MeshRuntimeStore.getInstance().turnStore().listAttemptsForTask(meshId, taskId)
  if (attempts.length === 0) return []
  const placeholders = attempts.map(() => '?').join(',')
  const rows = MeshRuntimeStore.getInstance().db
    .prepare(`SELECT kind FROM turn_events WHERE attempt_id IN (${placeholders})`)
    .all(...attempts.map(a => a.attemptId)) as Array<{ kind: string }>
  return rows.map(r => r.kind)
}

/** The raw evidence body of the (first) `dispatch_failed` event recorded for a task. */
function dispatchFailedEvidence(meshId: string, taskId: string): Record<string, unknown> | undefined {
  const attempts = MeshRuntimeStore.getInstance().turnStore().listAttemptsForTask(meshId, taskId)
  if (attempts.length === 0) return undefined
  const placeholders = attempts.map(() => '?').join(',')
  const row = MeshRuntimeStore.getInstance().db
    .prepare(`SELECT payload_json FROM turn_events WHERE attempt_id IN (${placeholders}) AND kind = 'dispatch_failed' LIMIT 1`)
    .get(...attempts.map(a => a.attemptId)) as { payload_json: string } | undefined
  if (!row) return undefined
  return (JSON.parse(row.payload_json)?.evidence ?? {}) as Record<string, unknown>
}

describe('REFUSAL-BOOKED-AS-DELIVERED — a resolved {success:false} answer is a dispatch failure, not delivery', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('remote: mesh-sender-gate refusal (resolved {success:false}, router.execute never throws it) is dispatch_failed, never delivered', async () => {
    const meshId = `mesh_refusal_remote_busy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, REMOTE_NODE_ID, { remote: true })
      // The literal shape `meshSenderRefusalResult` (commands/mesh-sender.ts) returns —
      // `DaemonCommandRouter.execute` RESOLVES with this as `result`, it is never thrown,
      // so it crosses the P2P RPC envelope as a genuine (non-error) response and reaches
      // `dispatchMeshCommand`'s caller as a RESOLVED value.
      const components = createComponents(meshId, REMOTE_NODE_ID, 'sess-remote-busy', async () => ({
        success: false,
        error: 'mesh_sender_not_session_coordinator',
        code: 'mesh_sender_not_session_coordinator',
        detail: 'sender is not the coordinator session for this task',
      }), { remote: true })
      const task = enqueueTask(meshId, 'DELTA-REMOTE-BUSY', { targetNodeId: REMOTE_NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      expect(tryAssignQueueTask(components, meshId, REMOTE_NODE_ID, 'sess-remote-busy', 'claude-cli')).toBe(true)
      await settle()

      const after = getQueue(meshId).find(t => t.id === task.id)!
      // THE ASSERTION: not left `assigned` as if delivered — it was returned to pending
      // (or terminalized), never booked as a live in-flight delivery.
      expect(after.status).not.toBe('assigned')
      const attempt = lastAttempt(meshId, task.id)
      expect(attempt?.state).not.toBe('generating')
      // No `delivered` evidence exists for this attempt/task.
      const eventKinds = eventKindsForTask(meshId, task.id)
      expect(eventKinds).not.toContain('delivered')
      expect(eventKinds).toContain('dispatch_failed')

      // Live-gap fix (2026-09-25): the worker's own refusal code is preserved
      // (sanitized) on the evidence — previously dispatch_failed carried only
      // {workerAbsent, reason:'rejected_by_worker'}, with the actual WHY dropped.
      const evidence = dispatchFailedEvidence(meshId, task.id)!
      expect(evidence.workerAbsent).toBe(false)
      expect(evidence.reason).toBe('rejected_by_worker')
      expect(evidence.refusalCode).toBe('mesh_sender_not_session_coordinator')
      // Content boundary: the free-text `detail` field must never reach the evidence.
      expect(JSON.stringify(evidence)).not.toContain('sender is not the coordinator')
    } finally {
      cleanup(meshId)
    }
  })

  it('remote: nested {result:{success:false}} refusal is unwrapped and handled the same way', async () => {
    const meshId = `mesh_refusal_remote_nested_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, REMOTE_NODE_ID, { remote: true })
      const components = createComponents(meshId, REMOTE_NODE_ID, 'sess-remote-nested', async () => ({
        result: { success: false, code: 'mesh_node_bootstrap_pending', reason: 'bootstrap_still_running' },
      }), { remote: true })
      const task = enqueueTask(meshId, 'DELTA-REMOTE-NESTED', { targetNodeId: REMOTE_NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      expect(tryAssignQueueTask(components, meshId, REMOTE_NODE_ID, 'sess-remote-nested', 'claude-cli')).toBe(true)
      await settle()

      const after = getQueue(meshId).find(t => t.id === task.id)!
      expect(after.status).not.toBe('assigned')
      const eventKinds = eventKindsForTask(meshId, task.id)
      expect(eventKinds).not.toContain('delivered')
      expect(eventKinds).toContain('dispatch_failed')
    } finally {
      cleanup(meshId)
    }
  })

  it('remote: a {success:true} answer is still booked as delivered (control)', async () => {
    const meshId = `mesh_refusal_remote_ok_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, REMOTE_NODE_ID, { remote: true })
      const components = createComponents(meshId, REMOTE_NODE_ID, 'sess-remote-ok', async () => ({ success: true }), { remote: true })
      const task = enqueueTask(meshId, 'DELTA-REMOTE-OK', { targetNodeId: REMOTE_NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      expect(tryAssignQueueTask(components, meshId, REMOTE_NODE_ID, 'sess-remote-ok', 'claude-cli')).toBe(true)
      await settle()

      const after = getQueue(meshId).find(t => t.id === task.id)!
      expect(after.status).toBe('assigned')
      const eventKinds = eventKindsForTask(meshId, task.id)
      expect(eventKinds).toContain('delivered')
      expect(eventKinds).not.toContain('dispatch_failed')
    } finally {
      cleanup(meshId)
    }
  })

  it('remote: a thrown rejection is unaffected by the fix (unchanged failure path)', async () => {
    const meshId = `mesh_refusal_remote_throw_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, REMOTE_NODE_ID, { remote: true })
      const components = createComponents(meshId, REMOTE_NODE_ID, 'sess-remote-throw', async () => {
        throw new Error('adapter busy, try again')
      }, { remote: true })
      const task = enqueueTask(meshId, 'DELTA-REMOTE-THROW', { targetNodeId: REMOTE_NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      expect(tryAssignQueueTask(components, meshId, REMOTE_NODE_ID, 'sess-remote-throw', 'claude-cli')).toBe(true)
      await settle()

      const after = getQueue(meshId).find(t => t.id === task.id)!
      expect(after.status).toBe('pending')
      const eventKinds = eventKindsForTask(meshId, task.id)
      expect(eventKinds).not.toContain('delivered')
      expect(eventKinds).toContain('dispatch_failed')

      // A genuine transport throw carries no worker answer at all, so no refusalCode
      // is synthesized — `reason` stays classified from the message text as before.
      const evidence = dispatchFailedEvidence(meshId, task.id)!
      expect(evidence.refusalCode).toBeUndefined()
      expect(evidence.reason).toBe('transport_error')
    } finally {
      cleanup(meshId)
    }
  })

  it('local: a resolved {success:false} answer from the in-process router is dispatch_failed, never delivered (symmetry with the remote arm)', async () => {
    // Today's actual local-transport refusals (session_busy_with_task,
    // task_already_stamped_on_live_instance in cli-manager.ts) throw, so they were already
    // caught by the pre-existing `.catch()` path. This pins the general contract instead —
    // deliverTaskToSession's `.then()` unwrap-and-fail must apply identically regardless of
    // transport, so a local handler that resolves `{success:false}` (any current or future
    // in-process refusal that chooses to answer rather than throw) is never booked as
    // `delivered` either — the local and remote arms of handleDispatchFailure must not drift.
    const meshId = `mesh_refusal_local_busy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, LOCAL_NODE_ID)
      const components = createComponents(meshId, LOCAL_NODE_ID, 'sess-local-busy', async () => ({
        success: false,
        code: 'session_busy_with_task',
        reason: 'session_busy_with_task',
        currentTaskId: 'other-task',
      }))
      const task = enqueueTask(meshId, 'DELTA-LOCAL-BUSY', { targetNodeId: LOCAL_NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      expect(tryAssignQueueTask(components, meshId, LOCAL_NODE_ID, 'sess-local-busy', 'claude-cli')).toBe(true)
      await settle()

      const after = getQueue(meshId).find(t => t.id === task.id)!
      expect(after.status).not.toBe('assigned')
      const eventKinds = eventKindsForTask(meshId, task.id)
      expect(eventKinds).not.toContain('delivered')
      expect(eventKinds).toContain('dispatch_failed')
    } finally {
      cleanup(meshId)
    }
  })

  it('local: a {success:true} answer is still booked as delivered (control)', async () => {
    const meshId = `mesh_refusal_local_ok_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, LOCAL_NODE_ID)
      const components = createComponents(meshId, LOCAL_NODE_ID, 'sess-local-ok', async () => ({ success: true }))
      const task = enqueueTask(meshId, 'DELTA-LOCAL-OK', { targetNodeId: LOCAL_NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      expect(tryAssignQueueTask(components, meshId, LOCAL_NODE_ID, 'sess-local-ok', 'claude-cli')).toBe(true)
      await settle()

      const after = getQueue(meshId).find(t => t.id === task.id)!
      expect(after.status).toBe('assigned')
      const eventKinds = eventKindsForTask(meshId, task.id)
      expect(eventKinds).toContain('delivered')
    } finally {
      cleanup(meshId)
    }
  })
})
