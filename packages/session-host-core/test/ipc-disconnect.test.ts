import test from 'node:test'
import assert from 'node:assert/strict'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { SessionHostClient, type SessionHostDisconnectInfo } from '../src/ipc.js'

/**
 * Regression cover for the observability half of the ENOSPC incident.
 *
 * A session host that died took its socket with it, and the daemon-side client
 * registered only 'data' and 'error' handlers — so a CLEAN close ran nothing:
 * no signal, no rejected waiters, and `this.socket` left dangling at a dead
 * socket. The host's death was therefore invisible from the daemon, and the
 * failure resurfaced downstream as sessions that never reported completion.
 *
 * These tests drive a real unix socket server so the close/end/error paths are
 * exercised as the kernel actually delivers them, not as a mock imagines them.
 */

interface Harness {
  sockPath: string
  server: net.Server
  client: SessionHostClient
  /** The most recent server-side accepted socket (the "session host" side). */
  peer(): net.Socket | null
  cleanup(): Promise<void>
}

async function makeHarness(options: { listen?: boolean; onData?: (s: net.Socket) => void } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-ipc-test-'))
  const sockPath = path.join(dir, 'host.sock')
  let peer: net.Socket | null = null

  const server = net.createServer((socket) => {
    peer = socket
    if (options.onData) options.onData(socket)
  })
  if (options.listen !== false) {
    await new Promise<void>((resolve) => server.listen(sockPath, resolve))
  }

  const client = new SessionHostClient({ endpoint: { kind: 'unix', path: sockPath } })

  return {
    sockPath,
    server,
    client,
    peer: () => peer,
    cleanup: async () => {
      await client.close().catch(() => {})
      if (server.listening) await new Promise<void>((r) => server.close(() => r()))
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
    },
  }
}

/** Resolve on the next disconnect, or reject after `ms`. */
function nextDisconnect(client: SessionHostClient, ms = 3000): Promise<SessionHostDisconnectInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('no disconnect signal was emitted — a host death passed silently')),
      ms,
    )
    const off = client.onDisconnect((info) => {
      clearTimeout(timer)
      off()
      resolve(info)
    })
  })
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

test('reports a CLEAN server-side close (the silent case that hid the ENOSPC death)', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()
    const signal = nextDisconnect(h.client)

    // The host process exits — a clean FIN, NOT a socket error. This is the
    // exact shape that previously produced no signal at all.
    h.peer()!.end()

    const info = await signal
    assert.ok(['ended', 'closed'].includes(info.reason), `unexpected reason: ${info.reason}`)
    assert.equal(info.endpointPath, h.sockPath)
  } finally {
    await h.cleanup()
  }
})

test('reports an abrupt destroy', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()
    const signal = nextDisconnect(h.client)

    h.peer()!.destroy()

    const info = await signal
    assert.ok(['ended', 'closed', 'error'].includes(info.reason), `unexpected reason: ${info.reason}`)
  } finally {
    await h.cleanup()
  }
})

test('rejects in-flight requests instead of hanging them to the 30s timeout', async () => {
  // Server accepts the request and then dies without ever responding — the
  // session-host-crashed-mid-request case.
  const h = await makeHarness({ onData: (s) => s.on('data', () => s.destroy()) })
  try {
    await h.client.connect()
    await assert.rejects(h.client.request({ type: 'list_sessions', payload: {} } as any))
  } finally {
    await h.cleanup()
  }
})

test('counts the abandoned in-flight requests in the disconnect signal', async () => {
  const h = await makeHarness({ onData: (s) => s.on('data', () => { /* swallow — never respond */ }) })
  try {
    await h.client.connect()
    const signal = nextDisconnect(h.client)

    const pending = h.client.request({ type: 'list_sessions', payload: {} } as any)
    pending.catch(() => { /* asserted below */ })
    await settle(50)
    h.peer()!.destroy()

    const info = await signal
    assert.equal(info.pendingRequests, 1)
    await assert.rejects(pending)
  } finally {
    await h.cleanup()
  }
})

test('clears the dead socket so the next connect() actually reconnects', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()
    const signal = nextDisconnect(h.client)
    h.peer()!.destroy()
    await signal

    // Server is still listening; a reconnect must succeed rather than
    // short-circuit on a stale non-destroyed socket reference.
    await h.client.connect()
    assert.equal(h.server.listening, true)
  } finally {
    await h.cleanup()
  }
})

test('does NOT report a disconnect for a connect that never established', async () => {
  // Nothing is listening — this is "host not up yet", not "host died".
  const h = await makeHarness({ listen: false })
  try {
    let signalled = false
    h.client.onDisconnect(() => { signalled = true })

    await assert.rejects(h.client.connect())
    await settle()
    assert.equal(signalled, false)
  } finally {
    await h.cleanup()
  }
})

test('does NOT report a disconnect for a deliberate close()', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()

    let signalled = false
    h.client.onDisconnect(() => { signalled = true })

    await h.client.close()
    await settle()
    assert.equal(signalled, false)
  } finally {
    await h.cleanup()
  }
})

test('emits at most one signal per socket', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()

    let count = 0
    h.client.onDisconnect(() => { count += 1 })

    // end() then destroy() would otherwise fire both 'end' and 'close'.
    h.peer()!.end()
    h.peer()!.destroy()
    await settle(250)
    assert.equal(count, 1)
  } finally {
    await h.cleanup()
  }
})

test('survives a throwing observer without taking down the process', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()

    let secondObserverRan = false
    h.client.onDisconnect(() => { throw new Error('observer blew up') })
    h.client.onDisconnect(() => { secondObserverRan = true })

    h.peer()!.destroy()
    await settle(250)
    assert.equal(secondObserverRan, true)
  } finally {
    await h.cleanup()
  }
})

test('stops signalling after the listener unsubscribes', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()

    let count = 0
    const off = h.client.onDisconnect(() => { count += 1 })
    off()

    h.peer()!.destroy()
    await settle(250)
    assert.equal(count, 0)
  } finally {
    await h.cleanup()
  }
})

test('request timeout destroys the wedged socket, rejects concurrent waiters, and reconnects on a fresh socket for the next request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-ipc-timeout-reconnect-'))
  const sockPath = path.join(dir, 'host.sock')
  let connectionCount = 0
  let dropRequestsOnCurrentSocket = true

  const server = net.createServer((socket) => {
    connectionCount += 1
    const connId = connectionCount
    socket.on('data', (chunk) => {
      if (connId === 1 && dropRequestsOnCurrentSocket) {
        // Simulate a wedged/split-brain socket (Recv-Q saturated or orphaned host):
        // connection stays open at the TCP/UDS level, but never replies.
        return
      }
      const lines = chunk.toString('utf8').split('\n').filter((line) => line.trim().length > 0)
      for (const line of lines) {
        const env = JSON.parse(line)
        socket.write(
          `${JSON.stringify({
            kind: 'response',
            requestId: env.requestId,
            response: { success: true, result: [{ sessionId: `from-conn-${connId}` }] },
          })}\n`,
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(sockPath, resolve))

  const client = new SessionHostClient({
    endpoint: { kind: 'unix', path: sockPath },
    requestTimeoutMs: 30,
  } as any)
  const disconnectSignals: SessionHostDisconnectInfo[] = []
  client.onDisconnect((info) => disconnectSignals.push(info))
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const adjustedMs = ms === 30_000 ? 45 : ms
    return realSetTimeout(fn, adjustedMs, ...args)
  }

  try {
    const firstReq = client.request({ type: 'list_sessions', payload: {} })
    const concurrentReq = client.request({ type: 'get_host_diagnostics', payload: {} })

    await assert.rejects(firstReq, /Session host request timed out after 30ms \(list_sessions\)/)
    await assert.rejects(concurrentReq, /Session host request timed out after 30ms \(list_sessions\)/)
    assert.equal(connectionCount, 1)
    assert.equal(disconnectSignals.length, 1, 'timeout/disconnect must emit onDisconnect for established socket')

    // Subsequent request must open a new UDS connection (connId === 2) instead of reusing wedged connId === 1
    dropRequestsOnCurrentSocket = false
    const recovery = await client.request<Array<{ sessionId: string }>>({
      type: 'list_sessions',
      payload: {},
    })
    assert.equal(recovery.success, true)
    assert.deepEqual(recovery.result, [{ sessionId: 'from-conn-2' }])
    assert.equal(connectionCount, 2)
  } finally {
    globalThis.setTimeout = realSetTimeout
    await client.close().catch(() => {})
    if (server.listening) await new Promise<void>((r) => server.close(() => r()))
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

test('H1: client that attached to a session automatically replays attach_session on reconnect after disconnect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-ipc-reattach-'))
  const sockPath = path.join(dir, 'host.sock')
  const attachedByConn = new Map<number, string[]>()
  let connectionCount = 0

  const server = net.createServer((socket) => {
    connectionCount += 1
    const connId = connectionCount
    attachedByConn.set(connId, [])
    socket.on('data', (chunk) => {
      const lines = chunk.toString('utf8').split('\n').filter((line) => line.trim().length > 0)
      for (const line of lines) {
        const env = JSON.parse(line)
        if (env.request?.type === 'attach_session') {
          attachedByConn.get(connId)!.push(env.request.payload.sessionId)
        }
        socket.write(
          `${JSON.stringify({
            kind: 'response',
            requestId: env.requestId,
            response: { success: true, result: { sessionId: env.request?.payload?.sessionId || 'ok' } },
          })}\n`,
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(sockPath, resolve))

  const client = new SessionHostClient({ endpoint: { kind: 'unix', path: sockPath } })
  try {
    await client.request({
      type: 'attach_session',
      payload: {
        sessionId: 'sess-reattach-1',
        clientId: 'daemon-transport-1',
        clientType: 'daemon',
        readOnly: false,
      },
    })
    assert.deepEqual(attachedByConn.get(1), ['sess-reattach-1'])

    client.disconnect(new Error('simulated socket wedge'))
    await client.request({ type: 'list_sessions', payload: {} })

    assert.equal(connectionCount, 2)
    assert.deepEqual(
      attachedByConn.get(2),
      ['sess-reattach-1'],
      'reconnected socket must automatically replay attach_session so session events are not lost',
    )
  } finally {
    await client.close().catch(() => {})
    if (server.listening) await new Promise<void>((r) => server.close(() => r()))
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

test('L3: create_session without clientId does not invent a daemon clientId on reconnect, and failed replay entries are pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-ipc-l3-'))
  const sockPath = path.join(dir, 'host.sock')
  let connectionCount = 0
  const replaysByConn = new Map<number, Array<{ sessionId: string; clientId: string }>>()

  const server = net.createServer((socket) => {
    connectionCount += 1
    const connId = connectionCount
    replaysByConn.set(connId, [])
    socket.on('data', (chunk) => {
      const lines = chunk.toString('utf8').split('\n').filter((line) => line.trim().length > 0)
      for (const line of lines) {
        const env = JSON.parse(line)
        if (env.request?.type === 'attach_session' && connId >= 2) {
          replaysByConn.get(connId)!.push({
            sessionId: env.request.payload.sessionId,
            clientId: env.request.payload.clientId,
          })
          socket.write(
            `${JSON.stringify({
              kind: 'response',
              requestId: env.requestId,
              response: { success: false, error: `Unknown session: ${env.request.payload.sessionId}` },
            })}\n`,
          )
          continue
        }
        socket.write(
          `${JSON.stringify({
            kind: 'response',
            requestId: env.requestId,
            response: { success: true, result: { sessionId: env.request?.payload?.sessionId || 'ok' } },
          })}\n`,
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(sockPath, resolve))

  const client = new SessionHostClient({ endpoint: { kind: 'unix', path: sockPath } })
  try {
    await client.request({
      type: 'create_session',
      payload: {
        sessionId: 'sess-no-client-id',
        providerType: 'codex',
        category: 'cli',
        workspace: dir,
        launchCommand: { command: process.execPath, args: ['-e', ''] },
      },
    })
    await client.request({
      type: 'attach_session',
      payload: {
        sessionId: 'sess-gone-later',
        clientId: 'explicit-client-1',
        clientType: 'daemon',
        readOnly: false,
      },
    })

    // First reconnect: only sess-gone-later should be replayed (never sess-no-client-id with an invented clientId),
    // and its replay fails with Unknown session.
    client.disconnect(new Error('drop 1'))
    await client.request({ type: 'list_sessions', payload: {} })
    assert.deepEqual(replaysByConn.get(2), [
      { sessionId: 'sess-gone-later', clientId: 'explicit-client-1' },
    ])

    // Second reconnect: sess-gone-later was pruned after failing replay on conn 2, so conn 3 replays nothing.
    client.disconnect(new Error('drop 2'))
    await client.request({ type: 'list_sessions', payload: {} })
    assert.deepEqual(replaysByConn.get(3), [])
  } finally {
    await client.close().catch(() => {})
    if (server.listening) await new Promise<void>((r) => server.close(() => r()))
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

test('findConnectedClient returns an established client for the endpoint and clears after disconnectClients', async () => {
  const h = await makeHarness()
  const endpoint = { kind: 'unix' as const, path: h.sockPath }
  try {
    assert.equal(h.client.isConnected(), false)
    assert.equal(SessionHostClient.findConnectedClient(endpoint), null)

    await h.client.connect()
    assert.equal(h.client.isConnected(), true)
    assert.equal(SessionHostClient.findConnectedClient(endpoint), h.client)

    SessionHostClient.disconnectClients(endpoint)
    assert.equal(h.client.isConnected(), false)
    assert.equal(SessionHostClient.findConnectedClient(endpoint), null)
  } finally {
    await h.cleanup()
  }
})


test('a per-request probe timeout overrides the 30s default on an existing connection', async () => {
  const h = await makeHarness()
  try {
    await h.client.connect()
    const started = Date.now()
    const request = h.client.request({ type: 'get_host_diagnostics', payload: { includeSessions: false } }, { timeoutMs: 25 })
    const outcome = await Promise.race([
      request.then(() => 'unexpected success', e => e),
      settle(250).then(() => 'probe exceeded its budget'),
    ])
    assert.ok(outcome instanceof Error, String(outcome))
    assert.match(outcome.message, /timed out after 25ms/)
    assert.ok(Date.now() - started < 250)
  } finally { h.peer()?.destroy(); await h.cleanup() }
})

test('an isolated probe stays out of the shared client registry', async () => {
  const h = await makeHarness()
  const endpoint = { kind: 'unix' as const, path: h.sockPath }
  const probe = new SessionHostClient({ endpoint, registerAsShared: false })
  try {
    await probe.connect()
    assert.equal(SessionHostClient.findConnectedClient(endpoint), null)
    await h.client.connect()
    assert.equal(SessionHostClient.findConnectedClient(endpoint), h.client)
    SessionHostClient.disconnectClients(endpoint)
    assert.equal(h.client.isConnected(), false)
    assert.equal(probe.isConnected(), true)
  } finally {
    await probe.close()
    await h.cleanup()
  }
})
