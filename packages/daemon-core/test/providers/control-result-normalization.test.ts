import { describe, expect, it } from 'vitest'
import {
  extractProviderControlValues,
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

  it('normalizes legacy model objects that only expose name + selected flags', () => {
    expect(normalizeControlListResult({
      models: [
        { name: 'GPT-5.4', selected: true },
        { name: 'GPT-5.4-Mini', selected: false },
      ],
      current: 'GPT-5.4',
    })).toEqual({
      options: [
        { value: 'GPT-5.4', label: 'GPT-5.4' },
        { value: 'GPT-5.4-Mini', label: 'GPT-5.4-Mini' },
      ],
      currentValue: 'GPT-5.4',
    })
  })

  it('does not inject implicit model/mode control values without schema mapping', () => {
    expect(extractProviderControlValues([], { model: 'opus', mode: 'plan' })).toBeUndefined()

    expect(extractProviderControlValues([
      { id: 'model', type: 'select', label: 'Model', placement: 'bar', readFrom: 'model' },
      { id: 'mode', type: 'select', label: 'Mode', placement: 'bar', readFrom: 'mode' },
    ], { model: 'opus', mode: 'plan' })).toEqual({
      model: 'opus',
      mode: 'plan',
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
