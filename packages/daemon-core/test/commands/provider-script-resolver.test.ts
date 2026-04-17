import { describe, expect, it } from 'vitest'
import { resolveLegacyProviderScript } from '../../src/commands/provider-script-resolver.js'

describe('resolveLegacyProviderScript', () => {
  it('passes object params through for modern control wrappers like setMode', () => {
    const fn = (params?: Record<string, unknown> | string) =>
      `mode=${String(typeof params === 'string' ? '' : (params?.MODE ?? params?.mode ?? params?.value ?? ''))}`

    expect(resolveLegacyProviderScript(fn, 'setMode', { mode: 'Ask before edits' })).toBe('mode=Ask before edits')
    expect(resolveLegacyProviderScript(fn, 'setMode', { MODE: 'Plan mode' })).toBe('mode=Plan mode')
  })

  it('still supports legacy sendMessage wrappers that expect a raw string', () => {
    const fn = (params?: Record<string, unknown> | string) =>
      typeof params === 'string' ? `message=${params}` : null

    expect(resolveLegacyProviderScript(fn, 'sendMessage', { message: 'hello world' })).toBe('message=hello world')
  })

  it('falls back to the first scalar value when object invocation leaks [object Object]', () => {
    const fn = (params?: Record<string, unknown> | string) => {
      if (typeof params === 'string') return `legacy=${params}`
      return `broken=${String(params)}`
    }

    expect(resolveLegacyProviderScript(fn, 'setMode', { mode: 'Edit automatically' })).toBe('legacy=Edit automatically')
  })
})