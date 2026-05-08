import { describe, expect, it, vi } from 'vitest'
import { DaemonCommandRouter } from '../../src/commands/router'

function createRouter(overrides: Record<string, unknown> = {}) {
  const sessionHostControl = {
    listSessions: vi.fn(async () => []),
    stopSession: vi.fn(async (sessionId: string) => ({ sessionId })),
    deleteSession: vi.fn(async (sessionId: string) => ({ sessionId, deleted: true })),
    getDiagnostics: vi.fn(async () => ({})),
    resumeSession: vi.fn(async (sessionId: string) => ({ sessionId })),
    restartSession: vi.fn(async (sessionId: string) => ({ sessionId })),
    sendSignal: vi.fn(async (sessionId: string) => ({ sessionId })),
    forceDetachClient: vi.fn(async (sessionId: string) => ({ sessionId })),
    pruneDuplicateSessions: vi.fn(async () => ({ prunedSessionIds: [] })),
    acquireWrite: vi.fn(async () => ({ sessionId: 'session-write' })),
    releaseWrite: vi.fn(async () => ({ sessionId: 'session-release' })),
    ...overrides,
  }

  const router = new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: sessionHostControl as any,
  })

  return { router, sessionHostControl }
}

describe('mesh session cleanup', () => {
  it('deletes only completed sessions for the target node workspace by default-safe mode', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'done-1', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
        { sessionId: 'failed-1', workspace: '/repo/worktree-a', lifecycle: 'failed' },
        { sessionId: 'running-1', workspace: '/repo/worktree-a', lifecycle: 'running' },
        { sessionId: 'other-1', workspace: '/repo/other', lifecycle: 'stopped' },
      ]),
    })

    const result = await router.execute('cleanup_mesh_sessions', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      mode: 'delete_stopped',
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      mode: 'delete_stopped',
      matchedCount: 3,
      deletedSessionIds: ['done-1', 'failed-1'],
      skippedSessionIds: ['running-1'],
    })
    expect(sessionHostControl.deleteSession).toHaveBeenCalledTimes(2)
    expect(sessionHostControl.deleteSession).toHaveBeenNthCalledWith(1, 'done-1', { force: false })
    expect(sessionHostControl.deleteSession).toHaveBeenNthCalledWith(2, 'failed-1', { force: false })
    expect(sessionHostControl.stopSession).not.toHaveBeenCalled()
  })

  it('falls back to stopping live sessions when delete_session is unsupported by an older session host', async () => {
    const unsupported = new Error('Unsupported session host request: delete_session')
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'running-1', workspace: '/repo/worktree-a', lifecycle: 'running' },
        { sessionId: 'done-1', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
      ]),
      deleteSession: vi.fn(async () => { throw unsupported }),
    })

    const result = await router.execute('cleanup_mesh_sessions', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      mode: 'stop_and_delete',
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: {},
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      mode: 'stop_and_delete',
      matchedCount: 2,
      stoppedSessionIds: ['running-1'],
      deletedSessionIds: [],
      skippedSessionIds: ['running-1', 'done-1'],
      deleteUnsupportedSessionIds: ['running-1', 'done-1'],
    })
    expect(sessionHostControl.deleteSession).toHaveBeenCalledTimes(2)
    expect(sessionHostControl.stopSession).toHaveBeenCalledTimes(1)
    expect(sessionHostControl.stopSession).toHaveBeenCalledWith('running-1')
  })

  it('applies mesh policy cleanup before removing a node', async () => {
    const { router, sessionHostControl } = createRouter({
      listSessions: vi.fn(async () => [
        { sessionId: 'done-1', workspace: '/repo/worktree-a', lifecycle: 'stopped' },
      ]),
    })

    const result = await router.execute('remove_mesh_node', {
      meshId: 'mesh-1',
      nodeId: 'node-a',
      inlineMesh: {
        id: 'mesh-1',
        name: 'Mesh',
        policy: { sessionCleanupOnNodeRemove: 'delete_stopped' },
        nodes: [{ id: 'node-a', workspace: '/repo/worktree-a' }],
      },
    })

    expect(result).toMatchObject({
      success: true,
      removed: true,
      sessionCleanup: {
        mode: 'delete_stopped',
        deletedSessionIds: ['done-1'],
      },
    })
    expect(sessionHostControl.deleteSession).toHaveBeenCalledWith('done-1', { force: false })
  })
})
