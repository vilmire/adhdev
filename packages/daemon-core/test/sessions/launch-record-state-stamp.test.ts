import { describe, expect, it } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { createSessionEventPort } from '../../src/sessions/session-port.js'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'
import { buildSessionEntries } from '../../src/status/builders.js'
import { buildSessionLaunchRecord } from '../../src/sessions/launch-record.js'

// Phase E end-to-end: the registry-owned launch record reaches SessionEntry
// (P2P) — registry → session port read → instance manager stamps the collected
// CLI / ACP state → status builders.
//
// ★PENDING: the port read + state stamp are a REQUESTED EDIT (session-port.ts,
// provider-instance.ts, provider-instance-manager.ts are outside workstream E's
// files). Un-skip once applied.
const pending = it

function fakeInstance(id: string, category: 'cli' | 'ide') {
  return {
    type: category === 'cli' ? 'claude-cli' : 'cursor',
    category,
    init: async () => {},
    dispose: () => {},
    onTick: async () => {},
    onEvent: () => {},
    getState: () => ({
      category,
      type: category === 'cli' ? 'claude-cli' : 'cursor',
      name: id,
      instanceId: id,
      status: 'idle',
      mode: 'chat',
      workspace: '/w',
      activeChat: null,
      settings: {},
      lastUpdated: 1,
      pendingEvents: [],
      ...(category === 'ide' ? { cdpConnected: true, extensions: [] } : {}),
    }),
  } as any
}

describe('launch record → provider state → SessionEntry', () => {
  pending('a CLI session with a record publishes it; an IDE session does not', async () => {
    const bus = createSessionLifecycleBus()
    const registry = new SessionRegistry(bus)
    const manager = new ProviderInstanceManager()
    manager.setSessionEventPort(createSessionEventPort(bus, registry))
    await manager.addInstance('cli-1', fakeInstance('cli-1', 'cli'), { settings: {} })
    await manager.addInstance('ide-1', fakeInstance('ide-1', 'ide'), { settings: {} })
    registry.register({ sessionId: 'cli-1', parentSessionId: null, providerType: 'claude-cli', transport: 'pty' }, 'launch')
    registry.setLaunchRecord('cli-1', buildSessionLaunchRecord({
      sessionId: 'cli-1',
      providerType: 'claude-cli',
      launchedBy: 'dashboard',
      launchedAt: 1,
      model: { requested: 'sonnet', declaredSource: 'user', launchValue: 'sonnet' },
      thinkingLevel: {},
    }))

    const states = manager.collectAllStates()
    expect(states.find((s) => s.instanceId === 'cli-1')).toMatchObject({ launch: { launchedBy: 'dashboard' } })
    expect(states.find((s) => s.instanceId === 'ide-1')).not.toHaveProperty('launch')

    const sessions = buildSessionEntries(states, new Map(), { profile: 'full' })
    expect(sessions.find((s) => s.id === 'cli-1')).toMatchObject({ model: 'sonnet', modelSource: 'user', launch: { sessionId: 'cli-1' } })
  })
})
