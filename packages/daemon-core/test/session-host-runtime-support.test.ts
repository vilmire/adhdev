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

  it('refuses a persistent live-host connection failure before the automatic stop callback', async () => {
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
    } as any)).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })

    expect(events).toEqual([])
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
      existingHostState: () => 'dead',
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

  it.each(['unix', 'pipe'] as const)('never replaces a live %s host on >=3 connected diagnostics timeouts across >=2 ensure calls spanning >=30s without explicit replacement authority', async (kind) => {
    vi.useFakeTimers()
    const spawnHost = vi.fn()
    const beforeSpawnHost = vi.fn()
    const endpoint = { kind, path: `/tmp/fresh-wedge-r2-${kind}.sock` }
    const options = {
      endpoint, spawnHost, beforeSpawnHost,
      existingHostIdentity: () => 'pid-54321:birth-1',
      isExistingHostAlive: () => true, isExistingSocketPresent: () => true,
      canConnectRetries: 1, canConnectRetryDelayMs: 1, timeoutMs: 15_000,
    }
    const structuredTimeout = () => Object.assign(
      new Error('Session host request timed out after 3s (get_host_diagnostics)'),
      {
        code: 'SESSION_HOST_REQUEST_TIMEOUT',
        requestType: 'get_host_diagnostics',
        scheduledTimeoutMs: 3_000,
        actualElapsedMs: 3_000,
        wallElapsedMs: 3_000,
        observerLagMs: 0,
      },
    )
    // Invocation 1: two connected diagnostic timeouts at t=0
    mocks.state.diagnosticsResults = [structuredTimeout(), structuredTimeout()]
    const call1 = ensureSessionHostReady(options).then((r) => ({ r }), (e) => ({ e }))
    await vi.advanceTimersByTimeAsync(10)
    expect(await call1).toMatchObject({ e: { code: 'session_host_unavailable_transient' } })
    expect(spawnHost).not.toHaveBeenCalled()

    // Invocation 2 at t=30s with remaining budget (12s left of 15s deadline): >=3 timeouts, >=2 calls, >=30s span
    await vi.advanceTimersByTimeAsync(30_000)
    mocks.state.diagnosticsResults = [structuredTimeout(), structuredTimeout()]
    const call2 = ensureSessionHostReady(options).then((r) => ({ r }), (e) => ({ e }))
    await vi.advanceTimersByTimeAsync(10)
    expect(await call2).toMatchObject({ e: { code: 'session_host_unavailable_transient' } })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
  })

  it('refuses takeover on 28-31s observer starvation / late timer delivery across >=3 timeouts and >=2 calls with budget remaining', async () => {
    vi.useFakeTimers()
    const spawnHost = vi.fn()
    const beforeSpawnHost = vi.fn()
    const endpoint = { kind: 'unix' as const, path: '/tmp/observer-starvation-r3.sock' }
    const starvedTimeout = (lagMs: number) => Object.assign(
      new Error('Session host request timed out after 3s (get_host_diagnostics)'),
      {
        code: 'SESSION_HOST_REQUEST_TIMEOUT',
        requestType: 'get_host_diagnostics',
        scheduledTimeoutMs: 3_000,
        actualElapsedMs: 3_000 + lagMs,
        wallElapsedMs: 3_000 + lagMs,
        observerLagMs: lagMs,
      },
    )
    const inv1 = runtimeSupport.createSessionHostProbeInvocation()
    expect(runtimeSupport.recordSessionHostProbeFailure(endpoint, starvedTimeout(28_500), 'pid-500:birth-a', inv1)).toBe(false)
    expect(runtimeSupport.recordSessionHostProbeFailure(endpoint, starvedTimeout(29_000), 'pid-500:birth-a', inv1)).toBe(false)
    await vi.advanceTimersByTimeAsync(31_000)
    mocks.state.diagnosticsResults = [starvedTimeout(30_200)]
    await expect(ensureSessionHostReady({
      endpoint,
      spawnHost,
      beforeSpawnHost,
      existingHostIdentity: () => 'pid-500:birth-a',
      isExistingHostAlive: () => true,
      isExistingSocketPresent: () => true,
      canConnectRetries: 0,
      timeoutMs: 15_000,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
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

  it('carries a foreign-entry diagnostic timeout into ensure after that client disconnects without authorizing live-host eviction', async () => {
    vi.useFakeTimers()
    const endpoint = { kind: 'unix' as const, path: '/tmp/preflight-evidence-r2.sock' }
    const timeout = Object.assign(new Error('diagnostics_rpc_timeout'), {
      code: 'SESSION_HOST_REQUEST_TIMEOUT',
      requestType: 'get_host_diagnostics',
      scheduledTimeoutMs: 3_000,
      actualElapsedMs: 3_000,
      wallElapsedMs: 3_000,
      observerLagMs: 0,
    })
    const record = runtimeSupport.recordSessionHostProbeFailure
    const invocation = runtimeSupport.createSessionHostProbeInvocation()
    expect(record(endpoint, timeout, 'pid-42:birth-1', invocation)).toBe(false)
    expect(record(endpoint, timeout, 'pid-42:birth-1', invocation)).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    mocks.state.diagnosticsResults = [timeout]
    const spawnHost = vi.fn()
    const beforeSpawnHost = vi.fn()
    await expect(ensureSessionHostReady({ endpoint, spawnHost, beforeSpawnHost, existingHostIdentity: () => 'pid-42:birth-1',
      isExistingHostAlive: () => true, isExistingSocketPresent: () => true,
      canConnectRetries: 0, timeoutMs: 15_000 } as any)).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('wall clock jumps without monotonic elapsed time do not satisfy the 30s diagnostic timeout span', () => {
    const endpoint = { kind: 'unix' as const, path: '/tmp/wall-clock-jump-r3.sock' }
    const timeout = Object.assign(new Error('structured-timeout-without-prose'), {
      code: 'SESSION_HOST_REQUEST_TIMEOUT',
      requestType: 'get_host_diagnostics',
      scheduledTimeoutMs: 3_000,
      actualElapsedMs: 3_000,
      wallElapsedMs: 3_000,
      observerLagMs: 0,
    })
    const inv1 = runtimeSupport.createSessionHostProbeInvocation()
    expect(runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, 'pid-99:birth-1', inv1)).toBe(false)
    expect(runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, 'pid-99:birth-1', inv1)).toBe(false)
    const wallStart = Date.now()
    // Jump wall clock +45s while monotonic clock does not advance
    vi.spyOn(Date, 'now').mockReturnValue(wallStart + 45_000)
    const inv2 = runtimeSupport.createSessionHostProbeInvocation()
    expect(runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, 'pid-99:birth-1', inv2)).toBe(false)
  })

  it('coalesces concurrent ensureSessionHostReady calls on a dead endpoint so replacement spawns only once', async () => {
    const endpoint = { kind: 'unix' as const, path: '/tmp/concurrent-dead-recovery-r3.sock' }
    let spawned = false
    const beforeSpawnHost = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const spawnHost = vi.fn(() => {
      spawned = true
    })
    mocks.state.connectResults = ['fail', 'fail', 'ok', 'ok']
    mocks.state.diagnosticsResults = [
      { success: true, result: { supportedRequestTypes: ['delete_session'], hostStartedAt: 777 } },
      { success: true, result: { supportedRequestTypes: ['delete_session'], hostStartedAt: 777 } },
    ]
    const [resA, resB] = await Promise.all([
      ensureSessionHostReady({
        endpoint,
        spawnHost,
        beforeSpawnHost,
        existingHostState: () => spawned ? 'alive' : 'dead',
        isExistingSocketPresent: () => true,
        canConnectRetries: 0,
        timeoutMs: 500,
        requiredRequestTypes: ['delete_session'],
      }),
      ensureSessionHostReady({
        endpoint,
        spawnHost,
        beforeSpawnHost,
        existingHostState: () => spawned ? 'alive' : 'dead',
        isExistingSocketPresent: () => true,
        canConnectRetries: 0,
        timeoutMs: 500,
        requiredRequestTypes: ['delete_session'],
      }),
    ])
    expect(resA).toEqual(endpoint)
    expect(resB).toEqual(endpoint)
    expect(spawnHost).toHaveBeenCalledTimes(1)
    expect(beforeSpawnHost).toHaveBeenCalledTimes(1)
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

  it.each(['success', 'connect failure', 'PID change', 'birth generation change', 'expired window'])('discards old timeout evidence after %s', async (reset) => {
    vi.useFakeTimers()
    const endpoint = { kind: 'unix' as const, path: `/tmp/evidence-reset-r2-${reset}.sock` }
    const timeout = Object.assign(new Error('Session host request timed out after 10ms (get_host_diagnostics)'), {
      code: 'SESSION_HOST_REQUEST_TIMEOUT',
      requestType: 'get_host_diagnostics',
      scheduledTimeoutMs: 10,
      actualElapsedMs: 10,
      wallElapsedMs: 10,
      observerLagMs: 0,
    })
    const record = runtimeSupport.recordSessionHostProbeFailure
    const invocation = runtimeSupport.createSessionHostProbeInvocation()
    record(endpoint, timeout, 'pid-1:birth-a', invocation)
    record(endpoint, timeout, 'pid-1:birth-a', invocation)
    if (reset === 'success') runtimeSupport.recordSessionHostProbeSuccess(endpoint)
    if (reset === 'connect failure') record(endpoint, new Error('connect failed'), 'pid-1:birth-a')
    await vi.advanceTimersByTimeAsync(reset === 'expired window' ? 90_001 : 30_000)
    const nextIdentity =
      reset === 'PID change'
        ? 'pid-2:birth-a'
        : reset === 'birth generation change'
          ? 'pid-1:birth-b'
          : 'pid-1:birth-a'
    expect(record(endpoint, timeout, nextIdentity, runtimeSupport.createSessionHostProbeInvocation())).toBe(false)
  })

  it('never replaces on ENFILE even after earlier connected timeout evidence reached the bound', async () => {
    vi.useFakeTimers()
    const endpoint = { kind: 'unix' as const, path: '/tmp/prior-proof-enfile-r2.sock' }
    const timeout = Object.assign(new Error('Session host request timed out (get_host_diagnostics)'), {
      code: 'SESSION_HOST_REQUEST_TIMEOUT',
      requestType: 'get_host_diagnostics',
      scheduledTimeoutMs: 3_000,
      actualElapsedMs: 3_000,
      wallElapsedMs: 3_000,
      observerLagMs: 0,
    })
    const invocation = runtimeSupport.createSessionHostProbeInvocation()
    runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, 'pid-1:birth-a', invocation)
    runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, 'pid-1:birth-a', invocation)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runtimeSupport.recordSessionHostProbeFailure(endpoint, timeout, 'pid-1:birth-a', runtimeSupport.createSessionHostProbeInvocation())).toBe(true)
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

  it.each(['alive', 'unknown'] as const)('R4 refuses complete count-zero authority for a %s host before disconnect or admission', async (hostState) => {
    const spawnHost = vi.fn(), beforeSpawnHost = vi.fn()
    mocks.state.connectResults = ['fail']
    await expect(ensureSessionHostReady({
      endpoint: { kind: 'unix', path: '/tmp/r4-automatic-refusal.sock' },
      existingHostState: () => hostState,
      existingHostIdentity: () => 'pid-777:birth-Sat Oct 24 06:00:00 2026',
      replacementAuthority: {
        expectedPid: 777, expectedBirth: 'Sat Oct 24 06:00:00 2026',
        expectedInstanceConfigDir: '/tmp/owned-config', expectedBootId: 'fixture-boot',
        expectedEpoch: 3, expectedOwner: 'fixture_owner', activeRuntimeCount: 0,
      },
      spawnHost, beforeSpawnHost, canConnectRetries: 0, timeoutMs: 1000,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
  })

  it('R4 revalidates dead state after asynchronous admission before every effect', async () => {
    const spawnHost = vi.fn()
    let hostState: 'dead' | 'alive' = 'dead'
    mocks.state.connectResults = ['fail']
    await expect(ensureSessionHostReady({
      endpoint: { kind: 'unix', path: '/tmp/r4-post-admission.sock' },
      existingHostState: () => hostState,
      beforeSpawnHost: async () => { hostState = 'alive' },
      spawnHost, canConnectRetries: 0, timeoutMs: 1000,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
  })

  it('R4 refuses an in-flight join for a different config/PID/birth generation on the same endpoint', async () => {
    const endpoint = { kind: 'unix' as const, path: '/tmp/r4-inflight-generation.sock' }
    let generation = 'config-a:pid-7:birth-a'
    let release!: () => void
    const admitted = new Promise<void>(resolve => { release = resolve })
    const spawnHost = vi.fn()
    const beforeSpawnHost = vi.fn(() => admitted)
    mocks.state.connectResults = ['fail', 'fail', 'ok']
    const options = { endpoint, existingHostState: () => 'dead' as const,
      existingHostGeneration: () => generation, spawnHost, beforeSpawnHost,
      canConnectRetries: 0, timeoutMs: 1000 }
    const first = ensureSessionHostReady(options)
    await new Promise(resolve => setImmediate(resolve))
    generation = 'config-b:pid-8:birth-b'
    const second = ensureSessionHostReady(options).then(value => ({ value }), error => ({ error }))
    await new Promise(resolve => setImmediate(resolve))
    generation = 'config-a:pid-7:birth-a'
    release()
    expect(await second).toMatchObject({ error: { code: 'session_host_unavailable_transient' } })
    await expect(first).resolves.toEqual(endpoint)
    expect(spawnHost).toHaveBeenCalledTimes(1)
    expect(beforeSpawnHost).toHaveBeenCalledTimes(1)
  })

  it.each(['generation', 'cancel-after-native-read'] as const)('R4 refuses %s changes after admission and before disconnect/spawn', async (fault) => {
    let generation = 'initial', cancelled = false, reads = 0
    const spawnHost = vi.fn()
    mocks.state.connectResults = ['fail']
    await expect(ensureSessionHostReady({
      endpoint: { kind: 'unix', path: '/tmp/r4-effect-generation.sock' },
      existingHostState: () => 'dead',
      existingHostGeneration: () => { if (++reads >= 3 && fault === 'cancel-after-native-read') cancelled = true; return generation },
      isCancelled: () => cancelled,
      beforeSpawnHost: () => { if (fault === 'generation') generation = 'changed' },
      spawnHost, canConnectRetries: 0, timeoutMs: 1000,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(spawnHost).not.toHaveBeenCalled()
    expect(mocks.state.disconnectClientsCalls).toBe(0)
  })

  it('rejects partial caller replacementAuthority ({ activeRuntimeCount: 0 } alone) and refuses when observed runtimeCount > 0 or cancelled during identity check', async () => {
    const spawnHost = vi.fn()
    const beforeSpawnHost = vi.fn()
    const endpoint = { kind: 'unix' as const, path: '/tmp/adhdev-r2-auth-shape.sock' }
    mocks.state.connectResults = ['fail', 'fail', 'fail', 'fail']

    // 1. Partial authority ({ activeRuntimeCount: 0 } alone) must be rejected
    await expect(ensureSessionHostReady({
      endpoint,
      spawnHost,
      beforeSpawnHost,
      existingHostIdentity: () => 'pid-777:birth-1',
      existingHostState: () => 'alive',
      replacementAuthority: { activeRuntimeCount: 0 } as any,
      canConnectRetries: 0,
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()

    // 2. Complete valid authority (passing shape check) is rejected if a previous probe observed runtimeCount > 0 on this endpoint
    const canonicalBirth = 'Sat Oct 24 06:00:00 2026'
    const canonicalIdentity = `pid-777:birth-${canonicalBirth}`
    const validFullAuthority = {
      expectedPid: 777,
      expectedBirth: canonicalBirth,
      expectedInstanceConfigDir: '/tmp/cfg',
      expectedBootId: 'boot-idle-1',
      expectedEpoch: 1,
      expectedOwner: 'rollout_owner_01',
      expectedIdentity: canonicalIdentity,
      activeRuntimeCount: 0 as const,
    }
    expect(runtimeSupport.isValidReplacementAuthorizationShape(validFullAuthority)).toBe(true)

    runtimeSupport.recordSessionHostProbeSuccess(endpoint, { runtimeCount: 2 } as any)
    expect(runtimeSupport.getObservedSessionHostRuntimeCount(endpoint)).toBe(2)
    await expect(ensureSessionHostReady({
      endpoint,
      spawnHost,
      beforeSpawnHost,
      existingHostIdentity: () => canonicalIdentity,
      existingHostState: () => 'alive',
      replacementAuthority: validFullAuthority,
      canConnectRetries: 0,
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()

    // 3. Cancellation occurring during existingHostIdentity() query prevents beforeSpawnHost and spawnHost
    runtimeSupport.recordSessionHostProbeSuccess(endpoint, { runtimeCount: 0 } as any)
    expect(runtimeSupport.getObservedSessionHostRuntimeCount(endpoint)).toBe(0)
    let cancelled = false
    await expect(ensureSessionHostReady({
      endpoint,
      spawnHost,
      beforeSpawnHost,
      existingHostIdentity: () => {
        cancelled = true
        return canonicalIdentity
      },
      existingHostState: () => 'alive',
      replacementAuthority: () => ({
        ...validFullAuthority,
        isCancelled: () => cancelled,
      }),
      canConnectRetries: 0,
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()

    // R4 / R3-14: count zero with identical canonical authority is also unsupported.
    cancelled = false
    beforeSpawnHost.mockImplementationOnce(async () => {
      throw new runtimeSupport.SessionHostUnavailableTransientError(endpoint)
    })
    await expect(ensureSessionHostReady({
      endpoint,
      spawnHost,
      beforeSpawnHost,
      existingHostIdentity: () => canonicalIdentity,
      existingHostState: () => 'alive',
      replacementAuthority: () => ({
        ...validFullAuthority,
        isCancelled: () => cancelled,
      }),
      canConnectRetries: 0,
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
    expect(beforeSpawnHost).not.toHaveBeenCalled()
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
