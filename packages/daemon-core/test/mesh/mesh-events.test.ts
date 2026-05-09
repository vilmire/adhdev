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
    expect(text).toContain('status event path')
    expect(text).toContain('mesh_read_chat once')
    expect(text).toContain('do not poll repeatedly')
  })

  it('does not inject completion event when the completed session is a coordinator (meshCoordinatorFor set)', () => {
    // This reproduces the bug: a coordinator session completing on the same workspace
    // must not be forwarded back into another coordinator session.
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue({ id: 'mesh_inline_1', nodes: [] })

    let listener: ((event: any) => void) | undefined
    const coordinatorState = {
      instanceId: 'coordinator-session-self',
      workspace: '/repo/main',
      settings: { meshCoordinatorFor: 'mesh_inline_1' },
    }
    const coordinator = {
      category: 'cli',
      getState: vi.fn(() => coordinatorState),
      onEvent: vi.fn(),
    }
    const instanceManager = {
      onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
      getInstance: vi.fn(() => coordinator),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [coordinator] : []),
    }
    const components = { instanceManager } as any
    setupMeshEventForwarding(components)

    listener!({
      event: 'agent:generating_completed',
      instanceId: 'coordinator-session-self',
      targetSessionId: 'coordinator-session-self',
      providerType: 'hermes-cli',
    })

    expect(coordinator.onEvent).not.toHaveBeenCalled()
  })

  it('does not inject completion event for unrelated CLI sessions without mesh metadata', () => {
    // Sessions without meshNodeFor or launchedByCoordinator must not be forwarded,
    // even if getMeshByRepo returns a mesh for the same workspace.
    meshConfigMocks.getMesh.mockReturnValue(undefined)
    meshConfigMocks.getMeshByRepo.mockReturnValue({ id: 'mesh_inline_1', nodes: [] })

    let listener: ((event: any) => void) | undefined
    const unrelatedState = {
      instanceId: 'unrelated-session-1',
      workspace: '/repo/main',
      settings: {}, // no meshNodeFor, no launchedByCoordinator
    }
    const coordinatorState = {
      instanceId: 'coordinator-session-1',
      workspace: '/repo/main',
      settings: { meshCoordinatorFor: 'mesh_inline_1' },
    }
    const unrelated = {
      category: 'cli',
      getState: vi.fn(() => unrelatedState),
      onEvent: vi.fn(),
    }
    const coordinator = {
      category: 'cli',
      getState: vi.fn(() => coordinatorState),
      onEvent: vi.fn(),
    }
    const instanceManager = {
      onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
      getInstance: vi.fn((id: string) => id === 'unrelated-session-1' ? unrelated : undefined),
      getByCategory: vi.fn((category: string) => category === 'cli' ? [unrelated, coordinator] : []),
    }
    const components = { instanceManager } as any
    setupMeshEventForwarding(components)

    listener!({
      event: 'agent:generating_completed',
      instanceId: 'unrelated-session-1',
      targetSessionId: 'unrelated-session-1',
      providerType: 'hermes-cli',
    })

    expect(coordinator.onEvent).not.toHaveBeenCalled()
  })
})
