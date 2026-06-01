import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
}))

const detectCliMocks = vi.hoisted(() => ({
  detectCLI: vi.fn(),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
}))

vi.mock('../../src/detection/cli-detector.js', () => ({
  detectCLI: detectCliMocks.detectCLI,
}))

import { drainPendingMeshCoordinatorEvents, handleMeshForwardEvent, queuePendingMeshCoordinatorEvent, setupMeshEventForwarding, triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetBeadsDBForTests, claimNextTask, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, readLedgerEntries, appendLedgerEntry, getLedgerSummary } from '../../src/mesh/mesh-ledger.js'

function createComponents(meshId = 'mesh_inline_1') {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: 'runtime-session-1',
    workspace: '/repo/worktree-a',
    settings: {
      meshNodeFor: meshId,
      meshNodeId: 'node_child_1',
    },
  }
  const coordinatorState = {
    instanceId: 'coordinator-session-1',
    workspace: '/repo/main',
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
  __resetBeadsDBForTests()
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
  it('forwards delegated completion to the matching coordinator using runtime mesh settings without local mesh config', () => {
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

  it('buffers delegated completion events for MCP coordinators even when a CLI coordinator is present', () => {
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

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      emit({
        event: 'agent:generating_completed',
        instanceId: 'runtime-session-1',
        targetSessionId: 'runtime-session-1',
        providerType: 'codex-cli',
        providerSessionId: 'codex-history-1',
        finalSummary: 'done',
        timestamp: 12345,
      })
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        event: 'agent:generating_completed',
        meshId,
        nodeId: 'node_child_1',
        metadataEvent: {
          targetSessionId: 'runtime-session-1',
          providerType: 'codex-cli',
          providerSessionId: 'codex-history-1',
          finalSummary: 'done',
        },
      })
      expect(pending[0].coordinatorMessage).toContain('has completed its task')
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

  it('records a second task_completed for same-session continuations after an earlier completion', () => {
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

  it('injects forwarded stopped and long-generating coordinator hints from remote worker daemons', () => {
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

    expect(stopped).toEqual({ success: true, forwarded: 1 })
    expect(longGenerating).toEqual({ success: true, forwarded: 1 })
    expect(coordinator.onEvent).toHaveBeenCalledTimes(2)
    expect(coordinator.onEvent.mock.calls[0][1].input.textFallback).toContain('has stopped')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).toContain('still reported as generating')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).toContain('one bounded status check')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).not.toContain('mesh_read_chat once')
    cleanupMeshFiles(meshId)
  })

  it('reconciles a long-generating monitor to completion when final summary evidence exists', () => {
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

      expect(result).toEqual({ success: true, forwarded: 1 })
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

  it('suppresses duplicate completion replays from relay/backfill paths for the same logical event', () => {
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
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(duplicate).toMatchObject({ success: true, forwarded: 0, suppressed: true, duplicateCompletion: true })
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

  it('buffers refine:completed to pending events when CLI coordinator is generating', () => {
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

      // When coordinator is generating, do NOT inject via send_message — only buffer to pending queue.
      // Injecting into a generating PTY corrupts the input stream and leaves Codex stuck generating.
      expect(result).toMatchObject({ success: true, forwarded: 0, bufferedForGeneratingCoordinator: true })
      expect(coordinator.onEvent).not.toHaveBeenCalled()

      // Terminal event must be in pending queue so coordinator can drain it via get_pending_mesh_events
      // once it returns to idle after its current generation turn.
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        event: 'refine:completed',
        meshId,
        nodeId: 'node-worktree',
      })
      expect(pending[0].coordinatorMessage).toContain('completed successfully')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('buffers refine:failed to pending events when CLI coordinator is generating', () => {
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

      // When coordinator is generating, do NOT inject via send_message — only buffer to pending queue.
      expect(result).toMatchObject({ success: true, forwarded: 0, bufferedForGeneratingCoordinator: true })
      expect(coordinator.onEvent).not.toHaveBeenCalled()

      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        event: 'refine:failed',
        meshId,
      })
      expect(pending[0].coordinatorMessage).toContain('failed')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT buffer refine:completed to pending events when CLI coordinator is idle (normal path)', () => {
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

      expect(result).toMatchObject({ success: true, forwarded: 1 })
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)

      // Idle coordinator receives directly — should NOT buffer to pending queue
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('buffers refine:accepted to pending events whether coordinator is generating or idle (non-terminal event dual delivery)', () => {
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

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      // Non-terminal events always buffer for MCP dual delivery
      const pending = drainPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(1)
      expect(pending[0].event).toBe('refine:accepted')
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

  it('routes worker completion events to a claude-cli coordinator session (not just codex/hermes)', () => {
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

  it('routes pending buffered coordinator events to a claude-cli coordinator via handleMeshForwardEvent', () => {
    const meshId = `mesh_claude_forward_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue(undefined)
      meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)

      const claudeCoordinatorState = {
        instanceId: 'claude-coordinator-fwd',
        workspace: '/repo/main',
        type: 'claude-cli',
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

      expect(result).toEqual({ success: true, forwarded: 1 })
      expect(claudeCoordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = claudeCoordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.input.textFallback).toContain('has stopped')
    } finally {
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
