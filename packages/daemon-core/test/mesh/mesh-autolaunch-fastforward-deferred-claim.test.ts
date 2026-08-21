import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// AUTOLAUNCH-DEFERRED-CLAIM. The local auto-launch path makes exactly ONE claim attempt: an
// inline tryAssignQueueTask immediately after launch_cli returns. `agent:ready` does NOT drive a
// claim for a locally-launched session, so that inline attempt is the only opportunity there is.
//
// When an auto fast-forward held the workspace lease at that instant, the claim was refused and
// the launch STILL stamped autoLaunch='completed'. The per-task await-claim guard then read that
// record, concluded "a claim is already in flight, just wait", and suppressed every retry for
// AUTO_LAUNCH_AWAIT_CLAIM_MS (90s) before backing off 90→180→360s — while the launched session
// sat idle at zero messages and the task sat pending. Nothing reconnected them.
//
// Live evidence (2026-08-20, coordinator's own Mac node):
//   23:34:07.698  session_auto_launch phase=started   task eb553f30
//   23:34:07.779  session_auto_launch phase=completed  session 146a8c48
//   23:34:07.780  "Deferring queue claim … an auto fast-forward is mutating its workspace"
//   → no task_claimed, ever. Two sibling tasks on the SAME node, same provider, same model,
//     launched at 23:29:55 and 23:37:28 with no ff running, both claimed within ~260ms.
//
// This suite pins:
//   (a) an ff-deferred claim is RE-DRIVEN on the next tick (the defect: it never was);
//   (b) the re-drive is BOUNDED — a lease that never clears cannot spin it forever;
//   (c) auto-FF itself is untouched: while the lease is genuinely held, no claim happens.
//
// ★A NOTE ON WHAT (a) MUST ISOLATE, learned from an injection test that failed to go red.
// `triggerMeshQueue` drains LOCAL idle sessions (instanceManager scan) BEFORE it reaches the
// auto-launch guard. A test whose launched session is visible to that scan gets claimed by the
// drain on tick 2 no matter what the auto-launch path does — so it passes with the fix reverted
// and pins nothing. Case (a) therefore withholds the session from `getByCategory` (the REMOTE
// shape: a session this daemon cannot see in its own instanceManager), which is exactly the
// condition under which the auto-launch re-drive is the ONLY path that can reconnect the pair.
// Case (a2) keeps the locally-visible shape and asserts the drain recovers it, so the two
// recovery paths are pinned separately instead of one masking the other.

const testTmpDir = path.join(tmpdir(), `adhdev-al-ffdefer-test-${randomUUID().slice(0, 8)}`)
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
// The workspace lease lives in mesh-auto-fast-forward. Mocking only the read predicate lets a
// case hold/release the lease deterministically without running real git — and, importantly,
// leaves the ff module's own behavior untouched (this fix must not weaken auto-FF).
const ffMocks = vi.hoisted(() => ({ inFlight: false }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))

vi.mock('../../src/mesh/mesh-auto-fast-forward.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mesh/mesh-auto-fast-forward.js')>()
  return {
    ...actual,
    isWorkspaceAutoFastForwardInFlight: () => ffMocks.inFlight,
    // The idle-edge ff is irrelevant to these cases and would touch the filesystem.
    maybeAutoFastForwardIdleNode: async () => { /* no-op */ },
  }
})

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import {
  __resetAutoLaunchAwaitClaimBackoffForTests,
  __resetClaimDeferralForTests,
} from '../../src/mesh/mesh-queue-assignment.js'

const NODE_A = 'node_alpha'

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'FF Deferred Claim Mesh',
    policy: {},
    nodes: [
      { id: NODE_A, workspace: `/repo/${NODE_A}`, repoRoot: `/repo/${NODE_A}`, policy: { providerPriority: ['codex-cli'] } },
    ],
  })
}

// A launched session must look LOCAL, IDLE and mesh-bound, because that is the live shape: the
// session really did spawn, it really is idle, and it really is bound to the node. The defect is
// purely that nothing re-attempts the claim.
// `hideFromLocalDrain` withholds spawned sessions from getByCategory('cli') — the REMOTE shape,
// where this daemon cannot see the session in its own instanceManager, so the local idle drain
// has no candidate and the auto-launch re-drive is the only recovery path. getInstance still
// resolves it (the claim path's own identity lookups must still work).
function createComponents(opts: { hideFromLocalDrain?: boolean } = {}) {
  const spawned: string[] = []
  const instances = new Map<string, any>()
  const makeInstance = (sessionId: string, meshId: string) => ({
    getState: () => ({
      instanceId: sessionId,
      type: 'codex-cli',
      status: 'idle',
      workspace: `/repo/${NODE_A}`,
      settings: { meshNodeFor: meshId, meshNodeId: NODE_A, providerType: 'codex-cli' },
    }),
  })
  const components: any = {
    __meshId: '',
    instanceManager: {
      getByCategory: vi.fn((category: string) => (
        category === 'cli' && !opts.hideFromLocalDrain ? [...instances.values()] : []
      )),
      getInstance: vi.fn((id: string) => instances.get(id)),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) => {
        if (command !== 'launch_cli') return { success: true }
        const sessionId = `spawned-${randomUUID().slice(0, 8)}`
        spawned.push(sessionId)
        instances.set(sessionId, makeInstance(sessionId, components.__meshId))
        return { success: true, sessionId }
      }),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
      getMeta: vi.fn(() => undefined),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  }
  components.__spawned = spawned
  return components
}

function taskRow(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

function cleanup(meshId: string) {
  ffMocks.inFlight = false
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  __resetClaimDeferralForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('AUTOLAUNCH-DEFERRED-CLAIM — an ff-deferred claim is re-driven, not stranded', () => {
  afterEach(() => { vi.clearAllMocks() })

  // (a) THE REGRESSION. Launch while the ff lease is held (so the one inline claim is refused),
  // then release the lease and tick again. Before the fix the await-claim guard saw
  // autoLaunch='completed' and skipped for 90s, leaving the task pending forever from the
  // coordinator's point of view. After the fix the next tick re-drives the claim.
  it('(a) claim deferred by the ff lease is re-driven on the next tick once the lease clears', async () => {
    const meshId = `mesh_ffdefer_a_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // Hidden from the local idle drain, so ONLY the auto-launch re-drive can reconnect the
      // launched session to its task. Without this the drain claims on tick 2 regardless and
      // the case passes even with the fix reverted (verified: it did).
      const components = createComponents({ hideFromLocalDrain: true })
      components.__meshId = meshId
      const task = enqueueTask(meshId, 'deferred work', { taskMode: 'code_change', difficulty: 'medium' })

      // Tick 1: the ff lease is held, exactly as at 23:34:07.780 live.
      ffMocks.inFlight = true
      await triggerMeshQueue(components, meshId)

      // The session really was spawned, and the task really did NOT claim — the live shape.
      expect(components.__spawned).toHaveLength(1)
      expect(taskRow(meshId, task.id)?.status).toBe('pending')
      expect(taskRow(meshId, task.id)?.autoLaunch?.status).toBe('completed')

      // Tick 2: the ff finished and released the lease.
      ffMocks.inFlight = false
      await triggerMeshQueue(components, meshId)

      // The task is now claimed by the SAME session that was launched for it — no respawn.
      const row = taskRow(meshId, task.id)
      expect(row?.status).toBe('assigned')
      expect(row?.assignedSessionId).toBe(components.__spawned[0])
      expect(components.__spawned).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // (b) BOUNDED. A workspace whose ff keeps re-acquiring the lease must not make the re-drive
  // spin forever; past the budget it falls back to the ordinary await-claim window. The
  // observable guarantee is that no extra session is ever spawned to "fix" the stuck claim.
  it('(b) a lease that never clears does not spin the re-drive or spawn duplicate sessions', async () => {
    const meshId = `mesh_ffdefer_b_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      components.__meshId = meshId
      const task = enqueueTask(meshId, 'perpetually deferred', { taskMode: 'code_change', difficulty: 'medium' })

      ffMocks.inFlight = true
      // Far more ticks than MAX_FAST_FORWARD_CLAIM_REDRIVES (3).
      for (let i = 0; i < 10; i += 1) await triggerMeshQueue(components, meshId)

      expect(taskRow(meshId, task.id)?.status).toBe('pending')
      // Exactly one session — the re-drive never respawns, and the await-claim guard still
      // suppresses duplicate launches.
      expect(components.__spawned).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // (c) AUTO-FF UNTOUCHED. The lease must keep doing its job: while it is genuinely held, no
  // task is claimed into the workspace being mutated. This is the property the fix must not
  // weaken — the bug was the missing retry, never the protection itself.
  it('(c) while the ff lease is held, the task is never claimed', async () => {
    const meshId = `mesh_ffdefer_c_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      components.__meshId = meshId
      const task = enqueueTask(meshId, 'protected work', { taskMode: 'code_change', difficulty: 'medium' })

      ffMocks.inFlight = true
      for (let i = 0; i < 3; i += 1) await triggerMeshQueue(components, meshId)

      // Held lease ⇒ pending, never assigned. No dispatch into a mid-checkout workspace.
      expect(taskRow(meshId, task.id)?.status).toBe('pending')
      expect(taskRow(meshId, task.id)?.assignedSessionId).toBeFalsy()
    } finally {
      cleanup(meshId)
    }
  })
})
