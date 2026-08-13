import { describe, expect, it, vi } from 'vitest'

import { fastForwardHandlers } from '../../src/commands/med-family/fast-forward'
import { cliAgentHandlers } from '../../src/commands/med-family/cli-agent'
import { enqueueTask, validateMeshTaskModeRequest } from '../../src/mesh/mesh-work-queue'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'

/**
 * Regression tests for the three "mesh tool rough" defects:
 *
 *  (1) mesh_fast_forward_node on a win32 daemon threw out of the safety-gate
 *      evaluation (mesh resolution / git status fan-out) and the router re-threw,
 *      surfacing an opaque "Daemon IPC command failed" instead of the structured
 *      blockingReasons a mac node returns. The handler now catches and returns a
 *      blocked result.
 *
 *  (2a) mesh_send_task issued immediately after mesh_launch_session injected into a
 *      session whose worktree bootstrap was still running; the prompt landed in the
 *      input buffer but the provider was not yet ready, so it was silently lost. The
 *      agent_command handler now DEFERS the send_chat with a recoverable
 *      mesh_node_bootstrap_pending result instead of injecting.
 *
 *  (2b) mesh_send_task without task_mode must not crash with
 *      "Cannot read properties of undefined (reading 'trim')". The task-mode arg
 *      handling is undefined-safe end to end.
 */

function makeMedCtx(overrides: Partial<any> = {}): any {
  return {
    deps: {
      statusInstanceId: 'daemon_mach_self',
      // No dispatchMeshCommand → local execution path.
      cliManager: { handleCliCommand: vi.fn(async () => ({ success: true })) },
      instanceManager: { getInstance: () => null },
    },
    getMeshForCommand: vi.fn(async () => null),
    getCachedInlineMesh: vi.fn(() => undefined),
    ...overrides,
  }
}

describe('(1) fast_forward_mesh_node safety-gate never escapes as an IPC crash', () => {
  it('returns a structured blocked result when the mesh-resolution / git gate throws', async () => {
    // Simulate the win32 throw: the safety-gate evaluation (getMeshForCommand →
    // git status / stash / submodule fan-out) raises before fastForwardMeshNode's
    // own guarded body runs.
    const ctx = makeMedCtx({
      getMeshForCommand: vi.fn(async () => {
        throw new Error('win32 git safety-gate exploded (stash/submodule fan-out)')
      }),
    })

    const result: any = await fastForwardHandlers.fast_forward_mesh_node(ctx, {
      meshId: 'mesh-win',
      nodeId: 'node-win',
      workspace: 'C:/Users/dev/repo',
      dryRun: true,
    })

    // Must be a structured failure with blockingReasons, NOT a thrown exception.
    expect(result).toBeDefined()
    expect(result.success).toBe(false)
    expect(result.code).toBe('fast_forward_safety_gate_error')
    expect(result.allowed).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.blockingReasons).toContain('fast_forward_safety_gate_error')
    expect(result.workspace).toBe('C:/Users/dev/repo')
    expect(typeof result.operationError).toBe('string')
    expect(result.operationError).toMatch(/win32 git safety-gate/)
  })
})

describe('(2a) agent_command defers send_chat while node worktree bootstrap is running', () => {
  it('refuses the inject with a recoverable mesh_node_bootstrap_pending result and does not dispatch', async () => {
    const handleCliCommand = vi.fn(async () => ({ success: true }))
    const ctx = makeMedCtx({
      deps: {
        statusInstanceId: 'daemon_mach_self',
        cliManager: { handleCliCommand },
        instanceManager: { getInstance: () => null },
      },
      getCachedInlineMesh: vi.fn(() => ({
        id: 'mesh-bootstrap',
        nodes: [{ id: 'node-booting', worktreeBootstrap: { status: 'running' } }],
      })),
    })

    const result: any = await cliAgentHandlers.agent_command(ctx, {
      agentType: 'claude-code',
      action: 'send_chat',
      message: 'do the work',
      meshContext: { meshId: 'mesh-bootstrap', nodeId: 'node-booting', taskId: 'task-1' },
    })

    expect(result).toMatchObject({
      success: false,
      recoverable: true,
      dispatched: false,
      code: 'mesh_node_bootstrap_pending',
      reason: 'bootstrap_still_running',
      nodeId: 'node-booting',
      taskId: 'task-1',
    })
    // The inject must NOT have been forwarded to the CLI manager — the gap this fix closes.
    expect(handleCliCommand).not.toHaveBeenCalled()
  })

  it('dispatches normally when the node bootstrap is already complete', async () => {
    const handleCliCommand = vi.fn(async () => ({ success: true, status: 'generating' }))
    const ctx = makeMedCtx({
      deps: {
        statusInstanceId: 'daemon_mach_self',
        cliManager: { handleCliCommand },
        instanceManager: { getInstance: () => null },
      },
      getCachedInlineMesh: vi.fn(() => ({
        id: 'mesh-ready',
        nodes: [{ id: 'node-ready', worktreeBootstrap: { status: 'complete' } }],
      })),
    })

    const result: any = await cliAgentHandlers.agent_command(ctx, {
      agentType: 'claude-code',
      action: 'send_chat',
      message: 'do the work',
      meshContext: { meshId: 'mesh-ready', nodeId: 'node-ready' },
    })

    expect(handleCliCommand).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true })
  })
})

describe('(2b) task_mode is undefined-safe end to end', () => {
  it('validateMeshTaskModeRequest does not crash when task_mode is undefined', () => {
    expect(() => validateMeshTaskModeRequest(undefined, 'a task with no mode')).not.toThrow()
    const result = validateMeshTaskModeRequest(undefined, 'a task with no mode')
    expect(result.valid).toBe(true)
    expect(result.taskMode).toBeUndefined()
  })

  it('enqueueTask does not crash when no taskMode option is supplied', () => {
    const meshId = 'mesh-no-taskmode'
    try {
      const task = enqueueTask(meshId, 'untargeted task without task_mode', {
        targetNodeId: 'node-x',
        difficulty: 'medium',
      })
      expect(task).toBeDefined()
      expect(task.message).toBe('untargeted task without task_mode')
      expect(task.taskMode).toBeUndefined()
    } finally {
      // Keep the in-memory runtime store clean for sibling tests.
      MeshRuntimeStore.getInstance().replaceQueue(meshId, [])
    }
  })
})
