import { describe, expect, it } from 'vitest'
import { IdeProviderInstance } from '../../src/providers/ide-provider-instance.js'
import { ExtensionProviderInstance } from '../../src/providers/extension-provider-instance.js'
import { AcpProviderInstance } from '../../src/providers/acp-provider-instance.js'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { createSessionEventPort, type SessionEventPort } from '../../src/sessions/session-port.js'
import type { BusEvent } from '../../src/sessions/lifecycle-events.js'

// Wiring-unification B2: IDE / extension / ACP instances publish provider
// events and status edges through the lifecycle port AT THE TRANSITION —
// no collectAllStates() drain is needed for a subscriber to see them. The
// per-instance event buffer (pendingEvents / events / flushEvents) that used
// to also be written, for the pre-B5 onEvent drain, is gone (wiring-unification
// B residue cleanup): the port is the only delivery path now.

function busPort() {
  const bus = createSessionLifecycleBus()
  const seen: BusEvent[] = []
  bus.on('*', (e) => { seen.push(e) }, { name: 'test.recorder' })
  const registry = { get: () => undefined, terminate: () => false } as any
  const port = createSessionEventPort(bus, registry)
  return { bus, port, seen }
}

const provider = (type: string, category: string) => ({ type, name: type.toUpperCase(), category, scripts: {} }) as any

describe('IDE poll → immediate port emission', () => {
  it('generating_started and the idle→generating edge reach the bus without collectAllStates()', () => {
    const { port, seen } = busPort()
    const ide = new IdeProviderInstance(provider('cursor', 'ide')) as any
    ide.setSessionEventPort(port)
    ide.workspace = '/ws'
    const id = ide.getInstanceId()

    ide.detectAgentTransitions({ status: 'generating', title: 'Chat', messages: [] }, Date.now())

    const events = seen.filter((e) => e.kind === 'provider_event') as any[]
    expect(events.map((e) => e.event.event)).toEqual(['agent:generating_started'])
    expect(events[0]).toEqual(expect.objectContaining({ sessionId: id }))
    expect(events[0].event).toEqual(expect.objectContaining({
      providerType: 'cursor', instanceId: id, targetSessionId: id, workspaceName: '/ws',
    }))
    expect(seen.filter((e) => e.kind === 'status')).toEqual([
      expect.objectContaining({ sessionId: id, prev: 'idle', next: 'generating', cause: 'ide_poll', providerType: 'cursor' }),
    ])
    // No buffer any more: getState() carries no pendingEvents field.
    expect(ide.getState()).not.toHaveProperty('pendingEvents')
  })

  it('without a port nothing is emitted, and nothing throws', () => {
    const ide = new IdeProviderInstance(provider('cursor', 'ide')) as any
    expect(() => ide.detectAgentTransitions({ status: 'generating', title: 'Chat', messages: [] }, Date.now())).not.toThrow()
    expect(ide.getState()).not.toHaveProperty('pendingEvents')
  })
})

describe('Extension poll → immediate port emission', () => {
  it('a stream_update edge reaches the bus with the parent context the drain would add', async () => {
    const { port, seen } = busPort()
    const ide = new IdeProviderInstance(provider('cursor', 'ide')) as any
    await ide.init({ settings: {}, lifecycle: port })
    await ide.addExtension(provider('cline', 'extension'))
    ide.workspace = '/ws-late' // set after the extension was added — read lazily
    const ext = ide.getExtensionInstances()[0] as ExtensionProviderInstance
    const extId = ext.getInstanceId()

    ext.onEvent('stream_update', { status: 'generating', messages: [] })

    const events = seen.filter((e) => e.kind === 'provider_event') as any[]
    expect(events.map((e) => e.event.event)).toEqual(['agent:generating_started'])
    expect(events[0].sessionId).toBe(extId)
    expect(events[0].event).toEqual(expect.objectContaining({
      providerType: 'cline', targetSessionId: extId, parentSessionId: ide.getInstanceId(), workspaceName: '/ws-late',
    }))
    expect(seen.filter((e) => e.kind === 'status')).toEqual([
      expect.objectContaining({ sessionId: extId, prev: 'idle', next: 'generating', cause: 'ide_poll', providerType: 'cline' }),
    ])
  })
})

describe('ACP update → immediate port emission', () => {
  it('a status transition emits its provider event and the edge immediately', () => {
    const calls: Array<[string, ...unknown[]]> = []
    const port: SessionEventPort = {
      status: (...a) => { calls.push(['status', ...a]) },
      modal: () => {},
      prompt: () => {},
      signal: () => {},
      providerEvent: (...a) => { calls.push(['providerEvent', ...a]) },
      exited: () => {},
    }
    const acp = new AcpProviderInstance(provider('gemini-acp', 'acp'), '/repo') as any
    acp.setSessionEventPort(port)
    const id = acp.getInstanceId()
    acp.lastStatus = 'idle'
    acp.currentStatus = 'generating'
    acp.detectStatusTransition()

    expect(calls.map((c) => c[0])).toEqual(['providerEvent', 'status'])
    expect(calls[0][1]).toBe(id)
    expect(calls[0][2]).toEqual(expect.objectContaining({ event: 'agent:generating_started', providerType: 'gemini-acp', targetSessionId: id, workspaceName: '/repo' }))
    expect(calls[1]).toEqual(['status', id, 'idle', 'generating', 'acp_update', 'gemini-acp'])
  })
})

describe('ProviderInstanceManager — port delivery is the only path (B5)', () => {
  it('a port-delivered event reaches the bus exactly once; the state drain adds nothing', async () => {
    const { bus, port, seen } = busPort()
    const manager = new ProviderInstanceManager()
    manager.attachBus(bus)
    manager.setSessionEventPort(port)
    const ide = new IdeProviderInstance(provider('cursor', 'ide')) as any
    await manager.addInstance('ide:cursor', ide, { settings: {} })

    ide.detectAgentTransitions({ status: 'generating', title: 'Chat', messages: [] }, Date.now())
    expect(seen.filter((e) => e.kind === 'provider_event')).toHaveLength(1)

    manager.collectAllStates()
    expect(seen.filter((e) => e.kind === 'provider_event')).toHaveLength(1)
  })
})
