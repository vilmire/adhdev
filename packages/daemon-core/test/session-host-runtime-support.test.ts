import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    connectResults: [] as Array<'ok' | 'fail'>,
    diagnosticsResults: [] as unknown[],
    inventoryResults: [] as unknown[],
    clients: [] as Array<{
      connect: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      request: ReturnType<typeof vi.fn>
    }>,
  }

  return { state }
})

vi.mock('@adhdev/session-host-core', () => ({
  getDefaultSessionHostEndpoint: (appName = 'adhdev') => ({
    kind: 'unix',
    path: `/tmp/${appName}-session-host.sock`,
  }),
  SessionHostClient: vi.fn().mockImplementation(function MockSessionHostClient(this: any) {
    this.connect = vi.fn(async () => {
      const next = mocks.state.connectResults.shift() ?? 'ok'
      if (next === 'fail') throw new Error('connect failed')
    })
    this.close = vi.fn(async () => {})
    this.request = vi.fn(async (request: { type: string }) => {
      if (request.type === 'get_host_diagnostics') {
        const next = mocks.state.diagnosticsResults.shift()
        return next ?? { success: true, result: { supportedRequestTypes: ['delete_session'] } }
      }
      return mocks.state.inventoryResults.shift() ?? { success: true, result: [] }
    })
    mocks.state.clients.push(this)
  }),
}))

import { ensureSessionHostReady, listHostedCliRuntimes } from '../src/session-host/runtime-support'

describe('session host runtime support compatibility', () => {
  beforeEach(() => {
    mocks.state.connectResults = []
    mocks.state.diagnosticsResults = []
    mocks.state.clients = []
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
})


describe('assistant runtime provenance inventory', () => {
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
