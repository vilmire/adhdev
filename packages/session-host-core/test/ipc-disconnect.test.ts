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
