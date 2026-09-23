import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { routeStandaloneStatusEvent } from '../src/standalone-status-event.ts'

// Wiring-unification B5, checklist item 3: the standalone daemon broadcasts
// `{type:'status_event', payload}` over the dashboard WS; the context routes it
// into web-core's event manager exactly like web-cloud's P2P handler.

function sink() {
  const calls: Array<{ payload: any; source: string }> = []
  return { calls, handleRawEvent: (payload: any, source: 'ws' | 'p2p') => { calls.push({ payload, source }) } }
}

test('a status_event frame reaches the event manager stamped with the daemon id', () => {
  const s = sink()
  const handled = routeStandaloneStatusEvent({
    type: 'status_event',
    payload: { event: 'agent:waiting_approval', targetSessionId: 's1', modalMessage: 'rm -rf build/', timestamp: 5 },
    timestamp: 6,
  }, 'standalone_mach_1', s)
  assert.equal(handled, true)
  assert.deepEqual(s.calls, [{
    payload: { event: 'agent:waiting_approval', targetSessionId: 's1', modalMessage: 'rm -rf build/', timestamp: 5, daemonId: 'standalone_mach_1' },
    source: 'ws',
  }])
})

test('other frames are not consumed, and a malformed status_event is swallowed', () => {
  const s = sink()
  assert.equal(routeStandaloneStatusEvent({ type: 'topic_update', update: {} }, 'd', s), false)
  assert.equal(routeStandaloneStatusEvent(null, 'd', s), false)
  assert.equal(routeStandaloneStatusEvent({ type: 'status_event', payload: { noEvent: true } }, 'd', s), true)
  assert.deepEqual(s.calls, [])
})

test('falls back to the standalone daemon id before the first status frame', () => {
  const s = sink()
  routeStandaloneStatusEvent({ type: 'status_event', payload: { event: 'agent:generating_completed' } }, null, s)
  assert.equal(s.calls[0].payload.daemonId, 'standalone')
})
