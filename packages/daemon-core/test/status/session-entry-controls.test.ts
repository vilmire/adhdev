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
        category: 'ide',
        type: 'cursor',
        name: 'Cursor',
        instanceId: 'ide-1',
        status: 'idle',
        workspace: '/repo',
        currentAutoApprove: 'auto',
        activeChat: null,
        extensions: [],
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
    const ideSession = sessions.find((session) => session.id === 'ide-1')
    const acpSession = sessions.find((session) => session.id === 'acp-1')

    expect(cliSession?.providerControls).toBeUndefined()
    expect(cliSession).not.toHaveProperty('currentModel')
    expect(cliSession).not.toHaveProperty('currentPlan')
    expect(ideSession).not.toHaveProperty('currentAutoApprove')
    expect(ideSession).not.toHaveProperty('currentModel')
    expect(acpSession?.providerControls).toBeUndefined()
    expect(acpSession).not.toHaveProperty('currentModel')
    expect(acpSession).not.toHaveProperty('currentPlan')
    expect(acpSession).not.toHaveProperty('acpModes')
    expect(acpSession).not.toHaveProperty('acpConfigOptions')
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

  it('omits empty controlValues from the public session surface', () => {
    const sessions = buildSessionEntries([
      {
        category: 'cli',
        type: 'codex',
        name: 'Codex',
        instanceId: 'cli-empty-controls',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        activeChat: null,
        controlValues: {},
        providerControls: [
          { id: 'model', type: 'select', label: 'Model', placement: 'bar' },
        ],
      } as any,
      {
        category: 'ide',
        type: 'cursor',
        name: 'Cursor',
        instanceId: 'ide-empty-controls',
        status: 'idle',
        workspace: '/repo',
        activeChat: null,
        extensions: [],
        controlValues: {},
        providerControls: [
          { id: 'mode', type: 'select', label: 'Mode', placement: 'bar' },
        ],
      } as any,
      {
        category: 'acp',
        type: 'claude-acp',
        name: 'Claude ACP',
        instanceId: 'acp-empty-controls',
        status: 'idle',
        workspace: '/repo',
        activeChat: null,
        controlValues: {},
        providerControls: [
          { id: 'mode', type: 'select', label: 'Mode', placement: 'bar' },
        ],
      } as any,
    ], new Map(), { profile: 'full' })

    for (const session of sessions) {
      expect(session).not.toHaveProperty('controlValues')
    }
  })

  it('passes through flexible summary metadata without reintroducing top-level current fields', () => {
    const sessions = buildSessionEntries([
      {
        category: 'acp',
        type: 'codex-acp',
        name: 'Codex ACP',
        instanceId: 'acp-summary',
        status: 'idle',
        workspace: '/repo',
        mode: 'chat',
        activeChat: null,
        controlValues: {},
        providerControls: undefined,
        summaryMetadata: {
          items: [
            { id: 'model', label: 'Model', value: 'gpt-5', order: 20 },
            { id: 'profile', label: 'Profile', value: 'reasoning', order: 10 },
          ],
        },
      } as any,
    ], new Map(), { profile: 'live' })

    expect(sessions[0]?.summaryMetadata).toEqual({
      items: [
        { id: 'profile', label: 'Profile', value: 'reasoning', order: 10 },
        { id: 'model', label: 'Model', value: 'gpt-5', order: 20 },
      ],
    })
    expect(sessions[0]).not.toHaveProperty('currentModel')
    expect(sessions[0]).not.toHaveProperty('currentPlan')
  })
})
