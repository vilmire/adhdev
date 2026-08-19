import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// RC.20 TARGET-PIN TTL (the mesh_queue_requeue wedge, observed live 2026-07-28): a task
// requeued with target_session_id could wedge 'pending' FOREVER behind the
// target_session_constraint auto-launch skip whenever the pinned session could never
// claim — a session on a REMOTE node this daemon cannot observe (the dead-target verdict
// deliberately stays UNKNOWN there), a non-claim-participant session, or one busy
// indefinitely. Contract: (a) a LIVE compatible pinned session claims/delivers through
// the normal claim path; (b) a pin UNCLAIMED past the bounded TARGET_SESSION_PIN_TTL_MS
// is EXPIRED — cleared without consuming the retry budget — so the task becomes
// claimable by any compatible session. Explicit operator cancellation stays terminal.

const testTmpDir = path.join(tmpdir(), `adhdev-target-pin-ttl-test-${randomUUID().slice(0, 8)}`)
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
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn(async () => ({ path: '/usr/bin/codex' })) }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, getQueue, claimNextTask, cancelTask, parkTaskTargetPin } from '../../src/mesh/mesh-work-queue.js'
import { __resetTargetPinGeneratingCreditForTests } from '../../src/mesh/mesh-skip-notify.js'
import { PARK_REASON_PIN_EXPIRED } from '../../src/mesh/mesh-task-parking.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import { getTurnLedgerMetrics, __resetTurnLedgerMetricsForTests } from '../../src/mesh/mesh-turn-ledger.js'

// THIS daemon's node (isLocalAutoLaunchNode resolves 'test-machine' as local when the
// node carries no foreign daemonId/machineId) and a REMOTE node whose sessions are not
// locally observable.
const NODE_ID = 'node_main'
const REMOTE_NODE_ID = 'node_remote'
// Younger than the TTL but past the 60s dead-target grace (dead-target path untouched).
const DEAD_TARGET_AGE_MS = 5 * 60_000
// Older than TARGET_SESSION_PIN_TTL_MS (15 min) so the TTL expiry fires.
const PAST_TTL_AGE_MS = 16 * 60_000

function liveSession(meshId: string, sessionId: string, status: string, nodeId: string = NODE_ID) {
  const state = {
    instanceId: sessionId,
    status,
    workspace: `/repo/${nodeId}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: nodeId },
  }
  return { category: 'cli', getState: () => state }
}

function createComponents(cliInstances: any[] = []) {
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) =>
        command === 'launch_cli' ? { success: true, sessionId: `spawned-${randomUUID().slice(0, 6)}` } : { success: true }),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

// Mesh with the local node AND a live remote node (daemonId 'remote-daemon').
function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Target Pin TTL Mesh',
    policy: {},
    nodes: [
      { id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } },
      { id: REMOTE_NODE_ID, workspace: `/repo/${REMOTE_NODE_ID}`, daemonId: 'remote-daemon', policy: { providerPriority: ['codex-cli'] } },
    ],
  })
}

function task(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

// Insert a pending queue row DIRECTLY with a controllable createdAt (the TTL anchor —
// updateQueueEntry stamps updatedAt=now, which would defeat the age measurement).
function insertPendingTask(
  meshId: string,
  opts: { id?: string; targetNodeId?: string; targetSessionId?: string; ageMs?: number; maxRetries?: number },
): { id: string } {
  const id = opts.id ?? `task_${randomUUID().slice(0, 8)}`
  const anchor = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id, meshId, message: 'do work', status: 'pending', taskMode: 'code_change',
    targetNodeId: opts.targetNodeId, targetSessionId: opts.targetSessionId,
    maxRetries: opts.maxRetries,
    createdAt: anchor, updatedAt: anchor,
  } as any)
  return { id }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  __resetTargetPinGeneratingCreditForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('RC.20 TARGET-PIN TTL — a requeued target_session_id pin delivers to the live session or expires bounded; never wedges pending', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('(a) LIVE compatible target: the pinned session claims the task through the normal claim path (pin never expired)', async () => {
    const meshId = `mesh_ttl_live_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([liveSession(meshId, 'live-idle', 'idle')])
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'live-idle' })

      // The auto-launch scan does not disturb the pin…
      await triggerMeshQueue(components, meshId)
      expect(task(meshId, t.id)!.targetSessionId).toBe('live-idle')
      expect(task(meshId, t.id)!.autoLaunch?.reason).toBe('target_session_constraint')

      // …and the pinned live session claims the task itself (delivery path (a)).
      const claimed = claimNextTask(meshId, NODE_ID, 'live-idle', [])
      expect(claimed?.id).toBe(t.id)
      expect(claimed?.status).toBe('assigned')
      expect(claimed?.assignedSessionId).toBe('live-idle')
    } finally {
      cleanup(meshId)
    }
  })

  it('(b) STALE unobservable target (live REMOTE node, session not locally observable): the pin expires past the TTL and the task is PARKED — never silently re-homed, retry budget untouched', async () => {
    const meshId = `mesh_ttl_remote_${randomUUID().slice(0, 8)}`
    __resetTurnLedgerMetricsForTests()
    try {
      setMesh(meshId)
      const components = createComponents([])
      // Pinned to a session on the LIVE remote node. The dead-target verdict cannot
      // prove it dead (remote absence is UNKNOWN by design), and it never claims.
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: PAST_TTL_AGE_MS })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      // ★ PIN-PARKING (behaviour change): the stale pin is PARKED, not cleared. The
      // address is PRESERVED — both on the row (which is what keeps it unclaimable via
      // the tier-1 claim SELECT) and mirrored in `parked` for the coordinator's benefit.
      expect(after.parked?.reason).toBe(PARK_REASON_PIN_EXPIRED)
      expect(after.parked?.targetSessionId).toBe('remote-sess')
      expect(after.parked?.parkedAt).toBeTruthy()
      expect(after.targetSessionId).toBe('remote-sess')
      expect(after.targetNodeId).toBe(REMOTE_NODE_ID)
      expect(after.status).toBe('pending')
      expect(after.autoLaunch?.reason).toBe('target_session_pin_parked')
      // No retry-budget cost — parking is a holding operation, not a retry.
      expect(after.requeueCount ?? 0).toBe(0)
      // Content-free metric for the transition.
      expect(getTurnLedgerMetrics().targetPinClearedByReason[PARK_REASON_PIN_EXPIRED]).toBe(1)

      // ★ THE REGRESSION THIS FILE NOW GUARDS: no silent succession. A parked task is
      // claimable by NOBODY — not another compatible session…
      expect(claimNextTask(meshId, REMOTE_NODE_ID, 'any-compatible-session', [])).toBeNull()
      // …and not even the session it is still pinned to (the coordinator was asked to
      // re-confirm this delta's premise; delivering it anyway would defeat the park).
      expect(claimNextTask(meshId, REMOTE_NODE_ID, 'remote-sess', [])).toBeNull()
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT expire a pin younger than the TTL (a live claim always wins the race)', async () => {
    const meshId = `mesh_ttl_young_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([])
      // Remote-unobservable pin, but only 5 min old — inside the 15-min TTL.
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: DEAD_TARGET_AGE_MS })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(after.targetSessionId).toBe('remote-sess')
      expect(after.status).toBe('pending')
      expect(after.autoLaunch?.reason).toBe('target_session_constraint')
    } finally {
      cleanup(meshId)
    }
  })

  it('live-busy LOCAL target inside the TTL is undisturbed (the session will claim when it frees up)', async () => {
    const meshId = `mesh_ttl_busy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([liveSession(meshId, 'busy-session', 'generating')])
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'busy-session', ageMs: DEAD_TARGET_AGE_MS })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(after.targetSessionId).toBe('busy-session')
      expect(after.status).toBe('pending')
      expect(after.requeueCount ?? 0).toBe(0)
      expect(after.autoLaunch?.reason).toBe('target_session_constraint')
    } finally {
      cleanup(meshId)
    }
  })

  it('explicit operator CANCELLATION is terminal: a cancelled pinned task is never expired, requeued, or resurrected', async () => {
    const meshId = `mesh_ttl_cancel_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([])
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: PAST_TTL_AGE_MS })

      const cancelled = cancelTask(meshId, t.id, { reason: 'operator_cancel' })
      expect(cancelled?.status).toBe('cancelled')

      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(after.status).toBe('cancelled')
      // The parking mutation itself refuses non-pending rows.
      expect(parkTaskTargetPin(meshId, t.id, { reason: PARK_REASON_PIN_EXPIRED })).toBeNull()
      expect(task(meshId, t.id)!.status).toBe('cancelled')
    } finally {
      cleanup(meshId)
    }
  })

  it('dead-target self-heal also records the content-free targetPinCleared metric', async () => {
    const meshId = `mesh_ttl_metric_${randomUUID().slice(0, 8)}`
    __resetTurnLedgerMetricsForTests()
    try {
      setMesh(meshId)
      const components = createComponents([])
      // Session absent on the LIVE LOCAL node, past the 60s dead-target grace but
      // inside the TTL → the dead-target path (not the TTL) clears it.
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'dead-session', ageMs: DEAD_TARGET_AGE_MS })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(after.targetSessionId).toBeUndefined()
      expect(after.requeueReason).toBe('dead_target_session_absent')
      expect(getTurnLedgerMetrics().targetPinClearedByReason['dead_target_session_absent']).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })
})
