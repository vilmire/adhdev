import { describe, expect, it, vi } from 'vitest'
import { handleChangeModel, handleSetThoughtLevel } from '../../src/commands/chat-commands-write.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { buildSessionLaunchRecord } from '../../src/sessions/launch-record.js'

// Phase E: a successful runtime change (change_model / set_thought_level)
// updates the addressed session's launch record — `current` + a history entry —
// and a failed one leaves it untouched.

function setup(opts: { withRecord?: boolean; setConfigOption?: (category: string, value: string) => Promise<void> } = {}) {
  const registry = new SessionRegistry()
  registry.register({ sessionId: 'acp-1', parentSessionId: null, providerType: 'x-acp', transport: 'acp', adapterKey: 'acp-1', instanceKey: 'acp-1' }, 'launch')
  if (opts.withRecord !== false) {
    registry.setLaunchRecord('acp-1', buildSessionLaunchRecord({
      sessionId: 'acp-1',
      providerType: 'x-acp',
      launchedBy: 'dashboard',
      launchedAt: 1,
      model: { requested: 'sonnet', declaredSource: 'user', launchValue: 'sonnet' },
      thinkingLevel: {},
    }))
  }
  const setConfigOption = vi.fn(opts.setConfigOption ?? (async () => {}))
  const h = {
    ctx: { sessionRegistry: registry },
    currentSession: registry.get('acp-1'),
    currentManagerKey: undefined,
    currentProviderType: 'x-acp',
    getProvider: () => ({ type: 'x-acp', category: 'acp' }),
    getCliAdapter: () => ({ cliType: 'x-acp', _acpInstance: { setConfigOption } }),
    getProviderScript: () => null,
  } as any
  return { registry, h, setConfigOption }
}

describe('change_model / set_thought_level → launch record', () => {
  it('change_model success sets current and appends change_model history; source is unchanged', async () => {
    const { registry, h } = setup()
    const result = await handleChangeModel(h, { targetSessionId: 'acp-1', model: 'opus' })
    expect(result).toMatchObject({ success: true })
    const model = registry.get('acp-1')!.launch!.model
    expect(model.current).toBe('opus')
    expect(model.source).toBe('user')
    expect(model.history.map((e) => [e.via, e.value])).toEqual([['launch', 'sonnet'], ['change_model', 'opus']])
  })

  it('a failed change leaves the record untouched', async () => {
    const { registry, h } = setup({ setConfigOption: async () => { throw new Error('no connection') } })
    await expect(handleChangeModel(h, { targetSessionId: 'acp-1', model: 'opus' })).rejects.toThrow('no connection')
    expect(registry.get('acp-1')!.launch!.model.history).toHaveLength(1)
  })

  it('a session with no launch record still changes model (no crash, nothing recorded)', async () => {
    const { registry, h } = setup({ withRecord: false })
    const result = await handleChangeModel(h, { targetSessionId: 'acp-1', model: 'opus' })
    expect(result).toMatchObject({ success: true })
    expect(registry.get('acp-1')!.launch).toBeUndefined()
  })

  it('set_thought_level updates the thinking axis only for the thought_level category', async () => {
    const { registry, h } = setup()
    await handleSetThoughtLevel(h, { targetSessionId: 'acp-1', configId: 'mode', value: 'plan' })
    expect(registry.get('acp-1')!.launch!.thinkingLevel.history).toHaveLength(0)
    await handleSetThoughtLevel(h, { targetSessionId: 'acp-1', configId: 'thought_level', value: 'high' })
    const thinking = registry.get('acp-1')!.launch!.thinkingLevel
    expect(thinking.current).toBe('high')
    expect(thinking.history).toEqual([{ at: expect.any(Number), value: 'high', via: 'change_model' }])
  })
})
