import { describe, expect, it, vi } from 'vitest'
import { handleChangeModel } from '../../src/commands/chat-commands-write.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { buildSessionLaunchRecord } from '../../src/sessions/launch-record.js'

// Phase E: a successful runtime change (change_model) updates the addressed
// session's launch record — `current` + a history entry — and a failed one
// leaves it untouched.

function setup(opts: { withRecord?: boolean; scriptSucceeds?: boolean } = {}) {
  const registry = new SessionRegistry()
  registry.register({ sessionId: 'ide-1', parentSessionId: null, providerType: 'x-ext', transport: 'cdp-webview', adapterKey: 'ide-1', instanceKey: 'ide-1' }, 'launch')
  if (opts.withRecord !== false) {
    registry.setLaunchRecord('ide-1', buildSessionLaunchRecord({
      sessionId: 'ide-1',
      providerType: 'x-ext',
      launchedBy: 'dashboard',
      launchedAt: 1,
      model: { requested: 'sonnet', declaredSource: 'user', launchValue: 'sonnet' },
      thinkingLevel: {},
    }))
  }
  const evaluateInWebviewFrame = vi.fn(async () => JSON.stringify({ success: opts.scriptSucceeds !== false }))
  const h = {
    ctx: { sessionRegistry: registry },
    currentSession: registry.get('ide-1'),
    currentManagerKey: undefined,
    currentProviderType: 'x-ext',
    getProvider: () => ({ type: 'x-ext', category: 'extension' }),
    getCdp: () => ({ isConnected: true, evaluateInWebviewFrame }),
    getProviderScript: (name: string) => (name === 'webviewSetModel' ? '(() => ({ success: true }))()' : null),
    evaluateProviderScript: async () => null,
  } as any
  return { registry, h }
}

describe('change_model → launch record', () => {
  it('change_model success sets current and appends change_model history; source is unchanged', async () => {
    const { registry, h } = setup()
    const result = await handleChangeModel(h, { targetSessionId: 'ide-1', model: 'opus' })
    expect(result).toMatchObject({ success: true })
    const model = registry.get('ide-1')!.launch!.model
    expect(model.current).toBe('opus')
    expect(model.source).toBe('user')
    expect(model.history.map((e) => [e.via, e.value])).toEqual([['launch', 'sonnet'], ['change_model', 'opus']])
  })

  it('a failed change leaves the record untouched', async () => {
    const { registry, h } = setup({ scriptSucceeds: false })
    const result = await handleChangeModel(h, { targetSessionId: 'ide-1', model: 'opus' })
    expect(result).toMatchObject({ success: false })
    expect(registry.get('ide-1')!.launch!.model.history).toHaveLength(1)
  })

  it('a session with no launch record still changes model (no crash, nothing recorded)', async () => {
    const { registry, h } = setup({ withRecord: false })
    const result = await handleChangeModel(h, { targetSessionId: 'ide-1', model: 'opus' })
    expect(result).toMatchObject({ success: true })
    expect(registry.get('ide-1')!.launch).toBeUndefined()
  })
})
