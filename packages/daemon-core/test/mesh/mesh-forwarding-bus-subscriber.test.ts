/**
 * B4: mesh event forwarding is a lifecycle-bus `provider_event` subscriber
 * (plan §1.4d) — not an `instanceManager.onEvent` listener — when the
 * components carry a bus, and its disposer unsubscribes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { setupMeshEventForwarding } from '../../src/mesh/mesh-events.js'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'

function readyEvent(instanceId: string) {
  return { kind: 'provider_event' as const, sessionId: instanceId, at: 1, event: { event: 'agent:ready', instanceId, targetSessionId: instanceId, providerType: 'claude-cli' } as any }
}

describe('setupMeshEventForwarding on the bus', () => {
  it('subscribes to provider_event (not instanceManager.onEvent) and unsubscribes on dispose', () => {
    const bus = createSessionLifecycleBus()
    const getInstance = vi.fn(() => undefined)
    const onEvent = vi.fn()
    const components = { bus, instanceManager: { getInstance, onEvent, getByCategory: () => [] } } as any

    const dispose = setupMeshEventForwarding(components)
    expect(onEvent).not.toHaveBeenCalled()

    bus.emit(readyEvent('sess-a'))
    // The coordinator idle fast-path looks the instance up first.
    expect(getInstance).toHaveBeenCalledWith('sess-a')

    dispose()
    getInstance.mockClear()
    bus.emit(readyEvent('sess-b'))
    expect(getInstance).not.toHaveBeenCalled()
    expect(bus.stats().handlerErrors).toBe(0)
  })
})
