import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionHostServer } from '../src/server.js'

// SUBMIT-UNCONFIRMED-RECLAIM (review R7): every accepted send_input is announced
// (seq + writer) BEFORE its bytes reach the PTY; a rejected one is not counted.

function host() {
  const server = new SessionHostServer({ appName: `adhdev-input-ann-${process.pid}` }) as any
  const order: string[] = []
  server.emitEvent = (e: any) => { if (e.type === 'session_input') order.push(`announce:${e.seq}:${e.clientId}`) }
  const record = server.registry.createSession({ sessionId: 's1', providerType: 'test', category: 'cli', workspace: '/tmp', launchCommand: { command: '/bin/true', args: [] }, clientId: 'daemon', clientType: 'daemon' })
  server.registry.restoreSession({ ...record, lifecycle: 'running' })
  server.runtimes.set('s1', { write: (s: string) => order.push(`pty:${s}`) })
  return { server, order }
}

test('an accepted input is announced with its seq and writer before it reaches the PTY', async () => {
  const { server, order } = host()
  const res = await server.handleRequest({ type: 'send_input', payload: { sessionId: 's1', clientId: 'daemon', data: 'a' } })
  assert.equal(res.success, true)
  assert.equal(res.result.inputSeq, 1)
  await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 's1', clientId: 'unattached', ownerType: 'user', force: true } })
  await server.handleRequest({ type: 'send_input', payload: { sessionId: 's1', clientId: 'unattached', data: 'b' } })
  assert.deepEqual(order, ['announce:1:daemon', 'pty:a', 'announce:2:unattached', 'pty:b'])
})

test('a rejected input (not the owner, or read-only) is neither announced nor counted', async () => {
  const { server, order } = host()
  await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 's1', clientId: 'owner', ownerType: 'user', force: true } })
  const res = await server.handleRequest({ type: 'send_input', payload: { sessionId: 's1', clientId: 'daemon', data: 'x' } })
  assert.equal(res.success, false)
  await server.handleRequest({ type: 'attach_session', payload: { sessionId: 's1', clientId: 'viewer', clientType: 'local-terminal', readOnly: true } })
  const ro = await server.handleRequest({ type: 'send_input', payload: { sessionId: 's1', clientId: 'viewer', data: 'y' } })
  assert.equal(ro.success, false)
  assert.deepEqual(order, [])
  assert.equal(server.registry.getSession('s1').inputSeq, 0)
})

test('send_input_if_seq (review R8-1): writes only at the exact accounted point, refuses a stale point or a foreign owner without writing, announces what it writes', async () => {
  const { server, order } = host()
  const st = (await server.handleRequest({ type: 'get_input_state', payload: { sessionId: 's1' } })).result
  const ok = await server.handleRequest({ type: 'send_input_if_seq', payload: { sessionId: 's1', clientId: 'daemon', data: 'a', expectedInputSeq: st.inputSeq, expectedInputEpoch: st.inputEpoch } })
  assert.equal(ok.success, true)
  const stale = await server.handleRequest({ type: 'send_input_if_seq', payload: { sessionId: 's1', clientId: 'daemon', data: 'b', expectedInputSeq: st.inputSeq, expectedInputEpoch: st.inputEpoch } })
  assert.equal(stale.success, false)
  assert.equal(stale.error, 'input_seq_mismatch')
  const wrongEpoch = await server.handleRequest({ type: 'send_input_if_seq', payload: { sessionId: 's1', clientId: 'daemon', data: 'c', expectedInputSeq: 1, expectedInputEpoch: 'other' } })
  assert.equal(wrongEpoch.success, false)
  await server.handleRequest({ type: 'acquire_write', payload: { sessionId: 's1', clientId: 'owner', ownerType: 'user', force: true } })
  const owned = await server.handleRequest({ type: 'send_input_if_seq', payload: { sessionId: 's1', clientId: 'daemon', data: 'd', expectedInputSeq: 1, expectedInputEpoch: st.inputEpoch } })
  assert.equal(owned.success, false)
  assert.equal(server.registry.getSession('s1').writeOwner.clientId, 'owner')
  assert.deepEqual(order, ['announce:1:daemon', 'pty:a'])
})
