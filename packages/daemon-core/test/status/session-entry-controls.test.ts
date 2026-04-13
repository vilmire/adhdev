import { describe, expect, it } from 'vitest'
import { buildSessionEntries } from '../../src/status/builders.js'

describe('buildSessionEntries control schema output', () => {
  it('does not synthesize fallback controls from legacy model/mode state', () => {
    const sessions = buildSessionEntries([
      {
        category: 'cli',
        type: 'gemini-cli',
        name: 'Gemini CLI',
        instanceId: 'cli-1',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        currentModel: 'gemini-2.5-pro',
        currentPlan: 'plan',
        activeChat: null,
        controlValues: {},
        providerControls: undefined,
      } as any,
      {
        category: 'acp',
        type: 'codex-acp',
        name: 'Codex ACP',
        instanceId: 'acp-1',
        status: 'idle',
        workspace: '/repo',
        currentModel: 'gpt-5',
        currentPlan: 'plan',
        acpConfigOptions: [{ category: 'model', configId: 'model', options: [{ value: 'gpt-5', name: 'GPT-5' }] }],
        acpModes: [{ id: 'plan', name: 'Plan' }],
        activeChat: null,
        controlValues: {},
        providerControls: undefined,
      } as any,
    ], new Map(), { profile: 'full' })

    const cliSession = sessions.find((session) => session.id === 'cli-1')
    const acpSession = sessions.find((session) => session.id === 'acp-1')

    expect(cliSession?.providerControls).toBeUndefined()
    expect(acpSession?.providerControls).toBeUndefined()
  })

  it('preserves explicit provider controls without synthesizing replacements', () => {
    const sessions = buildSessionEntries([
      {
        category: 'cli',
        type: 'gemini-cli',
        name: 'Gemini CLI',
        instanceId: 'cli-2',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        currentModel: 'gemini-2.5-pro',
        currentPlan: 'plan',
        activeChat: null,
        providerControls: [
          { id: 'model', type: 'select', label: 'Model', placement: 'bar' },
        ],
        controlValues: { model: 'gemini-2.5-pro' },
      } as any,
    ], new Map(), { profile: 'full' })

    expect(sessions[0]?.providerControls).toEqual([
      { id: 'model', type: 'select', label: 'Model', placement: 'bar' },
    ])
  })
})
