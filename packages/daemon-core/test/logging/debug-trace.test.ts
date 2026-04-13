import { describe, expect, it } from 'vitest'
import { createDebugTraceStore, sanitizeTracePayload } from '../../src/logging/debug-trace'
import { resetDebugRuntimeConfig, setDebugRuntimeConfig } from '../../src/logging/debug-config'

describe('debug-trace', () => {
  it('keeps only the newest entries within capacity', () => {
    const store = createDebugTraceStore({ enabled: true, capacity: 2 })

    store.record({ category: 'command', stage: 'received', level: 'info', payload: { seq: 1 } })
    store.record({ category: 'command', stage: 'routed', level: 'info', payload: { seq: 2 } })
    store.record({ category: 'command', stage: 'completed', level: 'info', payload: { seq: 3 } })

    const entries = store.list({ limit: 10 })
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.payload)).toEqual([{ seq: 2 }, { seq: 3 }])
  })

  it('filters by interaction id and category', () => {
    resetDebugRuntimeConfig()
    setDebugRuntimeConfig({
      logLevel: 'debug',
      collectDebugTrace: true,
      traceContent: true,
      traceBufferSize: 100,
      traceCategories: [],
    })
    const store = createDebugTraceStore({ enabled: true, capacity: 10 })

    store.record({ interactionId: 'ix_a', category: 'command', stage: 'received', level: 'info', payload: { kind: 'a' } })
    store.record({ interactionId: 'ix_b', category: 'topic', stage: 'published', level: 'info', payload: { kind: 'b' } })
    store.record({ interactionId: 'ix_a', category: 'topic', stage: 'published', level: 'info', payload: { kind: 'c' } })

    expect(store.list({ interactionId: 'ix_a', limit: 10 }).map((entry) => entry.payload))
      .toEqual([{ kind: 'a' }, { kind: 'c' }])
    expect(store.list({ category: 'topic', limit: 10 }).map((entry) => entry.payload))
      .toEqual([{ kind: 'b' }, { kind: 'c' }])
  })

  it('does not record when disabled', () => {
    const store = createDebugTraceStore({ enabled: false, capacity: 10 })

    store.record({ category: 'command', stage: 'received', level: 'info', payload: { ignored: true } })

    expect(store.list({ limit: 10 })).toEqual([])
  })

  it('summarizes large content when traceContent is disabled', () => {
    resetDebugRuntimeConfig()
    setDebugRuntimeConfig({
      logLevel: 'info',
      collectDebugTrace: true,
      traceContent: false,
      traceBufferSize: 100,
      traceCategories: [],
    })

    const payload = sanitizeTracePayload({
      text: 'x'.repeat(50),
      nested: { message: 'hello world' },
    })

    expect(payload).toEqual({
      text: '[50 chars]',
      nested: { message: '[11 chars]' },
    })
  })

  it('preserves content when traceContent is enabled', () => {
    resetDebugRuntimeConfig()
    setDebugRuntimeConfig({
      logLevel: 'debug',
      collectDebugTrace: true,
      traceContent: true,
      traceBufferSize: 100,
      traceCategories: [],
    })

    const payload = sanitizeTracePayload({
      text: 'hello',
      nested: { message: 'world' },
    })

    expect(payload).toEqual({
      text: 'hello',
      nested: { message: 'world' },
    })
  })
})
