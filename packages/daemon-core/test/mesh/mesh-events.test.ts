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
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
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
}))

vi.mock('../../src/detection/cli-detector.js', () => ({
  detectCLI: detectCliMocks.detectCLI,
}))

vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({
  fastForwardMeshNode: fastForwardMocks.fastForwardMeshNode,
}))

import { __resetIdleAutoFastForwardForTests, __resetMeshWorkspaceCacheForTests, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, handleMeshForwardEvent, queuePendingMeshCoordinatorEvent, runMeshReconcileTick, setupMeshEventForwarding, triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, claimNextTask, enqueueTask, getQueue, insertDirectDispatch } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, readLedgerEntries, appendLedgerEntry, getLedgerSummary } from '../../src/mesh/mesh-ledger.js'
import { UNROUTABLE_DIAGNOSTIC_STREAM, __resetUnroutableDiagnosticsForTests } from '../../src/mesh/mesh-routing.js'

function createComponents(meshId = 'mesh_inline_1', workerSettings?: Record<string, unknown>) {
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
    status: 'idle',
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
    components: { instanceManager } as any,
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

  it('R4: emits a delivery_unroutable diagnostic when an enveloped worker resolves to no mesh', () => {
    // The worker presents a valid envelope (launchedByCoordinator) but neither the mesh-id
    // lookup nor the workspace lookup resolves a mesh. Before R4 the completion was dropped
    // silently — no coordinator inject, no queue, no trace. R4 leaves a fail-loud
    // delivery_unroutable ledger entry so the lost completion is discoverable.
    const meshId = `mesh_unroutable_${Date.now()}`
    __resetUnroutableDiagnosticsForTests()
    __resetMeshWorkspaceCacheForTests() // ensure no prior test cached /repo/worktree-a → a real mesh
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined) // no mesh resolvable by workspace either
      const { components, emit, coordinator } = createComponents(meshId, {
        launchedByCoordinator: true, // envelope present, but meshNodeFor absent and workspace unresolved
      })

      setupMeshEventForwarding(components)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'claude-cli',
        timestamp: 4242,
      })

      // The event was unroutable: no coordinator inject.
      expect(coordinator.onEvent).not.toHaveBeenCalled()

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

  it('does not force-inject non-terminal long-generating alerts into the coordinator', async () => {
    // long_generating is informational — the coordinator should receive it through the
    // normal (queueable) path, not force-written into a generating PTY as noise.
    const meshId = `mesh_no_force_long_gen_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
      const { components, emit, coordinator } = createComponents(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'monitor:long_generating',
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

  it('injects forwarded stopped and long-generating coordinator hints from remote worker daemons', async () => {
    const meshId = `mesh_long_gen_plain_${Date.now()}`
    const { components, coordinator } = createComponents(meshId)

    const stopped = handleMeshForwardEvent(components, {
      event: 'agent:stopped',
      meshId,
      nodeId: 'node_child_1',
      targetSessionId: 'runtime-session-1',
      providerType: 'hermes-cli',
    })
    const longGenerating = handleMeshForwardEvent(components, {
      event: 'monitor:long_generating',
      meshId,
      nodeId: 'node_child_1',
      targetSessionId: 'runtime-session-long',
      providerType: 'hermes-cli',
    })

    // Queue-only: handleMeshForwardEvent persists to the queue (forwarded: 0); the
    // reconcile tick injects into the live coordinator.
    expect(stopped).toEqual({ success: true, forwarded: 0 })
    expect(longGenerating).toEqual({ success: true, forwarded: 0 })
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

  it('reconciles a long-generating monitor to completion when final summary evidence exists', async () => {
    const meshId = `mesh_long_gen_reconcile_${Date.now()}`
    try {
      const { components, coordinator } = createComponents(meshId)
      const queued = enqueueTask(meshId, 'finish delegated task')
      claimNextTask(meshId, 'node_child_1', 'runtime-session-1')

      const result = handleMeshForwardEvent(components, {
        event: 'monitor:long_generating',
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

  it('suppresses long-generating alert when terminal ledger evidence already exists', () => {
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
        event: 'monitor:long_generating',
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

  it('suppresses cleanup-requested stop and stale long-generating events from failure/recovery ledgers', () => {
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
      const longGenerating = handleMeshForwardEvent(components, {
        event: 'monitor:long_generating',
        meshId,
        nodeId: 'node_child_1',
        targetSessionId: 'runtime-session-1',
        providerType: 'hermes-cli',
      })

      expect(stopped).toMatchObject({ success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true })
      expect(longGenerating).toMatchObject({ success: true, forwarded: 0, suppressed: true, intentionalCleanupStop: true })
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

  it('skips remote nodes instead of local auto-launching through cliManager', async () => {
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

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('pending')
      expect(entry.autoLaunch?.reason).toBe('remote_auto_launch_unsupported')
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

  it('force-injects refine:completed into a generating CLI coordinator (force-drain)', async () => {
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

      // refine:completed is a force-inject event — the reconcile tick force-drains it
      // into the generating coordinator (force:true) rather than leaving it deadlocked.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][1].force).toBe(true)

      // Consumed — nothing left to re-deliver.
      expect(drainPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('force-injects refine:failed into a generating CLI coordinator (force-drain)', async () => {
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

      // refine:failed is a force-inject event — force-drained into the generating coordinator.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][1].force).toBe(true)

      expect(drainPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
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

  it('force-injects agent:generating_completed into a generating CLI coordinator (force-drain)', async () => {
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

      // agent:generating_completed is a force-inject event — the reconcile tick
      // force-drains it into the generating coordinator (the bug this fix closes:
      // a coordinator awaiting a worker result is generating, not idle).
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][1].force).toBe(true)

      expect(drainPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
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
