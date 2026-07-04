import { afterEach, describe, expect, it } from 'vitest'
import {
  isAlwaysOnTraceCategory,
  resetDebugRuntimeConfig,
  resolveDebugRuntimeConfig,
  setDebugRuntimeConfig,
  shouldCollectTraceCategory,
} from '../../src/logging/debug-config'

describe('debug-config', () => {
  it('keeps normal mode quiet by default', () => {
    const config = resolveDebugRuntimeConfig({})

    expect(config.logLevel).toBe('info')
    expect(config.collectDebugTrace).toBe(false)
    expect(config.traceContent).toBe(false)
    expect(config.traceBufferSize).toBeGreaterThan(0)
  })

  it('turns on debug trace defaults in dev mode', () => {
    const config = resolveDebugRuntimeConfig({ dev: true })

    expect(config.logLevel).toBe('debug')
    expect(config.collectDebugTrace).toBe(true)
    expect(config.traceContent).toBe(false)
    expect(config.traceBufferSize).toBeGreaterThan(200)
  })

  it('honors explicit overrides over dev defaults', () => {
    const config = resolveDebugRuntimeConfig({
      dev: true,
      logLevel: 'warn',
      trace: false,
      traceContent: true,
      traceBufferSize: 42,
      traceCategories: ['command', 'topic'],
    })

    expect(config.logLevel).toBe('warn')
    expect(config.collectDebugTrace).toBe(false)
    expect(config.traceContent).toBe(true)
    expect(config.traceBufferSize).toBe(42)
    expect(config.traceCategories).toEqual(['command', 'topic'])
  })
})

describe('shouldCollectTraceCategory always-on', () => {
  afterEach(() => {
    resetDebugRuntimeConfig()
  })

  it('flags the always-on categories', () => {
    expect(isAlwaysOnTraceCategory('completion-gate')).toBe(true)
    expect(isAlwaysOnTraceCategory('fsm-transition')).toBe(true)
    expect(isAlwaysOnTraceCategory('command')).toBe(false)
    expect(isAlwaysOnTraceCategory(undefined)).toBe(false)
    expect(isAlwaysOnTraceCategory(null)).toBe(false)
  })

  it('collects always-on categories even when collectDebugTrace is false', () => {
    resetDebugRuntimeConfig() // defaults: collectDebugTrace=false, traceCategories=[]

    expect(shouldCollectTraceCategory('completion-gate')).toBe(true)
    expect(shouldCollectTraceCategory('fsm-transition')).toBe(true)
    // Unrelated categories stay gated off in production.
    expect(shouldCollectTraceCategory('command')).toBe(false)
    expect(shouldCollectTraceCategory(undefined)).toBe(false)
  })

  it('keeps always-on categories as a superset of an explicit selection', () => {
    setDebugRuntimeConfig({
      logLevel: 'debug',
      collectDebugTrace: true,
      traceContent: false,
      traceBufferSize: 100,
      traceCategories: ['command'],
    })

    // Explicitly selected category still honored.
    expect(shouldCollectTraceCategory('command')).toBe(true)
    // Always-on categories included on top even though not selected.
    expect(shouldCollectTraceCategory('completion-gate')).toBe(true)
    expect(shouldCollectTraceCategory('fsm-transition')).toBe(true)
    // A category outside the selection (and not always-on) stays excluded.
    expect(shouldCollectTraceCategory('topic')).toBe(false)
  })
})
