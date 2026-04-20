import { describe, expect, it, vi } from 'vitest'
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

  it('surfaces parser crashes as an error state instead of dropping to silent adapter fallback', () => {
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude CLI',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
    } as any, '/tmp/project') as any

    instance.adapter = {
      getStatus: () => ({
        status: 'idle',
        activeModal: null,
        messages: [{ role: 'assistant', content: 'stale transcript' }],
      }),
      getScriptParsedStatus: () => {
        throw new Error('parse exploded')
      },
      getRuntimeMetadata: () => null,
    }

    const state = instance.getState() as any
    expect(state.status).toBe('error')
    expect(state.errorReason).toBe('parse_error')
    expect(state.errorMessage).toContain('parse exploded')
    expect(state.activeChat.messages).toEqual([
      expect.objectContaining({ content: 'stale transcript' }),
    ])
  })

  it('does not surface parsed idle chat status while the adapter still reports generating', () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
    } as any, '/tmp/project') as any

    instance.adapter = {
      getStatus: () => ({ status: 'generating', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        title: 'project',
        status: 'idle',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'done' },
        ],
      }),
      getRuntimeMetadata: () => null,
    }
    instance.historyWriter = { appendNewMessages: vi.fn() }

    const state = instance.getState() as any
    expect(state.status).toBe('generating')
    expect(state.activeChat.status).toBe('generating')
    expect(state.activeChat.messages).toHaveLength(2)
    expect(state.activeChat.messages[1]).toEqual(expect.objectContaining({ content: 'done' }))
  })

  it('keeps all runtime overlay messages instead of slicing the live chat tail to 50', () => {
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude CLI',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
    } as any, '/tmp/project') as any

    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({ title: 'project', status: 'idle', messages: [] }),
      getRuntimeMetadata: () => null,
    }
    instance.historyWriter = { appendNewMessages: () => {} }

    for (let index = 0; index < 60; index += 1) {
      instance.appendRuntimeSystemMessage(`runtime-${index + 1}`, `runtime:${index + 1}`, index + 1)
    }

    const state = instance.getState() as any
    expect(state.activeChat.messages).toHaveLength(60)
    expect(state.activeChat.messages[0]).toEqual(expect.objectContaining({ content: 'runtime-1' }))
    expect(state.activeChat.messages[59]).toEqual(expect.objectContaining({ content: 'runtime-60' }))
  })

  it('keeps all pending events until flush instead of silently slicing to 50', () => {
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude CLI',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
    } as any, '/tmp/project') as any

    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({ title: 'project', status: 'idle', messages: [] }),
      getRuntimeMetadata: () => null,
    }

    for (let index = 0; index < 60; index += 1) {
      instance.pushEvent({ event: 'provider:toast', effectId: `e-${index + 1}`, timestamp: index + 1, message: `toast-${index + 1}` })
    }

    const first = instance.getState() as any
    expect(first.pendingEvents).toHaveLength(60)
    expect(first.pendingEvents[0]).toEqual(expect.objectContaining({ message: 'toast-1' }))
    expect(first.pendingEvents[59]).toEqual(expect.objectContaining({ message: 'toast-60' }))

    const second = instance.getState() as any
    expect(second.pendingEvents).toEqual([])
  })
})
