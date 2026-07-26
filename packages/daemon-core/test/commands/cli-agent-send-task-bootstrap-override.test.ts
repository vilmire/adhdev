import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// BOOTSTRAP-POLICY-CONSISTENCY (Fix B, rc.15 orchestration RCA): the explicit mesh_send_task
// dispatch path (agent_command 'send_chat', med-family/cli-agent.ts) defers when the target
// node's worktreeBootstrap.status is 'running' — but that node-level flag is COARSE and can be
// stale. When the caller pinned a specific target session that is independently re-confirmed
// idle/ready right now (the same isIdleSessionState liveness probe the queue-assignment gate
// uses), the defer is a false block and must be overridden — narrowly, for that one dispatch.
// A session that is starting / generating / waiting_approval / anything non-idle must NOT
// qualify for the override.

const testTmpDir = path.join(tmpdir(), `adhdev-send-task-bootstrap-override-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
}))

import { cliAgentHandlers } from '../../src/commands/med-family/cli-agent.js'

const MESH_ID = 'mesh_send_task_override'
const NODE_ID = 'node_worktree_bootstrapping'
const SESSION_ID = 'target-session-1'

function makeCtx(opts: { sessionState?: Record<string, unknown>; worktreeBootstrapStatus?: string }) {
  const cliManagerHandleCliCommand = vi.fn(async () => ({ success: true, dispatched: true }))
  const instance = opts.sessionState
    ? { getState: () => opts.sessionState, updateSettings: vi.fn() }
    : undefined
  return {
    deps: {
      instanceManager: {
        getInstance: vi.fn((id: string) => (id === SESSION_ID ? instance : undefined)),
      },
      cliManager: { handleCliCommand: cliManagerHandleCliCommand },
    },
    getCachedInlineMesh: vi.fn(() => ({
      id: MESH_ID,
      nodes: [{
        id: NODE_ID,
        ...(opts.worktreeBootstrapStatus
          ? { worktreeBootstrap: { status: opts.worktreeBootstrapStatus, updatedAt: new Date().toISOString() } }
          : {}),
      }],
    })),
  } as any
}

function sendTaskArgs(overrides: Record<string, unknown> = {}) {
  return {
    action: 'send_chat',
    targetSessionId: SESSION_ID,
    meshContext: { meshId: MESH_ID, nodeId: NODE_ID, taskId: 'task-1' },
    ...overrides,
  }
}

describe('BOOTSTRAP-POLICY-CONSISTENCY — mesh_send_task session-aware override of the bootstrap defer', () => {
  it('refuses (defers) dispatch to a running-bootstrap node when NO target session is pinned', async () => {
    const ctx = makeCtx({ worktreeBootstrapStatus: 'running' })
    const result: any = await cliAgentHandlers.agent_command(ctx, sendTaskArgs({ targetSessionId: undefined }))

    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_node_bootstrap_pending')
    expect(ctx.deps.cliManager.handleCliCommand).not.toHaveBeenCalled()
  })

  it('refuses (defers) dispatch when the pinned target session is UNREADY (starting)', async () => {
    const ctx = makeCtx({
      worktreeBootstrapStatus: 'running',
      sessionState: { instanceId: SESSION_ID, status: 'starting', settings: {} },
    })
    const result: any = await cliAgentHandlers.agent_command(ctx, sendTaskArgs())

    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_node_bootstrap_pending')
    expect(ctx.deps.cliManager.handleCliCommand).not.toHaveBeenCalled()
  })

  it('refuses (defers) dispatch when the pinned target session is at a modal (waiting_approval)', async () => {
    const ctx = makeCtx({
      worktreeBootstrapStatus: 'running',
      sessionState: { instanceId: SESSION_ID, status: 'waiting_approval', settings: {} },
    })
    const result: any = await cliAgentHandlers.agent_command(ctx, sendTaskArgs())

    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_node_bootstrap_pending')
    expect(ctx.deps.cliManager.handleCliCommand).not.toHaveBeenCalled()
  })

  it('refuses (defers) dispatch when the pinned target session is generating (busy, not ready)', async () => {
    const ctx = makeCtx({
      worktreeBootstrapStatus: 'running',
      sessionState: { instanceId: SESSION_ID, status: 'generating', settings: {} },
    })
    const result: any = await cliAgentHandlers.agent_command(ctx, sendTaskArgs())

    expect(result.success).toBe(false)
    expect(result.code).toBe('mesh_node_bootstrap_pending')
    expect(ctx.deps.cliManager.handleCliCommand).not.toHaveBeenCalled()
  })

  it('OVERRIDES the defer when the pinned target session is independently confirmed idle/ready', async () => {
    const ctx = makeCtx({
      worktreeBootstrapStatus: 'running',
      sessionState: { instanceId: SESSION_ID, status: 'idle', settings: {} },
    })
    const result: any = await cliAgentHandlers.agent_command(ctx, sendTaskArgs())

    // No false block — the dispatch proceeds to cliManager.handleCliCommand.
    expect(result.code).not.toBe('mesh_node_bootstrap_pending')
    expect(ctx.deps.cliManager.handleCliCommand).toHaveBeenCalledWith('agent_command', expect.anything())
  })

  it('regression: dispatch proceeds normally when the node is NOT mid-bootstrap, regardless of session status', async () => {
    const ctx = makeCtx({
      sessionState: { instanceId: SESSION_ID, status: 'generating', settings: {} },
    })
    const result: any = await cliAgentHandlers.agent_command(ctx, sendTaskArgs())

    expect(result.code).not.toBe('mesh_node_bootstrap_pending')
    expect(ctx.deps.cliManager.handleCliCommand).toHaveBeenCalledWith('agent_command', expect.anything())
  })
})
