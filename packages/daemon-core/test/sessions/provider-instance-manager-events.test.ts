import { describe, expect, it } from 'vitest'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'
import type { InstanceContext, ProviderEvent, ProviderInstance, ProviderState } from '../../src/providers/provider-instance.js'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import type { EventOf } from '../../src/sessions/lifecycle-events.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { createSessionEventPort } from '../../src/sessions/session-port.js'

function fakeInstance(type: string, pendingEvents: ProviderEvent[] = []) {
  let context: InstanceContext | null = null
  const instance: ProviderInstance & { context(): InstanceContext | null } = {
    type,
    category: 'cli',
    async init(ctx) { context = ctx },
    async onTick() {},
    getState(): ProviderState {
      const events = pendingEvents.splice(0)
      return {
        type, name: type, category: 'cli', mode: 'chat', status: 'idle', activeChat: null,
        instanceId: `${type}-1`, workspace: '/w', lastUpdated: 0, settings: {}, pendingEvents: events,
      }
    },
    onEvent() {},
    dispose() {},
    context: () => context,
  }
  return instance
}

describe('ProviderInstanceManager event root', () => {
  // Wiring-unification B5: there is no listener array and no pendingEvents
  // drain any more. Every provider event reaches consumers as the bus's
  // `provider_event` (the bus isolates each subscriber — lifecycle-bus.test.ts);
  // `onEvent` survives only as a deprecated adapter over that subscription.
  it('the state drain publishes nothing — buffered pendingEvents never reach the bus from collectAllStates', async () => {
    const manager = new ProviderInstanceManager()
    const bus = createSessionLifecycleBus()
    const onBus: string[] = []
    bus.on('provider_event', (e) => { onBus.push(e.event.event) })
    manager.attachBus(bus)
    await manager.addInstance('s2', fakeInstance('codex-cli', [{ event: 'agent:ready', timestamp: 2 }]), { settings: {} })
    manager.collectAllStates()
    expect(onBus).toEqual([])
  })

  it('onEvent is a bus adapter: delivers through the attached bus and unsubscribes', () => {
    const manager = new ProviderInstanceManager()
    const seen: string[] = []
    expect(() => manager.onEvent(() => {})()).not.toThrow() // no bus: a no-op subscription
    manager.attachBus(createSessionLifecycleBus())
    const off = manager.onEvent((e) => { seen.push(e.event) })
    manager.emitProviderEvent('claude-cli', 's1', { event: 'a', timestamp: 1 })
    off()
    off()
    manager.emitProviderEvent('claude-cli', 's1', { event: 'b', timestamp: 2 })
    expect(seen).toEqual(['a'])
  })

  it('forwards every emitted provider event to an attached bus as provider_event', async () => {
    const manager = new ProviderInstanceManager()
    const bus = createSessionLifecycleBus()
    const onBus: EventOf<'provider_event'>[] = []
    bus.on('provider_event', (e) => { onBus.push(e) })

    manager.emitProviderEvent('claude-cli', 's1', { event: 'before-attach', timestamp: 0 })
    manager.attachBus(bus)
    manager.emitProviderEvent('claude-cli', 's1', { event: 'agent:generating_started', timestamp: 1, targetSessionId: 'child' })
    await manager.addInstance('s2', fakeInstance('codex-cli'), { settings: {} })
    manager.emitProviderEvent('codex-cli', 's2', { event: 'agent:ready', timestamp: 2 })

    expect(onBus.map((e) => [e.sessionId, e.event.event, e.event.providerType])).toEqual([
      ['child', 'agent:generating_started', 'claude-cli'],
      ['s2', 'agent:ready', 'codex-cli'],
    ])

    manager.attachBus(null)
    manager.emitProviderEvent('claude-cli', 's1', { event: 'after-detach', timestamp: 3 })
    expect(onBus).toHaveLength(2)
  })

  it('injects the session event port into instances added after setSessionEventPort', async () => {
    const manager = new ProviderInstanceManager()
    const before = fakeInstance('a')
    await manager.addInstance('a', before, { settings: {} })

    const bus = createSessionLifecycleBus()
    const port = createSessionEventPort(bus, new SessionRegistry(bus))
    manager.setSessionEventPort(port)
    const after = fakeInstance('b')
    await manager.addInstance('b', after, { settings: {} })

    expect(before.context()?.lifecycle).toBeUndefined()
    expect(after.context()?.lifecycle).toBe(port)
    expect(typeof after.context()?.emitProviderEvent).toBe('function')
  })

  it('hands the port to already-live instances through their optional setter', async () => {
    const manager = new ProviderInstanceManager()
    const received: unknown[] = []
    const live = Object.assign(fakeInstance('live'), { setSessionEventPort(port: unknown) { received.push(port) } })
    await manager.addInstance('live', live, { settings: {} })
    await manager.addInstance('legacy', fakeInstance('legacy'), { settings: {} }) // no setter: skipped

    const bus = createSessionLifecycleBus()
    const port = createSessionEventPort(bus, new SessionRegistry(bus))
    manager.setSessionEventPort(port)
    manager.setSessionEventPort(null)
    expect(received).toEqual([port, null])
  })
})
