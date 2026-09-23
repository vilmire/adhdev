import { describe, expect, it } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import type { BusEvent, EventOf } from '../../src/sessions/lifecycle-events.js'
import { SessionRegistry, type SessionRuntimeTarget } from '../../src/sessions/registry.js'
import { reconcileIdeRuntimeSessions } from '../../src/sessions/reconcile.js'
import { createSessionEventPort } from '../../src/sessions/session-port.js'

function setup() {
  const bus = createSessionLifecycleBus()
  const events: BusEvent[] = []
  bus.on('*', (e) => { events.push(e) }, { name: 'recorder' })
  const registry = new SessionRegistry(bus, () => 1000)
  const of = <K extends BusEvent['kind']>(kind: K) => events.filter((e): e is EventOf<K> => e.kind === kind)
  return { bus, events, registry, of }
}

function cli(sessionId: string, extra: Partial<SessionRuntimeTarget> = {}): SessionRuntimeTarget {
  return {
    sessionId,
    parentSessionId: null,
    providerType: 'claude-cli',
    transport: 'pty',
    adapterKey: sessionId,
    instanceKey: sessionId,
    workspace: '/w',
    ...extra,
  }
}

describe('SessionRegistry lifecycle emission', () => {
  it('register emits one registered{origin} with a snapshot of the session', () => {
    const { registry, of } = setup()
    registry.register(cli('s1'), 'launch')
    registry.register(cli('s2'), 'restore')

    expect(of('registered').map((e) => [e.sessionId, e.origin])).toEqual([['s1', 'launch'], ['s2', 'restore']])
    expect(of('registered')[0]).toMatchObject({ at: 1000, session: { sessionId: 's1', providerType: 'claude-cli', workspace: '/w' } })
  })

  it('infers the legacy origin from the transport when a caller passes none', () => {
    const { registry, of } = setup()
    registry.register(cli('pty'))
    registry.register({ sessionId: 'page', parentSessionId: null, providerType: 'cursor', transport: 'cdp-page', cdpManagerKey: 'cursor', instanceKey: 'ide:cursor' })
    registry.register({ sessionId: 'hook', parentSessionId: 'page', providerType: 'cline', transport: 'cdp-webview', cdpManagerKey: 'cursor', instanceKey: 'ide:cursor' })
    registry.register({ sessionId: 'acp', parentSessionId: null, providerType: 'x-acp', transport: 'acp' })

    expect(of('registered').map((e) => [e.sessionId, e.origin])).toEqual([
      ['pty', 'launch'], ['page', 'attach'], ['hook', 'discover'], ['acp', 'launch'],
    ])
  })

  it('reconcile repairs a dropped IDE entry with origin reconcile', () => {
    const { registry, of } = setup()
    const ide = {
      category: 'ide',
      type: 'cursor',
      getInstanceId: () => 'ide-session',
      getExtensionInstances: () => [{ type: 'cline', getInstanceId: () => 'ext-session' }],
    }
    const manager = { listInstanceIds: () => ['ide:cursor'], getInstance: () => ide }
    reconcileIdeRuntimeSessions(manager, registry)
    reconcileIdeRuntimeSessions(manager, registry) // unchanged -> no re-emit

    expect(of('registered').map((e) => [e.sessionId, e.origin])).toEqual([
      ['ide-session', 'reconcile'], ['ext-session', 'reconcile'],
    ])
  })

  it('re-registering a live id is an upsert: registered again, no terminated, binding preserved', () => {
    const { registry, of } = setup()
    registry.register(cli('s1'), 'launch')
    registry.setProviderSessionId('s1', 'conv-1')
    registry.register(cli('s1'), 'restore')

    expect(of('registered')).toHaveLength(2)
    expect(of('terminated')).toHaveLength(0)
    expect(registry.get('s1')?.providerSessionId).toBe('conv-1')
    expect(registry.resolveAlias('conv-1')).toBe('s1')
  })

  it('emits exactly one terminated when pty exit, stop and auto-clean race for one registration', () => {
    const { bus, registry, of } = setup()
    const port = createSessionEventPort(bus, registry)
    registry.register(cli('s1'), 'launch')

    // A terminated subscriber that itself tries to clean up again (re-entrant race).
    const reentrantResults: boolean[] = []
    // (Retries once only, so a broken registry fails this test instead of looping forever.)
    bus.on('terminated', (e) => {
      if (reentrantResults.length === 0) reentrantResults.push(registry.terminate(e.sessionId, 'auto_clean'))
    })
    // A status subscriber that reacts to "stopped" with an explicit stop.
    bus.on('status', (e) => {
      if (e.next === 'stopped') registry.terminate(e.sessionId, 'stop_requested')
    })

    port.status('s1', 'generating', 'stopped', 'pty_exit')
    port.exited('s1', { exitCode: null, signal: 9, reason: 'signal', lifecycle: 'failed', terminatedAt: 5 }, { a: 1 })
    expect(registry.terminate('s1', 'auto_clean')).toBe(false)
    expect(registry.terminateByInstanceKey('s1', 'stop_requested')).toBe(0)

    const terminated = of('terminated')
    expect(terminated).toHaveLength(1)
    // The status subscriber ran first (queued behind the status fan-out), so its cause wins.
    expect(terminated[0]).toMatchObject({ sessionId: 's1', cause: 'stop_requested', providerType: 'claude-cli', workspace: '/w' })
    expect(reentrantResults).toEqual([false])
    expect(registry.get('s1')).toBeUndefined()
  })

  it('re-register after terminate starts a new registration that can terminate again', () => {
    const { registry, of } = setup()
    registry.register(cli('s1'), 'launch')
    expect(registry.terminate('s1', 'stop_requested')).toBe(true)
    registry.register(cli('s1'), 'launch')
    expect(registry.terminate('s1', 'pty_exit')).toBe(true)
    expect(of('terminated').map((e) => e.cause)).toEqual(['stop_requested', 'pty_exit'])
    expect(of('registered')).toHaveLength(2)
  })

  it('terminateByManagerKey / ByInstanceKey terminate each member once and report the count', () => {
    const { registry, of } = setup()
    registry.register({ sessionId: 'page', parentSessionId: null, providerType: 'cursor', transport: 'cdp-page', cdpManagerKey: 'cursor', instanceKey: 'ide:cursor' }, 'attach')
    registry.register({ sessionId: 'ext', parentSessionId: 'page', providerType: 'cline', transport: 'cdp-webview', cdpManagerKey: 'cursor', instanceKey: 'ide:cursor' }, 'attach')
    expect(registry.listChildren('page').map((t) => t.sessionId)).toEqual(['ext'])

    expect(registry.terminateByManagerKey('cursor', 'ide_detached')).toBe(2)
    expect(registry.terminateByInstanceKey('ide:cursor', 'ide_stopped')).toBe(0)
    expect(of('terminated').map((e) => [e.sessionId, e.cause])).toEqual([['page', 'ide_detached'], ['ext', 'ide_detached']])
    expect(registry.listChildren('page')).toEqual([])
  })

  it('every termination carries the real cause its caller passed', () => {
    const { registry, of } = setup()
    registry.register(cli('a'), 'launch')
    registry.register(cli('b'), 'launch')
    registry.terminate('a', 'stop_requested')
    registry.terminateByInstanceKey('b', 'auto_clean')
    expect(of('terminated').map((e) => [e.sessionId, e.cause])).toEqual([['a', 'stop_requested'], ['b', 'auto_clean']])
  })

  it('beginShutdown stamps daemon_shutdown on every later termination', () => {
    const { registry, of } = setup()
    registry.register(cli('s1'), 'launch')
    registry.beginShutdown()
    registry.terminate('s1', 'stop_requested')
    expect(of('terminated')[0].cause).toBe('daemon_shutdown')
  })

  it('setProviderSessionId emits binding only on change and maintains the alias index', () => {
    const { registry, of } = setup()
    registry.register(cli('s1'), 'launch')
    expect(registry.setProviderSessionId('s1', 'conv-1')).toBe(true)
    expect(registry.setProviderSessionId('s1', 'conv-1')).toBe(false)
    expect(registry.setProviderSessionId('s1', '')).toBe(false)
    expect(registry.setProviderSessionId('missing', 'conv-x')).toBe(false)
    expect(registry.setProviderSessionId('s1', 'conv-2')).toBe(true)

    expect(of('binding').map((e) => e.providerSessionId)).toEqual(['conv-1', 'conv-2'])
    expect(registry.resolveAlias('conv-1')).toBeNull()
    expect(registry.resolveAlias('conv-2')).toBe('s1')
    expect(registry.resolveAlias('s1')).toBe('s1')

    registry.terminate('s1', 'stop_requested')
    expect(registry.resolveAlias('conv-2')).toBeNull()
  })

  it('works without a bus (boot has not attached one yet)', () => {
    const registry = new SessionRegistry()
    registry.register(cli('s1'))
    expect(registry.has('s1')).toBe(true)
    expect(registry.terminate('s1', 'stop_requested')).toBe(true)
    expect(registry.list()).toEqual([])
  })
})
