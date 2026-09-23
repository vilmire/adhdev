/**
 * `get_runtime_snapshot` / `get_command_history` — moved off cloud's
 * `cloud-command-transports.ts` P2P-only special case onto the shared command
 * registry (wiring-unification B residue cleanup, deliverable 7). Both were
 * P2P-only, never-relayed-by-the-server commands; `sources: ['p2p']` on their
 * specs (session-host.ts / diagnostics.ts) is what preserves that property now
 * that the registry — not a cloud-only branch — is the single dispatch path.
 */
import { describe, expect, it, vi } from 'vitest'

const commandLogMocks = vi.hoisted(() => ({
  getRecentCommands: vi.fn(() => [{ ts: '2026-01-01T00:00:00.000Z', cmd: 'launch_cli', source: 'p2p' as const, success: true }]),
}))
vi.mock('../../src/logging/command-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logging/command-log.js')>()
  return {
    ...actual,
    getRecentCommands: commandLogMocks.getRecentCommands,
  }
})

import { DaemonCommandRouter } from '../../src/commands/router'

function createRouter(overrides: { sessionHostControl?: Record<string, unknown> | null } = {}) {
  const sessionHostControl = overrides.sessionHostControl === null
    ? null
    : {
      getDiagnostics: vi.fn(async () => ({})),
      listSessions: vi.fn(async () => []),
      stopSession: vi.fn(async () => ({})),
      resumeSession: vi.fn(async () => ({})),
      restartSession: vi.fn(async () => ({})),
      sendSignal: vi.fn(async () => ({})),
      forceDetachClient: vi.fn(async () => ({})),
      pruneDuplicateSessions: vi.fn(async () => ({})),
      acquireWrite: vi.fn(async () => ({})),
      releaseWrite: vi.fn(async () => ({})),
      ...overrides.sessionHostControl,
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

  return { router }
}

describe('get_runtime_snapshot', () => {
  it('is refused from a non-p2p source (source gate preserves "never relayed by the server")', async () => {
    const { router } = createRouter({
      sessionHostControl: { getSnapshot: vi.fn(async () => ({ seq: 1, text: 'hi', truncated: false })) },
    })

    const result = await router.execute('get_runtime_snapshot', { sessionId: 'sess-1' }, 'ws')

    expect(result.success).toBe(false)
    expect((result as any).code).toBe('COMMAND_SOURCE_REJECTED')
  })

  it('rejected from mesh and internal too — p2p is the only allowed source', async () => {
    const { router } = createRouter({
      sessionHostControl: { getSnapshot: vi.fn(async () => ({ seq: 1, text: 'hi', truncated: false })) },
    })

    for (const source of ['mesh', 'internal', 'api', 'ext', 'standalone', 'ipc']) {
      const result = await router.execute('get_runtime_snapshot', { sessionId: 'sess-1' }, source)
      expect(result.success, `source=${source}`).toBe(false)
      expect((result as any).code, `source=${source}`).toBe('COMMAND_SOURCE_REJECTED')
    }
  })

  it('returns the session-host snapshot when accepted from p2p', async () => {
    const getSnapshot = vi.fn(async () => ({
      seq: 42, text: 'terminal output', truncated: false, cols: 80, rows: 24,
    }))
    const { router } = createRouter({ sessionHostControl: { getSnapshot } })

    const result = await router.execute('get_runtime_snapshot', { sessionId: 'sess-1', sinceSeq: 10 }, 'p2p')

    expect(result.success).toBe(true)
    expect((result as any).result).toEqual({ seq: 42, text: 'terminal output', truncated: false, cols: 80, rows: 24 })
    expect(getSnapshot).toHaveBeenCalledWith('sess-1', 10)
  })

  it('requires sessionId', async () => {
    const { router } = createRouter({
      sessionHostControl: { getSnapshot: vi.fn(async () => ({ seq: 1, text: '', truncated: false })) },
    })

    const result = await router.execute('get_runtime_snapshot', {}, 'p2p')

    expect(result.success).toBe(false)
    expect((result as any).error).toMatch(/sessionId/)
  })

  it('fails closed with CLI_RUNTIME_UNAVAILABLE when the control plane has no getSnapshot wired yet', async () => {
    // The concrete session-host-controller.ts implementation of getSnapshot is a
    // REQUESTED EDIT (unowned file) — until it lands, this is the real shape of
    // sessionHostControl in production: every method except getSnapshot.
    const { router } = createRouter({ sessionHostControl: {} })

    const result = await router.execute('get_runtime_snapshot', { sessionId: 'sess-1' }, 'p2p')

    expect(result.success).toBe(false)
    expect((result as any).code).toBe('CLI_RUNTIME_UNAVAILABLE')
  })

  it('fails closed when sessionHostControl itself is absent', async () => {
    const { router } = createRouter({ sessionHostControl: null })

    const result = await router.execute('get_runtime_snapshot', { sessionId: 'sess-1' }, 'p2p')

    expect(result.success).toBe(false)
    expect((result as any).error).toMatch(/unavailable/i)
  })
})

describe('get_command_history', () => {
  it('is refused from a non-p2p source', async () => {
    const { router } = createRouter()

    const result = await router.execute('get_command_history', {}, 'ws')

    expect(result.success).toBe(false)
    expect((result as any).code).toBe('COMMAND_SOURCE_REJECTED')
  })

  it('returns the process-local command log when accepted from p2p', async () => {
    const { router } = createRouter()

    const result = await router.execute('get_command_history', { count: 10 }, 'p2p')

    expect(result.success).toBe(true)
    expect((result as any).history).toEqual(commandLogMocks.getRecentCommands())
    expect(commandLogMocks.getRecentCommands).toHaveBeenCalledWith(10)
  })
})
