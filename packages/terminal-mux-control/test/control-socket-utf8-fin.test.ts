import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {
  AdhMuxControlClient,
  createAdhMuxControlServer,
  createControlLineParser,
  type AdhMuxControlRequest,
} from '../src/control-socket.js'
import { getWorkspaceControlEndpoint } from '../src/storage.js'

/**
 * UTF8-CHUNK-BOUNDARY / PARSER-EOF-FLUSH regression cover for the adhmux
 * control socket.
 *
 * The control socket carried a verbatim copy of session-host-core's pre-fix
 * line parser: `chunk.toString()` on each Buffer in isolation. A multi-byte
 * UTF-8 sequence straddling a chunk boundary decoded as two truncated
 * sequences, each collapsing to U+FFFD. The corruption is SILENT — U+FFFD is
 * legal JSON string content, so the envelope still parses and only the value is
 * wrong. Measured before the fix: 25 of 129 interior split points corrupted the
 * payload with zero parse errors.
 *
 * These tests assert the payload STRING ITSELF surviving a chunked delivery —
 * not that a decoder was constructed, not that a handler was registered.
 *
 * ON TEST LAYERING — this is load-bearing, do not "simplify" it into one
 * socket-only suite. The exhaustive every-split sweep drives the parser
 * DIRECTLY, because two back-to-back `socket.write()` calls coalesce into a
 * single `data` event (measured: a 77/123 split arrived as one 200-byte event),
 * which silently reduces a split-boundary test to a no-op. An earlier draft of
 * this file did exactly that and PASSED against the unfixed parser. The socket
 * tests below therefore force genuinely separate `data` events by awaiting
 * between writes, and cover the wiring — that both ends actually use the
 * corrected parser — rather than re-deriving boundary coverage.
 */

/** 1-byte ASCII, 2-byte Latin/Cyrillic, 3-byte Hangul/CJK, 4-byte emoji. */
const MIXED = 'ascii ÆØÅ дом 도착했습니다 漢字 🚀👩‍💻🇰🇷 tail'

let workspaceCounter = 0
function uniqueWorkspace(): string {
  workspaceCounter += 1
  return `adhmux-utf8-test-${process.pid}-${workspaceCounter}`
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function responseEnvelope(requestId: string, content: string): string {
  return `${JSON.stringify({
    kind: 'response',
    requestId,
    response: { success: true, data: { content } },
  })}\n`
}

function contentOf(result: { data?: unknown }): string | undefined {
  return (result.data as { content?: string } | undefined)?.content
}

/**
 * Offsets at which cutting the buffer tears a multi-byte UTF-8 sequence.
 *
 * A split only exposes the defect when the byte it lands on is a continuation
 * byte (10xxxxxx) — cutting on a character boundary decodes fine even with the
 * broken per-chunk `toString()`. These offsets are COMPUTED rather than
 * hand-picked: an earlier draft hard-coded offsets that turned out to be clean
 * boundaries, so those tests passed against the unfixed parser.
 */
function tearingOffsets(bytes: Buffer): number[] {
  const offsets: number[] = []
  for (let i = 1; i < bytes.length; i += 1) {
    if ((bytes[i] & 0xc0) === 0x80) offsets.push(i)
  }
  return offsets
}

function firstTearingOffset(bytes: Buffer): number {
  const [first] = tearingOffsets(bytes)
  assert.ok(first !== undefined, 'precondition: payload must contain a multi-byte sequence to tear')
  return first
}

/** A handful of tearing offsets spread across the buffer, in ascending order. */
function sampleTearingOffsets(bytes: Buffer, count: number): number[] {
  const all = tearingOffsets(bytes)
  assert.ok(all.length >= count, `precondition: need >=${count} tearing offsets, found ${all.length}`)
  const step = Math.floor(all.length / count)
  return Array.from({ length: count }, (_, i) => all[i * step])
}

// ---------------------------------------------------------------------------
// Parser-level: exhaustive boundary coverage (no socket timing involved)
// ---------------------------------------------------------------------------

test('control parser: payload survives EVERY interior byte split point', () => {
  // The load-bearing test. The defect only manifests when the cut lands
  // mid-sequence, and which offsets those are is exactly what we must not have
  // to guess — so sweep all of them rather than sampling.
  const line = Buffer.from(responseEnvelope('req-1', MIXED), 'utf8')
  const corrupted: string[] = []

  for (let split = 1; split < line.length; split += 1) {
    const seen: any[] = []
    const parser = createControlLineParser((envelope) => seen.push(envelope))
    parser(line.subarray(0, split))
    parser(line.subarray(split))

    if (seen.length !== 1) {
      corrupted.push(`split ${split}: expected 1 envelope, got ${seen.length}`)
      continue
    }
    const got = seen[0]?.response?.data?.content
    if (got !== MIXED) {
      corrupted.push(`split ${split}: ${JSON.stringify(got?.slice(0, 48))}`)
    }
  }

  assert.deepEqual(
    corrupted,
    [],
    `payload corrupted at ${corrupted.length} split point(s) — a multi-byte sequence was torn across chunks:\n${corrupted.slice(0, 10).join('\n')}`,
  )
})

test('control parser: reproduces the 8192-byte boundary shape without loss', () => {
  // The live incident shape from the sister socket: a long Korean payload where
  // a 3-byte character straddles an 8192-byte chunk boundary.
  //
  // The filler length is chosen so the boundary lands MID-SEQUENCE. An earlier
  // draft used 2000 chars, which produced a 6099-byte envelope — under 8192, so
  // it was never chunked at all and the test passed on the unfixed parser.
  // Assert the precondition rather than trusting the arithmetic.
  const filler = '가'.repeat(4000) // 3 bytes each
  const text = `${filler}도착`
  const bytes = Buffer.from(responseEnvelope('req-8192', text), 'utf8')

  assert.ok(bytes.length > 8192, 'precondition: the envelope must actually span a chunk boundary')
  assert.equal(
    bytes[8192] & 0xc0,
    0x80,
    'precondition: byte 8192 must be a UTF-8 continuation byte, i.e. the boundary tears a character',
  )

  const seen: any[] = []
  const parser = createControlLineParser((envelope) => seen.push(envelope))
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    parser(bytes.subarray(offset, offset + 8192))
  }

  assert.equal(seen.length, 1)
  const got = seen[0].response.data.content
  assert.equal(got, text)
  assert.ok(got.endsWith('도착'), 'the character on the chunk boundary must survive intact')
  assert.ok(!got.includes('�'), 'payload must contain no U+FFFD replacement characters')
})

test('control parser: deterministic uneven chunking reassembles byte-identically', () => {
  const bytes = Buffer.from(
    [responseEnvelope('a', `${MIXED} #1`), responseEnvelope('b', `${MIXED} #2`), responseEnvelope('c', `${MIXED} #3`)].join(''),
    'utf8',
  )
  // No RNG — split sizes must be replayable when this test fails.
  const sizes = [1, 2, 3, 5, 7, 11, 13, 17, 23, 29, 31, 37]

  const seen: any[] = []
  const parser = createControlLineParser((envelope) => seen.push(envelope))
  let offset = 0
  let i = 0
  while (offset < bytes.length) {
    const size = sizes[i % sizes.length]
    parser(bytes.subarray(offset, offset + size))
    offset += size
    i += 1
  }

  assert.equal(seen.length, 3)
  assert.deepEqual(
    seen.map((e) => e.response.data.content),
    [`${MIXED} #1`, `${MIXED} #2`, `${MIXED} #3`],
  )
})

test('control parser: empty chunks are a no-op around a mid-sequence split', () => {
  const bytes = Buffer.from(responseEnvelope('empty', MIXED), 'utf8')
  const split = firstTearingOffset(bytes)
  const seen: any[] = []
  const parser = createControlLineParser((envelope) => seen.push(envelope))
  parser(Buffer.alloc(0))
  parser(bytes.subarray(0, split))
  parser(Buffer.alloc(0))
  parser(bytes.subarray(split))
  parser(Buffer.alloc(0))

  assert.equal(seen.length, 1)
  assert.equal(seen[0].response.data.content, MIXED)
})

test('control parser: end() surfaces an unterminated tail and never parses it', () => {
  const bytes = Buffer.from(responseEnvelope('tail', MIXED), 'utf8')
  const seen: any[] = []
  const parser = createControlLineParser((envelope) => seen.push(envelope))
  parser(bytes.subarray(0, 40)) // cut mid-line AND mid-sequence

  const remainder = parser.end()
  assert.equal(seen.length, 0, 'a truncated line must not be parsed as an envelope')
  assert.ok(remainder.length > 0, 'end() must surface the unterminated tail')
  assert.equal(parser.end(), '', 'end() is idempotent — the buffer is drained')
})

test('control parser: end() does not throw on a half-written envelope', () => {
  const parser = createControlLineParser(() => {})
  parser(Buffer.from('{"kind":"respon', 'utf8'))
  assert.doesNotThrow(() => parser.end())
})

test('control parser: string chunks bypass the decoder untouched', () => {
  const json = responseEnvelope('str', MIXED)
  const seen: any[] = []
  const parser = createControlLineParser((envelope) => seen.push(envelope))
  parser(json.slice(0, 12))
  parser(json.slice(12))

  assert.equal(seen.length, 1)
  assert.equal(seen[0].response.data.content, MIXED)
})

// ---------------------------------------------------------------------------
// Socket-level: both ends are actually wired to the corrected parser
// ---------------------------------------------------------------------------

test('control socket: client reassembles a response split across real data events', async () => {
  // Forces genuinely SEPARATE 'data' events by awaiting between writes —
  // without the await the kernel coalesces them and the split never reaches the
  // parser at all.
  const workspace = uniqueWorkspace()
  const endpoint = getWorkspaceControlEndpoint(workspace)

  const server = net.createServer((socket) => {
    socket.on('error', () => { /* peer teardown is expected */ })
    socket.on('data', async (chunk) => {
      const requestId = (JSON.parse(chunk.toString('utf8').trim()) as { requestId: string }).requestId
      const bytes = Buffer.from(responseEnvelope(requestId, MIXED), 'utf8')
      // Split points COMPUTED to land mid-sequence — hand-picked offsets are
      // how an earlier draft accidentally cut on clean character boundaries.
      let prev = 0
      for (const offset of sampleTearingOffsets(bytes, 4)) {
        socket.write(bytes.subarray(prev, offset))
        await delay(15) // let the peer drain, so the next write is its own event
        prev = offset
      }
      socket.write(bytes.subarray(prev))
    })
  })
  server.listen(endpoint.path)

  const client = new AdhMuxControlClient(workspace)
  try {
    const result = await client.request({ type: 'capture_pane' })
    const got = contentOf(result)
    assert.equal(got, MIXED, 'payload was corrupted across real socket chunk boundaries')
    assert.ok(!got?.includes('�'), 'payload must contain no U+FFFD replacement characters')
  } finally {
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('control socket: server reassembles a send_keys request split across real data events', async () => {
  // The inbound direction — user keystrokes reaching the pane.
  const workspace = uniqueWorkspace()
  const received: AdhMuxControlRequest[] = []
  const server = createAdhMuxControlServer(workspace, async (request) => {
    received.push(request)
    return { success: true }
  })
  const endpoint = getWorkspaceControlEndpoint(workspace)
  await delay(50)

  const bytes = Buffer.from(
    `${JSON.stringify({
      kind: 'request',
      requestId: 'req-send-keys',
      request: { type: 'send_keys', payload: { keys: MIXED } },
    })}\n`,
    'utf8',
  )

  const socket = net.createConnection(endpoint.path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  // Tear the frame at COMPUTED mid-sequence offsets, draining between each
  // write so the server sees distinct 'data' events rather than one coalesced
  // buffer.
  let prev = 0
  for (const offset of sampleTearingOffsets(bytes, 4)) {
    socket.write(bytes.subarray(prev, offset))
    await delay(15)
    prev = offset
  }
  socket.write(bytes.subarray(prev))
  await delay(200)
  socket.destroy()
  server.close()

  assert.equal(received.length, 1, 'exactly one request must be reassembled from the torn chunks')
  assert.equal(
    (received[0].payload as { keys: string }).keys,
    MIXED,
    'keystroke payload was corrupted across chunk boundaries',
  )
})

test('control socket: a clean FIN fails the in-flight request instead of hanging 30s', async () => {
  // FIN handling. Before the fix the client registered only 'error', so a peer
  // that closed cleanly mid-request left the waiter pending to its 30s timeout
  // and `this.socket` pointing at a dead socket.
  const workspace = uniqueWorkspace()
  const endpoint = getWorkspaceControlEndpoint(workspace)
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* expected */ })
    socket.on('data', () => { socket.end() }) // FIN without ever answering
  })
  server.listen(endpoint.path)

  const client = new AdhMuxControlClient(workspace)
  const started = Date.now()
  try {
    await assert.rejects(
      () => client.request({ type: 'capture_pane' }),
      /adhmux control connection (ended|closed)/,
      'a clean FIN must reject the in-flight request with a connection reason',
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `rejection must be prompt, not the 30s request timeout (took ${elapsed}ms)`)
  } finally {
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('control socket: a FIN mid-frame drops the partial line without parsing or throwing', async () => {
  // A peer cut off mid-write leaves a newline-unterminated frame. It must not
  // reach JSON.parse — that would be an uncaught exception inside a socket
  // close handler, turning the peer's death into a crash of this process.
  const workspace = uniqueWorkspace()
  const endpoint = getWorkspaceControlEndpoint(workspace)
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* expected */ })
    socket.on('data', () => {
      const full = Buffer.from(responseEnvelope('never', '도착'), 'utf8')
      socket.write(full.subarray(0, full.length - 8)) // cut mid multi-byte seq
      socket.end()
    })
  })
  server.listen(endpoint.path)

  const client = new AdhMuxControlClient(workspace)
  const events: unknown[] = []
  client.onEvent((event) => events.push(event))
  try {
    await assert.rejects(
      () => client.request({ type: 'capture_pane' }),
      /adhmux control connection (ended|closed)/,
    )
    assert.equal(events.length, 0, 'a truncated frame must not surface as an envelope')
  } finally {
    await client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('control socket: server survives a client that dies mid-frame', async () => {
  // Server-side FIN: the peer writes a partial envelope then vanishes. The
  // server must neither parse the fragment nor crash on the socket teardown.
  const workspace = uniqueWorkspace()
  const received: AdhMuxControlRequest[] = []
  const server = createAdhMuxControlServer(workspace, async (request) => {
    received.push(request)
    return { success: true }
  })
  const endpoint = getWorkspaceControlEndpoint(workspace)
  await delay(50)

  const bytes = Buffer.from(
    `${JSON.stringify({
      kind: 'request',
      requestId: 'partial',
      request: { type: 'send_keys', payload: { keys: '도착했습니다' } },
    })}\n`,
    'utf8',
  )
  const socket = net.createConnection(endpoint.path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  socket.write(bytes.subarray(0, bytes.length - 10))
  socket.end()

  await delay(200)
  assert.equal(received.length, 0, 'a truncated request must not be dispatched to the handler')
  server.close()
})
