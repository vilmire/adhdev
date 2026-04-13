import { describe, expect, it } from 'vitest'
import { resolveDebugRuntimeConfig } from '../../src/logging/debug-config'

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
