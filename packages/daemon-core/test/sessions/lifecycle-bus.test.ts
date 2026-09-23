import { describe, expect, it } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import type { BusEvent } from '../../src/sessions/lifecycle-events.js'

function facts(sessionId: string): BusEvent {
  return { kind: 'daemon_facts', at: 0, cause: 'provider_detection', sessionId }
}

function meshState(meshId: string): BusEvent {
  return { kind: 'mesh_state', at: 0, meshId }
}

function tag(event: BusEvent): string {
  if (event.kind === 'daemon_facts') return `facts:${event.sessionId}`
  if (event.kind === 'mesh_state') return `mesh:${event.meshId}`
  return event.kind
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('SessionLifecycleBus', () => {
  it('isolates a throwing subscriber: later subscribers still run and the error is counted and logged', () => {
    const logs: string[] = []
    const bus = createSessionLifecycleBus({ log: (m) => logs.push(m) })
    const seen: string[] = []
    bus.on('daemon_facts', () => { seen.push('a') }, { name: 'a' })
    bus.on('daemon_facts', () => { throw new Error('boom') }, { name: 'thrower' })
    bus.on('daemon_facts', () => { seen.push('c') }, { name: 'c' })

    bus.emit(facts('s1'))
    bus.emit(facts('s2'))

    expect(seen).toEqual(['a', 'c', 'a', 'c'])
    const stats = bus.stats()
    expect(stats.handlerErrors).toBe(2)
    expect(stats.handlerErrorsBySubscriber).toEqual({ thrower: 2 })
    // Throttled: one log line per subscriber+kind per interval.
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('thrower')
    expect(logs[0]).toContain('boom')
  })

  it('delivers matching kinds only, in registration order, and "*" receives everything', () => {
    const bus = createSessionLifecycleBus()
    const seen: string[] = []
    bus.on('mesh_state', (e) => { seen.push(`m1:${e.meshId}`) })
    bus.on('*', (e) => { seen.push(`all:${tag(e)}`) })
    bus.on(['mesh_state', 'daemon_facts'], (e) => { seen.push(`both:${tag(e)}`) })

    bus.emit(facts('x'))
    bus.emit(meshState('m'))

    expect(seen).toEqual(['all:facts:x', 'both:facts:x', 'm1:m', 'all:mesh:m', 'both:mesh:m'])
    expect(bus.stats().emittedByKind.daemon_facts).toBe(1)
    expect(bus.stats().emitted).toBe(2)
  })

  it('queues re-entrant emits FIFO after the current fan-out, so all subscribers see one global order', () => {
    const bus = createSessionLifecycleBus()
    const first: string[] = []
    const second: string[] = []
    bus.on('*', (e) => {
      first.push(tag(e))
      if (tag(e) === 'facts:A') {
        bus.emit(facts('B'))
        bus.emit(facts('C'))
      }
    })
    bus.on('*', (e) => {
      second.push(tag(e))
      if (tag(e) === 'facts:B') bus.emit(facts('D'))
    })

    bus.emit(facts('A'))

    expect(first).toEqual(['facts:A', 'facts:B', 'facts:C', 'facts:D'])
    expect(second).toEqual(first)
  })

  it('unsubscribe stops delivery, including for the rest of an in-flight fan-out', () => {
    const bus = createSessionLifecycleBus()
    const seen: string[] = []
    let offB: () => void = () => {}
    const offA = bus.on('daemon_facts', () => {
      seen.push('a')
      offB()
    })
    offB = bus.on('daemon_facts', () => { seen.push('b') })

    bus.emit(facts('1'))
    expect(seen).toEqual(['a'])

    offA()
    offA() // idempotent
    bus.emit(facts('2'))
    expect(seen).toEqual(['a'])
  })

  it('async lane runs serially per subscriber and drops the OLDEST pending beyond maxPending', async () => {
    const bus = createSessionLifecycleBus()
    const handled: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    bus.onAsync('daemon_facts', async (e) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (e.sessionId === '1') await gate
      handled.push(e.sessionId ?? '')
      inFlight -= 1
    }, { name: 'slow', maxPending: 2 })

    bus.emit(facts('1'))      // picked up by the pump (not pending once it starts)
    await flush()
    bus.emit(facts('2'))
    bus.emit(facts('3'))
    bus.emit(facts('4'))      // overflow: '2' (oldest pending) is dropped
    expect(bus.stats().asyncPending).toEqual({ slow: 2 })
    expect(bus.stats().dropped).toBe(1)
    expect(bus.stats().droppedBySubscriber).toEqual({ slow: 1 })

    release()
    await flush()
    await flush()
    expect(handled).toEqual(['1', '3', '4'])
    expect(maxInFlight).toBe(1)
  })

  it('async lane does not run the handler inside emit and counts rejections', async () => {
    const bus = createSessionLifecycleBus({ log: () => {} })
    const handled: string[] = []
    bus.onAsync('mesh_state', async (e) => {
      if (e.meshId === 'bad') throw new Error('nope')
      handled.push(e.meshId)
    }, { name: 'async' })

    bus.emit(meshState('bad'))
    bus.emit(meshState('good'))
    expect(handled).toEqual([])
    await flush()
    expect(handled).toEqual(['good'])
    expect(bus.stats().handlerErrorsBySubscriber).toEqual({ async: 1 })
  })

  it('close() rejects further emits, drains nothing, and refuses new subscribers', async () => {
    const bus = createSessionLifecycleBus()
    const syncSeen: string[] = []
    const asyncSeen: string[] = []
    bus.on('daemon_facts', (e) => {
      syncSeen.push(e.sessionId ?? '')
      if (e.sessionId === 'first') {
        bus.emit(facts('queued'))
        bus.close()
      }
    })
    bus.onAsync('daemon_facts', async (e) => { asyncSeen.push(e.sessionId ?? '') })

    bus.emit(facts('first'))
    bus.emit(facts('after'))
    await flush()

    expect(syncSeen).toEqual(['first'])
    expect(asyncSeen).toEqual([])
    expect(bus.stats().closed).toBe(true)
    expect(bus.stats().rejectedAfterClose).toBe(1)
    expect(() => bus.on('daemon_facts', () => {})).toThrow(/closed/)
    expect(() => bus.onAsync('daemon_facts', async () => {})).toThrow(/closed/)
  })
})
