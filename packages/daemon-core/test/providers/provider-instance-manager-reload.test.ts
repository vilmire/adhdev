import { describe, expect, it } from 'vitest'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'
import type { ProviderInstance, ProviderState } from '../../src/providers/provider-instance.js'
import type { ProviderModule } from '../../src/providers/contracts.js'

function buildFakeInstance(type: string, category: ProviderInstance['category'] = 'cli') {
  const refreshed: ProviderModule[] = []
  const instance: ProviderInstance & { refreshed: ProviderModule[]; refreshProviderDefinition(provider: ProviderModule): void } = {
    type,
    category,
    refreshed,
    async init() {},
    async onTick() {},
    getState(): ProviderState {
      return {
        type,
        name: type,
        category: category as any,
        status: 'idle',
        activeChat: null,
        instanceId: type,
        lastUpdated: Date.now(),
        settings: {},
        pendingEvents: [],
        ...(category === 'cli' ? { mode: 'chat' } : {}),
        ...(category === 'ide' ? { cdpConnected: true, extensions: [] } : {}),
      } as ProviderState
    },
    onEvent() {},
    dispose() {},
    refreshProviderDefinition(provider: ProviderModule) {
      refreshed.push(provider)
    },
  }
  return instance
}

describe('ProviderInstanceManager provider reload propagation', () => {
  it('refreshes already-running instances with newly resolved provider definitions', async () => {
    const manager = new ProviderInstanceManager()
    const hermes = buildFakeInstance('hermes-cli')
    const codex = buildFakeInstance('codex-cli')
    await manager.addInstance('cli:hermes-cli', hermes, { settings: {} })
    await manager.addInstance('cli:codex-cli', codex, { settings: {} })

    const refreshed = manager.refreshProviderDefinitions((type) => (
      type === 'hermes-cli'
        ? ({ type, name: 'Hermes Agent Reloaded', category: 'cli', binary: 'hermes' } as ProviderModule)
        : null
    ))

    expect(refreshed).toBe(1)
    expect(hermes.refreshed).toHaveLength(1)
    expect(hermes.refreshed[0].name).toBe('Hermes Agent Reloaded')
    expect(codex.refreshed).toHaveLength(0)
  })
})
