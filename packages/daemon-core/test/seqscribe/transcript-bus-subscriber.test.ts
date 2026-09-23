/**
 * §8 unit 3 dirty triggers as lifecycle-bus subscribers (wiring-unification B4,
 * plan §1.4g). Replaces the cloud-only `emitStatusEvent` trigger test: the
 * status-transition trigger is now a `provider_event` subscriber, so it runs
 * in both hosts, and the per-session maps are forgotten on `terminated` (C9).
 */
import { describe, expect, it, vi } from 'vitest'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { SessionRegistry } from '../../src/sessions/registry.js'
import { subscribeTranscriptProjection } from '../../src/seqscribe/transcript-bus-subscriber.js'
import { TranscriptProjectionService } from '../../src/seqscribe/transcript-publisher.js'

function stubService() {
  return { markDirty: vi.fn(), startPolling: vi.fn(), stopPolling: vi.fn(), forgetSession: vi.fn() }
}

function providerEvent(event: string, sessionId = 'sess-1') {
  return { kind: 'provider_event' as const, sessionId, at: 1, event: { event, providerType: 'claude-cli', targetSessionId: sessionId } as any }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

describe('subscribeTranscriptProjection', () => {
  it('agent:generating_completed (the finalizing→terminal edge) pulls the target session through the REAL service', async () => {
    const bus = createSessionLifecycleBus()
    const collectObservation = vi.fn().mockResolvedValue(null)
    const service = new TranscriptProjectionService({
      daemonId: () => 'daemon-1', writerId: () => 'writer-1', publishRevision: async () => {}, collectObservation,
    })
    subscribeTranscriptProjection(bus, service)
    bus.emit(providerEvent('agent:generating_completed'))
    await flush()
    expect(collectObservation).toHaveBeenCalledWith('sess-1')
    service.dispose()
  })

  it('status events mark dirty as status_event; provider:* never does', () => {
    const bus = createSessionLifecycleBus()
    const service = stubService()
    subscribeTranscriptProjection(bus, service)
    bus.emit(providerEvent('agent:waiting_approval'))
    bus.emit(providerEvent('monitor:no_progress'))
    bus.emit(providerEvent('provider:something'))
    expect(service.markDirty.mock.calls).toEqual([['sess-1', 'status_event'], ['sess-1', 'status_event']])
  })

  it('post-chat commands mark dirty as post_chat; others do not', () => {
    const bus = createSessionLifecycleBus()
    const service = stubService()
    subscribeTranscriptProjection(bus, service)
    const base = { kind: 'command_executed' as const, at: 1, source: 'p2p' as const, success: true, invalidates: new Set<any>(), fastFlush: false, interactionId: 'i' }
    bus.emit({ ...base, command: 'send_chat', sessionId: 'sess-2', postChat: true })
    bus.emit({ ...base, command: 'read_chat', sessionId: 'sess-2', postChat: false })
    bus.emit({ ...base, command: 'send_chat', postChat: true })
    expect(service.markDirty.mock.calls).toEqual([['sess-2', 'post_chat']])
  })

  it('registered starts stat polling; terminated stops it and forgets the session (C9)', () => {
    const bus = createSessionLifecycleBus()
    const registry = new SessionRegistry(bus)
    const service = stubService()
    subscribeTranscriptProjection(bus, service)
    registry.register({ sessionId: 'sess-3', parentSessionId: null, providerType: 'codex-cli', transport: 'pty' }, 'launch')
    expect(service.startPolling).toHaveBeenCalledWith('sess-3')
    registry.terminate('sess-3', 'pty_exit')
    expect(service.stopPolling).toHaveBeenCalledWith('sess-3')
    expect(service.forgetSession).toHaveBeenCalledWith('sess-3')
  })

  it('forgetSession drops the per-session revision state so the maps cannot grow forever', async () => {
    const service = new TranscriptProjectionService({
      daemonId: () => 'daemon-1', writerId: () => 'writer-1', epoch: 'e', now: () => '2026-09-23T00:00:00.000Z', publishRevision: async () => {},
    })
    service.observe('sess-4', {
      sessionId: 'sess-4', providerType: 'claude-code', status: 'idle',
      messages: [{ role: 'assistant', kind: 'standard', content: 'hi' }],
      coverage: { mode: 'full', totalMessageCount: 1, returnedMessageCount: 1, omittedBefore: false },
    } as any)
    await flush()
    expect(service.trackedSessionCount).toBe(1)
    service.forgetSession('sess-4')
    expect(service.trackedSessionCount).toBe(0)
    service.dispose()
  })

  it('unsubscribe stops every trigger', () => {
    const bus = createSessionLifecycleBus()
    const service = stubService()
    const off = subscribeTranscriptProjection(bus, service)
    off()
    bus.emit(providerEvent('agent:generating_completed'))
    expect(service.markDirty).not.toHaveBeenCalled()
  })
})
