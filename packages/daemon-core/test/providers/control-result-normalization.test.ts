import { describe, expect, it } from 'vitest'
import {
  normalizeControlInvokeResult,
  normalizeControlListResult,
  normalizeControlSetResult,
} from '../../src/providers/control-effects.js'

describe('control result normalization', () => {
  it('passes through typed list results', () => {
    expect(normalizeControlListResult({
      options: [
        { value: 'gpt-4.1', label: 'GPT-4.1' },
        { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      ],
      currentValue: 'gpt-4.1',
    })).toEqual({
      options: [
        { value: 'gpt-4.1', label: 'GPT-4.1' },
        { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      ],
      currentValue: 'gpt-4.1',
    })
  })

  it('normalizes legacy model/mode arrays into typed option results', () => {
    expect(normalizeControlListResult({ models: ['opus', 'sonnet'], current: 'opus' })).toEqual({
      options: [
        { value: 'opus', label: 'opus' },
        { value: 'sonnet', label: 'sonnet' },
      ],
      currentValue: 'opus',
    })

    expect(normalizeControlListResult({ modes: [{ value: 'plan', name: 'Plan' }] })).toEqual({
      options: [{ value: 'plan', label: 'Plan' }],
    })
  })

  it('normalizes typed and legacy set results', () => {
    expect(normalizeControlSetResult({ ok: true, currentValue: 'opus' })).toEqual({
      ok: true,
      currentValue: 'opus',
    })

    expect(normalizeControlSetResult({ success: true })).toEqual({ ok: true })
  })

  it('normalizes typed and legacy invoke results', () => {
    expect(normalizeControlInvokeResult({ ok: true })).toEqual({ ok: true })
    expect(normalizeControlInvokeResult({ success: true, value: 'done' })).toEqual({
      ok: true,
      currentValue: 'done',
    })
  })
})
