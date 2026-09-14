import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionHostServer } from '../src/server.js'
import { createUncaughtExceptionLimiter } from '../src/index.js'

// SIGINT and SIGTERM are registered as independent handlers, so a double signal
// (or a signal racing an explicit shutdown) can enter stop() twice. Without a
// re-entrancy guard the second entry re-runs flushAllPersistence() and
// runtime.stop() against already-cleared state.
test('stop() is re-entrant: concurrent and repeat calls tear down exactly once', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-stop-'))
  try {
    const server = new SessionHostServer({
      appName: `adhdev-stop-guard-${process.pid}`,
      endpoint: { kind: 'unix', path: path.join(tmp, 'sock') },
      storageRootDir: path.join(tmp, 'storage'),
    })
    await server.start()

    let flushes = 0
    const realFlush = server.flushAllPersistence.bind(server)
    ;(server as any).flushAllPersistence = (...args: any[]) => {
      flushes += 1
      return (realFlush as any)(...args)
    }

    // Two concurrent callers (the two signal handlers) plus a later one.
    await Promise.all([server.stop(), server.stop()])
    await server.stop()

    assert.equal(flushes, 1, 'teardown ran more than once')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// The uncaughtException handler deliberately swallows faults so a transient
// native crash (node-pty on Windows) does not kill healthy sessions. Unbounded
// swallowing instead produces a zombie that holds the socket and pid file while
// failing every request, so the tolerance is bounded.
test('uncaught-exception limiter tolerates bursts under the limit', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 10)
  for (let i = 0; i < 10; i++) {
    assert.equal(shouldExit(1000 + i).exit, false, `fault ${i + 1} should be tolerated`)
  }
})

test('uncaught-exception limiter exits once the limit is exceeded in the window', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 10)
  for (let i = 0; i < 10; i++) shouldExit(1000 + i)
  const eleventh = shouldExit(1010)
  assert.equal(eleventh.exit, true)
  assert.equal(eleventh.countInWindow, 11)
})

test('uncaught-exception limiter never exits on faults spread beyond the window', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 10)
  for (let i = 0; i < 50; i++) {
    assert.equal(shouldExit(i * 61_000).exit, false, 'slow drip must not trip the limiter')
  }
})

// Regression: a 0-based clock must not be mistaken for "no window yet". Using 0
// as the unset sentinel reset the window on every call, so the limiter never
// tripped when timestamps started at 0.
test('uncaught-exception limiter counts correctly from a zero timestamp', () => {
  const shouldExit = createUncaughtExceptionLimiter(60_000, 3)
  assert.equal(shouldExit(0).exit, false)
  assert.equal(shouldExit(1).exit, false)
  assert.equal(shouldExit(2).exit, false)
  assert.equal(shouldExit(3).exit, true)
})
