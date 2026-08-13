import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// DOUBLE-DISPATCH Layer (a): maybeAutoLaunchOneQueueSession must NOT spawn a second worker
// when the target node already has a LIVE mesh session on its way to claim (idle / booting /
// momentary non-idle flip). The enqueue→drain race RCA: the idle drain skipped a
// momentarily-non-idle session as a candidate, and the write-only nodeHasActiveAssignment
// gate (status='assigned' rows only) could not see the about-to-claim session either, so a
// duplicate session spawned and the same taskId was sequentially stamped on two sessions.
// The new nodeHasLiveSessionPendingClaim gate closes that. It must still allow the legitimate
// first spawn (no live session) and a read-only launch onto a node whose only session is
// genuinely BUSY (holding its own assigned task).

const testTmpDir = path.join(tmpdir(), `adhdev-double-dispatch-al-test-${randomUUID().slice(0, 8)}`)
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
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests, __seedAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

const NODE_ID = 'node_main'

// A fake live CLI instance bound to NODE_ID for `meshId`, in the given status.
// `providerType` (optional) stamps state.type — the session's launched provider, used by the
// PROVIDER-MATCH gate to decide whether this session could claim a provider-scoped task.
function liveSession(meshId: string, sessionId: string, status: string, providerType?: string) {
  const state = {
    instanceId: sessionId,
    status,
    ...(providerType ? { type: providerType } : {}),
    workspace: `/repo/${NODE_ID}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID },
  }
  return { category: 'cli', getState: () => state }
}

// A fake live COORDINATOR session on NODE_ID: it carries meshCoordinatorFor === meshId in
// addition to the worker-node stamp (a coordinator runs on a mesh node). It is generating
// and holds NO assigned queue task — the exact shape that used to make the skip gate think a
// worker was pending-claim (DISPATCH-DEADLOCK-COORD-SESSION-SLOT).
function coordinatorSession(meshId: string, sessionId: string, status = 'generating') {
  const state = {
    instanceId: sessionId,
    status,
    workspace: `/repo/${NODE_ID}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, meshCoordinatorFor: meshId },
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
      // The auto-launch envelope reads provider meta for auto-approve defaults
      // (delegatedWorkerAutoApproveSettings). Without this the launch throws
      // `getMeta is not a function` and no launch_cli is dispatched.
      getMeta: vi.fn(() => undefined),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Double Dispatch Mesh',
    policy: {},
    nodes: [{ id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } }],
  })
}

function autoLaunchReason(meshId: string, taskId: string): string | undefined {
  return getQueue(meshId).find(t => t.id === taskId)?.autoLaunch?.reason
}

function launchCliCalls(components: any): number {
  return components.cliManager.handleCliCommand.mock.calls.filter((c: any[]) => c[0] === 'launch_cli').length
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('DOUBLE-DISPATCH Layer (a) — auto-launch suppressed when node has a live pending-claim session', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('skips auto-launch (node_has_live_session_pending_claim) when a live, momentarily non-idle session exists on the node', async () => {
    const meshId = `mesh_al_skip_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // Live session in a NON-idle flip (generating) holding NO assigned task — the idle
      // drain skips it as a candidate, but it will claim the pending task on its next idle.
      const components = createComponents([liveSession(meshId, 'existing-sess', 'generating')])
      const task = enqueueTask(meshId, 'do work', { taskMode: 'code_change',
    difficulty: 'medium',
})

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: launches normally (no skip) when the node has NO live session', async () => {
    const meshId = `mesh_al_spawn_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([]) // dead/empty node — legitimate first spawn
      const task = enqueueTask(meshId, 'do work', { taskMode: 'code_change',
    difficulty: 'medium',
})

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('DEPENDSON-GATE-SYMMETRY: a task with an unmet dependency is excluded from auto-launch (dependencies_unsatisfied, no spawn)', async () => {
    const meshId = `mesh_al_dep_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([]) // empty node — dependent would otherwise be a legitimate first spawn
      // The prerequisite is in-flight (assigned, NOT completed) so it is not itself a pending
      // auto-launch candidate, leaving the dependent as the sole pending task the loop reaches.
      const dep = enqueueTask(meshId, 'prerequisite', { taskMode: 'code_change',
    difficulty: 'medium',
})
      MeshRuntimeStore.getInstance().updateQueueEntry({
        ...dep, status: 'assigned', assignedNodeId: NODE_ID, assignedSessionId: 'other-sess',
        updatedAt: new Date().toISOString(),
      } as any)
      const dependent = enqueueTask(meshId, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id],
    difficulty: 'medium',
})

      await triggerMeshQueue(components, meshId)

      // The dependent must NOT spawn a session — the launched session would idle→claim and be
      // refused by the SAME dependency gate in claimNextQueueTask (re-launch churn).
      expect(autoLaunchReason(meshId, dependent.id)).toBe('dependencies_unsatisfied')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('DEPENDSON-GATE-SYMMETRY: once the dependency completes, the dependent auto-launches (gate opens)', async () => {
    const meshId = `mesh_al_depdone_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([]) // empty node → legitimate spawn when unblocked
      const dep = enqueueTask(meshId, 'prerequisite', { taskMode: 'code_change',
    difficulty: 'medium',
})
      const dependent = enqueueTask(meshId, 'dependent work', { taskMode: 'code_change', dependsOn: [dep.id],
    difficulty: 'medium',
})
      // Complete the prerequisite so the gate opens.
      MeshRuntimeStore.getInstance().updateQueueEntry({ ...dep, status: 'completed' } as any)

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, dependent.id)).not.toBe('dependencies_unsatisfied')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('DISPATCH-DEADLOCK-COORD-SESSION-SLOT: a task targeting a node whose ONLY live session is the coordinator still auto-launches (coordinator is not a pending-claim worker)', async () => {
    const meshId = `mesh_al_coord_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // The node's only live mesh session is the coordinator (generating, no assigned task).
      // The idle→claim drain never picks it up (it is the dispatcher, not an idle worker), so
      // if the skip gate counted it as a pending claimer the task would pend forever with no
      // worker ever launching (silent deadlock). The gate must exclude it → a worker launches.
      const components = createComponents([coordinatorSession(meshId, 'coord-sess')])
      const task = enqueueTask(meshId, 'do work', { taskMode: 'code_change',
    difficulty: 'medium',
})

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: a read-only task still launches when the node\'s only session is genuinely BUSY (holds its own assigned task)', async () => {
    const meshId = `mesh_al_busy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const busySessionId = 'busy-sess'
      // The busy session holds an assigned WRITE task on the node — it is real concurrent
      // work, not a free claimer, so it must NOT suppress a read-only auto-launch.
      const now = new Date().toISOString()
      MeshRuntimeStore.getInstance().insertQueueEntry({
        id: 'assigned-write', meshId, message: 'edit', status: 'assigned', taskMode: 'code_change',
        assignedNodeId: NODE_ID, assignedSessionId: busySessionId, createdAt: now, updatedAt: now,
      } as any)
      const components = createComponents([liveSession(meshId, busySessionId, 'generating')])
      const task = enqueueTask(meshId, 'diagnose', { taskMode: 'live_debug_readonly',
    difficulty: 'medium',
})

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })
})

// DISPATCH-DEADLOCK-PROVIDER-MISMATCH: nodeHasLiveSessionPendingClaim must NOT count a live
// session as a pending claimer for a task it can never claim. A session whose providerType does
// not satisfy the task's required_tags (e.g. a claude-cli session while the task is
// required_tags: [provider=codex-cli]) is refused by claimNextQueueTask's nodeSatisfiesRequiredTags
// gate — so if the skip gate treated it as a pending claimer, the required-provider worker never
// auto-launched AND no session could claim → permanent silent deadlock. The gate must skip the
// mismatched session (launch proceeds) yet still suppress a launch when the live session's provider
// DOES match (genuine double-dispatch avoidance).
describe('DISPATCH-DEADLOCK-PROVIDER-MISMATCH — pending-claim gate honours provider match', () => {
  afterEach(() => { vi.clearAllMocks() })

  // A node that can launch BOTH providers, so once the mismatched-session skip clears the
  // required-provider (codex-cli) worker can actually launch.
  function setMultiProviderMesh(meshId: string) {
    meshConfigMocks.getMesh.mockReturnValue({
      id: meshId,
      name: 'Provider Match Mesh',
      policy: {},
      nodes: [{
        id: NODE_ID,
        workspace: `/repo/${NODE_ID}`,
        repoRoot: `/repo/${NODE_ID}`,
        policy: { providerPriority: ['codex-cli', 'claude-cli'] },
      }],
    })
  }

  it('launches (no skip) when the node\'s only live session is a DIFFERENT provider than the task requires', async () => {
    const meshId = `mesh_pm_mismatch_${randomUUID().slice(0, 8)}`
    try {
      setMultiProviderMesh(meshId)
      // Live claude-cli session (e.g. a plain worker) on the node, generating and holding no
      // assigned task. The pending task requires provider=codex-cli — this session can NEVER
      // claim it, so it must NOT suppress the codex-cli auto-launch.
      const components = createComponents([liveSession(meshId, 'claude-sess', 'generating', 'claude-cli')])
      const task = enqueueTask(meshId, 'do codex work', {
        taskMode: 'code_change',
        requiredTags: ['provider=codex-cli'],
        difficulty: 'medium',
      })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: still SUPPRESSES the launch when the live session\'s provider MATCHES the required provider (double-dispatch avoided)', async () => {
    const meshId = `mesh_pm_match_${randomUUID().slice(0, 8)}`
    try {
      setMultiProviderMesh(meshId)
      // The live session IS a claude-cli session and the task requires provider=claude-cli — it
      // will claim this task itself on its next idle, so a second launch must be suppressed.
      const components = createComponents([liveSession(meshId, 'claude-sess', 'generating', 'claude-cli')])
      const task = enqueueTask(meshId, 'do claude work', {
        taskMode: 'code_change',
        requiredTags: ['provider=claude-cli'],
        difficulty: 'medium',
      })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: an untagged task (no required provider) is still suppressed by ANY live pending-claim session', async () => {
    const meshId = `mesh_pm_untagged_${randomUUID().slice(0, 8)}`
    try {
      setMultiProviderMesh(meshId)
      // No required_tags → the provider-match gate is a no-op and the original behaviour holds:
      // any live unassigned session is a pending claimer.
      const components = createComponents([liveSession(meshId, 'any-sess', 'generating', 'claude-cli')])
      const task = enqueueTask(meshId, 'do any work', { taskMode: 'code_change',
    difficulty: 'medium',
})

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('node_has_live_session_pending_claim')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })
})

// AUTOLAUNCH-CLAIM-CHURN: a REMOTE launched-but-not-yet-claimed session is invisible to the local
// instanceManager. Before the fix, the respawn guards could not see it, so after the 90s
// await-claim window the loop respawned a ghost every ~90s (observed live: 7 ghosts on one task).
// The fix makes the respawn guards remote-aware (in-window auto-launch record counts as a live
// pending-claim session), re-drives the claim on window expiry with backoff, and — after the
// backoff cap — direct-dispatches into the existing session instead of respawning.
describe('AUTOLAUNCH-CLAIM-CHURN — remote-aware await-claim (no ghost respawns)', () => {
  const REMOTE_DAEMON = 'daemon_remote'

  afterEach(() => { vi.clearAllMocks() })

  function setRemoteMesh(meshId: string) {
    meshConfigMocks.getMesh.mockReturnValue({
      id: meshId,
      name: 'Remote Mesh',
      policy: {},
      nodes: [{ id: NODE_ID, daemonId: REMOTE_DAEMON, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } }],
    })
  }

  // Components for a remote node: launch_cli / agent_command flow over dispatchMeshCommand.
  function createRemoteComponents() {
    const dispatchMeshCommand = vi.fn(async (_daemonId: string, cmd: string) =>
      cmd === 'launch_cli' ? { success: true, sessionId: 'remote-sess-A' } : { success: true })
    return {
      instanceManager: {
        getByCategory: vi.fn((category: string) => (category === 'cli' ? [] : [])),
        getInstance: vi.fn(() => undefined),
      },
      cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
      providerLoader: {
        resolveAlias: vi.fn((t: string) => t),
        isMachineProviderEnabled: vi.fn(() => true),
        setCliDetectionResults: vi.fn(),
      },
      dispatchMeshCommand,
      statusInstanceId: 'daemon-local',
      onStatusChange: vi.fn(),
    } as any
  }

  function dispatchCalls(components: any, cmd: string): number {
    return components.dispatchMeshCommand.mock.calls.filter((c: any[]) => c[1] === cmd).length
  }

  // Seed a task's auto-launch record as a launched remote session, optionally aged past the window.
  function seedAutoLaunch(meshId: string, taskId: string, ageMs: number) {
    const store = MeshRuntimeStore.getInstance()
    const e = store.findQueueEntryById(meshId, taskId)!
    e.autoLaunch = {
      status: 'completed',
      sessionId: 'remote-sess-A',
      nodeId: NODE_ID,
      providerType: 'codex-cli',
      updatedAt: new Date(Date.now() - ageMs).toISOString(),
    }
    store.updateQueueEntry(e)
  }

  // (1) A node with an in-window remote auto-launch record suppresses a second launch for another
  // pending task — the record counts as a live pending-claim session even though it is remote.
  it('suppresses a second launch when the node already has an in-window (remote) auto-launch record', async () => {
    const meshId = `mesh_alc_inwindow_${randomUUID().slice(0, 8)}`
    try {
      setRemoteMesh(meshId)
      const components = createRemoteComponents()
      const taskA = enqueueTask(meshId, 'work A', { taskMode: 'code_change',
    difficulty: 'medium',
})
      const taskB = enqueueTask(meshId, 'work B', { taskMode: 'code_change',
    difficulty: 'medium',
})
      seedAutoLaunch(meshId, taskA.id, 0) // fresh — inside the 90s await-claim window

      await triggerMeshQueue(components, meshId)

      // Task A is awaiting its claim; task B must NOT spawn a duplicate (ghost) session.
      expect(autoLaunchReason(meshId, taskB.id)).toBe('node_has_live_session_pending_claim')
      expect(dispatchCalls(components, 'launch_cli')).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  // (2) On window expiry with unknown liveness (no remote idle registration, no backoff cap),
  // the window is extended with backoff — NOT respawned.
  it('extends the await-claim window with backoff (no respawn) when liveness is unknown on expiry', async () => {
    const meshId = `mesh_alc_backoff_${randomUUID().slice(0, 8)}`
    try {
      setRemoteMesh(meshId)
      const components = createRemoteComponents()
      const taskA = enqueueTask(meshId, 'work A', { taskMode: 'code_change',
    difficulty: 'medium',
})
      seedAutoLaunch(meshId, taskA.id, 100_000) // > 90s → base window expired

      await triggerMeshQueue(components, meshId)

      // No respawn (no launch_cli, no direct-dispatch): the window was extended with backoff.
      expect(dispatchCalls(components, 'launch_cli')).toBe(0)
      expect(dispatchCalls(components, 'agent_command')).toBe(0)
      expect(getQueue(meshId).find(t => t.id === taskA.id)?.status).toBe('pending')
      const backoffLogged = readLedgerEntries(meshId).some(e =>
        e.kind === 'session_auto_launch' && (e.payload as any)?.reason === 'awaiting_launched_session_claim_backoff')
      expect(backoffLogged).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  // (3) After the backoff cap, the task is direct-dispatched into the EXISTING launched session
  // (mesh_send_task-equivalent) rather than respawning a new one.
  it('direct-dispatches into the existing session after the backoff cap (no respawn)', async () => {
    const meshId = `mesh_alc_fallback_${randomUUID().slice(0, 8)}`
    try {
      setRemoteMesh(meshId)
      const components = createRemoteComponents()
      const taskA = enqueueTask(meshId, 'work A', { taskMode: 'code_change',
    difficulty: 'medium',
})
      seedAutoLaunch(meshId, taskA.id, 100_000) // past window
      // Drive straight to the cap: cycles at the cap, next attempt due now.
      __seedAutoLaunchAwaitClaimBackoffForTests(meshId, taskA.id, { cycles: 2, nextAttemptAtMs: 0 })

      await triggerMeshQueue(components, meshId)

      // No new session spawned; the task was delivered directly into the existing session and
      // the row is now assigned to it.
      expect(dispatchCalls(components, 'launch_cli')).toBe(0)
      expect(dispatchCalls(components, 'agent_command')).toBe(1)
      const row = getQueue(meshId).find(t => t.id === taskA.id)!
      expect(row.status).toBe('assigned')
      expect(row.assignedSessionId).toBe('remote-sess-A')
      const fallbackLogged = readLedgerEntries(meshId).some(e =>
        e.kind === 'session_auto_launch' && (e.payload as any)?.reason === 'await_claim_direct_dispatch_fallback')
      expect(fallbackLogged).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })
})
