import { describe, expect, it } from 'vitest'
import { resolveProviderSourceMode } from '../../src/config/config.js'

describe('resolveProviderSourceMode', () => {
  it('defaults to normal', () => {
    expect(resolveProviderSourceMode(undefined, undefined)).toBe('normal')
  })

  it('maps legacy disableUpstream=true to no-upstream', () => {
    expect(resolveProviderSourceMode(undefined, true)).toBe('no-upstream')
  })

  it('maps legacy disableUpstream=false to normal', () => {
    expect(resolveProviderSourceMode(undefined, false)).toBe('normal')
  })

  it('prefers explicit providerSourceMode over legacy disableUpstream', () => {
    expect(resolveProviderSourceMode('normal', true)).toBe('normal')
    expect(resolveProviderSourceMode('no-upstream', false)).toBe('no-upstream')
  })
})
