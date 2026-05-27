import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

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

import { drainPendingMeshCoordinatorEvents, handleMeshForwardEvent, setupMeshEventForwarding, triggerMeshQueue } from '../../src/mesh/mesh-events.js'
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
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
    const { components, emit, coordinator } = createComponents()

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
    const { components, coordinator } = createComponents()

    const stopped = handleMeshForwardEvent(components, {
      event: 'agent:stopped',
      meshId: 'mesh_inline_1',
      nodeId: 'node_child_1',
      targetSessionId: 'runtime-session-1',
      providerType: 'hermes-cli',
    })
    const longGenerating = handleMeshForwardEvent(components, {
      event: 'monitor:long_generating',
      meshId: 'mesh_inline_1',
      nodeId: 'node_child_1',
      targetSessionId: 'runtime-session-1',
      providerType: 'hermes-cli',
    })

    expect(stopped).toEqual({ success: true, forwarded: 1 })
    expect(longGenerating).toEqual({ success: true, forwarded: 1 })
    expect(coordinator.onEvent).toHaveBeenCalledTimes(2)
    expect(coordinator.onEvent.mock.calls[0][1].input.textFallback).toContain('has stopped')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).toContain('has been generating for a long time')
    expect(coordinator.onEvent.mock.calls[1][1].input.textFallback).toContain('mesh_read_chat once')
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
