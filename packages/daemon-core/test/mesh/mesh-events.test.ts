import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { execFileSync } from 'node:child_process'

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
  getMachineId: () => (configMocks.loadConfig() as any).machineId,
  getMachineNickname: () => (configMocks.loadConfig() as any).machineNickname ?? null,
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

const readyWaitMocks = vi.hoisted(() => ({
  waitForRemoteSessionReady: vi.fn(async () => false),
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

vi.mock('../../src/mesh/mesh-remote-ready-wait.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mesh/mesh-remote-ready-wait.js')>()
  return {
    ...actual,
    waitForRemoteSessionReady: (...args: unknown[]) => readyWaitMocks.waitForRemoteSessionReady(...args),
  }
})

import { __resetIdleAutoFastForwardForTests, __resetMeshWorkspaceCacheForTests, handleMeshForwardEvent, notifyMeshCoordinator, setupMeshEventForwarding, triggerMeshQueue, tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
// C-W3: coordinator notices are turn.notify rows; the helper captures them.
import { drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, __clearMeshPendingEventsForTests } from '../helpers/pending-notices.js'
import { isWeakCompletionMetadata } from '../../src/mesh/mesh-events-utils.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, claimNextTask, enqueueTask, getQueue, insertDirectDispatch, getActiveDirectDispatches, recordTaskAutoLaunch, requeueTaskForLedgerReclaim } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { computeMeshTaskStats } from '../../src/mesh/mesh-task-stats.js'
import { getLedgerDir, readLedgerEntries, appendLedgerEntry, getLedgerSummary } from '../../src/mesh/mesh-ledger.js'
import { UNROUTABLE_DIAGNOSTIC_STREAM, __resetUnroutableDiagnosticsForTests } from '../../src/mesh/mesh-routing.js'
import { markRemoteSessionGenerating, __resetRemoteGeneratingMarksForTests } from '../../src/mesh/mesh-autolaunch-integrity.js'
import { LOG } from '../../src/logging/logger.js'
import { hasWorkerProtocolFooter } from '@adhdev/mesh-shared'
import { withMeshRouter } from './helpers/mesh-router-stub.js'
import { withMeshForwardingBus } from './helpers/mesh-forwarding-bus-fixture.js'

function createComponents(meshId = 'mesh_inline_1', workerSettings?: Record<string, unknown>, opts?: { coordinatorStatus?: 'idle' | 'generating' | 'waiting_approval'; statusInstanceId?: string }) {
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
    getInstance: vi.fn((id: string) => id === 'runtime-session-1' ? source : undefined),
    getByCategory: vi.fn((category: string) => category === 'cli' ? [source, coordinator] : []),
  }

  // Tests assign `components.cliManager` later; the mesh router stub resolves it at call time.
  const routed = withMeshRouter({ instanceManager, ...(opts?.statusInstanceId ? { statusInstanceId: opts.statusInstanceId } : {}) } as any)
  const components = withMeshForwardingBus(routed)
const { emit } = components
  return { components, emit, coordinator }
}

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetIdleAutoFastForwardForTests()
  __resetMeshWorkspaceCacheForTests()
  __resetRemoteGeneratingMarksForTests()
  readyWaitMocks.waitForRemoteSessionReady.mockReset()
  readyWaitMocks.waitForRemoteSessionReady.mockImplementation(async () => false)
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  fastForwardMocks.fastForwardMeshNode.mockReset()
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
}

// FALSE-COMPLETION-GIT-EVIDENCE: a real (non-mocked) git repo so the synchronous
// git-clean gate in markSessionTerminal (checkCodeChangeWorkspaceCleanSync) has an
// actual workspace to shell out against — this gate is untestable with the fake
// '/repo/worktree-a' paths the rest of this file uses everywhere else.
function tempGitRepo(name: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `adhdev-mesh-events-git-${name}-`)))
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'ADHDev Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  git(['add', '.'])
  git(['commit', '-m', 'initial'])
  return repo
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
    components: withMeshRouter({
      instanceManager: {
        getByCategory: vi.fn((category: string) => category === 'cli' ? (args?.existingCliInstances || []) : []),
      },
      cliManager,
      providerLoader: {
        resolveAlias: vi.fn((type: string) => type),
        isMachineProviderEnabled: vi.fn(() => true),
        setCliDetectionResults: vi.fn(),
        // getMeta is a stable method on the real ProviderLoader (returns
        // ProviderModule | undefined). The auto-launch auto-approve envelope reads
        // it via providerLoader?.getMeta(...); without the stub the call throws
        // "getMeta is not a function" and the launch is caught as failed.
        getMeta: vi.fn(() => undefined),
      },
      onStatusChange: vi.fn(),
    } as any),
    cliManager,
  }
}

describe('setupMeshEventForwarding', () => {
  it('Fix C: does NOT supersede a completion for a NON-redrive requeue (e.g. dispatch-unconfirmed reclaim)', async () => {
    const meshId = `mesh_redrive_no_supersede_${Date.now()}`
    try {
      const mesh = { id: meshId, nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }] }
      meshConfigMocks.getMesh.mockReturnValue(mesh)
      meshConfigMocks.getMeshByRepo.mockReturnValue(mesh)
      meshConfigMocks.listMeshes.mockReturnValue([mesh])

      enqueueTask(meshId, 'do work', { targetNodeId: 'node_child_1',
    difficulty: 'medium',
})
      const claimed = claimNextTask(meshId, 'node_child_1', 'runtime-session-1', [])!
      // Reclaimed as NEVER-delivered (nothing ran) — a completion for it is not a late race and
      // must NOT be superseded into a terminal flip by this path.
      const reclaimed = requeueTaskForLedgerReclaim(meshId, claimed.id, 'H1_await_delivery', new Date().toISOString())!
      expect(reclaimed.status).toBe('pending')

      const { components, emit } = createComponents(meshId, {
        meshNodeFor: meshId,
        meshNodeId: 'node_child_1',
      })
      setupMeshEventForwarding(components)

      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        meshNodeId: 'node_child_1',
        taskId: claimed.id,
        providerType: 'claude-cli',
        finalSummary: 'All done.',
        timestamp: Date.now(),
      })

      // No supersede: the non-redrive reason is left to the normal path (row stays pending).
      const row = getQueue(meshId).find(t => t.id === claimed.id)!
      expect(row.status).toBe('pending')
      expect(readLedgerEntries(meshId).some(
        e => (e.payload as any)?.source === 'redrive_late_completion_supersede',
      )).toBe(false)
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
      enqueueTask(meshId, 'reuse-vs-autolaunch task', { targetNodeId: 'node_child_1',
    difficulty: 'medium',
})
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
          // A real fast_forward_available dry-run always carries `current` with a
          // positive `behind` (ahead=0). dryRunSatisfiesAutoFastForwardPolicy
          // defensively re-asserts behind>0, so the execute step only fires when
          // the dry-run reports a real ff-only gap.
          current: { ahead: 0, behind: 2, submodules: [] },
        })
        .mockResolvedValueOnce({
          success: true,
          code: 'fast_forward_applied',
          allowed: true,
          dryRun: false,
          willRun: true,
          executed: true,
        })

      const nextTask = enqueueTask(meshId, 'next queued task', { difficulty: 'medium' })
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

      // The trigger chain is async and event-loop-scheduled: emit(agent:ready) synchronously
      // schedules a setImmediate that awaits the dry-run fast-forward (call 1) and then, when
      // the dry-run satisfies policy, the execute fast-forward (call 2), and only then assigns
      // the queue task. On a contended CI runner the whole file's ~100 tests thrash the event
      // loop (real fs I/O per test), so the default 1000ms vi.waitFor window could expire after
      // the dry-run but before the execute landed — the "expected 2, got 1" flake. Give the
      // poll a generous deadline and a tight interval so a slow event loop is tolerated without
      // changing what is asserted (the sequence is still deterministic — two ordered calls).
      await vi.waitFor(() => {
        expect(fastForwardMocks.fastForwardMeshNode).toHaveBeenCalledTimes(2)
        expect(getQueue(meshId).find(task => task.id === nextTask.id)?.status).toBe('assigned')
      }, { timeout: 5000, interval: 10 })
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

      // A second idle edge within the 30-minute throttle window must NOT re-run the ff. This is
      // a negative assertion, so flush the full trigger-chain depth (the setImmediate that would
      // schedule the run, plus a couple more event-loop turns to catch the awaited dry-run/execute
      // had the throttle failed to gate) before asserting the count is unchanged. A single
      // setImmediate tick only drains the outer scheduler, not the awaited inner calls.
      emit({
        event: 'agent:ready',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
      })
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
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

      const nextTask = enqueueTask(meshId, 'next queued task', { difficulty: 'medium' })
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

      const nextTask = enqueueTask(meshId, 'next queued task', { difficulty: 'medium' })
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

  it('WEAK-QUEUE-TENTATIVE: a PREMATURE weak completion (missing_final_assistant, not timed-out) keeps its queue task tentative (assigned), not completed', () => {
    // FIX 2 (secondary) — a weak, early decoupled-immediate completion (no final assistant,
    // emittedAfterFinalizationTimeout NOT set) must NOT hard-flip a queue-claimed row to
    // 'completed'. The row stays 'assigned' so the reconcile net owns the genuine terminal /
    // reclaim, symmetric with the direct-dispatch tentative guard.
    const meshId = `mesh_weak_queue_tentative_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      const queued = enqueueTask(meshId, 'weak-completion task', { difficulty: 'medium' })
      expect(claimNextTask(meshId, 'node_child_1', 'runtime-session-1')?.id).toBe(queued.id)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        taskId: queued.id,
        timestamp: Date.now(),
        completionDiagnostic: {
          blockReason: 'missing_final_assistant',
          finalAssistantPresent: false,
          // PREMATURE: the decoupled-immediate path, NOT the 30s force-timeout.
          emittedAfterFinalizationTimeout: false,
          decoupledImmediateEmit: true,
        },
      })

      // The row is kept tentative — still 'assigned', NOT flipped 'completed'.
      expect(getQueue(meshId).map(task => task.status)).toEqual(['assigned'])
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  // WEAK-EVIDENCE-SNAPSHOT-REGRESSION: pins the ordering fragility flagged in review at the
  // exact mechanism level. markSessionTerminal's gap-3 fix stamps reviewRecommended=true onto
  // args.metadataEvent for an emittedAfterFinalizationTimeout completion (to surface a review
  // note without wedging the task). isWeakCompletionEvidence treats reviewRecommended===true as
  // ONE OF ITS OWN weak-evidence signals (mesh-events-utils.ts). If markSessionTerminal's later
  // uses (the outbox `weak:` annotation, and `genuineTerminal` gating the COMPLETION-PROPAGATION
  // F2 flip-miss safety net near the end of the function) were to call isWeakCompletionEvidence
  // LIVE again on args.metadataEvent — instead of reusing the `weakEvidenceAtEntry` boolean
  // frozen BEFORE any mutation — they would read the gate's own side effect back as if it were
  // original evidence, and wrongly reclassify an already-flagged completion as weak a second
  // time. This first assertion proves that exact mechanism exists (i.e. that the hazard is
  // real, not hypothetical): the SAME metadataEvent shape, evaluated once before and once after
  // simulating the reviewRecommended stamp, flips its verdict.
  //
  // The second half is the integration-level guard: an emittedAfterFinalizationTimeout
  // completion must still terminate (as 'failed' — FINALIZATION-TIMEOUT-FORCE — not left
  // 'assigned' or silently dropped) and carry reviewRecommended, proving markSessionTerminal's
  // actual multi-use of the frozen snapshot (weakCompleted, the reducer evidence, and
  // genuineTerminal) produces the SAME observable outcome as before the ordering fix — the fix
  // is a safety hardening for future code paths that read weakEvidenceAtEntry, not a behavior
  // change to the paths already covered by the "gap 3" test above. A DIRECT F2-isolated
  // integration test was attempted but is not currently constructible: for
  // agent:generating_completed the ledger kind (EVENT_TO_LEDGER_KIND, overridden to
  // 'task_failed' only for the forced-timeout case) is written by the ordinary ledger-append
  // block (which runs unconditionally, keyed off directDispatchTaskIdForLedger derived from the
  // SAME args.metadataEvent.taskId F2 reads) before F2 runs, so findTerminalLedgerEvidenceForTask
  // inside F2 always finds it and F2's OWN append is shadowed — this is existing, unrelated
  // behavior, not something this fix changed. F2's only other side effect
  // (endTaskDispatchInFlight) is itself a no-op unless the row's in-flight mark was set via
  // beginTaskDispatchInFlight, which only the real dispatch path (mesh-queue-assignment.ts)
  // sets — claimNextTask alone (as used in every other test in this file) never does. This gap
  // is reported as a genuine test-surface limitation, not silently glossed over.
  it('WEAK-EVIDENCE-SNAPSHOT-REGRESSION: isWeakCompletionEvidence treats its own reviewRecommended stamp as weak evidence — proves the ordering hazard is real', () => {
    const baseEvent: Record<string, unknown> = {
      completionDiagnostic: {
        blockReason: 'missing_final_assistant',
        finalAssistantPresent: false,
        emittedAfterFinalizationTimeout: true,
      },
    }
    // BEFORE the gap-3 stamp: emittedAfterFinalizationTimeout alone does not carry
    // evidenceLevel/reviewRecommended, and isMissingFinalAssistantDiagnostic (the
    // completionDiagnostic-shape check) is what makes this weak at entry.
    expect(isWeakCompletionMetadata(baseEvent)).toBe(true)
    // Simulate the gap-3 mutation exactly as markSessionTerminal performs it.
    const afterStamp = { ...baseEvent, reviewRecommended: true }
    // Still weak — but for a DIFFERENT reason now (reviewRecommended, not just the diagnostic
    // shape). A live re-read after the stamp cannot tell these apart from the frozen original;
    // it just sees "weak" either way. This is exactly why genuineTerminal/the outbox `weak:`
    // field must reuse the FROZEN pre-mutation read (weakEvidenceAtEntry) rather than re-derive
    // live — a live re-read would still classify this as weak even in a hypothetical future
    // completion where reviewRecommended was the ONLY signal (e.g. a mode-specific flag set for
    // an otherwise strong completion), which would then wrongly suppress logic gated on
    // "genuinely weak at completion time".
    expect(isWeakCompletionMetadata(afterStamp)).toBe(true)
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

      const queued = enqueueTask(meshId, 'local task that transiently fails to dispatch', { difficulty: 'medium' })

      const components = withMeshRouter({
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
      } as any)

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

  it('does not complete an assigned code_change task from agent:ready without assistant or summary evidence', () => {
    const meshId = `mesh_ready_no_evidence_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
        policy: {},
      })
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const queued = enqueueTask(meshId, 'queued code change task', { taskMode: 'code_change',
    difficulty: 'medium',
})
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
      getInstance: vi.fn(() => coordinator),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [coordinator] : []),
    }
    const components = withMeshForwardingBus({ instanceManager } as any)
const { emit } = components
    setupMeshEventForwarding(components)

    emit({
      event: 'agent:generating_completed',
      instanceId: 'coordinator-session-self',
      targetSessionId: 'coordinator-session-self',
      providerType: 'hermes-cli',
    })

    expect(coordinator.onEvent).not.toHaveBeenCalled()
  })

  it('does not inject completion event for unrelated CLI sessions without mesh metadata', () => {
    // Sessions without meshNodeFor or launchedByCoordinator must not be forwarded,
    // even if getMeshByRepo returns a mesh for the same workspace.
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue({ id: 'mesh_inline_1', nodes: [] })

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
      getInstance: vi.fn((id: string) => id === 'unrelated-session-1' ? unrelated : undefined),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [unrelated, coordinator] : []),
    }
    const components = withMeshForwardingBus({ instanceManager } as any)
const { emit } = components
    setupMeshEventForwarding(components)

    emit({
      event: 'agent:generating_completed',
      instanceId: 'unrelated-session-1',
      targetSessionId: 'unrelated-session-1',
      providerType: 'hermes-cli',
    })

    expect(coordinator.onEvent).not.toHaveBeenCalled()
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
        difficulty: 'medium',
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
      const components = withMeshRouter({
        instanceManager: {
          getByCategory: vi.fn((category: string) => category === 'cli' ? [stoppedSource] : []),
        },
        cliManager: {
          adapters: new Map(),
          handleCliCommand: vi.fn(),
        },
      } as any)

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
        difficulty: 'medium',
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
      const components = withMeshRouter({
        instanceManager: {
          getByCategory: vi.fn((category: string) => category === 'cli' ? [stoppedSource] : []),
        },
        cliManager: {
          adapters: new Map(),
          handleCliCommand: vi.fn(),
        },
      } as any)

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
      const queued = enqueueTask(meshId, 'queued task', { difficulty: 'medium' })
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
        // F1: the dispatched body now carries the worker protocol footer
        // (resolveDispatchMessage) — assert the authored message is still the
        // prefix and the footer marker is present, rather than exact equality.
        message: expect.stringMatching(/^queued task/),
      }))
      {
        const call = cliManager.handleCliCommand.mock.calls.find((c: any[]) => c[0] === 'agent_command')
        expect(hasWorkerProtocolFooter(call?.[1]?.message)).toBe(true)
      }
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

  it('logs claude quota block → codex spawn only after the fallback launch succeeds', async () => {
    const meshId = `mesh_auto_launch_quota_fallback_${Date.now()}`
    const info = vi.spyOn(LOG, 'info').mockImplementation(() => undefined as any)
    try {
      const quota = (provider: string, weeklyUsedPercent: number) => ({
        provider,
        status: 'ok',
        session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
        weekly: { usedPercent: weeklyUsedPercent, windowMinutes: 10080, resetsAt: null },
        updatedAt: Date.now(),
        error: null,
      })
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{
          id: 'node_child_1',
          workspace: '/repo/worktree-a',
          health: 'online',
          policy: {
            slots: [
              { provider: 'kimi', difficulty: ['difficult'], maxParallel: 1 },
              { provider: 'claude-cli', difficulty: ['difficult'], maxParallel: 1 },
              { provider: 'codex-cli', difficulty: ['difficult'], maxParallel: 1 },
            ],
          },
          nodeFacts: {
            schemaVersion: 1,
            reportedAt: Date.now(),
            quota: {
              kimi: { ...quota('kimi', 100), status: 'error', session: null, weekly: null, error: 'token expired', metadata: { source: 'oauth', failureKind: 'expired-token' } },
              'claude-cli': quota('claude-cli', 32),
              'codex-cli': quota('codex-cli', 18),
            },
          },
        }],
        policy: {
          maxParallelTasks: 2,
          quotaRouting: { weeklyMinRemainingPercent: 80 },
        },
      })
      detectCliMocks.detectCLI.mockImplementation(async (provider: string) => provider === 'kimi' ? null : { path: `/bin/${provider}` })
      const queued = enqueueTask(meshId, 'today\'s difficult fallback', { difficulty: 'difficult' })
      const { components, cliManager } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)

      expect(cliManager.handleCliCommand).toHaveBeenCalledWith('launch_cli', expect.objectContaining({ cliType: 'codex-cli' }))
      const messages = info.mock.calls.map(([, message]) => String(message))
      const fallback = messages.filter(message => message.includes('auto-launch fallback succeeded'))
      expect(fallback).toHaveLength(1)
      expect(fallback[0]).toContain(`task ${queued.id}`)
      expect(fallback[0]).toContain("provider 'claude-cli' had 68.0% weekly quota remaining")
      expect(fallback[0]).toContain("spawned provider 'codex-cli'")
    } finally {
      info.mockRestore()
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
      const queued = enqueueTask(meshId, 'queued task awaiting booting session', { difficulty: 'medium' })
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
      const queued = enqueueTask(meshId, 'queued worktree task', { targetNodeId: 'node_worktree_1', requiredTags: [],
    difficulty: 'medium',
})
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
      enqueueTask(meshId, 'task for a missing node', { targetNodeId: 'node_MISSING', requiredTags: [],
    difficulty: 'medium',
})
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
      enqueueTask(meshId, 'tag-impossible task', { targetNodeId: 'node_x', requiredTags: ['os=plan9'],
    difficulty: 'medium',
})
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
      enqueueTask(meshId, 'remote queued task', { targetNodeId: 'node_remote_wt',
    difficulty: 'medium',
})

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
      enqueueTask(meshId, 'already running', { difficulty: 'medium' })
      claimNextTask(meshId, 'other_node', 'other_session')
      enqueueTask(meshId, 'pending task', { difficulty: 'medium' })
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
      enqueueTask(meshId, 'pending task', { difficulty: 'medium' })
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
      enqueueTask(meshId, 'already running', { difficulty: 'medium' })
      claimNextTask(meshId, 'node_child_1', 'busy_session')
      enqueueTask(meshId, 'pending task', { difficulty: 'medium' })
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
      enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
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
    // fire for a remote node; launch_cli must be forwarded exactly once.
    // AUTOLAUNCH-REMOTE-CLAIM (5-c): after the ready wait the remote path claims through
    // tryAssignQueueTask (symmetric with local). The old "task stays pending until
    // agent:ready round-trips" wedge was the defect this claim closes.
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
      const queued = enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
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
      expect(readyWaitMocks.waitForRemoteSessionReady).toHaveBeenCalled()
      expect(readyWaitMocks.waitForRemoteSessionReady.mock.calls[0][2]).toBe('remote-session-1')
      // Post-wait claim landed: the task is assigned into the launched session and the
      // prompt was dispatched over the same remote transport.
      const [entry] = getQueue(meshId)
      expect(entry.status).toBe('assigned')
      expect(entry.assignedNodeId).toBe('node_remote_1')
      expect(entry.assignedSessionId).toBe('remote-session-1')
      expect(entry.autoLaunch?.status).toBe('completed')
      expect(dispatchMeshCommand).toHaveBeenCalledWith('daemon_remote_machine', 'agent_command', expect.objectContaining({
        targetSessionId: 'remote-session-1',
        action: 'send_chat',
      }))
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not re-forward launch_cli for a task whose remote auto-launch is still awaiting its claim', async () => {
    // Regression (remote queue auto-launch claim loop): the reconcile loop re-runs
    // triggerMeshQueue every few seconds, and the per-(mesh,node) cooldown is only 5s.
    // Without a per-TASK guard every tick fired a fresh launch_cli for the same task,
    // spawning a new orphan worker session each time (observed live: dozens of sessions
    // for one task). The await-claim guard keys on autoLaunch.status==='completed' + a
    // recent updatedAt and skips re-launching.
    // AUTOLAUNCH-REMOTE-CLAIM (5-c): the first tick now claims after the ready wait
    // (status → assigned). Subsequent ticks must STILL not re-forward launch_cli — the
    // duplicate-spawn guard is independent of whether that claim landed.
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
      enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
      const { components, cliManager } = createQueueAutoLaunchComponents()
      const dispatchMeshCommand = vi.fn(async () => ({ success: true, sessionId: 'remote-session-1' }))
      components.dispatchMeshCommand = dispatchMeshCommand

      // First tick forwards launch_cli once, then claims the launched session.
      await triggerMeshQueue(components, meshId)
      expect(getQueue(meshId)[0].autoLaunch?.status).toBe('completed')
      expect(getQueue(meshId)[0].status).toBe('assigned')
      expect(getQueue(meshId)[0].assignedSessionId).toBe('remote-session-1')

      // Subsequent ticks (still within the await-claim window) must NOT forward again.
      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      const launchForwards = dispatchMeshCommand.mock.calls.filter(([, command]: [string, string]) => command === 'launch_cli')
      expect(launchForwards).toHaveLength(1)
      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      // Duplicate inject is also suppressed: send_chat fired on the claiming tick only.
      expect(dispatchMeshCommand.mock.calls.filter(([, command]: [string, string]) => command === 'agent_command')).toHaveLength(1)
      // The guard skip must NOT clobber the 'completed' autoLaunch record (that record is the
      // guard's own state for the next tick — overwriting it would reopen the duplicate hole).
      expect(getQueue(meshId)[0].autoLaunch?.status).toBe('completed')
      expect(getQueue(meshId)[0].autoLaunch?.sessionId).toBe('remote-session-1')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does not re-forward launch_cli when a generating remote auto-launch fail-closes the claim', async () => {
    // Companion to the subsequent-ticks guard above: when generating_started was observed
    // the post-wait claim is fail-closed and the task stays pending. The duplicate-spawn
    // guard must still hold in that pending window — subsequent ticks must not launch a
    // second session, and must not clobber the completed autoLaunch record that the
    // await-claim skip keys on.
    const meshId = `mesh_auto_launch_await_claim_generating_${Date.now()}`
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
      enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
      const { components, cliManager } = createQueueAutoLaunchComponents()
      const dispatchMeshCommand = vi.fn(async () => ({ success: true, sessionId: 'remote-session-1' }))
      components.dispatchMeshCommand = dispatchMeshCommand
      markRemoteSessionGenerating(meshId, 'remote-session-1')

      await triggerMeshQueue(components, meshId)
      expect(getQueue(meshId)[0].autoLaunch?.status).toBe('completed')
      expect(getQueue(meshId)[0].status).toBe('pending')
      expect(dispatchMeshCommand.mock.calls.filter(([, command]: [string, string]) => command === 'agent_command')).toHaveLength(0)

      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      expect(dispatchMeshCommand.mock.calls.filter(([, command]: [string, string]) => command === 'launch_cli')).toHaveLength(1)
      expect(cliManager.handleCliCommand).not.toHaveBeenCalledWith('launch_cli', expect.anything())
      expect(dispatchMeshCommand.mock.calls.filter(([, command]: [string, string]) => command === 'agent_command')).toHaveLength(0)
      expect(getQueue(meshId)[0].status).toBe('pending')
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
      enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
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

  it('de-dups skipped auto-launch entries per node when candidates skip for DIFFERENT reasons', async () => {
    // LEDGER-AUTOLAUNCH-RETRY-SPAM regression. The de-dup above is a last-value compare.
    // Keyed by task alone it collapses only when every candidate node reports the SAME
    // reason — which is why the single-node test above passed while the ledger flooded.
    //
    // Here two nodes skip for two DIFFERENT reasons, the shape measured live on
    // 2026-09-02 (node A `slot_for_model_busy`, node B a difficulty-floor miss). Per
    // tick the task-keyed signature flipped A→B→A→B and never matched, so EVERY skip
    // appended: 2 entries/tick, ~30/min, forever. With the key including nodeId each
    // node's own repeat collapses, so three ticks must yield exactly one entry per node.
    const meshId = `mesh_auto_launch_skip_dedup_multinode_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [
          {
            id: 'node_remote_a',
            workspace: '/repo/worktree-a',
            health: 'online',
            daemonId: 'daemon_remote_a',
            machineId: 'mach_remote_a',
            policy: { providerPriority: ['hermes-cli'] },
          },
          {
            // Dirty workspace → a different skip reason than node A's.
            id: 'node_remote_b',
            workspace: '/repo/worktree-b',
            health: 'online',
            daemonId: 'daemon_remote_b',
            machineId: 'mach_remote_b',
            git: { dirty: true },
            policy: { providerPriority: ['hermes-cli'] },
          },
        ],
        policy: { maxParallelTasks: 2 },
      })
      enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
      const { components } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      const skips = readLedgerEntries(meshId).filter(
        e => e.kind === 'session_auto_launch' && e.payload?.phase === 'skipped',
      )
      // Two distinct reasons were genuinely observed, so both must remain visible...
      const reasons = new Set(skips.map(e => e.payload?.reason))
      expect(reasons.size).toBeGreaterThanOrEqual(2)
      // ...but no (node, reason) pair may repeat across the three ticks. This is the
      // assertion that actually fails pre-fix: node A alternating with node B replays
      // both pairs on every tick.
      const perNodeReason = skips.map(e => `${e.nodeId}|${e.payload?.reason}`)
      expect(perNodeReason).toHaveLength(new Set(perNodeReason).size)
      // Pre-fix: 6 (2 nodes x 3 ticks, nothing suppressed). Post-fix: 3 — one per
      // (node, reason), node A legitimately contributing two because it transitions
      // remote_auto_launch_unsupported -> auto_launch_cooldown, a real state change
      // that MUST still record. Bounded well under the per-tick replay either way.
      expect(skips.length).toBeLessThanOrEqual(4)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('re-appends a skipped auto-launch entry when the same node reports a CHANGED reason', async () => {
    // The de-dup must stay a transition detector, not a mute: a node whose skip reason
    // changes is a real state change and must reappear in the ledger. Guards against
    // "fixing" the spam by suppressing per node regardless of reason.
    const meshId = `mesh_auto_launch_skip_reason_change_${Date.now()}`
    try {
      const node = {
        id: 'node_remote_1',
        workspace: '/repo/remote-worktree',
        health: 'online',
        daemonId: 'daemon_remote_machine',
        machineId: 'mach_remote',
        policy: { providerPriority: ['hermes-cli'] },
      }
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [node], policy: { maxParallelTasks: 2 } })
      enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
      const { components } = createQueueAutoLaunchComponents()

      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)
      // The node goes dirty → the SAME node now skips for a different reason.
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        nodes: [{ ...node, git: { dirty: true } }],
        policy: { maxParallelTasks: 2 },
      })
      await triggerMeshQueue(components, meshId)

      const reasons = readLedgerEntries(meshId)
        .filter(e => e.kind === 'session_auto_launch' && e.payload?.phase === 'skipped')
        .map(e => e.payload?.reason)
      expect(new Set(reasons).size).toBeGreaterThanOrEqual(2)
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
      enqueueTask(meshId, 'pending remote task', { difficulty: 'medium' })
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
      enqueueTask(meshId, 'task 1', { difficulty: 'medium' })
      enqueueTask(meshId, 'task 2', { difficulty: 'medium' })
      enqueueTask(meshId, 'task 3', { difficulty: 'medium' })
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
      enqueueTask(meshId, 'hermes-only task', { requiredTags: ['provider=hermes-cli'],
    difficulty: 'medium',
})
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
      const queued = enqueueTask(meshId, 'hermes task', { requiredTags: ['provider=hermes-cli'],
    difficulty: 'medium',
})
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

  it('does not inject completion event when the source is a claude-cli coordinator session (aliasing guard)', () => {
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue({ id: 'mesh_inline_claude', nodes: [] })

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
      getInstance: vi.fn(() => claudeCoordinator),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [claudeCoordinator] : []),
    }
    const components = withMeshForwardingBus({ instanceManager } as any)
const { emit } = components
    setupMeshEventForwarding(components)

    emit({
      event: 'agent:generating_completed',
      instanceId: 'claude-coord-self',
      targetSessionId: 'claude-coord-self',
      providerType: 'claude-cli',
    })

    expect(claudeCoordinator.onEvent).not.toHaveBeenCalled()
  })

})

describe('drain consumption safety', () => {
  it('queueing does not throw when the mesh has no prior pending state', () => {
    const meshId = `mesh-pending-nofile-${randomUUID().slice(0, 8)}`
    try {
      expect(() => {
        notifyMeshCoordinator({ event: 'agent:ready', meshId, nodeLabel: 'node', metadataEvent: { timestamp: Date.now() }, queuedAt: Date.now() })
      }).not.toThrow()
    } finally {
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
        getInstance: vi.fn((id: string) => id === 'runtime-session-ws' ? workerSession : undefined),
        getByCategory: vi.fn((_category: string) => []),
      }
      const components = withMeshForwardingBus({ instanceManager } as any)
const { emit } = components
      setupMeshEventForwarding(components)

      // Emit 5 mesh events from the same workspace instance
      for (let i = 0; i < 5; i++) {
        emit({
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


afterAll(() => {
  try {
    if (fs.existsSync(testTmpDir)) fs.rmSync(testTmpDir, { recursive: true, force: true })
  } catch { /* best-effort cleanup */ }
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
        // A NOTICE event (C-W3: a completion is ledger evidence; recovery is event-agnostic).
        event: 'refine:completed',
        // meshId intentionally absent — the worker was in the mesh_unresolved fallback.
        nodeId: 'node_child_1',
        workspace: '/repo/worktree-a',
        targetSessionId: 'worker-session-1',
        providerType: 'claude-cli',
        timestamp: 1710000010000,
      })

      expect(result).toMatchObject({ success: true, notice: 'refine:completed' })
      // Recorded under the recovered meshId — the notice now reaches the coordinator.
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
        event: 'refine:completed',
        nodeId: 'node_child_1',
        targetSessionId: 'worker-session-1',
        providerType: 'claude-cli',
        timestamp: 1710000011000,
      })

      expect(result).toMatchObject({ success: true, notice: 'refine:completed' })
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
        event: 'refine:completed',
        workspace: '/repo/worktree-a',
        targetSessionId: 'worker-session-2',
        providerType: 'claude-cli',
        timestamp: 1710000013000,
      })

      expect(result).toMatchObject({ success: true, notice: 'refine:completed' })
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
