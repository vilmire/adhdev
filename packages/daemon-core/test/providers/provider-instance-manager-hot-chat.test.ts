import { describe, expect, it, vi } from 'vitest'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'
import { IdeProviderInstance } from '../../src/providers/ide-provider-instance.js'

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

  it('projects unread, inbox bucket, and last message metadata from fallback provider state', async () => {
    const manager = new ProviderInstanceManager()
    const getState = vi.fn(() => ({
      type: 'hermes-cli',
      name: 'Hermes',
      category: 'cli',
      status: 'idle',
      activeChat: { status: 'idle', lastMessageAt: 1234 },
      instanceId: 'runtime-1',
      unread: true,
      inboxBucket: 'task_complete',
      runtime: {
        lifecycle: 'running',
        surfaceKind: 'live_runtime',
      },
      lastUpdated: 1,
      settings: {},
      pendingEvents: [],
    }))
    const instance = createInstance({ getState })

    await manager.addInstance('runtime-1', instance, { settings: {} })

    expect(manager.collectHotChatSessionStates()).toEqual([
      expect.objectContaining({
        id: 'runtime-1',
        status: 'idle',
        unread: true,
        inboxBucket: 'task_complete',
        lastMessageAt: 1234,
        runtimeLifecycle: 'running',
        runtimeSurfaceKind: 'live_runtime',
      }),
    ])
  })
})

describe('ProviderInstanceManager session modal projection lookup', () => {
  it('uses the direct subscribed session projection without rich getState', async () => {
    const manager = new ProviderInstanceManager()
    const getSessionModalState = vi.fn(() => ({
      id: 'runtime-1',
      status: 'waiting_approval',
      title: 'Hermes',
      activeModal: { message: 'Approve?', buttons: ['Approve', 'Reject'] },
    }))
    const instance = createInstance({ getSessionModalState })

    await manager.addInstance('runtime-1', instance, { settings: {} })

    expect(manager.getSessionModalState('runtime-1')).toEqual(expect.objectContaining({
      id: 'runtime-1',
      status: 'waiting_approval',
    }))
    expect(getSessionModalState).toHaveBeenCalledWith('runtime-1')
    expect(instance.getState).not.toHaveBeenCalled()
  })

  it('uses the registered owner instance key to project cdp-webview session modal state', async () => {
    const manager = new ProviderInstanceManager()
    const getSessionModalState = vi.fn((sessionId: string) => sessionId === 'ext-session'
      ? {
          id: 'ext-session',
          status: 'waiting_approval',
          title: 'Cline task',
          activeModal: { message: 'Approve webview?', buttons: ['Approve'] },
        }
      : null)
    const owner = createInstance({ category: 'ide', type: 'cursor', instanceId: 'ide-session', getSessionModalState })

    await manager.addInstance('ide:cursor:123', owner, { settings: {} })

    expect(manager.getSessionModalState('ext-session', { instanceKey: 'ide:cursor:123' })).toEqual(expect.objectContaining({
      id: 'ext-session',
      status: 'waiting_approval',
    }))
    expect(getSessionModalState).toHaveBeenCalledWith('ext-session')
    expect(owner.getState).not.toHaveBeenCalled()
  })

  it('drops thrown or mismatched modal projections instead of surfacing the wrong session', async () => {
    const manager = new ProviderInstanceManager()
    const mismatched = createInstance({
      getSessionModalState: vi.fn(() => ({ id: 'other-session', status: 'waiting_approval' })),
    })
    const throwing = createInstance({
      getSessionModalState: vi.fn(() => { throw new Error('projection failed') }),
    })

    await manager.addInstance('runtime-1', mismatched, { settings: {} })
    await manager.addInstance('runtime-2', throwing, { settings: {} })

    expect(manager.getSessionModalState('runtime-1')).toBeNull()
    expect(manager.getSessionModalState('runtime-2')).toBeNull()
    expect(mismatched.getState).not.toHaveBeenCalled()
    expect(throwing.getState).not.toHaveBeenCalled()
  })
})

describe('IDE session modal projection lookup', () => {
  it('projects extension session modal state by explicit runtime session id without building provider state', async () => {
    const ide = new IdeProviderInstance({
      type: 'cursor',
      name: 'Cursor',
      category: 'ide',
      controls: [],
    } as any)
    await ide.init({ settings: {} })
    await ide.addExtension({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
      controls: [],
    } as any)
    const extension = ide.getExtension('cline')!
    const extensionSessionId = extension.getInstanceId()

    ide.onEvent('stream_update', {
      extensionType: 'cline',
      status: 'waiting_approval',
      title: 'Cline approval',
      activeModal: { message: 'Approve extension action?', buttons: ['Approve', 'Reject'] },
    })

    expect((ide as any).getSessionModalState(extensionSessionId)).toEqual({
      id: extensionSessionId,
      status: 'waiting_approval',
      title: 'Cline approval',
      activeModal: { message: 'Approve extension action?', buttons: ['Approve', 'Reject'] },
    })
  })
})
