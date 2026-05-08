import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    connectResults: [] as Array<'ok' | 'fail'>,
    diagnosticsResults: [] as unknown[],
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
      return { success: true, result: [] }
    })
    mocks.state.clients.push(this)
  }),
}))

import { ensureSessionHostReady } from '../src/session-host/runtime-support'

describe('session host runtime support compatibility', () => {
  beforeEach(() => {
    mocks.state.connectResults = []
    mocks.state.diagnosticsResults = []
    mocks.state.clients = []
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
})
