import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

describe('CliProviderInstance provider patch state', () => {
  it('accepts explicit controlValues from parsed status without requiring provider control schemas', () => {
    const instance = new CliProviderInstance({
      type: 'codex-cli',
      name: 'Codex CLI',
      category: 'cli',
      spawn: { command: 'codex', args: [] },
    } as any, '/tmp/project') as any

    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null }),
      getScriptParsedStatus: () => ({
        title: 'project',
        status: 'idle',
        messages: [],
        controlValues: { mode: 'plan' },
        summaryMetadata: {
          items: [{ id: 'mode', label: 'Mode', value: 'Plan', shortValue: 'plan', order: 20 }],
        },
      }),
      getRuntimeMetadata: () => null,
    }

    const state = instance.getState() as any
    expect(state.controlValues).toEqual({ mode: 'plan' })
    expect(state.summaryMetadata).toEqual({
      items: [{ id: 'mode', label: 'Mode', value: 'Plan', shortValue: 'plan', order: 20 }],
    })
  })

  it('derives legacy model and mode fields into the same control and summary shape as IDE/extension providers', () => {
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude CLI',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
    } as any, '/tmp/project') as any

    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null }),
      getScriptParsedStatus: () => ({
        title: 'project',
        status: 'idle',
        messages: [],
        model: 'sonnet',
        mode: 'plan',
      }),
      getRuntimeMetadata: () => null,
    }

    const state = instance.getState() as any
    expect(state.controlValues).toEqual({ model: 'sonnet', mode: 'plan' })
    expect(state.summaryMetadata).toEqual({
      items: [
        { id: 'model', label: 'Model', value: 'sonnet', shortValue: 'sonnet', order: 10 },
        { id: 'mode', label: 'Mode', value: 'plan', shortValue: 'plan', order: 20 },
      ],
    })
  })
})
