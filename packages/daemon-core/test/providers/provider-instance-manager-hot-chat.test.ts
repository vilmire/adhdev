import { describe, expect, it, vi } from 'vitest'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'

function createInstance(overrides: Record<string, any> = {}) {
  return {
    type: overrides.type || 'hermes-cli',
    category: overrides.category || 'cli',
    init: vi.fn(async () => {}),
    onTick: vi.fn(async () => {}),
    getState: vi.fn(() => ({
      type: overrides.type || 'hermes-cli',
      name: 'Hermes',
      category: overrides.category || 'cli',
      status: overrides.status || 'generating',
      activeChat: null,
      instanceId: overrides.instanceId || 'runtime-1',
      lastUpdated: 1,
      settings: {},
      pendingEvents: [],
    })),
    onEvent: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as any
}

describe('ProviderInstanceManager hot chat session collection', () => {
  it('uses provider lightweight hot chat state without calling full getState', async () => {
    const manager = new ProviderInstanceManager()
    const getHotChatSessionState = vi.fn(() => ({
      id: 'runtime-1',
      status: 'generating',
      runtimeLifecycle: 'running',
      runtimeSurfaceKind: 'live_runtime',
    }))
    const instance = createInstance({ getHotChatSessionState })

    await manager.addInstance('runtime-1', instance, { settings: {} })

    expect(manager.collectHotChatSessionStates()).toEqual([
      expect.objectContaining({ id: 'runtime-1', status: 'generating' }),
    ])
    expect(getHotChatSessionState).toHaveBeenCalledTimes(1)
    expect(instance.getState).not.toHaveBeenCalled()
  })
})
