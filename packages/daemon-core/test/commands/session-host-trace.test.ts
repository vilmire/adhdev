import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonCommandRouter } from '../../src/commands/router'
import { clearDebugTrace, configureDebugTraceStore, getRecentDebugTrace } from '../../src/logging/debug-trace'
import { resetDebugRuntimeConfig, setDebugRuntimeConfig } from '../../src/logging/debug-config'

function createRouter(overrides: Record<string, unknown> = {}) {
  const sessionHostControl = {
    getDiagnostics: vi.fn(async () => ({})),
    listSessions: vi.fn(async () => []),
    stopSession: vi.fn(async () => ({ sessionId: 'session-stop' })),
    resumeSession: vi.fn(async (sessionId: string) => ({
      sessionId,
      providerType: 'codex',
      workspace: '/tmp/workspace',
      meta: { providerSessionId: 'provider-session-1' },
    })),
    restartSession: vi.fn(async () => ({ sessionId: 'session-restart' })),
    sendSignal: vi.fn(async () => ({ sessionId: 'session-signal' })),
    forceDetachClient: vi.fn(async () => ({ sessionId: 'session-detach' })),
    pruneDuplicateSessions: vi.fn(async () => ({ prunedSessionIds: [] })),
    acquireWrite: vi.fn(async () => ({ sessionId: 'session-write' })),
    releaseWrite: vi.fn(async () => ({ sessionId: 'session-release' })),
    ...overrides,
  }

  const cliManager = {
    restoreHostedSessions: vi.fn(async () => {}),
  }

  const router = new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: cliManager as any,
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

  return { router, cliManager, sessionHostControl }
}

describe('session-host structured trace', () => {
  beforeEach(() => {
    setDebugRuntimeConfig({
      logLevel: 'debug',
      collectDebugTrace: true,
      traceContent: true,
      traceBufferSize: 100,
      traceCategories: [],
    })
    configureDebugTraceStore()
    clearDebugTrace()
  })

  afterEach(() => {
    clearDebugTrace()
    resetDebugRuntimeConfig()
    configureDebugTraceStore()
  })

  it('records requested and successful session-host action traces', async () => {
    const { router, cliManager } = createRouter()

    const result = await router.execute('session_host_resume_session', { sessionId: 'session-1' })

    expect(result.success).toBe(true)
    expect(cliManager.restoreHostedSessions).toHaveBeenCalledTimes(1)
    const trace = getRecentDebugTrace({ category: 'session_host', limit: 10 })
    expect(trace.map(entry => entry.stage)).toEqual(['action_requested', 'action_result'])
    expect(trace[0]?.payload).toMatchObject({ action: 'session_host_resume_session', sessionId: 'session-1' })
    expect(trace[1]?.payload).toMatchObject({
      action: 'session_host_resume_session',
      sessionId: 'session-1',
      success: true,
      surfaceKind: 'inactive_record',
      restoredHostedSession: true,
    })
  })

  it('records classification counts for diagnostics responses', async () => {
    const { router } = createRouter({
      getDiagnostics: vi.fn(async () => ({
        runtimeCount: 1,
        sessions: [
          { sessionId: 'live-1', lifecycle: 'running', meta: {} },
          { sessionId: 'recovery-1', lifecycle: 'stopped', meta: { restoredFromStorage: true } },
          { sessionId: 'inactive-1', lifecycle: 'stopped', meta: {} },
        ],
      })),
    })

    const result = await router.execute('session_host_get_diagnostics', { includeSessions: true })

    expect(result.success).toBe(true)
    const trace = getRecentDebugTrace({ category: 'session_host', limit: 10 })
    expect(trace[1]?.payload).toMatchObject({
      action: 'session_host_get_diagnostics',
      runtimeCount: 1,
      liveRuntimeCount: 1,
      recoverySnapshotCount: 1,
      inactiveRecordCount: 1,
    })
  })

  it('records failed session-host action traces when the control plane throws', async () => {
    const { router } = createRouter({
      stopSession: vi.fn(async () => {
        throw new Error('write conflict')
      }),
    })

    await expect(router.execute('session_host_stop_session', { sessionId: 'session-2' })).rejects.toThrow('write conflict')

    const trace = getRecentDebugTrace({ category: 'session_host', limit: 10 })
    expect(trace.map(entry => entry.stage)).toEqual(['action_requested', 'action_failed'])
    expect(trace[1]?.payload).toMatchObject({
      action: 'session_host_stop_session',
      sessionId: 'session-2',
      error: 'write conflict',
      failureKind: 'request_failed',
    })
  })

  it('records semantic write conflict details when acquire_write is rejected by another owner', async () => {
    const { router } = createRouter({
      acquireWrite: vi.fn(async () => {
        throw new Error('Write owned by daemon-owner-1')
      }),
    })

    await expect(router.execute('session_host_acquire_write', {
      sessionId: 'session-3',
      clientId: 'client-1',
      ownerType: 'user',
    })).rejects.toThrow('Write owned by daemon-owner-1')

    const trace = getRecentDebugTrace({ category: 'session_host', limit: 10 })
    expect(trace[1]?.payload).toMatchObject({
      action: 'session_host_acquire_write',
      sessionId: 'session-3',
      failureKind: 'write_conflict',
      conflictOwnerClientId: 'daemon-owner-1',
    })
  })
})
