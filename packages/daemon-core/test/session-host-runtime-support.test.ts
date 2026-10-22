import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    this.request = vi.fn(async (request: { type: string }) => {
      if (request.type === 'get_host_diagnostics') {
        const next = mocks.state.diagnosticsResults.shift()
        if (next instanceof Error) throw next
        return next ?? { success: true, result: { supportedRequestTypes: ['delete_session'] } }
      }
      return { success: true, result: [] }
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

import { ensureSessionHostReady } from '../src/session-host/runtime-support'
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
  beforeEach(() => {
    mocks.state.connectResults = []
    mocks.state.diagnosticsResults = []
    mocks.state.existingClient = null
    mocks.state.disconnectClientsCalls = 0
    mocks.state.clients = []
    unregisterMeshCoordinator('cli-claude-ghost7008')
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

  it('reuses the existing controller connection without opening a new socket, and only replaces a live host when the existing connection times out', async () => {
    const beforeSpawnHost = vi.fn()
    const spawnHost = vi.fn()
    mocks.state.existingClient = {
      isConnected: () => true,
      request: vi.fn(async () => ({
        success: true,
        result: { supportedRequestTypes: ['delete_session'] },
      })),
    }

    await expect(ensureSessionHostReady({
      appName: 'adhdev-reuse-existing',
      spawnHost,
      isExistingHostAlive: () => true,
      isExistingSocketPresent: () => true,
      beforeSpawnHost,
      requiredRequestTypes: ['delete_session'],
    } as any)).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-reuse-existing-session-host.sock' })

    // No new SessionHostClient socket was created because the existing controller client was reused.
    expect(mocks.state.clients).toHaveLength(0)
    expect(beforeSpawnHost).not.toHaveBeenCalled()
    expect(spawnHost).not.toHaveBeenCalled()

    // Now simulate the existing controller connection timing out (proof of unresponsiveness)
    mocks.state.existingClient = {
      isConnected: () => true,
      request: vi.fn(async () => {
        throw new Error('Session host request timed out: get_host_diagnostics')
      }),
    }
    mocks.state.connectResults = ['ok']
    mocks.state.diagnosticsResults = [{ success: true, result: { supportedRequestTypes: ['delete_session'] } }]

    await expect(ensureSessionHostReady({
      appName: 'adhdev-unresponsive-existing',
      spawnHost,
      isExistingHostAlive: () => true,
      isExistingSocketPresent: () => true,
      beforeSpawnHost,
      canConnectRetries: 1,
      canConnectRetryDelayMs: 5,
      requiredRequestTypes: ['delete_session'],
      timeoutMs: 50,
    } as any)).resolves.toEqual({ kind: 'unix', path: '/tmp/adhdev-unresponsive-existing-session-host.sock' })

    expect(beforeSpawnHost).toHaveBeenCalledTimes(1)
    expect(spawnHost).toHaveBeenCalledTimes(1)
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
