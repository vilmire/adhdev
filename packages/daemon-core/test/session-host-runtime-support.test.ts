import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    connectResults: [] as Array<'ok' | 'fail' | Error>,
    diagnosticsResults: [] as unknown[],
    existingClient: null as null | {
      isConnected?: () => boolean
      request: ReturnType<typeof vi.fn>
      close?: ReturnType<typeof vi.fn>
    },
    disconnectClientsCalls: 0,
    inventoryResults: [] as unknown[],
    clients: [] as Array<{
      connect: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      request: ReturnType<typeof vi.fn>
    }>,
  }

  return { state }
})

vi.mock('@adhdev/session-host-core', () => {
  const MockSessionHostClient: any = vi.fn().mockImplementation(function MockSessionHostClient(this: any) {
    this.connect = vi.fn(async () => {
      const next = mocks.state.connectResults.shift() ?? 'ok'
      if (next instanceof Error) throw next
      if (next === 'fail') throw new Error('connect failed')
    })
    this.close = vi.fn(async () => {})
    this.request = vi.fn(async (request: { type: string }, options?: { timeoutMs: number }) => {
      if (request.type === 'get_host_diagnostics') {
        const next = mocks.state.diagnosticsResults.shift()
        if (next instanceof Error) throw next
        if (typeof next === 'function') return next(request, options)
        return next ?? { success: true, result: { supportedRequestTypes: ['delete_session'] } }
      }
      return mocks.state.inventoryResults.shift() ?? { success: true, result: [] }
    })
    mocks.state.clients.push(this)
  })
  MockSessionHostClient.disconnectClients = vi.fn(async () => {
    mocks.state.disconnectClientsCalls += 1
    return 1
  })
  MockSessionHostClient.findConnectedClient = vi.fn(() => mocks.state.existingClient)
  return {
    getDefaultSessionHostEndpoint: (appName = 'adhdev') => ({
      kind: 'unix',
      path: `/tmp/${appName}-session-host.sock`,
    }),
    SessionHostClient: MockSessionHostClient,
  }
})

import * as runtimeSupport from '../src/session-host/runtime-support'
import { ensureSessionHostReady, listHostedCliRuntimes } from '../src/session-host/runtime-support'
import { DaemonCliManager } from '../src/commands/cli-manager'
import { ProviderInstanceManager } from '../src/providers/provider-instance-manager'
import { SessionRegistry } from '../src/sessions/registry'
import {
  registerMeshCoordinator,
  unregisterMeshCoordinator,
} from '../src/mesh/coordinator-registry'
import { listLocalCoordinatorSessions } from '../src/mesh/mesh-event-forwarding'
import { pickCoordinator } from '../src/assistant/coordinator-lifecycle'

describe('session host runtime support compatibility', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  beforeEach(() => {
    mocks.state.connectResults = []
    mocks.state.diagnosticsResults = []
    mocks.state.existingClient = null
    mocks.state.disconnectClientsCalls = 0
    mocks.state.clients = []
    unregisterMeshCoordinator('cli-claude-ghost7008')
    mocks.state.inventoryResults = []
  })

  it('rejects a reachable older host when diagnostics do not advertise delete_session support', async () => {
    const spawnHost = vi.fn()
    mocks.state.connectResults = ['ok']
    mocks.state.diagnosticsResults = [{ success: true, result: { supportedRequestTypes: ['list_sessions'] } }]

    await expect(ensureSessionHostReady({
      appName: 'adhdev-compat-old',
      spawnHost,
      requiredRequestTypes: ['delete_session'],
    })).rejects.toThrow(/does not support required request types: delete_session/)

    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('accepts a reachable host when diagnostics advertise delete_session support', async () => {
    const spawnHost = vi.fn()
    mocks.state.connectResults = ['ok']
    mocks.state.diagnosticsResults = [{ success: true, result: { supportedRequestTypes: ['list_sessions', 'delete_session'] } }]

    await expect(ensureSessionHostReady({
      appName: 'adhdev-compat-new',
      spawnHost,
      requiredRequestTypes: ['delete_session'],
    })).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-compat-new-session-host.sock' })

    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('spawns and waits until the new host advertises required request support when no host is active', async () => {
    const spawnHost = vi.fn()
    mocks.state.connectResults = ['fail', 'ok']
    mocks.state.diagnosticsResults = [{ success: true, result: { supportedRequestTypes: ['delete_session'] } }]

    await expect(ensureSessionHostReady({
      appName: 'adhdev-compat-spawn',
      spawnHost,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 50,
    })).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-compat-spawn-session-host.sock' })

    expect(spawnHost).toHaveBeenCalledTimes(1)
  })

  it('does NOT stop or replace a live existing host on a transient canConnect failure when retry succeeds', async () => {
    const events: string[] = []
    const spawnHost = vi.fn(() => events.push('spawn'))
    const beforeSpawnHost = vi.fn(() => events.push('stop-existing'))
    mocks.state.connectResults = ['fail', 'ok']
    mocks.state.diagnosticsResults = [{ success: true, result: { supportedRequestTypes: ['delete_session'] } }]

    await expect(ensureSessionHostReady({
      appName: 'adhdev-transient-stall',
      spawnHost,
      isExistingHostAlive: () => true,
      beforeSpawnHost,
      verifyRetries: 2,
      verifyRetryDelayMs: 5,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 50,
    } as any)).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-transient-stall-session-host.sock' })

    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('stops the existing host before spawning a replacement when canConnect persistently fails (no split-brain)', async () => {
    const events: string[] = []
    let existingAlive = true
    const beforeSpawnHost = vi.fn(() => {
      events.push('stop-existing')
      existingAlive = false
    })
    const spawnHost = vi.fn(() => {
      // At spawn time the old host must already be stopped so two hosts never coexist.
      expect(existingAlive).toBe(false)
      events.push('spawn')
    })
    mocks.state.connectResults = ['fail', 'fail', 'fail', 'ok']
    mocks.state.diagnosticsResults = [{ success: true, result: { supportedRequestTypes: ['delete_session'] } }]

    await expect(ensureSessionHostReady({
      appName: 'adhdev-persistent-wedge',
      spawnHost,
      isExistingHostAlive: () => existingAlive,
      beforeSpawnHost,
      verifyRetries: 2,
      verifyRetryDelayMs: 5,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 50,
    } as any)).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-persistent-wedge-session-host.sock' })

    expect(events).toEqual(['stop-existing', 'spawn'])
  })

  it('never kills or replaces a live host when connect fails with ENFILE (or when socket path exists), throwing session_host_unavailable_transient', async () => {
    const beforeSpawnHost = vi.fn()
    const spawnHost = vi.fn()
    const enfileError = Object.assign(new Error('connect ENFILE /tmp/adhdev-enfile-session-host.sock'), {
      code: 'ENFILE',
      errno: -23,
    })
    mocks.state.connectResults = [enfileError, enfileError, enfileError, 'ok']

    await expect(ensureSessionHostReady({
      appName: 'adhdev-enfile',
      spawnHost,
      isExistingHostAlive: () => true,
      isExistingSocketPresent: () => true,
      beforeSpawnHost,
      canConnectRetries: 2,
      canConnectRetryDelayMs: 5,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 50,
    } as any)).rejects.toMatchObject({
      code: 'session_host_unavailable_transient',
    })

    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
  })

  it('always uses a dedicated diagnostic client even with a connected controller', async () => {
    const request = vi.fn()
    mocks.state.existingClient = { isConnected: () => true, request }
    const spawnHost = vi.fn()
    await ensureSessionHostReady({ appName: 'dedicated-probe-r3', spawnHost })
    expect(mocks.state.clients).toHaveLength(1)
    expect(mocks.state.clients[0].close).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('does not replace a host that stalls once for 10 seconds', async () => {
    vi.useFakeTimers()
    const timeout = (_request: unknown, options: { timeoutMs: number }) => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('Session host request timed out (get_host_diagnostics)')), options.timeoutMs)
    })
    mocks.state.diagnosticsResults = [timeout, timeout, timeout]
    const spawnHost = vi.fn()
    const options = { appName: 'ten-second-stall-r3', spawnHost,
      isExistingHostAlive: () => true, isExistingSocketPresent: () => true, timeoutMs: 15_000 }
    const outcome = ensureSessionHostReady(options).then(result => ({ result }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await outcome).toMatchObject({ error: { code: 'session_host_unavailable_transient' } })
    await expect(ensureSessionHostReady(options)).resolves.toBeDefined()
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('does not replace from one ensure invocation even when its timeouts span 30s', async () => {
    vi.useFakeTimers()
    const timeout = (_request: unknown, options: { timeoutMs: number }) => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('Session host request timed out (get_host_diagnostics)')), options.timeoutMs)
    })
    mocks.state.diagnosticsResults = Array(12).fill(timeout)
    const spawnHost = vi.fn()
    const outcome = ensureSessionHostReady({ appName: 'one-long-call-r3', spawnHost,
      isExistingHostAlive: () => true, isExistingSocketPresent: () => true, timeoutMs: 60_000,
      canConnectRetries: 11, canConnectRetryDelayMs: 0 }).then(result => ({ result }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await outcome).toMatchObject({ error: { code: 'session_host_unavailable_transient' } })
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('replaces the host when connect fails while the existing host is dead', async () => {
    const beforeSpawnHost = vi.fn()
    const spawnHost = vi.fn()
    mocks.state.connectResults = ['fail', 'ok']
    mocks.state.diagnosticsResults = [{ success: true, result: { supportedRequestTypes: ['delete_session'] } }]

    await expect(ensureSessionHostReady({
      appName: 'adhdev-dead-host',
      spawnHost,
      isExistingHostAlive: () => false,
      isExistingSocketPresent: () => true,
      beforeSpawnHost,
      canConnectRetries: 2,
      canConnectRetryDelayMs: 5,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 50,
    } as any)).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-dead-host-session-host.sock' })

    expect(beforeSpawnHost).toHaveBeenCalledTimes(1)
    expect(spawnHost).toHaveBeenCalledTimes(1)
  })

  it.each(['unix', 'pipe'] as const)('bounds fresh-connection request timeouts across ensure calls before replacing a wedged %s host', async (kind) => {
    const spawnHost = vi.fn()
    const beforeSpawnHost = vi.fn()
    const options = {
      endpoint: { kind, path: `/tmp/fresh-wedge-r2-${kind}.sock` }, spawnHost, beforeSpawnHost,
      isExistingHostAlive: () => true, isExistingSocketPresent: () => true,
      canConnectRetries: 0, timeoutMs: 100,
    }
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    for (let count = 0; count < 2; count++) {
      now.mockReturnValue(start + count * 15_000)
      mocks.state.diagnosticsResults = [new Error('Session host request timed out after 10ms (get_host_diagnostics)')]
      await expect(ensureSessionHostReady(options)).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
      expect(spawnHost).not.toHaveBeenCalled()
    }
    now.mockReturnValue(start + 30_000)
    mocks.state.diagnosticsResults = [new Error('Session host request timed out after 10ms (get_host_diagnostics)')]
    await expect(ensureSessionHostReady(options)).resolves.toBeDefined()
    expect(beforeSpawnHost).toHaveBeenCalledTimes(1)
    expect(spawnHost).toHaveBeenCalledTimes(1)
  })

  it('probes through a fresh client after an explicitly supplied controller has dropped its socket', async () => {
    const dropped = { isConnected: () => false, request: vi.fn() }
    mocks.state.diagnosticsResults = Array(3).fill(new Error('Session host request timed out (get_host_diagnostics)'))
    const spawnHost = vi.fn()
    await expect(ensureSessionHostReady({ appName: 'dropped-controller-r2', existingClient: dropped as any,
      spawnHost, isExistingHostAlive: () => true, isExistingSocketPresent: () => true,
      canConnectRetryDelayMs: 1, timeoutMs: 100 })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(spawnHost).not.toHaveBeenCalled()
    expect(dropped.request).not.toHaveBeenCalled()
  })

  it('carries a foreign-entry diagnostic timeout into ensure after that client disconnects', async () => {
    const endpoint = { kind: 'unix' as const, path: '/tmp/preflight-evidence-r2.sock' }
    const timeout = new Error('Session host request timed out after 10ms (get_host_diagnostics)')
    const record = (runtimeSupport as any).recordSessionHostProbeFailure
    expect(record).toBeTypeOf('function')
    const invocation = runtimeSupport.createSessionHostProbeInvocation()
    record(endpoint, timeout, 'pid-42', invocation)
    record(endpoint, timeout, 'pid-42', invocation)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000)
    mocks.state.diagnosticsResults = [timeout]
    const spawnHost = vi.fn()
    await expect(ensureSessionHostReady({ endpoint, spawnHost, existingHostIdentity: () => 'pid-42',
      isExistingHostAlive: () => true, isExistingSocketPresent: () => true,
      canConnectRetries: 0, timeoutMs: 100 } as any)).resolves.toEqual(endpoint)
    expect(spawnHost).toHaveBeenCalledTimes(1)
  })

  it.each(['ENFILE', 'EMFILE', 'EAGAIN', 'ENOBUFS'])('never treats repeated %s connects as proof, including on Windows pipes', async (code) => {
    const spawnHost = vi.fn()
    const endpoint = { kind: 'pipe' as const, path: `pipe-r2-${code}` }
    for (let n = 0; n < 4; n++) {
      mocks.state.connectResults = Array(4).fill(Object.assign(new Error(code), { code }))
      await expect(ensureSessionHostReady({ endpoint, spawnHost, isExistingHostAlive: () => true,
        canConnectRetries: 0, timeoutMs: 100 })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    }
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
  })

  it('preserves a live Windows pipe host on an unproven connect failure', async () => {
    mocks.state.connectResults = ['fail', 'fail', 'fail']
    const spawnHost = vi.fn()
    await expect(ensureSessionHostReady({ endpoint: { kind: 'pipe', path: 'pipe-r2-connect' }, spawnHost,
      isExistingHostAlive: () => true, canConnectRetries: 0, timeoutMs: 100 })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('gives dedicated diagnostics an explicit timeout within the ensure budget', async () => {
    const request = vi.fn(async () => ({ success: true, result: {} }))
    mocks.state.existingClient = { isConnected: () => true, request }
    await ensureSessionHostReady({ appName: 'probe-budget-r2', spawnHost: vi.fn(), timeoutMs: 25 })
    expect(mocks.state.clients[0].request.mock.calls[0][1]).toEqual({ timeoutMs: expect.any(Number) })
    expect(mocks.state.clients[0].request.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(25)
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['success', 'connect failure', 'PID change', 'expired window'])('discards old timeout evidence after %s', async (reset) => {
    const endpoint = { kind: 'unix' as const, path: `/tmp/evidence-reset-r2-${reset}.sock` }
    const timeout = new Error('Session host request timed out after 10ms (get_host_diagnostics)')
    const record = runtimeSupport.recordSessionHostProbeFailure
    const invocation = runtimeSupport.createSessionHostProbeInvocation()
    record(endpoint, timeout, 'pid-1', invocation)
    record(endpoint, timeout, 'pid-1', invocation)
    if (reset === 'success') runtimeSupport.recordSessionHostProbeSuccess(endpoint)
    if (reset === 'connect failure') record(endpoint, new Error('connect failed'), 'pid-1')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + (reset === 'expired window' ? 90_001 : 30_000))
    try {
      expect(record(endpoint, timeout, reset === 'PID change' ? 'pid-2' : 'pid-1', runtimeSupport.createSessionHostProbeInvocation())).toBe(false)
    } finally { vi.restoreAllMocks() }
  })

  it('never replaces on ENFILE even after earlier connected timeout evidence reached the bound', async () => {
    const endpoint = { kind: 'unix' as const, path: '/tmp/prior-proof-enfile-r2.sock' }
    const timeout = new Error('Session host request timed out (get_host_diagnostics)')
    const invocation = runtimeSupport.createSessionHostProbeInvocation()
    runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, undefined, invocation)
    runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, undefined, invocation)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000)
    expect(runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, undefined, runtimeSupport.createSessionHostProbeInvocation())).toBe(true)
    mocks.state.connectResults = [Object.assign(new Error('ENFILE'), { code: 'ENFILE' })]
    const spawnHost = vi.fn()
    await expect(ensureSessionHostReady({ endpoint, spawnHost, canConnectRetries: 0,
      isExistingHostAlive: () => true, isExistingSocketPresent: () => true, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
  })

  it('caps the complete ensure probe loop at timeoutMs', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((_request, options) => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('Session host request timed out (get_host_diagnostics)')), options?.timeoutMs ?? 30_000)
      }))
      mocks.state.diagnosticsResults = [request]
      const spawnHost = vi.fn()
      const result = ensureSessionHostReady({ appName: 'total-budget-r2', spawnHost,
        isExistingHostAlive: () => true, isExistingSocketPresent: () => true, timeoutMs: 80 })
      const checked = expect(result).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
      await vi.advanceTimersByTimeAsync(80)
      await checked
      expect(spawnHost).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('leaves tracked adapters intact when the hosted-runtime listing rejects', async () => {
    const detach = vi.fn()
    const cliManager = new DaemonCliManager({ getP2p: () => null, getInstanceManager: () => null,
      listHostedCliRuntimes: async () => { throw new Error('list failed') } })
    ;(cliManager as any).adapters.set('live-list-r2', { detach })
    await expect(cliManager.reconcileHostedSessionsAfterHostReplace()).rejects.toThrow('list failed')
    expect(detach).not.toHaveBeenCalled()
    expect((cliManager as any).adapters.has('live-list-r2')).toBe(true)
  })

  it('throws on a failed list_sessions rather than reporting an empty host', async () => {
    mocks.state.existingClient = { request: vi.fn(async () => ({ success: false, error: 'ENFILE' })) }
    await expect(listHostedCliRuntimes({ kind: 'unix', path: '/tmp/list-r2.sock' })).rejects.toThrow('ENFILE')
  })

  it('does not reconcile away tracked sessions when there is no successful hosted-runtime list', async () => {
    const detach = vi.fn()
    const removeInstance = vi.fn()
    const cliManager = new DaemonCliManager({ getP2p: () => null,
      getInstanceManager: () => ({ getByCategory: () => [], removeInstance }) as any })
    ;(cliManager as any).adapters.set('live-r2', { detach })
    await cliManager.reconcileHostedSessionsAfterHostReplace()
    expect(detach).not.toHaveBeenCalled()
    expect(removeInstance).not.toHaveBeenCalled()
  })

  it('leaves no ghost sessions selectable as coordinator after a forced host replace', async () => {
    const instanceManager = new ProviderInstanceManager()
    const sessionRegistry = new SessionRegistry()
    const ghostId = 'cli-claude-ghost7008'

    sessionRegistry.register({
      sessionId: ghostId,
      parentSessionId: null,
      providerType: 'claude-cli',
      transport: 'pty',
      adapterKey: ghostId,
      instanceKey: ghostId,
      workspace: '/tmp/proj-a',
      spawnedAtMs: Date.now(),
    })
    await instanceManager.addInstance(ghostId, {
      instanceId: ghostId,
      providerId: 'claude-code',
      category: 'cli',
      init: async () => {},
      getState: () => ({
        instanceId: ghostId,
        providerId: 'claude-code',
        category: 'cli',
        connected: true,
        status: 'idle',
        projectPath: '/tmp/proj-a',
        settings: { meshCoordinatorFor: 'mesh-1' },
      }),
      getDrainStatus: () => 'idle',
      dispose: () => {},
    } as any, {} as any)
    registerMeshCoordinator({
      meshId: 'mesh-1',
      sessionId: ghostId,
      workspace: '/tmp/proj-a',
      startedAt: Date.now(),
    })

    // Before replacement reconciliation, the coordinator is selectable.
    expect(
      pickCoordinator(
        listLocalCoordinatorSessions({ instanceManager, sessionRegistry } as any, 'mesh-1').map((v) => ({
          ...v,
          managedByAssistant: false,
        })),
      )?.sessionId,
    ).toBe(ghostId)

    const cliManager = new DaemonCliManager({
      getP2p: () => null,
      getInstanceManager: () => instanceManager,
      getSessionRegistry: () => sessionRegistry,
      listHostedCliRuntimes: async () => [],
    })

    // Simulate forced host replace where the new host has 0 sessions.
    mocks.state.connectResults = ['fail', 'ok']
    await expect(ensureSessionHostReady({
      appName: 'adhdev-forced-replace',
      isExistingHostAlive: () => false,
      spawnHost: () => {},
      onHostReplaced: async () => {
        await (cliManager as any).reconcileHostedSessionsAfterHostReplace()
      },
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 50,
    } as any)).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-forced-replace-session-host.sock' })

    // After forced replace, the ghost coordinator must be terminated and not selectable.
    expect(
      pickCoordinator(
        listLocalCoordinatorSessions({ instanceManager, sessionRegistry } as any, 'mesh-1').map((v) => ({
          ...v,
          managedByAssistant: false,
        })),
      ),
    ).toBeNull()
    expect(sessionRegistry.get(ghostId)).toBeUndefined()
  })
})


describe('assistant runtime provenance inventory', () => {
  it.each([' mesh-test ', '', '   ', 42, null])('validates the persisted coordinator mesh association (%j)', async value => {
    mocks.state.inventoryResults = [{ success: true, result: [
      { sessionId: 'coordinator', providerType: 'test-cli', category: 'cli', lifecycle: 'running',
        workspace: '/test', meta: { meshCoordinatorFor: value } },
    ] }];
    const [record] = await listHostedCliRuntimes({ kind: 'unix', path: '/tmp/test.sock' });
    expect(record.meshCoordinatorFor).toBe(value === ' mesh-test ' ? 'mesh-test' : undefined);
  });

  it('projects positive meta.assistant and launch provenance, while ignoring ordinary sessions', async () => {
    const launchRecord = { launchedBy: 'assistant' };
    mocks.state.inventoryResults = [{ success: true, result: [
      { sessionId: 'assistant', providerType: 'sample-cli', category: 'cli', lifecycle: 'running',
        workspace: '/assistant', startedAt: 42, meta: { assistant: true, launchRecord } },
      { sessionId: 'ordinary', providerType: 'sample-cli', category: 'cli', lifecycle: 'running',
        workspace: '/assistant', meta: { assistant: 'true' } },
    ] }];
    const records = await listHostedCliRuntimes({ kind: 'unix', path: '/tmp/test.sock' });
    expect(records[0]).toMatchObject({ runtimeId: 'assistant', assistant: true, launchRecord, startedAtMs: 42 });
    expect(records[1].assistant).toBeUndefined();
  });

  it('rejects unsuccessful inventories instead of presenting an authoritative empty set', async () => {
    mocks.state.inventoryResults = [{ success: false, error: 'host unavailable' }];
    await expect(listHostedCliRuntimes({ kind: 'unix', path: '/tmp/test.sock' })).rejects.toThrow('session_host_inventory_unavailable');
  });
});
