import { describe, expect, it, vi } from 'vitest'

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
}))

import { setupMeshEventForwarding } from '../../src/mesh/mesh-events.js'

function createComponents() {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: 'runtime-session-1',
    workspace: '/repo/worktree-a',
    settings: {
      meshNodeFor: 'mesh_inline_1',
      meshNodeId: 'node_child_1',
    },
  }
  const coordinatorState = {
    instanceId: 'coordinator-session-1',
    workspace: '/repo/main',
    settings: {
      meshCoordinatorFor: 'mesh_inline_1',
    },
  }
  const source = {
    category: 'cli',
    getState: vi.fn(() => sourceState),
  }
  const coordinator = {
    category: 'cli',
    getState: vi.fn(() => coordinatorState),
    onEvent: vi.fn(),
  }
  const instanceManager = {
    onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
    getInstance: vi.fn((id: string) => id === 'runtime-session-1' ? source : undefined),
    getByCategory: vi.fn((category: string) => category === 'cli' ? [source, coordinator] : []),
  }

  return {
    components: { instanceManager } as any,
    emit: (event: any) => {
      if (!listener) throw new Error('listener was not registered')
      listener(event)
    },
    coordinator,
  }
}

describe('setupMeshEventForwarding', () => {
  it('forwards delegated completion to the matching coordinator using runtime mesh settings without local mesh config', () => {
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
    const { components, emit, coordinator } = createComponents()

    setupMeshEventForwarding(components)
    emit({
      event: 'agent:generating_completed',
      instanceId: 'runtime-session-1',
      targetSessionId: 'runtime-session-1',
      providerType: 'hermes-cli',
      providerSessionId: 'provider-history-1',
      duration: 7,
      timestamp: 123,
    })

    expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
    const [eventName, payload] = coordinator.onEvent.mock.calls[0]
    expect(eventName).toBe('send_message')
    const text = payload.input.textFallback
    expect(text).toContain("Node 'node_child_1'")
    expect(text).toContain('session_id=runtime-session-1')
    expect(text).toContain('provider_session_id=provider-history-1')
    expect(text).toContain('provider=hermes-cli')
    expect(text).toContain('mesh_read_chat')
  })
})
