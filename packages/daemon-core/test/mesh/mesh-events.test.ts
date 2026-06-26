import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore, pending events) to a per-run
// temp directory so test runs never pollute the production ~/.adhdev/mesh-ledger.
// Without this mock, insertDirectDispatch writes to the real mesh-runtime.db and the
// entries are never cleaned up — causing staleDirectWorkSummary.count to grow
// by 4 per test run across the production coordinator view.
const testTmpDir = path.join(tmpdir(), `adhdev-mesh-events-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ machineId: 'test-machine' } as any)),
}))
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: configMocks.loadConfig,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))

const detectCliMocks = vi.hoisted(() => ({
  detectCLI: vi.fn(),
}))

const fastForwardMocks = vi.hoisted(() => ({
  fastForwardMeshNode: vi.fn(),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

vi.mock('../../src/detection/cli-detector.js', () => ({
  detectCLI: detectCliMocks.detectCLI,
}))

vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({
  fastForwardMeshNode: fastForwardMocks.fastForwardMeshNode,
}))

import { __resetIdleAutoFastForwardForTests, __resetMeshWorkspaceCacheForTests, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, handleMeshForwardEvent, queuePendingMeshCoordinatorEvent, reconcileDirectDispatchCompletionFromTranscript, runMeshReconcileTick, setupMeshEventForwarding, triggerMeshQueue, tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, claimNextTask, enqueueTask, getQueue, insertDirectDispatch, getActiveDirectDispatches, recordTaskAutoLaunch } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { computeMeshTaskStats } from '../../src/mesh/mesh-task-stats.js'
import { getLedgerDir, readLedgerEntries, appendLedgerEntry, getLedgerSummary } from '../../src/mesh/mesh-ledger.js'
import { UNROUTABLE_DIAGNOSTIC_STREAM, __resetUnroutableDiagnosticsForTests } from '../../src/mesh/mesh-routing.js'

function createComponents(meshId = 'mesh_inline_1', workerSettings?: Record<string, unknown>, opts?: { coordinatorStatus?: 'idle' | 'generating'; statusInstanceId?: string }) {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: 'runtime-session-1',
    workspace: '/repo/worktree-a',
    settings: workerSettings ?? {
      meshNodeFor: meshId,
      meshNodeId: 'node_child_1',
    },
  }
  const coordinatorState = {
    instanceId: 'coordinator-session-1',
    workspace: '/repo/main',
    // The reconcile loop only injects into an idle coordinator. The old direct-inject
    // path didn't check status; queue+tick delivery does, so default to idle.
    status: opts?.coordinatorStatus ?? 'idle',
    settings: {
      meshCoordinatorFor: meshId,
    },
  }
  const source = {
    category: 'cli',
    getState: vi.fn(() => sourceState),
  }
  const coordinator = {
    category: 'cli',
    getState: vi.fn(() => coordinatorState),
    onEvent: vi.fn(),
  }
  const instanceManager = {
    onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
    getInstance: vi.fn((id: string) => id === 'runtime-session-1' ? source : undefined),
    getByCategory: vi.fn((category: string) => category === 'cli' ? [source, coordinator] : []),
  }

  return {
    components: { instanceManager, ...(opts?.statusInstanceId ? { statusInstanceId: opts.statusInstanceId } : {}) } as any,
    emit: (event: any) => {
      if (!listener) throw new Error('listener was not registered')
      listener(event)
    },
    coordinator,
  }
}

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetIdleAutoFastForwardForTests()
  __resetMeshWorkspaceCacheForTests()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  fastForwardMocks.fastForwardMeshNode.mockReset()
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

function createQueueAutoLaunchComponents(args?: {
  existingCliInstances?: any[]
  launchResult?: any
  launchDelayMs?: number
}) {
  const launchResult = args?.launchResult ?? { success: true, sessionId: 'auto-session-1' }
  const cliManager = {
    adapters: new Map(),
    handleCliCommand: vi.fn((command: string) => {
      if (command === 'launch_cli' && args?.launchDelayMs) {
        return new Promise(resolve => setTimeout(() => resolve(launchResult), args.launchDelayMs))
      }
      return Promise.resolve(command === 'launch_cli' ? launchResult : { success: true })
    }),
  }
  return {
    components: {
      instanceManager: {
        getByCategory: vi.fn((category: string) => category === 'cli' ? (args?.existingCliInstances || []) : []),
      },
      cliManager,
      providerLoader: {
        resolveAlias: vi.fn((type: string) => type),
        isMachineProviderEnabled: vi.fn(() => true),
        setCliDetectionResults: vi.fn(),
      },
      onStatusChange: vi.fn(),
    } as any,
    cliManager,
  }
}

describe('setupMeshEventForwarding', () => {
  it('forwards delegated completion to the matching coordinator using runtime mesh settings without local mesh config', async () => {
    const meshId = `mesh_inline_forward_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit, coordinator } = createComponents(meshId)

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-history-1',
        duration: 7,
        timestamp: 123,
      })

      // Queue-only delivery now: the periodic reconcile tick drains the queue and
      // injects into the idle coordinator.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = coordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      const text = payload.input.textFallback
      expect(text).toContain("Node 'node_child_1'")
      expect(text).toContain('session_id=runtime-session-1')
      expect(text).toContain('provider_session_id=provider-history-1')
      expect(text).toContain('provider=hermes-cli')
      expect(text).toContain('status event path')
      expect(text).toContain('mesh_read_chat once')
      expect(text).toContain('do not poll repeatedly')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('standalone end-to-end: a coordinator self-receives a local worker completion stamped with the standalone status id (held while generating, delivered on idle, no manual pull)', async () => {
    // Full reproduction of the reported bug, exercising the REAL production path:
    //   worker completes → setupMeshEventForwarding → injectMeshSystemMessage queues a
    //   unicast pending event stamped targetCoordinatorDaemonId = the worker's
    //   meshCoordinatorDaemonId → runMeshReconcileTick must deliver it to the coordinator.
    // On standalone the MCP layer stamps meshCoordinatorDaemonId = `standalone_<machineId>`
    // (= getStatus().status.instanceId), NOT bare machineId. Before the id-form fix the
    // reconcile loop drained with bare loadConfig().machineId, so the unicast event never
    // matched. NOTIF-SURFACE-LOCAL adds the second half: while the coordinator's OWN session
    // is generating (the false-idle window — it is awaiting this very worker), a raw PTY
    // force-write is not consumed as a turn, so the event is HELD (not injected, not drained)
    // and delivered on the coordinator's next idle tick as a real turn.
    const meshId = `mesh_standalone_e2e_${Date.now()}`
    const statusInstanceId = 'standalone_test-machine'
    try {
      const mesh = { id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }] }
      meshConfigMocks.getMesh.mockReturnValue(mesh)
      meshConfigMocks.getMeshByRepo.mockReturnValue(mesh)
      // Worker stamped exactly as the standalone MCP dispatch path stamps it.
      const { components, emit, coordinator } = createComponents(meshId, {
        meshNodeFor: meshId,
        meshNodeId: 'node_child_1',
        meshCoordinatorDaemonId: statusInstanceId,
        launchedByCoordinator: true,
      }, { coordinatorStatus: 'generating', statusInstanceId })

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'provider-history-1',
        finalSummary: 'done',
        timestamp: 456,
      })

      // The coordinator is GENERATING — queue-only at emit time, and the reconcile tick
      // HOLDS it (no force-write into a generating PTY). The completion sits in the queue
      // stamped with the status id, undrained.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId, statusInstanceId)).toHaveLength(1)

      // The coordinator's turn ends → idle. The next tick drains the status-id-stamped
      // unicast event and delivers it into the idle input box as a real turn. This is the
      // self-receive that was broken (and lost in the false-idle window before the fix).
      coordinator.getState().status = 'idle'
      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = coordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.force).toBe(true)
      expect(payload.input.textFallback).toContain("Node 'node_child_1'")

      // Consumed atomically: a subsequent pull (with the status id) returns nothing.
      expect(drainPendingMeshCoordinatorEvents(meshId, statusInstanceId)).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('forwards completion when the worker carries only meshCoordinatorDaemonId (meshNodeFor stamp missing)', async () => {
    // Regression: a cloud worker can arrive with meshCoordinatorDaemonId set but meshNodeFor
    // undefined (envelope stamp dropped on a relaunch / direct dispatch). Gating delegate
    // routing on meshNodeFor alone made setupMeshEventForwarding return early, so the
    // completion only landed in the pending queue and the coordinator was never injected —
    // exactly the "completed but coordinator not notified" symptom. The worker envelope
    // marker (meshCoordinatorDaemonId) must be enough to route, recovering the mesh id by
    // workspace.
    const meshId = `mesh_envelope_only_${Date.now()}`
    try {
      const meshByWorkspace = {
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
      }
      meshConfigMocks.getMesh.mockReturnValue(meshByWorkspace)
      meshConfigMocks.getMeshByRepo.mockReturnValue(meshByWorkspace)
      const { components, emit, coordinator } = createComponents(meshId, {
        // No meshNodeFor — only the routing anchor stamped by the launch envelope hardening.
        meshCoordinatorDaemonId: 'test-machine',
        launchedByCoordinator: true,
      })

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'claude-history-1',
        finalSummary: 'done',
        timestamp: 99,
      })

      // Coordinator must be injected (via the reconcile tick), not just queued.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = coordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.input.textFallback).toContain('has completed its task')
      expect(payload.force).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('R4: emits a delivery_unroutable diagnostic when an enveloped worker resolves to no mesh AND has no coordinator anchor', () => {
    // The worker presents a valid envelope (launchedByCoordinator) but neither the mesh-id
    // lookup nor the workspace lookup resolves a mesh, AND it carries no coordinator daemon
    // anchor — so there is nowhere to fallback-forward the event. Before R4 the completion
    // was dropped silently — no coordinator inject, no queue, no trace. R4 leaves a fail-loud
    // delivery_unroutable ledger entry so the lost completion is discoverable.
    const meshId = `mesh_unroutable_${Date.now()}`
    __resetUnroutableDiagnosticsForTests()
    __resetMeshWorkspaceCacheForTests() // ensure no prior test cached /repo/worktree-a → a real mesh
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined) // no mesh resolvable by workspace either
      const { components, emit, coordinator } = createComponents(meshId, {
        launchedByCoordinator: true, // envelope present, but meshNodeFor absent and workspace unresolved
        // NOTE: deliberately no meshCoordinatorDaemonId — without it the fallback forward
        // cannot run, so the event must still land in the unroutable diagnostic stream.
      })
      const dispatchMeshCommand = vi.fn(async () => ({}))
      components.dispatchMeshCommand = dispatchMeshCommand

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        timestamp: 4242,
      })

      // The event was unroutable: no coordinator inject, and no fallback P2P forward
      // (there was no coordinator anchor to forward to).
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(dispatchMeshCommand).not.toHaveBeenCalled()

      // A fail-loud diagnostic landed in the shared unroutable stream.
      const diagnostics = readLedgerEntries(UNROUTABLE_DIAGNOSTIC_STREAM, { kind: ['delivery_unroutable'] })
      const mine = diagnostics.filter(d => (d.payload as any)?.workspace === '/repo/worktree-a' && d.sessionId === 'runtime-session-1')
      expect(mine.length).toBeGreaterThanOrEqual(1)
      expect((mine[mine.length - 1].payload as any).event).toBe('agent:generating_completed')
      expect((mine[mine.length - 1].payload as any).reason).toBe('mesh_unresolved')
    } finally {
      cleanupMeshFiles(meshId)
      // The diagnostic stream is shared across meshes; clean our entries up too.
      const diagPath = path.join(getLedgerDir(), `${UNROUTABLE_DIAGNOSTIC_STREAM}.jsonl`)
      if (fs.existsSync(diagPath)) fs.unlinkSync(diagPath)
      __resetUnroutableDiagnosticsForTests()
    }
  })

  it('fallback-forwards an unresolved-mesh worker completion to its coordinator daemon over P2P', async () => {
    // A REMOTE worker (P2P-remote-controlled by a coordinator) is NOT a member of the
    // coordinator's mesh: meshNodeFor is absent and the workspace lookup resolves no mesh,
    // so routing returns mesh_unresolved. But the worker carries the coordinator daemon
    // anchor (meshCoordinatorDaemonId). Instead of dropping the event (delivery_unroutable),
    // the forwarder must dispatch it straight to that coordinator daemon via P2P, which
    // hosts the mesh and recovers the id by workspace.
    const meshId = `mesh_fallback_fwd_${Date.now()}`
    __resetUnroutableDiagnosticsForTests()
    __resetMeshWorkspaceCacheForTests()
    // The unroutable stream is shared across tests (same workspace/session); start from a
    // clean slate — JSONL file, the SQLite runtime store, and the in-memory read cache —
    // so a prior test's diagnostic can't leak into our "no unroutable entry" assertion.
    const diagPathStart = path.join(getLedgerDir(), `${UNROUTABLE_DIAGNOSTIC_STREAM}.jsonl`)
    if (fs.existsSync(diagPathStart)) fs.unlinkSync(diagPathStart)
    __resetMeshRuntimeStoreForTests()
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined) // worker can't resolve the mesh locally
      const { components, emit, coordinator } = createComponents(meshId, {
        meshCoordinatorDaemonId: 'daemon_remote_coordinator', // the routing anchor survives
        meshNodeId: 'node_child_1',
        launchedByCoordinator: true,
      })
      const dispatchMeshCommand = vi.fn(async () => ({}))
      components.dispatchMeshCommand = dispatchMeshCommand

      // Baseline unroutable count for our (session, workspace) BEFORE the emit — the shared
      // stream may already hold entries from earlier tests, so we assert the delta is zero.
      const matchesMine = (d: any) => d.sessionId === 'runtime-session-1' && (d.payload as any)?.workspace === '/repo/worktree-a'
      const unroutableCountBefore = readLedgerEntries(UNROUTABLE_DIAGNOSTIC_STREAM, { kind: ['delivery_unroutable'] }).filter(matchesMine).length

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'claude-history-9',
        finalSummary: 'remote task done',
        timestamp: 7777,
      })

      // The event was forwarded to the coordinator daemon via P2P mesh_forward_event …
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
      const [targetDaemonId, command, payload] = dispatchMeshCommand.mock.calls[0]
      expect(targetDaemonId).toBe('daemon_remote_coordinator')
      expect(command).toBe('mesh_forward_event')
      expect(payload.event).toBe('agent:generating_completed')
      expect(payload.workspace).toBe('/repo/worktree-a')
      expect(payload.nodeId).toBe('node_child_1')
      expect(payload.finalSummary).toBe('remote task done')
      // meshId is intentionally omitted — the worker has none; the coordinator recovers it.
      expect(payload.meshId).toBeUndefined()

      // … and was NOT recorded as unroutable, because the fallback succeeded: no new entry.
      const unroutableCountAfter = readLedgerEntries(UNROUTABLE_DIAGNOSTIC_STREAM, { kind: ['delivery_unroutable'] }).filter(matchesMine).length
      expect(unroutableCountAfter).toBe(unroutableCountBefore)

      // The local worker daemon does not inject into a coordinator (it isn't one).
      expect(coordinator.onEvent).not.toHaveBeenCalled()
    } finally {
      cleanupMeshFiles(meshId)
      const diagPath = path.join(getLedgerDir(), `${UNROUTABLE_DIAGNOSTIC_STREAM}.jsonl`)
      if (fs.existsSync(diagPath)) fs.unlinkSync(diagPath)
      __resetUnroutableDiagnosticsForTests()
    }
  })

  it('queues agent:generating_completed and the reconcile tick injects it into the live CLI coordinator', async () => {
    const meshId = `mesh_completion_pending_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit, coordinator } = createComponents(meshId)

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'codex-history-1',
        finalSummary: 'done',
        timestamp: 12345,
      })

      // Queue-only delivery: the event is persisted to the pending queue first and
      // is visible to any consumer that peeks before the tick drains it.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)

      // The reconcile tick drains the queue (scoped to this daemon) and injects.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = coordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.input.textFallback).toContain('has completed its task')
      // Completion is a terminal event the coordinator may be blocked-generating on,
      // so it must be force-injected to bypass the busy send-guard / pendingOutboundQueue.
      expect(payload.force).toBe(true)

      // The tick's scoped drain (scoped to 'test-machine') already consumed the
      // unscoped queued event, so a subsequent unscoped drain sees nothing.
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('queues a silent agent:ready from a remote-coordinator worker so the coordinator can pull and claim', () => {
    // Regression (remote queue auto-launch claim loop): an auto-launched REMOTE worker
    // carries meshNodeFor (so resolveWorkerDelegateRouting treats it as a delegate) AND a
    // REMOTE meshCoordinatorDaemonId. When its session goes starting→idle it emits
    // agent:ready, which produces NO coordinator message. injectMeshSystemMessage used to
    // return early on the empty message and NEVER queue it — so the agent:ready (the event
    // that drives setRemoteIdleSession + tryAssignQueueTask) never reached the coordinator's
    // daemon. The coordinator never learned the session was idle, the queue task stayed
    // pending, and the reconcile loop re-auto-launched a fresh session every tick forever.
    // The fix queues the silent lifecycle event scoped to the remote coordinator daemon so
    // PHASE 1 pullRemoteNodeQueues delivers it and the claim runs on the right daemon.
    const meshId = `mesh_ready_remote_claim_${Date.now()}`
    try {
      // On the remote worker daemon the mesh is not locally hosted, but the meshNodeFor
      // stamp keeps the resolved meshId non-empty (delegate=true).
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit } = createComponents(meshId, {
        meshNodeFor: meshId,
        meshNodeId: 'node_child_1',
        meshCoordinatorDaemonId: 'daemon_remote_coordinator', // a DIFFERENT daemon than this one
        launchedByCoordinator: true,
      })

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        timestamp: 7001,
      })

      // The silent agent:ready is queued and stamped for the remote coordinator daemon, so
      // a scoped pull (PHASE 1 get_pending_mesh_events { coordinatorDaemonId }) delivers it.
      const scoped = getPendingMeshCoordinatorEvents(meshId, 'daemon_remote_coordinator')
      expect(scoped).toHaveLength(1)
      expect(scoped[0].event).toBe('agent:ready')
      expect(scoped[0].targetCoordinatorDaemonId).toBe('daemon_remote_coordinator')
      // It is a silent lifecycle event: no coordinator message, so a live CLI coordinator
      // is never injected/spammed with it (injectPendingIntoCoordinator skips empty messages).
      expect(scoped[0].coordinatorMessage ?? '').toBe('')
      // The claim-relevant metadata the coordinator needs to run tryAssignQueueTask survives.
      expect(scoped[0].metadataEvent.providerType).toBe('claude-cli')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('re-registers the remote-idle session on agent:generating_completed so a later enqueue reuses it instead of auto-launching (OVEREAGER-REMOTE-IDLE Defect A+B)', async () => {
    // Defect A+B root: setRemoteIdleSession used to run ONLY on agent:ready, while
    // agent:generating_started DELETES the entry. So the FIRST turn a remote worker runs
    // permanently evicts it from the remote-idle store, and generating_completed never
    // re-added it. A later mesh_enqueue_task's triggerMeshQueue then saw
    // getRemoteIdleSessions() == 0 (remoteIdleSessionsChecked:0) for a genuinely live-idle
    // session — needlessly auto-launching a second worker (A) and, because the two idle
    // sources disagreed, injecting the task body into BOTH sessions (B). The fix re-registers
    // the now-idle session on a genuine completion, symmetric with agent:ready.
    const meshId = `mesh_overeager_idle_reuse_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }] })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit } = createComponents(meshId, {
        meshNodeFor: meshId,
        meshNodeId: 'node_child_1',
        launchedByCoordinator: true,
      })

      setupMeshEventForwarding(components)

      // The worker started a turn → remote-idle entry is cleared (matches production).
      emit({
        event: 'agent:generating_started',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        meshNodeId: 'node_child_1',
        nodeId: 'node_child_1',
      })
      expect(MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId).some(s => s.sessionId === 'runtime-session-1')).toBe(false)

      // The turn completed with a genuine final assistant → the session is live-idle again and
      // MUST be re-registered so the next enqueue drain reuses it.
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        meshNodeId: 'node_child_1',
        nodeId: 'node_child_1',
        finalSummary: 'done',
        timestamp: 9100,
      })

      const idle = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
        .find(s => s.sessionId === 'runtime-session-1')
      expect(idle).toBeDefined()
      expect(idle?.nodeId).toBe('node_child_1')
      expect(idle?.providerType).toBe('claude-cli')

      // A subsequent enqueue's triggerMeshQueue now SEES the live-idle remote session
      // (remoteIdleSessionsChecked >= 1) rather than reporting 0 and auto-launching.
      enqueueTask(meshId, 'reuse-vs-autolaunch task', { targetNodeId: 'node_child_1' })
      const trigger = await triggerMeshQueue(components, meshId)
      expect(trigger.remoteIdleSessionsChecked).toBeGreaterThanOrEqual(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT re-register a false-idle agent:generating_completed (no final assistant) into the remote-idle store', () => {
    // A false-idle completion (mid-turn / no confirmed final assistant) means the session is
    // NOT genuinely idle — re-registering it would let the enqueue drain dispatch into a
    // session that is still working. Only a genuine completion re-registers.
    const meshId = `mesh_overeager_false_idle_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }] })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit } = createComponents(meshId, {
        meshNodeFor: meshId,
        meshNodeId: 'node_child_1',
        launchedByCoordinator: true,
      })

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        meshNodeId: 'node_child_1',
        nodeId: 'node_child_1',
        // completionDiagnostic marks this as a false-idle (no confirmed final assistant).
        completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' },
      })

      expect(MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId).some(s => s.sessionId === 'runtime-session-1')).toBe(false)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT queue a silent agent:ready when the worker is co-located with its coordinator', () => {
    // The mirror of the regression above: when the worker's coordinator IS this daemon
    // (the auto-launch stamped no meshCoordinatorDaemonId, or it equals this daemon's id),
    // the agent:ready claim already ran locally on the correct daemon. Queuing the silent
    // event would be pointless churn (nothing pulls it) — so it must NOT be queued. This
    // also guards against the coordinator re-queuing an agent:ready it pulled from a worker
    // (that path has no sourceSession, so workerCoordinatorDaemonId is empty → no re-queue).
    const meshId = `mesh_ready_local_no_queue_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      // No meshCoordinatorDaemonId stamp → workerCoordinatorDaemonId is empty → co-located.
      const { components, emit } = createComponents(meshId, {
        meshNodeFor: meshId,
        meshNodeId: 'node_child_1',
      })
      components.cliManager = { handleCliCommand: vi.fn(async () => ({ success: true })) }

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        timestamp: 7002,
      })

      // Nothing queued under any scope — the local claim path handled it directly.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
      expect(getPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('queues a completion exactly-once via the atomic queue drain (a second drain returns nothing)', () => {
    // Queue-only delivery: the terminal event is persisted to the pending queue exactly once.
    // A single drain consumes it; the SQLite drained=1 marking guarantees a second drain
    // (e.g. the reconcile tick and an MCP poll racing) sees nothing — exactly-once consumption.
    const meshId = `mesh_r3_exactly_once_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit } = createComponents(meshId)

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'codex-history-r3',
        finalSummary: 'done',
        timestamp: 99001,
      })

      // First drain (scoped to this coordinator daemon) returns the event once.
      const firstDrain = drainPendingMeshCoordinatorEvents(meshId, 'test-machine')
      expect(firstDrain).toHaveLength(1)
      expect(firstDrain[0].event).toBe('agent:generating_completed')

      // Second drain must return nothing — the event was already consumed.
      const secondDrain = drainPendingMeshCoordinatorEvents(meshId, 'test-machine')
      expect(secondDrain).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('standalone: prefixed worker stamp (standalone_<machineId>) queues exactly-once for the prefixed drain', () => {
    // Standalone divergence: the MCP coordinator reports ctx.localDaemonId as the runtime
    // instanceId `standalone_<machineId>` and stamps that prefixed id onto workers as
    // meshCoordinatorDaemonId, then drains with it. The queued event is scoped to that
    // prefixed daemon and a single scoped drain consumes it exactly once.
    const meshId = `mesh_r3_standalone_prefix_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
      })
      // Worker carries the PREFIXED coordinator daemon id, as standalone stamps it.
      const { components, emit } = createComponents(meshId, {
        meshNodeFor: meshId,
        meshNodeId: 'node_child_1',
        meshCoordinatorDaemonId: 'standalone_test-machine',
      })

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'claude-history-standalone',
        finalSummary: 'done',
        timestamp: 99003,
      })

      // The coordinator drains with its prefixed instanceId — gets the event once.
      const firstDrain = drainPendingMeshCoordinatorEvents(meshId, 'standalone_test-machine')
      expect(firstDrain).toHaveLength(1)
      expect(firstDrain[0].event).toBe('agent:generating_completed')

      // A second drain with the same prefixed id must return nothing (exactly-once).
      const secondDrain = drainPendingMeshCoordinatorEvents(meshId, 'standalone_test-machine')
      expect(secondDrain).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('R3: a DIFFERENT coordinator daemon still drains the queued event (dual delivery preserved for others)', () => {
    // The dedup is scoped per coordinator daemon: only the daemon that received the direct inject
    // skips the queued copy. A coordinator on another daemon (or an unscoped/MCP-only consumer)
    // never received the inject and must still backfill from the queue.
    const meshId = `mesh_r3_other_daemon_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit } = createComponents(meshId)

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'codex-history-r3b',
        finalSummary: 'done',
        timestamp: 99002,
      })

      const otherDaemonDrain = drainPendingMeshCoordinatorEvents(meshId, 'some-other-daemon')
      expect(otherDaemonDrain).toHaveLength(1)
      expect(otherDaemonDrain[0].event).toBe('agent:generating_completed')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('force-injects terminal events so a generating coordinator is not deadlocked, but not non-terminal status events', async () => {
    // Regression for the long-standing "recorded but never injected into coordinator chat"
    // deadlock: a coordinator CLI session that dispatched a task stays in `generating`
    // while awaiting the result. A generating coordinator queues incoming send_message
    // calls into its adapter's pendingOutboundQueue, which is only flushed on the
    // coordinator's OWN idle transition — a transition that cannot happen until it
    // receives the completion. Terminal events must therefore be force-injected so they
    // bypass the busy send-guard. Non-terminal status events (generating_started) must
    // NOT be forced, since they are mere informational chatter.
    const meshId = `mesh_force_inject_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit, coordinator } = createComponents(meshId)
      setupMeshEventForwarding(components)

      // Terminal completion → force inject
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'codex-history-force',
        finalSummary: 'done',
        timestamp: 22221,
      })
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][1].force).toBe(true)

    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not force-inject non-terminal no-progress alerts into the coordinator', async () => {
    // no_progress is informational — the coordinator should receive it through the
    // normal (queueable) path, not force-written into a generating PTY as noise.
    const meshId = `mesh_no_force_long_gen_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit, coordinator } = createComponents(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'monitor:no_progress',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        timestamp: 33331,
      })

      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][0]).toBe('send_message')
      expect(coordinator.onEvent.mock.calls[0][1].input.textFallback).toContain('still reported as generating')
      expect(coordinator.onEvent.mock.calls[0][1].force).toBeUndefined()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('dedupes the same approval event before ledger and coordinator delivery', async () => {
    const meshId = `mesh_approval_dedupe_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit, coordinator } = createComponents(meshId)

      setupMeshEventForwarding(components)
      const approvalEvent = {
        event: 'agent:waiting_approval',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        modalMessage: 'Allow git commit?',
        modalButtons: ['Allow once', 'Reject'],
        timestamp: 12346,
      }
      emit(approvalEvent)
      emit(approvalEvent)

      // The duplicate is deduped before queuing: exactly one ledger entry and one queued event.
      expect(readLedgerEntries(meshId).filter(entry => entry.kind === 'task_approval_needed')).toHaveLength(1)
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)

      // The reconcile tick injects the single deduped approval exactly once.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('marks the assigned queue task completed when a completion event only carries instanceId', () => {
    const meshId = `mesh_completion_fallback_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const queued = enqueueTask(meshId, 'queued task')
      const claimed = claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      expect(claimed?.id).toBe(queued.id)
      expect(getQueue(meshId)[0].status).toBe('assigned')

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-history-1',
      })

      expect(getQueue(meshId)[0].status).toBe('completed')
      const completedEntry = readLedgerEntries(meshId).find(entry => entry.kind === 'task_completed')
      expect(completedEntry?.payload.evidence).toMatchObject({
        source: 'agent_status_event',
        event: 'agent:generating_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        transcriptHandle: {
          kind: 'provider_session',
          sessionId: 'runtime-session-1',
          providerSessionId: 'provider-history-1',
          finalSummaryAvailable: false,
        },
        git: {
          status: 'deferred',
          reason: 'ordinary_completion_git_status_not_checked',
        },
        validation: {
          status: 'deferred',
          commandsRun: [],
          reason: 'ordinary_completion_validation_not_run',
        },
        checkpoint: {
          attempted: false,
          reason: 'not_attempted_for_ordinary_completion',
        },
      })
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('records task_completed for short-generating suppressed completion with short_generating_suppressed diagnostic', () => {
    // Reproduces Bug 1: a direct dispatch to an idle session that completes so fast
    // that the generating debounce is suppressed (< 1s generating). After fix, the provider
    // still emits agent:generating_completed with completionDiagnostic.reason=short_generating_suppressed,
    // and the mesh event system records task_completed so the direct dispatch is NOT classified stale.
    const meshId = `mesh_short_gen_suppressed_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const queued = enqueueTask(meshId, 'short-generating task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      expect(getQueue(meshId)[0].status).toBe('assigned')

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'provider-session-short',
        duration: 0,
        timestamp: Date.now(),
        completionDiagnostic: {
          reason: 'short_generating_suppressed',
          shortDurationMs: 450,
        },
      })

      expect(getQueue(meshId)[0].status).toBe('completed')
      const completedEntry = readLedgerEntries(meshId).find(entry => entry.kind === 'task_completed')
      expect(completedEntry).toBeDefined()
      expect(completedEntry?.payload.taskId).toBe(queued.id)
      expect(completedEntry?.payload.completionDiagnostic).toMatchObject({
        reason: 'short_generating_suppressed',
        shortDurationMs: 450,
      })
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('runs a throttled idle auto fast-forward before assigning the next queue task', async () => {
    const meshId = `mesh_idle_auto_ff_${Date.now()}`
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'adhdev-idle-auto-ff-'))
    try {
      await new Promise(resolve => setImmediate(resolve))
      __resetIdleAutoFastForwardForTests()
      fastForwardMocks.fastForwardMeshNode.mockReset()
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      fastForwardMocks.fastForwardMeshNode
        .mockResolvedValueOnce({
          success: true,
          code: 'fast_forward_available',
          allowed: true,
          dryRun: true,
          willRun: false,
          executed: false,
        })
        .mockResolvedValueOnce({
          success: true,
          code: 'fast_forward_applied',
          allowed: true,
          dryRun: false,
          willRun: true,
          executed: true,
        })

      const nextTask = enqueueTask(meshId, 'next queued task')
      const { components, emit } = createComponents(meshId)
      components.cliManager = {
        handleCliCommand: vi.fn(async () => ({ success: true })),
      }
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
      })

      await vi.waitFor(() => {
        expect(fastForwardMocks.fastForwardMeshNode).toHaveBeenCalledTimes(2)
        expect(getQueue(meshId).find(task => task.id === nextTask.id)?.status).toBe('assigned')
      })
      expect(fastForwardMocks.fastForwardMeshNode.mock.calls[0][0]).toMatchObject({
        meshId,
        nodeId: 'node_child_1',
        workspace,
        dryRun: true,
        trigger: 'idle_auto',
      })
      expect(fastForwardMocks.fastForwardMeshNode.mock.calls[1][0]).toMatchObject({
        meshId,
        nodeId: 'node_child_1',
        workspace,
        execute: true,
        trigger: 'idle_auto',
      })

      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(fastForwardMocks.fastForwardMeshNode).toHaveBeenCalledTimes(2)
    } finally {
      cleanupMeshFiles(meshId)
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('skips idle auto fast-forward when mesh policy disables it', async () => {
    const meshId = `mesh_idle_auto_ff_disabled_${Date.now()}`
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'adhdev-idle-auto-ff-disabled-'))
    try {
      __resetIdleAutoFastForwardForTests()
      fastForwardMocks.fastForwardMeshNode.mockReset()
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace }],
        policy: { autoFastForward: { enabled: false } },
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const nextTask = enqueueTask(meshId, 'next queued task')
      const { components, emit } = createComponents(meshId)
      components.cliManager = {
        handleCliCommand: vi.fn(async () => ({ success: true })),
      }
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
      })

      await vi.waitFor(() => {
        expect(getQueue(meshId).find(task => task.id === nextTask.id)?.status).toBe('assigned')
      })
      expect(fastForwardMocks.fastForwardMeshNode).not.toHaveBeenCalled()
    } finally {
      cleanupMeshFiles(meshId)
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not execute idle auto fast-forward when dry-run exceeds maxBehind policy', async () => {
    const meshId = `mesh_idle_auto_ff_max_${Date.now()}`
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'adhdev-idle-auto-ff-max-'))
    try {
      __resetIdleAutoFastForwardForTests()
      fastForwardMocks.fastForwardMeshNode.mockReset()
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace }],
        policy: { autoFastForward: { enabled: true, maxBehind: 2 } },
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      fastForwardMocks.fastForwardMeshNode.mockResolvedValueOnce({
        success: true,
        code: 'fast_forward_available',
        allowed: true,
        dryRun: true,
        willRun: false,
        executed: false,
        current: { ahead: 0, behind: 3, submodules: [] },
      })

      const nextTask = enqueueTask(meshId, 'next queued task')
      const { components, emit } = createComponents(meshId)
      components.cliManager = {
        handleCliCommand: vi.fn(async () => ({ success: true })),
      }
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
      })

      await vi.waitFor(() => {
        expect(fastForwardMocks.fastForwardMeshNode).toHaveBeenCalledTimes(1)
        expect(getQueue(meshId).find(task => task.id === nextTask.id)?.status).toBe('assigned')
      })
      expect(fastForwardMocks.fastForwardMeshNode.mock.calls[0][0]).toMatchObject({
        dryRun: true,
        trigger: 'idle_auto',
      })
    } finally {
      cleanupMeshFiles(meshId)
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('records task_completed for direct dispatch (no queue task) via short-generating suppressed path, matched by sessionId', () => {
    // Reproduces Bug 1 for direct dispatch (non-queue) path: no queue task exists,
    // so completedTaskForLedger is null, and the task_completed ledger entry has no taskId.
    // buildMeshActiveWork must match this by sessionId, classifying it as terminalDirectWork.
    const meshId = `mesh_short_gen_direct_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      // No queue task — this is a direct dispatch (e.g., mesh_send_task).
      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'provider-session-direct',
        duration: 0,
        timestamp: Date.now(),
        completionDiagnostic: {
          reason: 'short_generating_suppressed',
          shortDurationMs: 200,
        },
      })

      // A task_completed entry must still be written even without a queue task.
      const entries = readLedgerEntries(meshId)
      const completedEntry = entries.find(entry => entry.kind === 'task_completed')
      expect(completedEntry).toBeDefined()
      // No queue taskId — direct dispatch path writes no taskId in the terminal entry.
      expect(completedEntry?.payload.taskId).toBeUndefined()
      // sessionId must be recorded for terminalMatchesDispatch to find it by sessionId.
      expect(completedEntry?.sessionId).toBe('runtime-session-1')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not suppress a direct-dispatch completion against prior terminal ledger evidence, so the coordinator still observes task_completed', async () => {
    // Regression for the "task_completed silently idle" bug: a session direct-dispatched via
    // mesh_send_task (tracked in mesh_direct_dispatches, NOT the work queue) completes. A prior
    // terminal ledger entry exists for the same session with a matching finalSummary — e.g. a
    // reconciliation/ready-derived task_completed. The dedup at injectMeshSystemMessage gated only
    // on sessionHasActiveAssignment(), which inspected the work queue alone and was therefore blind
    // to in-flight direct dispatches. It wrongly classified the canonical agent:generating_completed
    // as a duplicate and returned forwarded:0 WITHOUT queuing a pending coordinator event, so a
    // coordinator polling get_pending_mesh_events never observed the completion and the session went
    // silently idle. The active direct dispatch must keep the completion alive: exactly one
    // task_completed pending coordinator event, even when no live CLI coordinator is present
    // (MCP/polling coordinator) and even when the coordinator is generating (force path).
    const meshId = `mesh_direct_no_suppress_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      // An active direct dispatch (mesh_send_task, validation) targeting the session.
      insertDirectDispatch(meshId, {
        taskId: 'task_direct_validation',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        message: 'validate the worktree',
        taskMode: 'validation',
        via: 'local_direct',
        dispatchedAt: new Date().toISOString(),
      })

      // Prior terminal ledger evidence for the SAME session with a matching finalSummary.
      // This is exactly the shape findRecentTerminalLedgerEvidence keys off to suppress.
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        payload: {
          event: 'agent:generating_completed',
          taskId: 'task_direct_validation',
          providerSessionId: 'provider-history-validation',
          finalSummary: 'validation report: all green',
          completedViaReady: true,
        },
      })

      const { components, emit, coordinator } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'provider-history-validation',
        finalSummary: 'validation report: all green',
        timestamp: Date.now(),
      })

      // The completion must NOT be suppressed. The MCP/polling coordinator can peek exactly
      // one task_completed event from the shared pending queue.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0].event).toBe('agent:generating_completed')
      expect(pending[0].metadataEvent.targetSessionId).toBe('runtime-session-1')

      // The reconcile tick injects into the live CLI coordinator, force-injected so a
      // generating coordinator awaiting this very completion is not deadlocked.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][0]).toBe('send_message')
      expect(coordinator.onEvent.mock.calls[0][1].force).toBe(true)
      expect(coordinator.onEvent.mock.calls[0][1].input.textFallback).toContain('has completed its task')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('CANON-B direct-dispatch race: a NEW task completion into a reused idle session is not suppressed by the PRIOR task terminal (same providerSessionId) and flips its own row, not a sibling', async () => {
    // Race regression: a fast mesh_send_task into an ALREADY-IDLE, previously-used session can
    // have its genuine agent:generating_completed reach the coordinator handler BEFORE the
    // dispatching side commits the new task's dispatch row / task_dispatched ledger entry. In
    // that window sessionHasActiveAssignment is false (no active dispatch row, no unterminal
    // ledger entry yet). The session already carries a PRIOR task_completed terminal whose
    // providerSessionId is identical (providerSessionId is stable across a reused session's
    // turns), so the prior-terminal dedup would match the NEW completion as a duplicate of the
    // PRIOR task and silently drop it (the intermittent miss). The echoed taskId is the
    // authoritative discriminator: a DIFFERENT taskId is a genuinely new completion and must
    // pass through. Fresh enqueue/autoLaunch is immune (no prior same-providerSessionId
    // terminal; queue row claimed atomically before dispatch) — hence direct-dispatch only.
    const meshId = `mesh_canonb_direct_race_${Date.now()}`
    const sharedProviderSessionId = 'provider-session-reused'
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      // PRIOR task terminal for the SAME session/providerSessionId — exactly the shape
      // findRecentTerminalLedgerEvidence keys off to suppress a later completion.
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        payload: {
          event: 'agent:generating_completed',
          taskId: 'task_prior',
          providerSessionId: sharedProviderSessionId,
          finalSummary: 'prior task report',
          completedViaReady: true,
        },
      })

      // A SIBLING direct dispatch that is still active and MUST NOT be flipped by the
      // completion of a different task. (It shares the session but a distinct taskId.)
      insertDirectDispatch(meshId, {
        taskId: 'task_sibling',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        message: 'sibling still-running task',
        via: 'local_direct',
        dispatchedAt: new Date().toISOString(),
      })

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      // The NEW task's genuine completion. It carries its own taskId (task_new) and the SAME
      // stable providerSessionId as the prior terminal — the exact collision the old dedup hit.
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: sharedProviderSessionId,
        taskId: 'task_new',
        finalSummary: 'new task report',
        timestamp: Date.now(),
      })

      // Not suppressed: the coordinator gets exactly one pending completion for the NEW task.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0].event).toBe('agent:generating_completed')
      expect(pending[0].metadataEvent.targetSessionId).toBe('runtime-session-1')
      expect(pending[0].metadataEvent.taskId).toBe('task_new')

      // The terminal ledger entry is attributed to the NEW task's id, exactly once.
      const completedEntries = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(completedEntries.map(e => e.payload.taskId)).toEqual(['task_prior', 'task_new'])

      // The sibling dispatch row is NOT flipped — the session_id fallback that would strand it
      // is never exercised because the completion echoed its own (distinct) taskId.
      const stillActive = getActiveDirectDispatches(meshId).map(d => d.taskId)
      expect(stillActive).toContain('task_sibling')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('records a second task_completed for same-session continuations after an earlier completion', async () => {
    const meshId = `mesh_same_session_continuation_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const { components, emit, coordinator } = createComponents(meshId)
      setupMeshEventForwarding(components)

      const firstQueued = enqueueTask(meshId, 'first delegated task')
      expect(claimNextTask(meshId, 'node_child_1', 'runtime-session-1')?.id).toBe(firstQueued.id)
      const firstCompletionAt = Date.now() + 1_000
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-history-1',
        finalSummary: 'first final assistant report',
        timestamp: firstCompletionAt,
      })

      const secondQueued = enqueueTask(meshId, 'same-session continuation task')
      expect(claimNextTask(meshId, 'node_child_1', 'runtime-session-1')?.id).toBe(secondQueued.id)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-history-1',
        finalSummary: 'second final assistant report',
        timestamp: firstCompletionAt + 1_000,
        completionDiagnostic: {
          sessionId: 'runtime-session-1',
          providerSessionId: 'provider-history-1',
          blockReason: 'missing_final_assistant',
          parsedStatus: 'idle',
          finalAssistantPresent: false,
          emittedAfterFinalizationTimeout: true,
        },
      })

      const completedEntries = readLedgerEntries(meshId).filter(entry => entry.kind === 'task_completed')
      expect(completedEntries).toHaveLength(2)
      expect(completedEntries.map(entry => entry.payload.taskId)).toEqual([firstQueued.id, secondQueued.id])
      expect(completedEntries[1].payload.completionDiagnostic).toMatchObject({
        sessionId: 'runtime-session-1',
        providerSessionId: 'provider-history-1',
        blockReason: 'missing_final_assistant',
        parsedStatus: 'idle',
        finalAssistantPresent: false,
      })
      // The reconcile tick drains both queued completions and injects them in order.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(2)
      const secondCoordinatorMessage = coordinator.onEvent.mock.calls[1][1].input.textFallback
      expect(secondCoordinatorMessage).toContain('completion_diagnostic=missing_final_assistant')
      expect(secondCoordinatorMessage).toContain('final_assistant=false')
      expect(getQueue(meshId).map(task => task.status)).toEqual(['completed', 'completed'])
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('D1: a transient LOCAL dispatch rejection returns the task to pending with a retryable dispatch_failed ledger entry (not terminal failed)', async () => {
    // Regression: the local-dispatch catch in tryAssignQueueTask used to mark the task
    // terminal 'failed' with no ledger and no retry, while the remote-dispatch catch
    // returned the task to 'pending' + a retryable dispatch_failed ledger entry. A
    // transient local refusal (e.g. the adapter rejected send_chat mid-generation)
    // therefore permanently killed a task the next reconcile tick would have delivered.
    // The local catch must now mirror the remote one: pending + retryable ledger.
    const meshId = `mesh_local_dispatch_retry_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        // No daemonId on the node → tryAssignQueueTask takes the local-dispatch branch.
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const queued = enqueueTask(meshId, 'local task that transiently fails to dispatch')

      const components = {
        instanceManager: {
          // Skip the best-effort updateSettings stamping; not relevant to this path.
          getInstance: vi.fn(() => undefined),
        },
        cliManager: {
          adapters: new Map(),
          handleCliCommand: vi.fn(async () => {
            throw new Error('adapter busy: send_chat rejected mid-generation')
          }),
        },
      } as any

      const assigned = tryAssignQueueTask(components, meshId, 'node_child_1', 'runtime-session-1', 'codex-cli')
      expect(assigned).toBe(true)

      // The dispatch failure is handled in an async .catch; wait for it to settle and
      // assert the task was returned to 'pending' (retryable) rather than 'failed'.
      await vi.waitFor(() => {
        const task = getQueue(meshId).find(t => t.id === queued.id)
        expect(task?.status).toBe('pending')
      })
      expect(getQueue(meshId).find(t => t.id === queued.id)?.status).not.toBe('failed')

      const dispatchFailed = readLedgerEntries(meshId).filter(entry => entry.kind === 'dispatch_failed')
      expect(dispatchFailed).toHaveLength(1)
      expect(dispatchFailed[0].payload).toMatchObject({ taskId: queued.id, retryable: true })
      expect((dispatchFailed[0].payload as any).error).toContain('adapter busy')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('records task completion evidence when a ready event completes an assigned task', () => {
    const meshId = `mesh_ready_evidence_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const queued = enqueueTask(meshId, 'queued task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-history-ready',
        finalSummary: 'ready summary',
      })

      const completedEntry = readLedgerEntries(meshId).find(entry => entry.kind === 'task_completed')
      expect(completedEntry?.payload.taskId).toBe(queued.id)
      expect(completedEntry?.payload.evidence).toMatchObject({
        source: 'agent_status_event',
        event: 'agent:ready',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        transcriptHandle: {
          kind: 'provider_session',
          providerSessionId: 'provider-history-ready',
          finalSummaryAvailable: true,
        },
        checkpoint: {
          attempted: false,
          reason: 'not_attempted_for_ordinary_completion',
        },
      })
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not complete an assigned code_change task from agent:ready without assistant or summary evidence', () => {
    const meshId = `mesh_ready_no_evidence_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const queued = enqueueTask(meshId, 'queued code change task', { taskMode: 'code_change' })
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'provider-history-ready-no-evidence',
      })

      expect(getQueue(meshId).find(task => task.id === queued.id)?.status).toBe('assigned')
      expect(readLedgerEntries(meshId).filter(entry => entry.kind === 'task_completed')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not inject completion event when the completed session is a coordinator (meshCoordinatorFor set)', () => {
    // This reproduces the bug: a coordinator session completing on the same workspace
    // must not be forwarded back into another coordinator session.
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue({ id: 'mesh_inline_1', nodes: [] })

    let listener: ((event: any) => void) | undefined
    const coordinatorState = {
      instanceId: 'coordinator-session-self',
      workspace: '/repo/main',
      settings: { meshCoordinatorFor: 'mesh_inline_1' },
    }
    const coordinator = {
      category: 'cli',
      getState: vi.fn(() => coordinatorState),
      onEvent: vi.fn(),
    }
    const instanceManager = {
      onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
      getInstance: vi.fn(() => coordinator),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [coordinator] : []),
    }
    const components = { instanceManager } as any
    setupMeshEventForwarding(components)

    listener!({
      event: 'agent:generating_completed',
      instanceId: 'coordinator-session-self',
      targetSessionId: 'coordinator-session-self',
      providerType: 'hermes-cli',
    })

    expect(coordinator.onEvent).not.toHaveBeenCalled()
  })

  it('forwards completion when a coordinator session is itself the direct-dispatch target so other coordinators see pendingCoordinatorEvents', () => {
    // Reproduces the missing-completion-signal bug: when an outer coordinator dispatches a
    // mesh_send_task to this local coordinator session, the dispatcher coordinator must
    // still receive a task_completed signal. Previously setupMeshEventForwarding bailed
    // out unconditionally for any meshCoordinatorFor session, so the dispatcher polled
    // pendingCoordinatorEvents forever and never saw the completion.
    const meshId = `mesh_coordinator_direct_dispatch_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      // Pre-register an in-flight direct dispatch targeting the coordinator session.
      insertDirectDispatch(meshId, {
        taskId: 'task_direct_to_coordinator',
        sessionId: 'coordinator-session-self',
        message: 'do work',
        via: 'local_direct',
        dispatchedAt: new Date().toISOString(),
      })

      let listener: ((event: any) => void) | undefined
      const coordinatorState = {
        instanceId: 'coordinator-session-self',
        workspace: '/repo/main',
        settings: { meshCoordinatorFor: meshId },
      }
      const coordinator = {
        category: 'cli',
        getState: vi.fn(() => coordinatorState),
        onEvent: vi.fn(),
      }
      const instanceManager = {
        onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
        getInstance: vi.fn(() => coordinator),
        // Only this single coordinator instance is present on this daemon; the
        // dispatching coordinator lives elsewhere and consumes pendingCoordinatorEvents.
        getByCategory: vi.fn((category: string) => category === 'cli' ? [coordinator] : []),
      }
      const components = { instanceManager } as any
      setupMeshEventForwarding(components)

      listener!({
        event: 'agent:generating_completed',
        instanceId: 'coordinator-session-self',
        targetSessionId: 'coordinator-session-self',
        providerType: 'claude-cli',
        providerSessionId: 'claude-history-1',
        finalSummary: 'task done',
      })

      // The local coordinator must not be sent a message about its own completion.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      // The dispatcher coordinator (on another daemon / process) must be able to drain
      // a task_completed event from the shared pending queue.
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        event: 'agent:generating_completed',
        meshId,
        metadataEvent: {
          targetSessionId: 'coordinator-session-self',
          providerType: 'claude-cli',
          providerSessionId: 'claude-history-1',
          finalSummary: 'task done',
        },
      })
      // Ledger must record task_completed for downstream activeWork reconciliation.
      const completedEntry = readLedgerEntries(meshId).find(entry => entry.kind === 'task_completed')
      expect(completedEntry).toBeTruthy()
      expect(completedEntry?.sessionId).toBe('coordinator-session-self')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('forwards completion for a coordinator direct-dispatch target when only ledger dispatch evidence exists', () => {
    const meshId = `mesh_coordinator_ledger_direct_dispatch_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        nodeId: 'node_self',
        sessionId: 'coordinator-session-self',
        providerType: 'codex-cli',
        payload: {
          source: 'direct',
          via: 'p2p_direct',
          taskId: 'task_ledger_only_direct',
          message: 'do work',
          targetSessionId: 'coordinator-session-self',
        },
      })

      let listener: ((event: any) => void) | undefined
      const coordinatorState = {
        instanceId: 'coordinator-session-self',
        workspace: '/repo/main',
        settings: { meshCoordinatorFor: meshId },
      }
      const coordinator = {
        category: 'cli',
        getState: vi.fn(() => coordinatorState),
        onEvent: vi.fn(),
      }
      const instanceManager = {
        onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
        getInstance: vi.fn(() => coordinator),
        getByCategory: vi.fn((category: string) => category === 'cli' ? [coordinator] : []),
      }
      const components = { instanceManager } as any
      setupMeshEventForwarding(components)

      listener!({
        event: 'agent:generating_completed',
        instanceId: 'coordinator-session-self',
        targetSessionId: 'coordinator-session-self',
        providerType: 'codex-cli',
        providerSessionId: 'codex-history-1',
        finalSummary: 'task done',
      })

      expect(coordinator.onEvent).not.toHaveBeenCalled()
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        event: 'agent:generating_completed',
        meshId,
        metadataEvent: {
          targetSessionId: 'coordinator-session-self',
          providerType: 'codex-cli',
          providerSessionId: 'codex-history-1',
          finalSummary: 'task done',
        },
      })
      const completedEntry = readLedgerEntries(meshId).find(entry => entry.kind === 'task_completed')
      expect(completedEntry).toBeTruthy()
      expect(completedEntry?.sessionId).toBe('coordinator-session-self')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not inject completion event for unrelated CLI sessions without mesh metadata', () => {
    // Sessions without meshNodeFor or launchedByCoordinator must not be forwarded,
    // even if getMeshByRepo returns a mesh for the same workspace.
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue({ id: 'mesh_inline_1', nodes: [] })

    let listener: ((event: any) => void) | undefined
    const unrelatedState = {
      instanceId: 'unrelated-session-1',
      workspace: '/repo/main',
      settings: {}, // no meshNodeFor, no launchedByCoordinator
    }
    const coordinatorState = {
      instanceId: 'coordinator-session-1',
      workspace: '/repo/main',
      settings: { meshCoordinatorFor: 'mesh_inline_1' },
    }
    const unrelated = {
      category: 'cli',
      getState: vi.fn(() => unrelatedState),
      onEvent: vi.fn(),
    }
    const coordinator = {
      category: 'cli',
      getState: vi.fn(() => coordinatorState),
      onEvent: vi.fn(),
    }
    const instanceManager = {
      onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
      getInstance: vi.fn((id: string) => id === 'unrelated-session-1' ? unrelated : undefined),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [unrelated, coordinator] : []),
    }
    const components = { instanceManager } as any
    setupMeshEventForwarding(components)

    listener!({
      event: 'agent:generating_completed',
      instanceId: 'unrelated-session-1',
      targetSessionId: 'unrelated-session-1',
      providerType: 'hermes-cli',
    })

    expect(coordinator.onEvent).not.toHaveBeenCalled()
  })

  it('injects forwarded stopped and no-progress coordinator hints from remote worker daemons', async () => {
    const meshId = `mesh_long_gen_plain_${Date.now()}`
    const { components, coordinator } = createComponents(meshId)

    const stopped = handleMeshForwardEvent(components, {
      event: 'agent:stopped',
      meshId,
      nodeId: 'node_child_1',
      targetSessionId: 'runtime-session-1',
      providerType: 'hermes-cli',
    })
    const noProgress = handleMeshForwardEvent(components, {
      event: 'monitor:no_progress',
      meshId,
      nodeId: 'node_child_1',
      targetSessionId: 'runtime-session-long',
      providerType: 'hermes-cli',
    })

    // Queue-only: handleMeshForwardEvent persists to the queue (forwarded: 0); the
    // reconcile tick injects into the live coordinator.
    expect(stopped).toEqual({ success: true, forwarded: 0 })
    expect(noProgress).toEqual({ success: true, forwarded: 0 })
    await runMeshReconcileTick(components)
    expect(coordinator.onEvent).toHaveBeenCalledTimes(2)
    expect(coordinator.onEvent.mock.calls[0][1].input.textFallback).toContain('has stopped')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).toContain('still reported as generating')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).toContain('one bounded status check')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).not.toContain('mesh_read_chat once')
    cleanupMeshFiles(meshId)
  })

  it('handleMeshForwardEvent forwards modalMessage and modalButtons from relay payload into metadataEvent for approval dedup and coordinator message', async () => {
    const meshId = `mesh_approval_relay_${Date.now()}`
    try {
      const { components, coordinator } = createComponents(meshId)

      const result = handleMeshForwardEvent(components, {
        event: 'agent:waiting_approval',
        meshId,
        nodeId: 'node_agy',
        targetSessionId: 'agy-session-1',
        providerType: 'antigravity-cli',
        modalMessage: 'Do you want to proceed?',
        modalButtons: ['Yes', 'No'],
        timestamp: 1710000005000,
      })

      expect(result).toEqual({ success: true, forwarded: 0 })

      // Verify a second identical event is deduped (requires modalMessage+modalButtons for fingerprinting).
      // Dedup happens at queue time, before the reconcile tick drains.
      const duplicate = handleMeshForwardEvent(components, {
        event: 'agent:waiting_approval',
        meshId,
        nodeId: 'node_agy',
        targetSessionId: 'agy-session-1',
        providerType: 'antigravity-cli',
        modalMessage: 'Do you want to proceed?',
        modalButtons: ['Yes', 'No'],
        timestamp: 1710000005000,
      })
      expect(duplicate).toMatchObject({ success: true, suppressed: true, duplicateApproval: true })

      // The reconcile tick injects the single deduped approval exactly once.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('handleMeshForwardEvent carries workspace/title/settings from relay payload into the forwarded coordinator metadata', async () => {
    const meshId = `mesh_workspace_carry_${Date.now()}`
    try {
      const { components } = createComponents(meshId)
      const forwarded: any[] = []
      components.onMeshCoordinatorEventForwarded = (payload: any) => { forwarded.push(payload) }

      const result = handleMeshForwardEvent(components, {
        event: 'agent:waiting_approval',
        meshId,
        nodeId: 'node_remote',
        targetSessionId: 'remote-session-1',
        providerType: 'claude-cli',
        providerName: 'Claude Code',
        workspace: '/repo/remote-worktree',
        workspaceName: '/repo/remote-worktree',
        sessionTitle: 'Fix mesh forward workspace flap',
        sessionStatus: 'awaiting_approval',
        sessionChatStatus: 'streaming',
        sessionSettings: { meshNodeFor: meshId, meshNodeId: 'node_remote', launchedByCoordinator: true },
        modalMessage: 'Approve?',
        modalButtons: ['Yes', 'No'],
        timestamp: 1710000006000,
      })

      expect(result).toEqual({ success: true, forwarded: 0 })
      expect(forwarded).toHaveLength(1)
      const payload = forwarded[0]
      // The remote-relay reconstruction must not drop the session identity fields, else
      // the dashboard flaps to the generic "Terminal (Mesh Node)" title.
      expect(payload.workspace).toBe('/repo/remote-worktree')
      expect(payload.workspaceName).toBe('/repo/remote-worktree')
      expect(payload.sessionTitle).toBe('Fix mesh forward workspace flap')
      expect(payload.sessionStatus).toBe('awaiting_approval')
      expect(payload.sessionChatStatus).toBe('streaming')
      expect(payload.providerName).toBe('Claude Code')
      expect(payload.sessionSettings).toMatchObject({
        meshNodeFor: meshId,
        meshNodeId: 'node_remote',
        launchedByCoordinator: true,
      })
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('handleMeshForwardEvent recovers workspace into the forwarded metadata even when only workspaceName is present', async () => {
    const meshId = `mesh_workspace_name_only_${Date.now()}`
    try {
      const { components } = createComponents(meshId)
      const forwarded: any[] = []
      components.onMeshCoordinatorEventForwarded = (payload: any) => { forwarded.push(payload) }

      const result = handleMeshForwardEvent(components, {
        event: 'agent:waiting_approval',
        meshId,
        nodeId: 'node_remote',
        targetSessionId: 'remote-session-2',
        providerType: 'claude-cli',
        workspaceName: '/repo/name-only-worktree',
        modalMessage: 'Approve?',
        modalButtons: ['Yes', 'No'],
        timestamp: 1710000007000,
      })

      expect(result).toEqual({ success: true, forwarded: 0 })
      expect(forwarded).toHaveLength(1)
      // workspace mirrors workspaceName when the worker only emitted the latter.
      expect(forwarded[0].workspace).toBe('/repo/name-only-worktree')
      expect(forwarded[0].workspaceName).toBe('/repo/name-only-worktree')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('reconciles a no-progress monitor to completion when final summary evidence exists', async () => {
    const meshId = `mesh_long_gen_reconcile_${Date.now()}`
    try {
      const { components, coordinator } = createComponents(meshId)
      const queued = enqueueTask(meshId, 'finish delegated task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')

      const result = handleMeshForwardEvent(components, {
        event: 'monitor:no_progress',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: '019e7707-24a5-76b3-88be-815f2155cab4',
        finalSummary: 'Committed cleanly and completed.',
        timestamp: Date.now(),
      })

      expect(result).toEqual({ success: true, forwarded: 0 })
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const text = coordinator.onEvent.mock.calls[0][1].input.textFallback
      expect(text).toContain('already has completion evidence')
      expect(text).toContain('reconciled the terminal handoff')
      expect(text).not.toContain('mesh_read_chat once')
      expect(getQueue(meshId)[0]).toMatchObject({ id: queued.id, status: 'completed' })
      const entries = readLedgerEntries(meshId)
      expect(entries.some(entry => entry.kind === 'task_completed' && entry.payload.taskId === queued.id)).toBe(true)
      expect(entries.some(entry => entry.kind === 'task_stalled')).toBe(false)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('suppresses no-progress alert when terminal ledger evidence already exists', () => {
    const meshId = `mesh_long_gen_terminal_${Date.now()}`
    try {
      const { components, coordinator } = createComponents(meshId)
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        payload: {
          event: 'agent:generating_completed',
          taskId: 'task-done',
          finalSummary: 'Already completed by ledger.',
        },
      })

      const result = handleMeshForwardEvent(components, {
        event: 'monitor:no_progress',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
      })

      expect(result).toMatchObject({
        success: true,
        forwarded: 0,
        suppressed: true,
        terminalLedgerEvidence: true,
        terminalLedgerKind: 'task_completed',
      })
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      const kinds = readLedgerEntries(meshId).map(entry => entry.kind)
      expect(kinds.filter(kind => kind === 'task_stalled')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('backfills refine terminal pending event from ledger when only accepted is pending', () => {
    const meshId = `mesh_refine_backfill_${Date.now()}`
    try {
      queuePendingMeshCoordinatorEvent({
        event: 'refine:accepted',
        meshId,
        nodeLabel: 'node-refine',
        nodeId: 'node-refine',
        workspace: '/repo/refine',
        metadataEvent: {
          source: 'refine_mesh_node_async_job',
          jobId: 'refine_ix_mpruebyb_tpytsw',
          interactionId: 'ix-test',
          meshId,
          nodeId: 'node-refine',
          status: 'accepted',
          startedAt: '2026-05-30T04:20:12.000Z',
        },
        queuedAt: Date.now(),
      })
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node-refine',
        payload: {
          source: 'refine_mesh_node_async_job',
          refineJob: {
            jobId: 'refine_ix_mpruebyb_tpytsw',
            interactionId: 'ix-test',
            status: 'completed',
            meshId,
            nodeId: 'node-refine',
            workspace: '/repo/refine',
            startedAt: '2026-05-30T04:20:12.000Z',
            completedAt: '2026-05-30T04:21:46.000Z',
          },
          async: true,
          success: true,
          result: {
            success: true,
            merged: true,
            branch: 'fix/completion-alert-event-handoff-v2',
            into: 'main',
          },
        },
      })

      const events = drainPendingMeshCoordinatorEvents(meshId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'refine:completed',
        meshId,
        nodeId: 'node-refine',
        metadataEvent: {
          source: 'refine_mesh_node_async_job',
          jobId: 'refine_ix_mpruebyb_tpytsw',
          status: 'completed',
        },
      })
      expect(events[0].coordinatorMessage).toContain('completed successfully')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('queues stopped failure events with recovery context when no live coordinator session exists', () => {
    const meshId = `mesh_stopped_pending_recovery_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: { maxTaskRetries: 1 },
      })
      const queued = enqueueTask(meshId, 'retryable failed task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        payload: { taskId: queued.id, message: 'retryable failed task' },
      })
      const components = {
        instanceManager: {
          getByCategory: vi.fn((category: string) => category === 'cli' ? [] : []),
        },
        cliManager: {
          handleCliCommand: vi.fn(() => Promise.resolve({ success: true, sessionId: 'retry-session-1' })),
        },
      } as any

      const stopped = handleMeshForwardEvent(components, {
        event: 'agent:stopped',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
      })

      expect(stopped).toEqual({ success: true, forwarded: 0 })
      const events = drainPendingMeshCoordinatorEvents(meshId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'agent:stopped',
        meshId,
        nodeId: 'node_child_1',
      })
      expect(events[0].metadataEvent.recoveryContext).toMatchObject({
        failedNodeId: 'node_child_1',
        failedSessionId: 'runtime-session-1',
        failedProviderType: 'hermes-cli',
        retryRecommended: true,
        lastTaskMessage: 'retryable failed task',
      })
      expect(readLedgerEntries(meshId).some(entry => entry.kind === 'task_failed' && entry.payload.taskId === queued.id)).toBe(true)
      expect(readLedgerEntries(meshId).some(entry => entry.kind === 'recovery_attempted')).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('suppresses duplicate completion replays from relay/backfill paths for the same logical event', async () => {
    const meshId = `mesh_completion_dedupe_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const queued = enqueueTask(meshId, 'queued task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')

      const { components, emit, coordinator } = createComponents(meshId)
      setupMeshEventForwarding(components)
      const completionTimestamp = Date.now() + 60_000
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-history-1',
        timestamp: completionTimestamp,
        finalSummary: 'done once',
      })

      const duplicate = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-history-1',
        timestamp: completionTimestamp,
        finalSummary: 'done once',
      })

      const completedEntries = readLedgerEntries(meshId).filter(entry => entry.kind === 'task_completed')
      expect(completedEntries).toHaveLength(1)
      expect(completedEntries[0].payload.taskId).toBe(queued.id)
      expect(duplicate).toMatchObject({ success: true, forwarded: 0, suppressed: true, duplicateCompletion: true })
      // Only the first (non-duplicate) completion was queued; the tick injects it once.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('suppresses cleanup-requested stop and stale no-progress events from failure/recovery ledgers', () => {
    const meshId = `mesh_cleanup_stop_${Date.now()}`
    try {
      const { components, coordinator } = createComponents(meshId)
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: { maxTaskRetries: 1 },
      })
      enqueueTask(meshId, 'duplicate session task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      appendLedgerEntry(meshId, {
        kind: 'session_stopped',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        payload: {
          intentional: true,
          reason: 'operator_cleanup',
          source: 'mesh_cleanup_sessions',
          cleanupMode: 'stop',
        },
      })

      const stopped = handleMeshForwardEvent(components, {
        event: 'agent:stopped',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
      })
      const noProgress = handleMeshForwardEvent(components, {
        event: 'monitor:no_progress',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
      })

      expect(stopped).toMatchObject({ success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true })
      expect(noProgress).toMatchObject({ success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true })
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getQueue(meshId)[0].status).toBe('assigned')
      const kinds = readLedgerEntries(meshId).map(entry => entry.kind)
      expect(kinds).toContain('session_stopped')
      expect(kinds).not.toContain('task_failed')
      expect(kinds).not.toContain('task_stalled')
      expect(kinds).not.toContain('recovery_attempted')
      expect(getLedgerSummary(meshId)).toMatchObject({ taskFailed: 0, taskStalled: 0, recentFailures: 0 })
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not let stopped delegated session records claim targeted queue tasks', () => {
    const meshId = `mesh_stopped_claim_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const queued = enqueueTask(meshId, 'targeted task for stopped session', {
        targetNodeId: 'node_child_1',
        targetSessionId: 'runtime-session-stopped',
      })
      const stoppedSource = {
        category: 'cli',
        getState: vi.fn(() => ({
          instanceId: 'runtime-session-stopped',
          workspace: '/repo/worktree-a',
          status: 'stopped',
          type: 'hermes-cli',
          settings: {
            meshNodeFor: meshId,
            meshNodeId: 'node_child_1',
            launchedByCoordinator: true,
          },
        })),
      }
      const components = {
        instanceManager: {
          getByCategory: vi.fn((category: string) => category === 'cli' ? [stoppedSource] : []),
        },
        cliManager: {
          adapters: new Map(),
          handleCliCommand: vi.fn(),
        },
      } as any

      triggerMeshQueue(components, meshId)

      const [entry] = getQueue(meshId)
      expect(entry.id).toBe(queued.id)
      expect(entry.status).toBe('pending')
      expect(entry.assignedSessionId).toBeUndefined()
      expect(components.cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('reports queue trigger claim state and skipped non-idle sessions', async () => {
    const meshId = `mesh_trigger_report_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      enqueueTask(meshId, 'targeted task waiting for stopped session', {
        targetNodeId: 'node_child_1',
        targetSessionId: 'runtime-session-stopped',
      })
      const stoppedSource = {
        category: 'cli',
        getState: vi.fn(() => ({
          instanceId: 'runtime-session-stopped',
          workspace: '/repo/worktree-a',
          status: 'stopped',
          type: 'hermes-cli',
          settings: {
            meshNodeFor: meshId,
            meshNodeId: 'node_child_1',
            launchedByCoordinator: true,
          },
        })),
      }
      const components = {
        instanceManager: {
          getByCategory: vi.fn((category: string) => category === 'cli' ? [stoppedSource] : []),
        },
        cliManager: {
          adapters: new Map(),
          handleCliCommand: vi.fn(),
        },
      } as any

      const result = await triggerMeshQueue(components, meshId)

      expect(result).toMatchObject({
        success: true,
        meshId,
        pendingBefore: 1,
        pendingAfter: 1,
        claimed: false,
        localIdleSessionsChecked: 0,
        noIdleMeshSessionAvailable: true,
      })
      expect(result.skippedSessions).toEqual([{
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-stopped',
        reason: 'terminal_session',
        status: 'stopped',
      }])
      expect(getQueue(meshId)[0].status).toBe('pending')
      expect(components.cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('auto-launches one provider session for a pending task when no idle session exists', async () => {
    const meshId = `mesh_auto_launch_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'online', policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 2, spawnedSessionVisibility: 'hidden' },
      })
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/hermes' })
      const queued = enqueueTask(meshId, 'queued task')
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('launch_cli', expect.objectContaining({
        cliType: 'hermes-cli',
        dir: '/repo/worktree-a',
        settings: expect.objectContaining({
          role: 'worker',
          meshNodeFor: meshId,
          meshNodeId: 'node_child_1',
          spawnedSessionVisibility: 'hidden',
          launchedByCoordinator: true,
          autoLaunchedForQueueTaskId: queued.id,
        }),
      }))
      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('agent_command', expect.objectContaining({
        targetSessionId: 'auto-session-1',
        cliType: 'hermes-cli',
        action: 'send_chat',
        message: 'queued task',
      }))
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('assigned')
      expect(entry.assignedNodeId).toBe('node_child_1')
      expect(entry.assignedSessionId).toBe('auto-session-1')
      expect(entry.autoLaunch?.status).toBe('completed')
      expect(readLedgerEntries(meshId).some(e => e.kind === 'session_auto_launch' && e.payload?.phase === 'completed')).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('reports autoLaunchPending (not noIdleMeshSessionAvailable) for a pending task whose just-launched session is still booting', async () => {
    // ENQNAG regression: a prior tick auto-launched a worker session for this task; the
    // session is booting and will claim within seconds (per-task await-claim guard
    // suppresses a second launch). On this follow-up tick autoLaunchStarted is false, but
    // the task is NOT in a no-session-available state — a session is on its way. The
    // trigger result must therefore advertise autoLaunchPending and MUST NOT set
    // noIdleMeshSessionAvailable, so the MCP layer does not advise launching a duplicate
    // worker that would double-edit the worktree.
    const meshId = `mesh_autolaunch_pending_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'online', policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 2, spawnedSessionVisibility: 'hidden' },
      })
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/hermes' })
      const queued = enqueueTask(meshId, 'queued task awaiting booting session')
      // Simulate the prior tick's successful launch: a session was spun up and we are
      // within the await-claim window (recordTaskAutoLaunch stamps updatedAt = now).
      recordTaskAutoLaunch(meshId, queued.id, {
        status: 'completed',
        nodeId: 'node_child_1',
        providerType: 'hermes-cli',
        sessionId: 'auto-session-booting',
      })
      const { components, cliManager } = createQueueAutoLaunchComponents()

      const result = await triggerMeshQueue(components, meshId)

      // The await-claim guard suppressed a second launch — no new session was spun up.
      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      // Task is still pending (the booting session has not claimed yet)...
      expect(getQueue(meshId)[0].status).toBe('pending')
      // ...but the result tells callers to WAIT, not to launch another worker.
      expect(result.autoLaunchPending).toBe(true)
      expect(result.noIdleMeshSessionAvailable).toBeUndefined()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('auto-launches a target_node_id task with empty requiredTags onto an inline-cached worktree node keyed by nodeId (not id)', async () => {
    // Regression: a queue task routed with target_node_id (prefer_worktree) and an
    // EMPTY requiredTags ([]) was left permanently pending with a misleading
    // session_auto_launch skip { reason: "no_node_satisfies_required_tags" }.
    // Root cause: the auto-launch candidate filter compared only `node.id ===
    // task.targetNodeId`, but an inline-cache-form mesh node carries its id under
    // `nodeId`/`node_id` (see readInlineMeshNodeId in commands/router.ts). The
    // worktree node was therefore dropped from candidates → empty candidate set →
    // skip, even though empty requiredTags means every node should pass.
    const meshId = `mesh_auto_launch_target_nodeid_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        // Inline-cache form: id lives under `nodeId`, NOT `id`.
        nodes: [{ nodeId: 'node_worktree_1', workspace: '/repo/worktree-a', health: 'online', isLocalWorktree: true, policy: { providerPriority: ['antigravity-cli'] } }],
        policy: { maxParallelTasks: 2, spawnedSessionVisibility: 'hidden' },
      })
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/antigravity' })
      // Exactly the live ledger shape: target_node_id set, requiredTags = [].
      const queued = enqueueTask(meshId, 'queued worktree task', { targetNodeId: 'node_worktree_1', requiredTags: [] })
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      // Must NOT have skipped with the misleading tag reason.
      expect(getQueue(meshId)[0].autoLaunch?.reason).not.toBe('no_node_satisfies_required_tags')
      // Auto-launched onto the worktree node and the task was claimed/assigned.
      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('launch_cli', expect.objectContaining({
        cliType: 'antigravity-cli',
        dir: '/repo/worktree-a',
        settings: expect.objectContaining({
          meshNodeId: 'node_worktree_1',
          autoLaunchedForQueueTaskId: queued.id,
        }),
      }))
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('assigned')
      expect(entry.assignedNodeId).toBe('node_worktree_1')
      expect(entry.assignedSessionId).toBe('auto-session-1')
      expect(entry.autoLaunch?.status).toBe('completed')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('Bug A: a target_node_id task whose node is ABSENT is labelled target_node_id_unmatched, not a tag failure', async () => {
    // A task pinned to a targetNodeId that matches NO mesh node is a ROUTING miss, not a
    // capability miss. The auto-launch candidate filter previously hard-coded the empty-
    // candidate skip reason to `no_node_satisfies_required_tags`, conflating a target-id
    // mismatch with a tag failure and sending diagnosis down the wrong path.
    const meshId = `mesh_bugA_unmatched_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_present', workspace: '/repo/present', health: 'online', policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 2 },
      })
      enqueueTask(meshId, 'task for a missing node', { targetNodeId: 'node_MISSING', requiredTags: [] })
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      const entry = getQueue(meshId)[0]
      expect(entry.status).toBe('pending')
      expect(entry.autoLaunch?.reason).toBe('target_node_id_unmatched')
      expect(entry.autoLaunch?.reason).not.toBe('no_node_satisfies_required_tags')
      // Nothing was launched — the target simply doesn't exist.
      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('Bug A guard: a genuine capability miss (target matches, tags unsatisfiable) still reports no_node_satisfies_required_tags', async () => {
    // The distinct target_node_id_unmatched reason must NOT swallow a real tag failure:
    // when the target pin DOES match a node but its tags exclude it, the tag reason stands.
    const meshId = `mesh_bugA_tagmiss_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_x', workspace: '/repo/x', health: 'online', policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 2 },
      })
      // Target node_x exists, but no provider on it can produce os=plan9 → tag miss.
      enqueueTask(meshId, 'tag-impossible task', { targetNodeId: 'node_x', requiredTags: ['os=plan9'] })
      const { components } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      const entry = getQueue(meshId)[0]
      expect(entry.status).toBe('pending')
      expect(entry.autoLaunch?.reason).toBe('no_node_satisfies_required_tags')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('claims a pending task for a REMOTE idle session whose node is keyed by nodeId (not id) — normalizer match', async () => {
    // Regression: triggerMeshQueue matched remote idle-session candidates with raw
    // `n.id === idle.nodeId`, but an inline-cached worktree node carries its id under
    // `nodeId`/`node_id` (readInlineMeshNodeId). A remote idle session registered for
    // such a node was silently dropped from the candidate pool, so its pending task
    // could never be claimed. The fix uses meshNodeIdMatches (the shared 3-form
    // normalizer), matching how the local-candidate and auto-launch paths already work.
    const meshId = `mesh_remote_idle_nodeid_${Date.now()}`
    try {
      // Inline-cache form: the remote worktree node's id lives under `nodeId`, NOT `id`.
      const mesh = {
        id: meshId,
        nodes: [{ nodeId: 'node_remote_wt', workspace: '/repo/worktree-r', health: 'online', daemonId: 'remote-daemon' }],
        policy: { maxParallelTasks: 2 },
      }
      meshConfigMocks.getMesh.mockReturnValue(mesh)
      enqueueTask(meshId, 'remote queued task', { targetNodeId: 'node_remote_wt' })

      // A remote idle session the coordinator registered (e.g. from a forwarded
      // agent:ready), keyed by the node's inline-cache id form.
      MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, 'node_remote_wt', 'remote-session-1', 'claude-cli', Date.now() + 60_000)

      const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
      const { components } = createQueueAutoLaunchComponents()
      ;(components as any).dispatchMeshCommand = dispatchMeshCommand

      await triggerMeshQueue(components, meshId)

      // The remote idle session was matched (via the normalizer) and the task dispatched
      // to its daemon over P2P, leaving the queue task assigned to that node/session.
      expect(dispatchMeshCommand).toHaveBeenCalledWith('remote-daemon', 'agent_command', expect.objectContaining({
        targetSessionId: 'remote-session-1',
        action: 'send_chat',
      }))
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('assigned')
      expect(entry.assignedNodeId).toBe('node_remote_wt')
      expect(entry.assignedSessionId).toBe('remote-session-1')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('skips auto spin-up when maxParallelTasks is already reached', async () => {
    const meshId = `mesh_auto_launch_max_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'online', policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 1 },
      })
      enqueueTask(meshId, 'already running')
      claimNextTask(meshId, 'other_node', 'other_session')
      enqueueTask(meshId, 'pending task')
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      const pending = getQueue(meshId).find(entry => entry.message === 'pending task')
      expect(pending?.status).toBe('pending')
      expect(pending?.autoLaunch?.reason).toBe('max_parallel_tasks_reached')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('skips dirty nodes instead of auto-launching into them', async () => {
    const meshId = `mesh_auto_launch_dirty_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'dirty', git: { dirty: true }, policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 2 },
      })
      enqueueTask(meshId, 'pending task')
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('pending')
      expect(entry.autoLaunch?.reason).toBe('dirty_workspace')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not auto-launch another session for a node that already has an active assigned task', async () => {
    const meshId = `mesh_auto_launch_active_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'online', policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 2 },
      })
      enqueueTask(meshId, 'already running')
      claimNextTask(meshId, 'node_child_1', 'busy_session')
      enqueueTask(meshId, 'pending task')
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      const pending = getQueue(meshId).find(entry => entry.message === 'pending task')
      expect(pending?.status).toBe('pending')
      expect(pending?.autoLaunch?.reason).toBe('node_has_active_assignment')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('gracefully skips a remote node when no dispatchMeshCommand transport is available', async () => {
    // With no dispatch transport (standalone, or cloud component without the relay),
    // a remote node cannot be reached — fall back to a graceful skip rather than a
    // local cliManager launch. The local launch path must NOT fire.
    const meshId = `mesh_auto_launch_remote_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{
          id: 'node_remote_1',
          workspace: '/repo/remote-worktree',
          health: 'online',
          daemonId: 'daemon_remote_machine',
          machineId: 'mach_remote',
          policy: { providerPriority: ['hermes-cli'] },
        }],
        policy: { maxParallelTasks: 2 },
      })
      enqueueTask(meshId, 'pending remote task')
      const { components, cliManager } = createQueueAutoLaunchComponents()
      // No components.dispatchMeshCommand → remote launch impossible.

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('pending')
      expect(entry.autoLaunch?.reason).toBe('remote_auto_launch_unsupported')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('forwards launch_cli to a remote node via dispatchMeshCommand when a transport is available', async () => {
    // Root fix: a remote queue task with no idle session must FORWARD launch_cli to the
    // node's daemon (mirroring mesh_launch_session) instead of being permanently skipped
    // with remote_auto_launch_unsupported. The local cliManager.launch_cli path must NOT
    // fire for a remote node; dispatchMeshCommand must be called exactly once.
    const meshId = `mesh_auto_launch_remote_forward_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{
          id: 'node_remote_1',
          workspace: '/repo/remote-worktree',
          health: 'online',
          daemonId: 'daemon_remote_machine',
          machineId: 'mach_remote',
          policy: { providerPriority: ['hermes-cli'] },
        }],
        policy: { maxParallelTasks: 2, spawnedSessionVisibility: 'hidden' },
      })
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/hermes' })
      const queued = enqueueTask(meshId, 'pending remote task')
      const { components, cliManager } = createQueueAutoLaunchComponents()
      const dispatchMeshCommand = vi.fn(async () => ({ success: true, sessionId: 'remote-session-1' }))
      components.dispatchMeshCommand = dispatchMeshCommand

      await triggerMeshQueue(components, meshId)

      // Local launch path is untouched for a remote node.
      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      // launch_cli was forwarded to the remote daemon exactly once.
      const launchForwards = dispatchMeshCommand.mock.calls.filter(([, command]: [string, string]) => command === 'launch_cli')
      expect(launchForwards).toHaveLength(1)
      const [targetDaemonId, command, payload] = launchForwards[0] as [string, string, any]
      expect(targetDaemonId).toBe('daemon_remote_machine')
      expect(command).toBe('launch_cli')
      expect(payload).toMatchObject({
        cliType: 'hermes-cli',
        dir: '/repo/remote-worktree',
        settings: expect.objectContaining({
          role: 'worker',
          meshNodeFor: meshId,
          meshNodeId: 'node_remote_1',
          launchedByCoordinator: true,
          autoLaunchedForQueueTaskId: queued.id,
          // Relay-safe coordinator anchor (bare machineId from mocked loadConfig).
          meshCoordinatorDaemonId: 'test-machine',
          meshCoordinatorNodeId: 'node_remote_1',
        }),
      })
      // Task stays pending until the remote worker's agent:ready is forwarded back and
      // the normal claim path assigns it — remote launch is async, not an immediate claim.
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('pending')
      expect(entry.autoLaunch?.status).toBe('completed')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not re-forward launch_cli for a task whose remote auto-launch is still awaiting its claim', async () => {
    // Regression (remote queue auto-launch claim loop): the remote launch is async — the
    // task stays pending until the worker's agent:ready round-trips back and claims it.
    // The reconcile loop re-runs triggerMeshQueue every few seconds, well within that
    // round trip, and the per-(mesh,node) cooldown is only 5s. Without a per-TASK guard
    // every tick fired a fresh launch_cli for the same still-pending task, spawning a new
    // orphan worker session each time (observed live: dozens of sessions for one task).
    // The await-claim guard keys on autoLaunch.status==='completed' + a recent updatedAt and
    // skips re-launching until the claim lands or the window lapses.
    const meshId = `mesh_auto_launch_await_claim_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{
          id: 'node_remote_1',
          workspace: '/repo/remote-worktree',
          health: 'online',
          daemonId: 'daemon_remote_machine',
          machineId: 'mach_remote',
          policy: { providerPriority: ['hermes-cli'] },
        }],
        policy: { maxParallelTasks: 2, spawnedSessionVisibility: 'hidden' },
      })
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/hermes' })
      enqueueTask(meshId, 'pending remote task')
      const { components, cliManager } = createQueueAutoLaunchComponents()
      const dispatchMeshCommand = vi.fn(async () => ({ success: true, sessionId: 'remote-session-1' }))
      components.dispatchMeshCommand = dispatchMeshCommand

      // First tick forwards launch_cli once and records autoLaunch.status='completed'.
      await triggerMeshQueue(components, meshId)
      expect(getQueue(meshId)[0].autoLaunch?.status).toBe('completed')
      expect(getQueue(meshId)[0].status).toBe('pending')

      // Subsequent ticks (still within the await-claim window) must NOT forward again.
      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      const launchForwards = dispatchMeshCommand.mock.calls.filter(([, command]: [string, string]) => command === 'launch_cli')
      expect(launchForwards).toHaveLength(1)
      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      // The guard skip must NOT clobber the 'completed' autoLaunch record (that record is the
      // guard's own state for the next tick — overwriting it would reopen the duplicate hole).
      expect(getQueue(meshId)[0].autoLaunch?.status).toBe('completed')
      expect(getQueue(meshId)[0].autoLaunch?.sessionId).toBe('remote-session-1')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('de-dups repeated skipped auto-launch ledger entries across reconcile re-triggers', async () => {
    // The reconcile loop re-runs triggerMeshQueue every 4s. A task that keeps skipping
    // for the SAME reason (e.g. a remote node with no transport) must append the
    // session_auto_launch{phase:'skipped'} ledger entry only once, not once per tick.
    const meshId = `mesh_auto_launch_skip_dedup_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{
          id: 'node_remote_1',
          workspace: '/repo/remote-worktree',
          health: 'online',
          daemonId: 'daemon_remote_machine',
          machineId: 'mach_remote',
          policy: { providerPriority: ['hermes-cli'] },
        }],
        policy: { maxParallelTasks: 2 },
      })
      enqueueTask(meshId, 'pending remote task')
      const { components } = createQueueAutoLaunchComponents()
      // No dispatchMeshCommand → skips every time with remote_auto_launch_unsupported.

      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      const skips = readLedgerEntries(meshId).filter(
        e => e.kind === 'session_auto_launch'
          && e.payload?.phase === 'skipped'
          && e.payload?.reason === 'remote_auto_launch_unsupported',
      )
      expect(skips).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('gracefully skips a remote node when no coordinator daemonId can be resolved', async () => {
    // dispatchMeshCommand exists but there is no local machineId to stamp as the
    // coordinator anchor → relay-safe completion routing is impossible, so skip
    // (with a distinct reason) rather than launch an unroutable remote worker.
    const meshId = `mesh_auto_launch_no_coord_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{
          id: 'node_remote_1',
          workspace: '/repo/remote-worktree',
          health: 'online',
          daemonId: 'daemon_remote_machine',
          machineId: 'mach_remote',
          policy: { providerPriority: ['hermes-cli'] },
        }],
        policy: { maxParallelTasks: 2 },
      })
      enqueueTask(meshId, 'pending remote task')
      const { components, cliManager } = createQueueAutoLaunchComponents()
      components.dispatchMeshCommand = vi.fn(async () => ({ success: true }))
      // Force loadConfig().machineId to be empty so no coordinator id resolves.
      // The node still reads as remote (its daemonId 'daemon_remote_machine' does not
      // match the empty-machine local ids), so this isolates the no-coordinator skip.
      configMocks.loadConfig.mockReturnValue({ machineId: '' } as any)

      try {
        await triggerMeshQueue(components, meshId)

        expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
        expect(components.dispatchMeshCommand).not.toHaveBeenCalledWith('daemon_remote_machine', 'launch_cli', expect.anything())
        const [entry] = getQueue(meshId)
        expect(entry.status).toBe('pending')
        expect(entry.autoLaunch?.reason).toBe('remote_auto_launch_no_coordinator_daemon_id')
      } finally {
        configMocks.loadConfig.mockReturnValue({ machineId: 'test-machine' } as any)
      }
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('auto-launches at most one new session in a trigger cycle even with multiple pending tasks', async () => {
    const meshId = `mesh_auto_launch_one_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'online', policy: { providerPriority: ['hermes-cli'] } }],
        policy: { maxParallelTasks: 3 },
      })
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/hermes' })
      enqueueTask(meshId, 'task 1')
      enqueueTask(meshId, 'task 2')
      enqueueTask(meshId, 'task 3')
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand.mock.calls.filter(([command]: [string]) => command === 'launch_cli')).toHaveLength(1)
      expect(cliManager.handleCliCommand.mock.calls.filter(([command]: [string]) => command === 'agent_command')).toHaveLength(1)
      expect(getQueue(meshId).filter(entry => entry.status === 'assigned')).toHaveLength(1)
      expect(getQueue(meshId).filter(entry => entry.status === 'pending')).toHaveLength(2)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('skips nodes whose providerPriority cannot satisfy task requiredTags during auto-launch', async () => {
    const meshId = `mesh_auto_launch_tags_skip_${Date.now()}`
    try {
      // Node only has claude-cli, but task requires provider=hermes-cli
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'online', policy: { providerPriority: ['claude-cli'] } }],
        policy: { maxParallelTasks: 2 },
      })
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/claude' })
      enqueueTask(meshId, 'hermes-only task', { requiredTags: ['provider=hermes-cli'] })
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('pending')
      expect(entry.autoLaunch?.reason).toBe('no_node_satisfies_required_tags')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('auto-launches with the matching provider when node providerPriority includes the required provider=X tag', async () => {
    const meshId = `mesh_auto_launch_tags_match_${Date.now()}`
    try {
      // Node has both providers; task requires hermes-cli specifically
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a', health: 'online', policy: { providerPriority: ['claude-cli', 'hermes-cli'] } }],
        policy: { maxParallelTasks: 2 },
      })
      // Both providers are detected; hermes-cli must be selected (not claude-cli)
      detectCliMocks.detectCLI.mockResolvedValue({ path: '/bin/hermes' })
      const queued = enqueueTask(meshId, 'hermes task', { requiredTags: ['provider=hermes-cli'] })
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('launch_cli', expect.objectContaining({
        cliType: 'hermes-cli',
      }))
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('assigned')
      expect(entry.id).toBe(queued.id)
      expect(entry.autoLaunch?.status).toBe('completed')
      expect(entry.autoLaunch?.providerType).toBe('hermes-cli')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

describe('Codex coordinator stuck-generating: refine terminal event delivery', () => {
  function createGeneratingCoordinatorComponents(meshId: string, coordinatorStatus: string = 'generating') {
    const coordinatorState = {
      instanceId: 'codex-coordinator-session',
      workspace: '/repo/main',
      settings: { meshCoordinatorFor: meshId },
      status: coordinatorStatus,
      activeChat: { status: coordinatorStatus === 'generating' ? 'generating' : undefined },
    }
    const coordinator = {
      category: 'cli',
      getState: vi.fn(() => coordinatorState),
      onEvent: vi.fn(),
    }
    const instanceManager = {
      onEvent: vi.fn(),
      getInstance: vi.fn(() => null),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [coordinator] : []),
    }
    return { components: { instanceManager } as any, coordinator }
  }

  it('HOLDS refine:completed for a generating CLI coordinator (no force-write; delivered on idle)', async () => {
    const meshId = `mesh_codex_refine_completed_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      const { components, coordinator } = createGeneratingCoordinatorComponents(meshId, 'generating')

      const result = handleMeshForwardEvent(components, {
        event: 'refine:completed',
        meshId,
        nodeId: 'node-worktree',
        jobId: 'refine_ix_test_123',
        status: 'completed',
        result: { success: true, merged: true, branch: 'fix/branch', into: 'main' },
      })

      // Queue-only at forward time: the event is persisted, not pushed.
      expect(result).toMatchObject({ success: true, forwarded: 0 })

      // A raw force-write into a generating claude-cli PTY is not consumed as a turn
      // (NOTIF-SURFACE-LOCAL), so the reconcile tick HOLDS the event — not injected, not
      // drained — for the coordinator's next idle tick. It stays recoverable in the queue.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).not.toHaveBeenCalled()

      // Still queued (drained=0) — a drain still returns it intact.
      expect(drainPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('HOLDS refine:failed for a generating CLI coordinator (no force-write; delivered on idle)', async () => {
    const meshId = `mesh_codex_refine_failed_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      const { components, coordinator } = createGeneratingCoordinatorComponents(meshId, 'generating')

      const result = handleMeshForwardEvent(components, {
        event: 'refine:failed',
        meshId,
        nodeId: 'node-worktree',
        jobId: 'refine_ix_test_456',
        status: 'failed',
        result: { success: false, code: 'validation_failed', error: 'Tests failed' },
      })

      // Queue-only at forward time: the event is persisted, not pushed.
      expect(result).toMatchObject({ success: true, forwarded: 0 })

      // Held (not injected, not drained) for the generating coordinator's next idle tick.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).not.toHaveBeenCalled()

      expect(drainPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('queues refine:completed and the reconcile tick injects it into an idle CLI coordinator', async () => {
    const meshId = `mesh_codex_refine_idle_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      const { components, coordinator } = createGeneratingCoordinatorComponents(meshId, 'idle')

      const result = handleMeshForwardEvent(components, {
        event: 'refine:completed',
        meshId,
        nodeId: 'node-worktree',
        jobId: 'refine_ix_test_789',
        status: 'completed',
        result: { success: true, merged: true },
      })

      expect(result).toMatchObject({ success: true, forwarded: 0 })

      // The event is queued and visible to any peeking consumer (MCP coordinator) before drain.
      const peeked = getPendingMeshCoordinatorEvents(meshId)
      expect(peeked).toHaveLength(1)
      expect(peeked[0].event).toBe('refine:completed')

      // The reconcile tick drains the queue and injects into the idle coordinator.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('queues refine:accepted for MCP dual delivery and does not inject into a generating coordinator', async () => {
    const meshId = `mesh_codex_refine_accepted_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      const { components, coordinator } = createGeneratingCoordinatorComponents(meshId, 'generating')

      handleMeshForwardEvent(components, {
        event: 'refine:accepted',
        meshId,
        nodeId: 'node-worktree',
        jobId: 'refine_ix_test_accepted',
        status: 'accepted',
      })

      // The reconcile tick must not inject into a generating coordinator.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).not.toHaveBeenCalled()

      // Non-terminal events still buffer for MCP dual delivery regardless of coordinator state.
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0].event).toBe('refine:accepted')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('HOLDS agent:generating_completed for a generating CLI coordinator (false-idle fix; delivered on idle)', async () => {
    const meshId = `mesh_codex_gen_completed_generating_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      const { components, coordinator } = createGeneratingCoordinatorComponents(meshId, 'generating')

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node-worker',
        instanceId: 'worker-session-1',
        targetSessionId: 'worker-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'claude-history-1',
        duration: 42,
        timestamp: 99999,
      })

      // Queue-only at forward time: the event is persisted, not pushed.
      expect(result).toMatchObject({ success: true, forwarded: 0 })

      // NOTIF-SURFACE-LOCAL: a coordinator awaiting a worker result is generating, not idle.
      // A raw force-write into its PTY is not consumed as a turn and would be lost, so the
      // reconcile tick HOLDS the completion (not injected, not drained) for the coordinator's
      // next idle tick — when it lands as a real turn. The event stays recoverable in the queue.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).not.toHaveBeenCalled()

      expect(drainPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('queues agent:generating_completed and the reconcile tick injects it into an idle CLI coordinator', async () => {
    const meshId = `mesh_codex_gen_completed_idle_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      const { components, coordinator } = createGeneratingCoordinatorComponents(meshId, 'idle')

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node-worker',
        instanceId: 'worker-session-2',
        targetSessionId: 'worker-session-2',
        providerType: 'codex-cli',
        providerSessionId: 'codex-history-2',
        duration: 10,
        timestamp: 88888,
      })

      expect(result).toMatchObject({ success: true, forwarded: 0 })

      // The event is visible to a peeking MCP coordinator before the tick drains it.
      const peeked = getPendingMeshCoordinatorEvents(meshId)
      expect(peeked).toHaveLength(1)
      expect(peeked[0].event).toBe('agent:generating_completed')

      // The reconcile tick drains the queue and injects into the idle coordinator.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('pending terminal refine events are surfaced to coordinator sessions even if provider was generating at fire time', () => {
    // Verify the reconcile path: accepted event in pending → ledger has terminal → drain replaces with terminal
    const meshId = `mesh_codex_refine_reconcile_${Date.now()}`
    try {
      queuePendingMeshCoordinatorEvent({
        event: 'refine:accepted',
        meshId,
        nodeLabel: 'node-worktree',
        nodeId: 'node-worktree',
        workspace: '/repo/worktree',
        metadataEvent: {
          source: 'refine_mesh_node_async_job',
          jobId: 'refine_ix_coord_stuck',
          interactionId: 'ix-stuck-test',
          meshId,
          nodeId: 'node-worktree',
          status: 'accepted',
          startedAt: '2026-06-01T00:00:00.000Z',
        },
        queuedAt: Date.now(),
      })

      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node-worktree',
        payload: {
          source: 'refine_mesh_node_async_job',
          refineJob: {
            jobId: 'refine_ix_coord_stuck',
            interactionId: 'ix-stuck-test',
            status: 'completed',
            meshId,
            nodeId: 'node-worktree',
            workspace: '/repo/worktree',
            startedAt: '2026-06-01T00:00:00.000Z',
            completedAt: '2026-06-01T00:02:00.000Z',
          },
          async: true,
          success: true,
          result: { success: true, merged: true, branch: 'fix/coord-stuck', into: 'main' },
        },
      })

      const events = drainPendingMeshCoordinatorEvents(meshId)
      // reconcilePendingMeshCoordinatorEvents should replace accepted with completed
      expect(events).toHaveLength(1)
      expect(events[0].event).toBe('refine:completed')
      expect(events[0].coordinatorMessage).toContain('completed successfully')
      expect(events[0].metadataEvent.jobId).toBe('refine_ix_coord_stuck')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('records task_completed for direct dispatch to idle session even when prior queue task used the same providerSessionId', () => {
    // Regression: direct task dispatched to idle live session; prior queue-task completion
    // shares the same providerSessionId (same long-running provider session reused across turns).
    // The new completion must NOT be suppressed as a duplicate — it belongs to the new direct task.
    const meshId = `mesh_direct_idle_session_completion_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      // Step 1: a queue task completes first (via emit, which updates queue status correctly).
      const queuedTask = enqueueTask(meshId, 'first queue task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'shared-provider-session-id',
        finalSummary: 'first task done',
        // No explicit timestamp — lets the ledger use new Date() (now) so the direct
        // dispatch appended immediately after is always timestamped after this terminal.
      })

      const afterFirstCompletion = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(afterFirstCompletion).toHaveLength(1)
      expect(afterFirstCompletion[0].payload.taskId).toBe(queuedTask.id)
      // Queue task is now marked completed, so updateSessionTaskStatus will find nothing for it
      expect(getQueue(meshId)[0]).toMatchObject({ status: 'completed' })

      // Step 2: a new direct dispatch is recorded to the same idle session
      // (simulating mesh_send_task with dispatchedToIdleSession: true).
      // appendLedgerEntry writes new Date() which is always AFTER the terminal written above.
      appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        payload: {
          source: 'direct',
          via: 'mesh_send_task',
          taskId: 'direct-task-501d7d38',
          message: 'verify the preview result',
          dispatchedToIdleSession: true,
        },
      })

      // Step 3: the session completes the direct task — same providerSessionId, new finalSummary.
      // No generating transition was observed (idle→idle path for fast or idle-session tasks).
      const secondResult = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'shared-provider-session-id',
        finalSummary: '--- 최종 보고서 (읽기 전용 검증) 실행한 읽기 전용 명령어 ...',
        completionMarker: 'turn:cli-turn:1',
      })

      // Must NOT be suppressed — a new task_dispatched existed after the prior terminal
      expect(secondResult).not.toMatchObject({ suppressed: true })
      expect(secondResult.success).toBe(true)

      // Two task_completed entries must exist in the ledger
      const allCompleted = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(allCompleted).toHaveLength(2)
      expect(allCompleted[0].payload.taskId).toBe(queuedTask.id)
      // Second entry has no taskId (direct task not in queue) but belongs to the direct dispatch
      expect(allCompleted[1].payload.taskId).toBeUndefined()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not suppress a fast direct-dispatch completion that races ahead of its dispatch record when it echoes a distinct taskId', () => {
    // Regression for the direct-dispatch completion race (#8): a FAST mesh_send_task to an
    // already-idle, previously-used session can have its genuine agent:generating_completed reach
    // the coordinator BEFORE the dispatching side records the new task's dispatch row
    // (insertDirectDispatch) / task_dispatched ledger entry — both run only AFTER the agent_command
    // await resolves, while a quick worker may already be done. In that window
    // sessionHasActiveAssignment is false and there is no task_dispatched-after-terminal, so the
    // prior-terminal dedup engages; and because providerSessionId is STABLE across the reused
    // session's turns, the providerSessionId match would suppress the NEW task's completion as a
    // duplicate of the PRIOR task — silently losing it (the observed intermittent miss). The echoed
    // taskId is the authoritative discriminator: a completion naming a DIFFERENT task than the
    // recorded terminal must NOT be suppressed, and it must be attributed to its own taskId.
    const meshId = `mesh_direct_completion_race_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const { components } = createComponents(meshId)
      setupMeshEventForwarding(components)

      // Prior terminal ledger evidence: a previous direct task completed on this reused session,
      // with a providerSessionId that is stable across the session's turns.
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        payload: {
          event: 'agent:generating_completed',
          taskId: 'task_prior',
          providerSessionId: 'shared-provider-session-id',
          finalSummary: 'prior task report',
        },
      })

      // The NEW direct dispatch (task_next) completes FAST — its completion arrives before the
      // dispatch row / task_dispatched ledger entry is recorded (the race). Deliberately NO
      // insertDirectDispatch and NO task_dispatched ledger entry: sessionHasActiveAssignment is
      // false and hasDispatchAfterTerminal is false. The completion echoes its own taskId
      // (meshActiveTaskId) and the SAME stable providerSessionId as the prior terminal.
      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'shared-provider-session-id',
        taskId: 'task_next',
        finalSummary: 'next task report',
      })

      // Must NOT be suppressed — the echoed taskId differs from the prior terminal's taskId.
      expect(result).not.toMatchObject({ suppressed: true })
      expect(result.success).toBe(true)

      // Both completions present; the second is attributed to its own (distinct) taskId — not
      // flipped onto / merged with the prior task's row.
      const completed = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(completed).toHaveLength(2)
      expect(completed.map(e => e.payload.taskId)).toEqual(['task_prior', 'task_next'])

      // Exactly one pending coordinator event for the new completion is queued (delivered once).
      const pending = getPendingMeshCoordinatorEvents(meshId).filter(p => p.event === 'agent:generating_completed')
      expect(pending).toHaveLength(1)
      expect(pending[0].metadataEvent.taskId).toBe('task_next')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('duplicate completion suppression respects newer dispatch', () => {
    const meshId = `mesh_duplicate_respects_newer_dispatch_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      const queuedTask = enqueueTask(meshId, 'first queue task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'shared-claude-session-id',
        finalSummary: 'first task done',
      })

      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(1)
      expect(getQueue(meshId)[0]).toMatchObject({ id: queuedTask.id, status: 'completed' })

      appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        payload: {
          source: 'queue',
          taskId: 'newer-dispatch-ledger-only',
          message: 'second task after prior terminal',
        },
      })

      const completion = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'shared-claude-session-id',
        finalSummary: 'second task done',
      })

      expect(completion).toMatchObject({ success: true })
      expect(completion).not.toMatchObject({ suppressed: true })
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(2)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('still suppresses genuine duplicate completion that has no new dispatch after prior terminal', () => {
    // Safety: verify the existing duplicate-suppression safeguard is not broken.
    // A second identical generating_completed with no intervening task_dispatched must still be suppressed.
    const meshId = `mesh_genuine_duplicate_suppressed_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      const queued = enqueueTask(meshId, 'dedupe queue task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      const completionAt = Date.now() + 1_000
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-dedup-1',
        finalSummary: 'task completed once',
        timestamp: completionAt,
      })

      // Same event replayed — no new dispatch in between
      const duplicate = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        providerSessionId: 'provider-dedup-1',
        finalSummary: 'task completed once',
        timestamp: completionAt,
      })

      expect(duplicate).toMatchObject({ success: true, forwarded: 0, suppressed: true, duplicateCompletion: true })
      const completedEntries = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(completedEntries).toHaveLength(1)
      expect(completedEntries[0].payload.taskId).toBe(queued.id)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('routes worker completion events to a claude-cli coordinator session (not just codex/hermes)', async () => {
    const meshId = `mesh_claude_coord_recv_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      let listener: ((event: any) => void) | undefined
      const workerState = {
        instanceId: 'worker-session-codex',
        workspace: '/repo/worktree-a',
        settings: {
          meshNodeFor: meshId,
          meshNodeId: 'node_worker',
          launchedByCoordinator: true,
        },
      }
      const claudeCoordinatorState = {
        instanceId: 'claude-coordinator-session',
        workspace: '/repo/main',
        type: 'claude-cli',
        status: 'idle',
        settings: { meshCoordinatorFor: meshId },
      }
      const worker = {
        category: 'cli',
        getState: vi.fn(() => workerState),
      }
      const claudeCoordinator = {
        category: 'cli',
        getState: vi.fn(() => claudeCoordinatorState),
        onEvent: vi.fn(),
      }
      const instanceManager = {
        onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
        getInstance: vi.fn((id: string) => id === 'worker-session-codex' ? worker : undefined),
        getByCategory: vi.fn((category: string) => category === 'cli' ? [worker, claudeCoordinator] : []),
      }
      const components = { instanceManager } as any
      setupMeshEventForwarding(components)

      listener!({
        event: 'agent:generating_completed',
        instanceId: 'worker-session-codex',
        targetSessionId: 'worker-session-codex',
        providerType: 'codex-cli',
        providerSessionId: 'codex-session-abc',
        finalSummary: 'implemented feature',
        timestamp: 1710000001000,
      })

      // Queue-only delivery: the reconcile tick drains and injects into the idle coordinator.
      await runMeshReconcileTick(components)
      expect(claudeCoordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = claudeCoordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      const text = payload.input.textFallback
      expect(text).toContain('node_worker')
      expect(text).toContain('session_id=worker-session-codex')
      expect(text).toContain('provider=codex-cli')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not inject completion event when the source is a claude-cli coordinator session (aliasing guard)', () => {
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue({ id: 'mesh_inline_claude', nodes: [] })

    let listener: ((event: any) => void) | undefined
    const claudeCoordinatorState = {
      instanceId: 'claude-coord-self',
      workspace: '/repo/main',
      type: 'claude-cli',
      settings: { meshCoordinatorFor: 'mesh_inline_claude' },
    }
    const claudeCoordinator = {
      category: 'cli',
      getState: vi.fn(() => claudeCoordinatorState),
      onEvent: vi.fn(),
    }
    const instanceManager = {
      onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
      getInstance: vi.fn(() => claudeCoordinator),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [claudeCoordinator] : []),
    }
    const components = { instanceManager } as any
    setupMeshEventForwarding(components)

    listener!({
      event: 'agent:generating_completed',
      instanceId: 'claude-coord-self',
      targetSessionId: 'claude-coord-self',
      providerType: 'claude-cli',
    })

    expect(claudeCoordinator.onEvent).not.toHaveBeenCalled()
  })

  it('routes pending buffered coordinator events to a claude-cli coordinator via handleMeshForwardEvent', async () => {
    const meshId = `mesh_claude_forward_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const claudeCoordinatorState = {
        instanceId: 'claude-coordinator-fwd',
        workspace: '/repo/main',
        type: 'claude-cli',
        status: 'idle',
        settings: { meshCoordinatorFor: meshId },
      }
      const claudeCoordinator = {
        category: 'cli',
        getState: vi.fn(() => claudeCoordinatorState),
        onEvent: vi.fn(),
      }
      const instanceManager = {
        onEvent: vi.fn(),
        getInstance: vi.fn(),
        getByCategory: vi.fn((category: string) => category === 'cli' ? [claudeCoordinator] : []),
      }
      const components = { instanceManager } as any

      const result = handleMeshForwardEvent(components, {
        event: 'agent:stopped',
        meshId,
        nodeId: 'node_worker',
        targetSessionId: 'worker-session-1',
        providerType: 'hermes-cli',
      })

      expect(result).toEqual({ success: true, forwarded: 0 })
      // The reconcile tick drains and injects into the idle coordinator.
      await runMeshReconcileTick(components)
      expect(claudeCoordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = claudeCoordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.input.textFallback).toContain('has stopped')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

describe('atomic drain — concurrent safety', () => {
  it('concurrent drains return events only once (atomic rename guarantees single consumer)', () => {
    const meshId = `drain-concurrent-${randomUUID().slice(0, 8)}`
    const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
    try {
      // Write 3 events directly to the pending-events file
      const base = Date.now()
      const lines = [0, 1, 2].map(i =>
        JSON.stringify({ event: 'agent:ready', meshId, nodeLabel: 'n', metadataEvent: { timestamp: base + i }, queuedAt: base + i })
      )
      fs.writeFileSync(pendingPath, lines.join('\n') + '\n', 'utf-8')

      // In Node.js single-threaded execution, the second drain happens after the first rename
      // completes — meaning it finds no file and returns empty.
      const first = drainPendingMeshCoordinatorEvents(meshId)
      const second = drainPendingMeshCoordinatorEvents(meshId)

      expect(first.length).toBe(3)
      expect(second.length).toBe(0)
    } finally {
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
      cleanupMeshFiles(meshId)
    }
  })

  it('drain is idempotent — empty on second call', () => {
    const meshId = `drain-idempotent-${randomUUID().slice(0, 8)}`
    const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
    try {
      const base = Date.now()
      const lines = [0, 1].map(i =>
        JSON.stringify({ event: 'agent:ready', meshId, nodeLabel: 'n', metadataEvent: { timestamp: base + i }, queuedAt: base + i })
      )
      fs.writeFileSync(pendingPath, lines.join('\n') + '\n', 'utf-8')

      const first = drainPendingMeshCoordinatorEvents(meshId)
      expect(first.length).toBe(2)

      // File is already gone after first drain — second drain must return empty
      const second = drainPendingMeshCoordinatorEvents(meshId)
      expect(second.length).toBe(0)
    } finally {
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
      cleanupMeshFiles(meshId)
    }
  })

  it('drain leaves no .draining temp file behind', () => {
    const meshId = `drain-no-temp-${randomUUID().slice(0, 8)}`
    const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
    const drainingPath = `${pendingPath}.draining`
    try {
      const base = Date.now()
      fs.writeFileSync(
        pendingPath,
        JSON.stringify({ event: 'agent:ready', meshId, nodeLabel: 'n', metadataEvent: { timestamp: base }, queuedAt: base }) + '\n',
        'utf-8'
      )

      drainPendingMeshCoordinatorEvents(meshId)

      // The .draining temp file must not remain on disk after a successful drain
      expect(fs.existsSync(drainingPath)).toBe(false)
    } finally {
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
      if (fs.existsSync(drainingPath)) fs.unlinkSync(drainingPath)
      cleanupMeshFiles(meshId)
    }
  })
})

describe('pending events file size guard', () => {
  it('trims pending events file to last 50 events when it exceeds 100KB', () => {
    const meshId = 'mesh-pending-trim-' + randomUUID().slice(0, 8)
    const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
    try {
      // Write 100 large event lines (~1200 chars each) so total > 100KB.
      // Each line has a unique timestamp so duplicate detection does not suppress any of them.
      const base = Date.now()
      const lines = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ event: 'agent:ready', meshId, nodeLabel: 'n', metadataEvent: { data: 'x'.repeat(1100), timestamp: base + i }, queuedAt: base + i })
      )
      fs.writeFileSync(pendingPath, lines.join('\n') + '\n', 'utf-8')

      queuePendingMeshCoordinatorEvent({ event: 'agent:ready', meshId, nodeLabel: 'node', metadataEvent: { timestamp: base + 200 }, queuedAt: base + 200 })

      const result = fs.readFileSync(pendingPath, 'utf-8').split('\n').filter(Boolean)
      expect(result.length).toBeLessThanOrEqual(51)
    } finally {
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
      cleanupMeshFiles(meshId)
    }
  })

  it('does not trim file that is under 100KB', () => {
    const meshId = 'mesh-pending-notrim-' + randomUUID().slice(0, 8)
    const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
    try {
      // Write 10 small event lines (~50 chars each, well under 100KB total).
      // Each line has a unique timestamp so duplicate detection does not suppress any of them.
      const base = Date.now()
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ event: 'agent:ready', meshId, nodeLabel: 'n', metadataEvent: { timestamp: base + i }, queuedAt: base + i })
      )
      fs.writeFileSync(pendingPath, lines.join('\n') + '\n', 'utf-8')

      queuePendingMeshCoordinatorEvent({ event: 'agent:ready', meshId, nodeLabel: 'node', metadataEvent: { timestamp: base + 100 }, queuedAt: base + 100 })

      const result = fs.readFileSync(pendingPath, 'utf-8').split('\n').filter(Boolean)
      expect(result.length).toBe(11)
    } finally {
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
      cleanupMeshFiles(meshId)
    }
  })

  it('trim is best-effort — does not fail if file is unreadable', () => {
    // Calling queuePendingMeshCoordinatorEvent on a normal non-existent file should not throw
    const meshId = 'mesh-pending-nofile-' + randomUUID().slice(0, 8)
    const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
    try {
      expect(() => {
        queuePendingMeshCoordinatorEvent({ event: 'agent:ready', meshId, nodeLabel: 'node', metadataEvent: { timestamp: Date.now() }, queuedAt: Date.now() })
      }).not.toThrow()
    } finally {
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
      cleanupMeshFiles(meshId)
    }
  })
})

describe('workspace-to-mesh cache in setupMeshEventForwarding', () => {
  it('caches getMeshByRepo result for repeated events from same workspace', () => {
    const meshId = `mesh-ws-cache-${randomUUID().slice(0, 8)}`
    try {
      meshConfigMocks.getMeshByRepo.mockReset()
      meshConfigMocks.getMesh.mockReset()
      meshConfigMocks.getMeshByRepo.mockReturnValue({ id: meshId, nodes: [] })
      meshConfigMocks.getMesh.mockReturnValue(null)

      let listener: ((event: any) => void) | undefined
      const noMeshNodeForState = {
        instanceId: 'runtime-session-ws',
        workspace: `/repo/workspace-cached-${randomUUID().slice(0, 8)}`,
        settings: {
          // NO meshNodeFor — triggers workspace-based lookup via getCachedMeshByWorkspace
          launchedByCoordinator: true,
        },
      }
      const workerSession = {
        category: 'cli',
        getState: vi.fn(() => noMeshNodeForState),
      }
      const instanceManager = {
        onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
        getInstance: vi.fn((id: string) => id === 'runtime-session-ws' ? workerSession : undefined),
        getByCategory: vi.fn((_category: string) => []),
      }
      const components = { instanceManager } as any
      setupMeshEventForwarding(components)

      // Emit 5 mesh events from the same workspace instance
      for (let i = 0; i < 5; i++) {
        listener!({
          instanceId: 'runtime-session-ws',
          event: 'agent:ready',
          targetSessionId: `sess-${i}`,
          timestamp: Date.now() + i,
        })
      }

      // getMeshByRepo should have been called only once (first cache miss), then cached
      expect(meshConfigMocks.getMeshByRepo).toHaveBeenCalledTimes(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

describe('daemon-scoped pending event drain', () => {
  // Regression: a8788999 ensures task_completed reaches a coordinator that itself is the
  // direct-dispatch target. This test pins the drain-side guarantee: when a coordinator
  // daemon polls drainPendingMeshCoordinatorEvents(meshId, daemonId), it must consume
  // events targeted at it (or unscoped), and leave events targeted at a different daemon
  // untouched in their own scoped file.
  function safeId(s: string) { return s.replace(/[^a-zA-Z0-9_-]/g, '_') }
  function cleanupScoped(meshId: string, daemonIds: string[]) {
    const sharedPath = path.join(getLedgerDir(), `${safeId(meshId)}.pending-events.jsonl`)
    if (fs.existsSync(sharedPath)) fs.unlinkSync(sharedPath)
    for (const id of daemonIds) {
      const scopedPath = path.join(getLedgerDir(), `${safeId(meshId)}-${safeId(id)}.pending-events.jsonl`)
      if (fs.existsSync(scopedPath)) fs.unlinkSync(scopedPath)
    }
  }

  it('coordinator drain consumes scoped events for its daemon and leaves other daemons\' scoped events on disk', () => {
    const meshId = `mesh_drain_scope_${randomUUID().slice(0, 8)}`
    const daemonA = `daemon_a_${randomUUID().slice(0, 8)}`
    const daemonB = `daemon_b_${randomUUID().slice(0, 8)}`
    try {
      const base = Date.now()
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: 'node-A',
        metadataEvent: { timestamp: base + 1, target: 'A' },
        queuedAt: base + 1,
        targetCoordinatorDaemonId: daemonA,
      })
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: 'node-B',
        metadataEvent: { timestamp: base + 2, target: 'B' },
        queuedAt: base + 2,
        targetCoordinatorDaemonId: daemonB,
      })

      const drainedByA = drainPendingMeshCoordinatorEvents(meshId, daemonA)
      expect(drainedByA).toHaveLength(1)
      expect((drainedByA[0].metadataEvent as any).target).toBe('A')

      // Daemon B's scoped file must remain untouched after A's drain
      const drainedByB = drainPendingMeshCoordinatorEvents(meshId, daemonB)
      expect(drainedByB).toHaveLength(1)
      expect((drainedByB[0].metadataEvent as any).target).toBe('B')
    } finally {
      cleanupScoped(meshId, [daemonA, daemonB])
      cleanupMeshFiles(meshId)
    }
  })

  it('legacy unscoped events in shared file are filtered to the polling coordinator only (other daemons leave them in place)', () => {
    const meshId = `mesh_drain_legacy_${randomUUID().slice(0, 8)}`
    const daemonA = `daemon_a_${randomUUID().slice(0, 8)}`
    const daemonB = `daemon_b_${randomUUID().slice(0, 8)}`
    const sharedPath = path.join(getLedgerDir(), `${safeId(meshId)}.pending-events.jsonl`)
    try {
      const base = Date.now()
      // Write directly to the legacy shared file: one targeted at daemonB, one fully unscoped.
      const lines = [
        JSON.stringify({ event: 'agent:generating_completed', meshId, nodeLabel: 'n', metadataEvent: { timestamp: base + 1, target: 'B' }, queuedAt: base + 1, targetCoordinatorDaemonId: daemonB }),
        JSON.stringify({ event: 'agent:ready', meshId, nodeLabel: 'n', metadataEvent: { timestamp: base + 2 }, queuedAt: base + 2 }),
      ]
      fs.writeFileSync(sharedPath, lines.join('\n') + '\n', 'utf-8')

      // Daemon A drains: must NOT receive the daemon-B-targeted event. Should receive the unscoped one.
      const drainedByA = drainPendingMeshCoordinatorEvents(meshId, daemonA)
      expect(drainedByA.map(e => e.event)).toEqual(['agent:ready'])

      // The atomic rename consumed the file; daemon B polling now sees nothing because the
      // shared file is gone. This is a known limitation of the legacy shared file path —
      // the test pins the behavior so it surfaces if anyone changes the contract.
      const drainedByB = drainPendingMeshCoordinatorEvents(meshId, daemonB)
      expect(drainedByB).toHaveLength(0)
    } finally {
      cleanupScoped(meshId, [daemonA, daemonB])
      cleanupMeshFiles(meshId)
    }
  })
})

afterAll(() => {
  try {
    if (fs.existsSync(testTmpDir)) fs.rmSync(testTmpDir, { recursive: true, force: true })
  } catch { /* best-effort cleanup */ }
})

describe('M1-3 — dependent wake on completion (event-based, no polling)', () => {
  it('claims a dependent task for another idle session after the dependency completes', async () => {
    const meshId = `mesh_dep_wake_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [
          { id: 'node_child_1', workspace: '/repo/worktree-a' },
          { id: 'node_child_2', workspace: '/repo/worktree-b' },
        ],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      fastForwardMocks.fastForwardMeshNode.mockResolvedValue({ code: 'noop', allowed: false })

      let listener: ((event: any) => void) | undefined
      const completingState = {
        instanceId: 'runtime-session-1',
        workspace: '/repo/worktree-a',
        status: 'generating',
        type: 'hermes-cli',
        settings: { meshNodeFor: meshId, meshNodeId: 'node_child_1' },
      }
      const idleWorkerState = {
        instanceId: 'runtime-session-2',
        workspace: '/repo/worktree-b',
        status: 'idle',
        type: 'hermes-cli',
        settings: { meshNodeFor: meshId, meshNodeId: 'node_child_2' },
      }
      const completing = { category: 'cli', getState: vi.fn(() => completingState) }
      const idleWorker = { category: 'cli', getState: vi.fn(() => idleWorkerState) }
      const cliManager = {
        adapters: new Map([['runtime-session-1', {}], ['runtime-session-2', {}]]),
        handleCliCommand: vi.fn(() => Promise.resolve({ success: true })),
      }
      const components = {
        instanceManager: {
          onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
          getInstance: vi.fn((id: string) => id === 'runtime-session-1' ? completing : id === 'runtime-session-2' ? idleWorker : undefined),
          getByCategory: vi.fn((category: string) => category === 'cli' ? [completing, idleWorker] : []),
        },
        cliManager,
      } as any

      // Task A assigned to session-1; B depends on A and targets session-2.
      const a = enqueueTask(meshId, 'task A')
      const claimedA = claimNextTask(meshId, 'node_child_1', 'runtime-session-1')
      expect(claimedA?.id).toBe(a.id)
      const b = enqueueTask(meshId, 'task B after A', { dependsOn: [a.id], targetSessionId: 'runtime-session-2' })

      setupMeshEventForwarding(components)
      listener!({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
        finalSummary: 'A done',
        timestamp: Date.now(),
      })

      // The wake path runs via setImmediate — allow the event loop to settle.
      await new Promise(resolve => setTimeout(resolve, 100))

      const after = getQueue(meshId)
      expect(after.find(t => t.id === a.id)?.status).toBe('completed')
      const afterB = after.find(t => t.id === b.id)
      expect(afterB?.status).toBe('assigned')
      expect(afterB?.assignedSessionId).toBe('runtime-session-2')
      // Dispatch went through the normal send_chat path for session-2.
      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('agent_command', expect.objectContaining({
        targetSessionId: 'runtime-session-2',
        action: 'send_chat',
        message: 'task B after A',
      }))
    } finally {
      cleanupMeshFiles(meshId)
      meshConfigMocks.getMesh.mockReset()
      meshConfigMocks.getMeshByRepo.mockReset()
    }
  })
})

describe('reconcile tick — autonomous remote queue pull (no live CLI coordinator)', () => {
  // Regression for the core remote-worktree-completion failure: the coordinator is
  // frequently a pure stdio MCP/LLM (no live CLI coordinator session on this daemon).
  // Previously runMeshReconcileTick early-returned when findLiveCoordinators() was
  // empty, so it never pulled remote worker nodes' queues — remote completions sat
  // on the remote node until the LLM happened to call mesh_read_chat (the MCP-side
  // pull). The daemon must now pull remote node queues on the timer for every mesh
  // it hosts, regardless of whether a live CLI coordinator exists.

  function hostComponents(opts: { dispatchMeshCommand?: any; statusInstanceId?: string }) {
    // No CLI instances at all → findLiveCoordinators() returns []. This is the
    // MCP/LLM-coordinator case the fix targets.
    return {
      instanceManager: {
        onEvent: vi.fn(),
        getInstance: vi.fn(() => undefined),
        getByCategory: vi.fn(() => []),
      },
      ...(opts.dispatchMeshCommand ? { dispatchMeshCommand: opts.dispatchMeshCommand } : {}),
      ...(opts.statusInstanceId ? { statusInstanceId: opts.statusInstanceId } : {}),
    } as any
  }

  it('pulls a remote worker node queue into the local queue even with no live CLI coordinator', async () => {
    const meshId = `mesh_remote_pull_${randomUUID().slice(0, 8)}`
    const remoteDaemon = `remote_daemon_${randomUUID().slice(0, 8)}`
    try {
      // This daemon (test-machine) hosts the mesh; the worker lives on remoteDaemon.
      const mesh = {
        id: meshId,
        nodes: [
          { id: 'node_coord', workspace: '/repo/main', daemonId: 'test-machine' },
          { id: 'node_worker', workspace: '/repo/worktree-a', daemonId: remoteDaemon },
        ],
        meshHost: { role: 'host', hostDaemonId: 'test-machine' },
      }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])

      // The remote node's daemon answers get_pending_mesh_events with one completion.
      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
        if (daemonId === remoteDaemon && command === 'get_pending_mesh_events') {
          return {
            events: [{
              event: 'agent:generating_completed',
              meshId,
              nodeId: 'node_worker',
              workspace: '/repo/worktree-a',
              metadataEvent: {
                providerType: 'claude-cli',
                providerSessionId: 'remote-history-1',
                finalSummary: 'remote worker done',
                timestamp: 55501,
              },
            }],
          }
        }
        return { events: [] }
      })

      const components = hostComponents({ dispatchMeshCommand })

      await runMeshReconcileTick(components)

      // The remote node was polled — NOT the local coordinator node (its events are
      // already local), and the tick did not early-return despite zero live CLI coordinators.
      expect(dispatchMeshCommand).toHaveBeenCalledWith(remoteDaemon, 'get_pending_mesh_events', expect.objectContaining({ meshId }))
      expect(dispatchMeshCommand).not.toHaveBeenCalledWith('test-machine', 'get_pending_mesh_events', expect.anything())

      // The pulled event was re-queued into THIS daemon's local pending queue, so the
      // MCP/LLM coordinator will see it on its next mesh tool call.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0].event).toBe('agent:generating_completed')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('pulls with BOTH the status id and bare machineId so either coordinator-id stamp is recovered', async () => {
    // A remote worker stamps the coordinator id as either the canonical status id
    // (standalone_/daemon_<machineId>, via the MCP layer) or the bare machineId.
    // The remote drain filters by coordinatorDaemonId, so the reconcile loop must
    // pull once per candidate id to recover a completion stamped with either form.
    const meshId = `mesh_dual_id_pull_${randomUUID().slice(0, 8)}`
    const remoteDaemon = `remote_daemon_${randomUUID().slice(0, 8)}`
    try {
      const mesh = {
        id: meshId,
        nodes: [
          { id: 'node_coord', workspace: '/repo/main', daemonId: 'test-machine' },
          { id: 'node_worker', workspace: '/repo/worktree-a', daemonId: remoteDaemon },
        ],
        meshHost: { role: 'host', hostDaemonId: 'standalone_test-machine' },
      }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])

      const dispatchMeshCommand = vi.fn(async () => ({ events: [] }))
      // statusInstanceId present → drainDaemonIds = ['standalone_test-machine', 'test-machine'].
      const components = hostComponents({ dispatchMeshCommand, statusInstanceId: 'standalone_test-machine' })

      await runMeshReconcileTick(components)

      const pulledIds = dispatchMeshCommand.mock.calls
        .filter(c => c[0] === remoteDaemon && c[1] === 'get_pending_mesh_events')
        .map(c => (c[2] as any).coordinatorDaemonId)
      expect(pulledIds).toContain('standalone_test-machine')
      expect(pulledIds).toContain('test-machine')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT pull when this daemon is only a member (another daemon is the host)', async () => {
    const meshId = `mesh_member_only_${randomUUID().slice(0, 8)}`
    const remoteDaemon = `remote_daemon_${randomUUID().slice(0, 8)}`
    try {
      const mesh = {
        id: meshId,
        nodes: [
          { id: 'node_worker', workspace: '/repo/worktree-a', daemonId: 'test-machine' },
          { id: 'node_other', workspace: '/repo/worktree-b', daemonId: remoteDaemon },
        ],
        // The host is a DIFFERENT daemon — this daemon is a member-only worker and
        // must not pull (the host pulls our queue, not the other way around).
        meshHost: { role: 'host', hostDaemonId: 'some-other-host-daemon' },
      }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])

      const dispatchMeshCommand = vi.fn(async () => ({ events: [] }))
      const components = hostComponents({ dispatchMeshCommand })

      await runMeshReconcileTick(components)

      expect(dispatchMeshCommand).not.toHaveBeenCalled()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('standalone (no dispatchMeshCommand) skips remote pull entirely', async () => {
    const meshId = `mesh_standalone_skip_${randomUUID().slice(0, 8)}`
    try {
      const mesh = {
        id: meshId,
        nodes: [{ id: 'node_coord', workspace: '/repo/main', daemonId: 'test-machine' }],
        meshHost: { role: 'host' },
      }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])

      // No dispatchMeshCommand → standalone. Must not throw and must be a no-op.
      const components = hostComponents({})
      await expect(runMeshReconcileTick(components)).resolves.toBeUndefined()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

// ─── EVT: re-dispatch 2nd-completion event recovery ───────────────────────────
// Root mechanism (ledger-confirmed): a worker's 1st turn drops to a FALSE idle (no
// confirmed final assistant — a "scheduled fallback" idle). That prematurely marked the
// direct-dispatch task terminal (task_completed, insufficient evidence). A coordinator
// nudge (direct re-dispatch) then drove a real 2nd turn that genuinely finished — but the
// 2nd completion was lost: it shared the (stable) providerSessionId of the false-idle
// terminal and had no live dispatch row, so the suppression dedup swallowed it, and direct
// dispatches were never attributed in the ledger / task-stats (status=unknown,
// terminalKind=null). These tests encode the fix set A/B/C.
describe('EVT — re-dispatch 2nd-completion event recovery', () => {
  it('Fix A: a false-idle completion of a direct dispatch is kept tentative (dispatch row stays active for reconcile)', () => {
    const meshId = `mesh_false_idle_tentative_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      insertDirectDispatch(meshId, {
        taskId: 'task_redispatch_1',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        message: 'build and commit',
        via: 'local_direct',
        dispatchedAt: new Date().toISOString(),
      })

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      // FALSE idle: the provider dropped to idle without a confirmed final assistant message.
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'provider-session-1',
        timestamp: Date.now(),
        completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' },
      })

      // The direct-dispatch row must remain ACTIVE — not flipped terminal — so the reconcile
      // loop (PHASE 4) can later confirm the genuine completion from the transcript.
      expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).toContain('task_redispatch_1')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('Fix A control: a GENUINE direct-dispatch completion still flips the dispatch row terminal', () => {
    const meshId = `mesh_genuine_terminal_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      insertDirectDispatch(meshId, {
        taskId: 'task_genuine_1',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        message: 'do work',
        via: 'local_direct',
        dispatchedAt: new Date().toISOString(),
      })

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'provider-session-1',
        finalSummary: 'work done',
        timestamp: Date.now(),
      })

      // Genuine completion → row marked terminal (no longer active). Regression guard for Fix A.
      expect(getActiveDirectDispatches(meshId).map(d => d.taskId)).not.toContain('task_genuine_1')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('Fix B: a genuine 2nd completion supersedes a prior weak (false-idle) terminal instead of being deduped by stable providerSessionId', () => {
    const meshId = `mesh_supersede_weak_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      // Prior WEAK terminal for the session (the false idle that prematurely terminated taskId-A).
      // No active direct dispatch and no queue task → sessionHasActiveAssignment is false, so the
      // suppression dedup below would normally fire on the matching (stable) providerSessionId.
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        payload: {
          event: 'agent:generating_completed',
          taskId: 'task_A',
          providerSessionId: 'provider-session-stable',
          evidenceLevel: 'insufficient',
          reviewRecommended: true,
          completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' },
        },
      })

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      // The genuine 2nd-turn completion (after a coordinator nudge) — SAME providerSessionId,
      // but real final-assistant evidence this time.
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'provider-session-stable',
        finalSummary: 'build succeeded and committed',
        timestamp: Date.now() + 5_000,
      })

      // Must NOT be suppressed: exactly one pending coordinator event for the genuine completion.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0].event).toBe('agent:generating_completed')
      // And a fresh (non-weak) task_completed ledger entry recorded for the genuine completion.
      const genuine = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed' && e.payload.finalSummary === 'build succeeded and committed')
      expect(genuine).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('FALSEIDLE-BGCHILD-b: a genuine 2nd completion with a FULLER summary supersedes a prior STRONG (background-child false-idle) terminal of the same task', () => {
    const meshId = `mesh_supersede_truncated_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      // Prior STRONG terminal: the background-child false idle. The screen parser DID see a
      // prior/intermediate standard assistant, so this is recorded WITHOUT weak markers — a
      // truncated-but-non-empty finalSummary, finalAssistantPresent !== false. This is exactly
      // the case isWeakTerminalLedgerPayload misses (so supersedesWeakTerminal would be false).
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        payload: {
          event: 'agent:generating_completed',
          taskId: 'task_BG',
          providerSessionId: 'provider-session-stable',
          finalSummary: 'Running tests in the background',
        },
      })

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      // The REAL final after the background child finished and the parent turn (commit) completed.
      // SAME task + SAME stable providerSessionId, but a fuller summary that extends the truncated one.
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'provider-session-stable',
        taskId: 'task_BG',
        finalSummary: 'Running tests in the background — all 42 passed, committed and pushed',
        timestamp: Date.now() + 5_000,
      })

      // Must NOT be suppressed: the genuine fuller completion reaches the coordinator.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0].event).toBe('agent:generating_completed')
      const genuine = readLedgerEntries(meshId).filter(
        e => e.kind === 'task_completed' && e.payload.finalSummary === 'Running tests in the background — all 42 passed, committed and pushed',
      )
      expect(genuine).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('FALSEIDLE-BGCHILD-b: an identical-summary re-arrival of a STRONG terminal is STILL deduped (supersession is fuller-only)', () => {
    const meshId = `mesh_supersede_identical_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        payload: {
          event: 'agent:generating_completed',
          taskId: 'task_DUP',
          providerSessionId: 'provider-session-stable',
          finalSummary: 'all done',
        },
      })

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      // A genuine duplicate: same task, same summary — must remain deduped, not re-forwarded.
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'provider-session-stable',
        taskId: 'task_DUP',
        finalSummary: 'all done',
        timestamp: Date.now() + 5_000,
      })

      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('Fix B: a direct-dispatch completion attributes its taskId to the terminal ledger so task-stats report it (not status=unknown / terminalKind=null)', () => {
    const meshId = `mesh_direct_attribution_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      // Direct dispatch row + its task_dispatched ledger entry (as the dispatch path records).
      insertDirectDispatch(meshId, {
        taskId: 'task_direct_X',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        message: 'run validation',
        via: 'local_direct',
        dispatchedAt: new Date(Date.now() - 60_000).toISOString(),
      })
      appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        payload: { taskId: 'task_direct_X', source: 'direct' },
      })

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        providerSessionId: 'provider-session-1',
        finalSummary: 'validation passed',
        timestamp: Date.now(),
      })

      // The terminal ledger entry must carry the direct-dispatch taskId (was undefined).
      const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.payload.finalSummary === 'validation passed')
      expect(completed?.payload.taskId).toBe('task_direct_X')

      // task-stats now reports the direct task as completed with a terminal kind (was unknown/null).
      const [stats] = computeMeshTaskStats(meshId, { taskIds: ['task_direct_X'] })
      expect(stats.status).toBe('completed')
      expect(stats.terminalKind).toBe('task_completed')
      expect(stats.dispatchCount).toBe(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('Fix C: transcript reconcile ignores a prior WEAK terminal and synthesizes the genuine completion', () => {
    const meshId = `mesh_reconcile_weak_${Date.now()}`
    try {
      // NOTIF-MISS grace gate: the dispatch must be older than the direct-dispatch reconcile
      // grace window for the synthesis to fire (this test exercises weak-terminal supersession,
      // which is orthogonal to the grace). Write the task_dispatched entry straight to the store
      // with a backdated timestamp (the public appendLedgerEntry always stamps `now`).
      MeshRuntimeStore.getInstance().appendLedgerEntry({
        id: 'dispatch-task_C',
        meshId,
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        kind: 'task_dispatched',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        payload: { taskId: 'task_C', source: 'direct' },
      })
      // A prior WEAK terminal for the same task — the false idle that prematurely "completed" it.
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        payload: {
          taskId: 'task_C',
          evidenceLevel: 'insufficient',
          reviewRecommended: true,
          completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' },
        },
      })

      const result = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: 'node_child_1',
        sessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        taskId: 'task_C',
        finalSummary: 'genuine final assistant: build + commit done',
        transcriptMessageAt: new Date(Date.now() + 10_000).toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })

      // The weak terminal must NOT count as alreadyTerminal — reconcile synthesizes the real one.
      expect(result.reconciled).toBe(true)
      expect(result.kind).toBe('task_completed')
      const synthesized = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed' && e.payload.finalSummary === 'genuine final assistant: build + commit done')
      expect(synthesized).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

// CANON-D: an unresolved-mesh worker (forwardUnresolvedDelegateEvent) forwards its
// completion with nodeId + workspace but NO meshId — it cannot resolve the mesh id
// locally. The coordinator must recover the id. Workspace recovery alone was
// unreliable (worktree clone repoIdentity divergence / transient cache miss), which
// left the reconcile retry permanently rejected with "meshId required" so the
// completion never surfaced. nodeId is a stable coordinator-side fact and recovers
// the mesh deterministically.
describe('handleMeshForwardEvent — meshId recovery by nodeId (CANON-D)', () => {
  it('recovers meshId by nodeId when the forward carries no meshId and workspace recovery fails', () => {
    const meshId = `mesh_nodeid_recover_${Date.now()}`
    try {
      const { components } = createComponents(meshId)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined) // workspace recovery misses
      meshConfigMocks.listMeshes.mockReturnValue([
        { id: meshId, nodes: [{ id: 'node_child_1' }] },
      ])

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        // meshId intentionally absent — the worker was in the mesh_unresolved fallback.
        nodeId: 'node_child_1',
        workspace: '/repo/worktree-a',
        targetSessionId: 'worker-session-1',
        providerType: 'claude-cli',
        timestamp: 1710000010000,
      })

      expect(result).toEqual({ success: true, forwarded: 0 })
      // Queued under the recovered meshId — the completion now reaches the coordinator.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('matches the node under any of the 3 id forms (id / nodeId / node_id)', () => {
    const meshId = `mesh_nodeid_3form_${Date.now()}`
    try {
      const { components } = createComponents(meshId)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      meshConfigMocks.listMeshes.mockReturnValue([
        { id: meshId, nodes: [{ node_id: 'node_child_1' }] }, // node_id form only
      ])

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        nodeId: 'node_child_1',
        targetSessionId: 'worker-session-1',
        providerType: 'claude-cli',
        timestamp: 1710000011000,
      })

      expect(result).toEqual({ success: true, forwarded: 0 })
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('still rejects when meshId is absent AND the nodeId belongs to no hosted mesh', () => {
    const meshId = `mesh_unknown_node_${Date.now()}`
    try {
      const { components } = createComponents(meshId)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      meshConfigMocks.listMeshes.mockReturnValue([
        { id: meshId, nodes: [{ id: 'node_child_1' }] },
      ])

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        nodeId: 'node_not_in_any_mesh',
        targetSessionId: 'worker-session-x',
        providerType: 'claude-cli',
        timestamp: 1710000012000,
      })

      expect(result).toEqual({ success: false, error: 'meshId required' })
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('keeps the workspace recovery fast-path (no meshId/nodeId but workspace resolves)', () => {
    const meshId = `mesh_ws_fallback_${Date.now()}`
    try {
      const { components } = createComponents(meshId)
      meshConfigMocks.getMeshByRepo.mockReturnValue({ id: meshId }) // workspace resolves
      meshConfigMocks.listMeshes.mockReturnValue([]) // nodeId path unavailable

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        workspace: '/repo/worktree-a',
        targetSessionId: 'worker-session-2',
        providerType: 'claude-cli',
        timestamp: 1710000013000,
      })

      expect(result).toEqual({ success: true, forwarded: 0 })
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
