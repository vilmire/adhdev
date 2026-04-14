import { describe, expect, it } from 'vitest'
import { normalizeProviderScriptArgs } from '../../src/commands/stream-commands.js'

describe('normalizeProviderScriptArgs', () => {
  it('derives model aliases from generic value payloads for setModel scripts', () => {
    expect(normalizeProviderScriptArgs({ value: 'gpt-5' }, 'setModel')).toMatchObject({
      value: 'gpt-5',
      VALUE: 'gpt-5',
      model: 'gpt-5',
      MODEL: 'gpt-5',
    })
  })

  it('derives mode aliases from generic value payloads for setMode scripts', () => {
    expect(normalizeProviderScriptArgs({ value: 'plan' }, 'setMode')).toMatchObject({
      value: 'plan',
      VALUE: 'plan',
      mode: 'plan',
      MODE: 'plan',
    })
  })

  it('keeps non-model controls as generic value-only payloads', () => {
    expect(normalizeProviderScriptArgs({ value: 'high' }, 'setEffort')).toEqual({
      value: 'high',
      VALUE: 'high',
    })
  })
})
