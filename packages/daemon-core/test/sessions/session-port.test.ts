import { describe, expect, it } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import type { BusEvent } from '../../src/sessions/lifecycle-events.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { createSessionEventPort } from '../../src/sessions/session-port.js'

function setup() {
  const bus = createSessionLifecycleBus()
  const events: BusEvent[] = []
  bus.on('*', (e) => { events.push(e) })
  const registry = new SessionRegistry(bus, () => 7)
  const port = createSessionEventPort(bus, registry, { now: () => 42 })
  registry.register({ sessionId: 's1', parentSessionId: null, providerType: 'codex-cli', transport: 'pty', workspace: '/repo' }, 'launch')
  events.length = 0
  return { events, registry, port }
}

describe('SessionEventPort', () => {
  it('exited routes through the registry: one terminated{cause:pty_exit} carrying the tombstone', () => {
    const { events, registry, port } = setup()
    const termination = { exitCode: null, signal: 9, reason: 'signal' as const, lifecycle: 'failed' as const, terminatedAt: 3 }

    port.exited('s1', termination, { autoApprove: true })
    port.exited('s1', termination, { autoApprove: true })

    expect(events).toEqual([{
      kind: 'terminated',
      sessionId: 's1',
      at: 7,
      cause: 'pty_exit',
      providerType: 'codex-cli',
      workspace: '/repo',
      runtimeSettings: { autoApprove: true },
      termination,
    }])
    expect(registry.has('s1')).toBe(false)
  })

  it('exited for an unregistered session emits nothing', () => {
    const { events, port } = setup()
    port.exited('ghost', undefined, {})
    expect(events).toEqual([])
  })

  it('status fills providerType from the registry and ignores non-edges', () => {
    const { events, port } = setup()
    port.status('s1', 'idle', 'idle', 'fsm_state')
    port.status('s1', 'idle', 'generating', 'fsm_state')
    port.status('other', 'generating', 'idle', 'ide_poll', 'cursor')
    port.status('unknown', 'generating', 'idle', 'ide_poll')

    expect(events).toEqual([
      { kind: 'status', sessionId: 's1', at: 42, providerType: 'codex-cli', prev: 'idle', next: 'generating', cause: 'fsm_state' },
      { kind: 'status', sessionId: 'other', at: 42, providerType: 'cursor', prev: 'generating', next: 'idle', cause: 'ide_poll' },
      { kind: 'status', sessionId: 'unknown', at: 42, providerType: 'unknown', prev: 'generating', next: 'idle', cause: 'ide_poll' },
    ])
  })

  it('modal / prompt / signal / providerEvent emit their kinds verbatim', () => {
    const { events, port } = setup()
    port.modal('s1', null)
    port.prompt('s1', null, null)
    const signal = { ruleId: 'r', kind: 'rate_limit' as const, params: {}, detectedAt: 1 }
    port.signal('s1', { providerType: 'codex-cli', runtimeSettings: {}, signal })
    port.providerEvent('s1', { event: 'agent:ready', timestamp: 1, providerType: 'codex-cli' })

    expect(events.map((e) => e.kind)).toEqual(['modal', 'prompt', 'signal', 'provider_event'])
    expect(events[2]).toMatchObject({ sessionId: 's1', signal, providerType: 'codex-cli' })
  })
})
