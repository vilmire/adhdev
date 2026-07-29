import * as assert from 'node:assert/strict'
import * as net from 'node:net'
import { test, type TestContext } from 'node:test'
import {
  PUBLIC_ANY_ADDRESSES,
  StandaloneCliArgsError,
  normalizeStandaloneHostAddress,
  parseStandaloneCliArgs,
} from '../src/standalone-cli-args'

// ─── Canonical contract: explicit --host <address> binds exactly that ───

test('parseStandaloneCliArgs accepts an explicit IPv4 address and binds exactly it', () => {
  const parsed = parseStandaloneCliArgs(['--host', '127.0.0.1'])
  assert.equal(parsed.options.host, '127.0.0.1')
  assert.equal(parsed.hostExplicit, true)
  // Regression pin for the live defect: no silent coercion to 0.0.0.0.
  assert.notEqual(parsed.options.host, '0.0.0.0')
})

test('parseStandaloneCliArgs accepts -H with IPv6 loopback', () => {
  const parsed = parseStandaloneCliArgs(['-H', '::1'])
  assert.equal(parsed.options.host, '::1')
  assert.equal(parsed.hostExplicit, true)
})

test('parseStandaloneCliArgs accepts --host=<address> inline form and localhost alias', () => {
  assert.equal(parseStandaloneCliArgs(['--host=0.0.0.0']).options.host, '0.0.0.0')
  assert.equal(parseStandaloneCliArgs(['--host', 'localhost']).options.host, 'localhost')
  assert.equal(parseStandaloneCliArgs(['--host', 'LOCALHOST']).options.host, 'localhost')
})

test('parseStandaloneCliArgs keeps the public-bind opt-in explicit (0.0.0.0 and ::)', () => {
  assert.equal(parseStandaloneCliArgs(['--host', '0.0.0.0']).options.host, '0.0.0.0')
  assert.equal(parseStandaloneCliArgs(['--host', '::']).options.host, '::')
  assert.ok(PUBLIC_ANY_ADDRESSES.has('0.0.0.0'))
  assert.ok(PUBLIC_ANY_ADDRESSES.has('::'))
})

test('parseStandaloneCliArgs leaves host unset when --host is absent', () => {
  const parsed = parseStandaloneCliArgs(['--port', '4000'])
  assert.equal(parsed.options.host, undefined)
  assert.equal(parsed.hostExplicit, false)
  assert.equal(parsed.options.port, 4000)
})

test('parseStandaloneCliArgs parses the remaining documented flags', () => {
  const parsed = parseStandaloneCliArgs(['-p', '3848', '--token', 'abc', '--public', '/tmp/x', '--no-open', '--dev', '--help'])
  assert.deepEqual(parsed.options, { port: 3848, token: 'abc', publicDir: '/tmp/x', open: false, dev: true })
  assert.equal(parsed.showHelp, true)
})

// ─── Negative controls: fail visibly, never start on a wrong bind ───

test('parseStandaloneCliArgs rejects a bare --host (missing value)', () => {
  assert.throws(() => parseStandaloneCliArgs(['--host']), StandaloneCliArgsError)
  assert.throws(() => parseStandaloneCliArgs(['-H']), StandaloneCliArgsError)
})

test('parseStandaloneCliArgs rejects --host followed by another flag as a missing value', () => {
  assert.throws(() => parseStandaloneCliArgs(['--host', '--port', '4000']), /Missing value for --host/)
})

test('parseStandaloneCliArgs rejects malformed addresses instead of coercing', () => {
  for (const bad of ['0.0.0.0.0', 'example.com', '256.1.1.1', '[::1]', '0,0,0,0']) {
    assert.throws(() => parseStandaloneCliArgs(['--host', bad]), StandaloneCliArgsError, `expected rejection for ${bad}`)
  }
  assert.throws(() => parseStandaloneCliArgs(['--host=']), /Missing value|Invalid --host/)
})

test('parseStandaloneCliArgs rejects unknown options and invalid ports visibly', () => {
  assert.throws(() => parseStandaloneCliArgs(['--hostname', 'x']), /Unknown option/)
  assert.throws(() => parseStandaloneCliArgs(['--port', 'abc']), /Invalid --port/)
  assert.throws(() => parseStandaloneCliArgs(['--port', '0']), /Invalid --port/)
  assert.throws(() => parseStandaloneCliArgs(['--port', '70000']), /Invalid --port/)
})

test('normalizeStandaloneHostAddress is deliberate about IPv4/IPv6/localhost', () => {
  assert.equal(normalizeStandaloneHostAddress('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeStandaloneHostAddress('192.168.1.20'), '192.168.1.20')
  assert.equal(normalizeStandaloneHostAddress('::1'), '::1')
  assert.equal(normalizeStandaloneHostAddress('fe80::1'), 'fe80::1')
  assert.equal(normalizeStandaloneHostAddress(' localhost '), 'localhost')
  assert.throws(() => normalizeStandaloneHostAddress(''), StandaloneCliArgsError)
})

// ─── Live isolated socket checks: the parsed address is what actually binds ───

async function bindAndProbe(t: TestContext, host: string, connectHost: string, expectedAddress: string): Promise<void> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const address = server.address()
  assert.ok(address && typeof address === 'object', `expected a bound address for ${host}`)
  assert.equal(address.address, expectedAddress)
  assert.ok(address.port > 0)

  // Prove the socket is really serving on the bound address.
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: connectHost, port: address.port })
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
    socket.once('error', reject)
  })
}

test('live bind: parsed 127.0.0.1 binds loopback only', async (t) => {
  const { options } = parseStandaloneCliArgs(['--host', '127.0.0.1'])
  await bindAndProbe(t, options.host!, '127.0.0.1', '127.0.0.1')
})

test('live bind: parsed localhost binds and serves', async (t) => {
  const { options } = parseStandaloneCliArgs(['--host', 'localhost'])
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, options.host!, () => resolve())
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  assert.ok(address.port > 0)
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: 'localhost', port: address.port })
    socket.once('connect', () => { socket.end(); resolve() })
    socket.once('error', reject)
  })
})

test('live bind: parsed ::1 binds IPv6 loopback (skipped when IPv6 is unavailable)', async (t) => {
  const { options } = parseStandaloneCliArgs(['--host', '::1'])
  const probe = net.createServer()
  const available = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '::1', () => probe.close(() => resolve(true)))
  })
  if (!available) {
    t.skip('IPv6 loopback unavailable in this environment')
    return
  }
  await bindAndProbe(t, options.host!, '::1', '::1')
})

test('live bind: explicit 0.0.0.0 opt-in binds the any-address', async (t) => {
  const { options } = parseStandaloneCliArgs(['--host', '0.0.0.0'])
  await bindAndProbe(t, options.host!, '127.0.0.1', '0.0.0.0')
})

test('live negative control: the malformed 0.0.0.0.0 the old parser produced cannot bind', async () => {
  // The verified defect parsed --host as a boolean and forwarded a value the
  // server mangled into 0.0.0.0.0. Node rejects that address outright —
  // which is exactly why the parser now fails visibly before listen() runs.
  assert.throws(() => parseStandaloneCliArgs(['--host', '0.0.0.0.0']), /Invalid --host address/)
  const server = net.createServer()
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0.0', () => resolve())
    }),
  )
})
