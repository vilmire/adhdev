import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDebugTrace,
  configureDebugTraceStore,
  createDebugTraceStore,
  getRecentDebugTrace,
  recordDebugTrace,
  sanitizeTracePayload,
} from '../../src/logging/debug-trace'
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

  it('records always-on categories on the store even when disabled', () => {
    const store = createDebugTraceStore({ enabled: false, capacity: 10 })

    store.record({ category: 'completion-gate', stage: 'fire', level: 'debug', payload: { path: 'clean' } })
    store.record({ category: 'fsm-transition', stage: 'transition', level: 'debug', payload: { to: 'idle' } })
    // A non-always-on category is still dropped when disabled.
    store.record({ category: 'command', stage: 'received', level: 'info', payload: { ignored: true } })

    expect(store.list({ limit: 10 }).map((entry) => entry.category)).toEqual([
      'completion-gate',
      'fsm-transition',
    ])
  })
})

describe('recordDebugTrace always-on (production, collectDebugTrace=false)', () => {
  afterEach(() => {
    clearDebugTrace()
    resetDebugRuntimeConfig()
    configureDebugTraceStore()
  })

  it('stores completion-gate and retrieves it via getRecentDebugTrace, while blocking unrelated categories', () => {
    // Simulate a production daemon: --trace unset ⇒ collectDebugTrace=false.
    resetDebugRuntimeConfig()
    configureDebugTraceStore()

    const gate = recordDebugTrace({
      category: 'completion-gate',
      stage: 'fire',
      level: 'debug',
      sessionId: 'sess_1',
      payload: { path: 'clean', duration: 3 },
    })
    const fsm = recordDebugTrace({
      category: 'fsm-transition',
      stage: 'transition',
      level: 'debug',
      sessionId: 'sess_1',
      payload: { from: 'generating', to: 'idle' },
    })
    const unrelated = recordDebugTrace({
      category: 'command',
      stage: 'received',
      level: 'info',
      payload: { ignored: true },
    })

    expect(gate).not.toBeNull()
    expect(fsm).not.toBeNull()
    expect(unrelated).toBeNull()

    expect(getRecentDebugTrace({ category: 'completion-gate', limit: 10 })).toHaveLength(1)
    expect(getRecentDebugTrace({ category: 'fsm-transition', limit: 10 })).toHaveLength(1)
    expect(getRecentDebugTrace({ category: 'command', limit: 10 })).toHaveLength(0)
  })
})
