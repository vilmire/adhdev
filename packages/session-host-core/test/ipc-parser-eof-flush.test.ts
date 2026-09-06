import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionHostClient, createLineParser } from '../src/ipc.js'

/**
 * PARSER-EOF-FLUSH regression cover.
 *
 * `createLineParser().end()` was fully implemented and fully unit-tested (see
 * ipc-line-parser-utf8.test.ts) — and completely UNREACHABLE. Both call sites
 * passed the parser inline to `socket.on('data', createLineParser(...))` and
 * kept no reference, so nothing could ever call `end()`. The decoder's held-back
 * bytes were dropped with the decoder at EOF.
 *
 * The unit tests above could not catch this: they call `parser.end()` directly,
 * which is precisely the call the production wiring never made. So these assert
 * the WIRING — that a real socket lifecycle reaches the flush — rather than the
 * parser semantics, which are already covered.
 *
 * Scope note: the in-stream UTF-8 fix (`decoder.write`) was always live. Only
 * this EOF tail was dead, and its impact is low — a truncated final frame is
 * discarded either way. What changes is that it is now OBSERVABLE instead of
 * silent.
 */

function tempEndpoint(name: string): { kind: 'unix' | 'pipe'; path: string } {
  if (process.platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\adhdev-test-${name}-${process.pid}` }
  }
  return { kind: 'unix', path: path.join(os.tmpdir(), `adhdev-test-${name}-${process.pid}.sock`) }
}

test('SessionHostClient: holds a parser reference so end() is reachable at EOF', async () => {
  const endpoint = tempEndpoint('eof-flush')
  if (endpoint.kind === 'unix') {
    try { fs.unlinkSync(endpoint.path) } catch { /* noop */ }
  }

  // The server writes ONE complete envelope followed by a truncated frame, then
  // hangs up — the peer-died-mid-write case the flush exists for.
  const server = net.createServer((socket) => {
    socket.write(`${JSON.stringify({ kind: 'event', event: { type: 'session_output', sessionId: 's', data: 'ok' } })}\n`)
    socket.write('{"kind":"event","event":{"type":"session_out')
    socket.end()
  })

  await new Promise<void>((resolve) => server.listen(endpoint.path, () => resolve()))

  try {
    const client = new SessionHostClient({ endpoint })
    const events: unknown[] = []
    client.onEvent((event) => { events.push(event) })

    const disconnected = new Promise<{ droppedTailBytes: number }>((resolve) => {
      client.onDisconnect((info) => resolve(info))
    })

    await client.connect()
    const info = await disconnected

    // The COMPLETE frame was delivered normally...
    assert.equal(events.length, 1, 'the complete envelope is delivered')

    // ★ RED WITHOUT THE FIX: with the parser passed inline and its handle
    // discarded, `end()` is unreachable, nothing drains the buffer, and this
    // count is 0 — the truncated frame vanishes with no trace that it existed.
    assert.equal(
      info.droppedTailBytes,
      '{"kind":"event","event":{"type":"session_out'.length,
      'the incomplete tail is flushed and reported at EOF',
    )

    // ...and it did NOT become an uncaught exception: the flush RETURNS the
    // partial frame for reporting rather than parsing it. Had it parsed, this
    // process would have died on an unhandled JSON.parse error inside a socket
    // handler before reaching here.
    assert.equal(events.length, 1, 'a truncated tail is never emitted as an envelope')

    await client.close()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (endpoint.kind === 'unix') {
      try { fs.unlinkSync(endpoint.path) } catch { /* noop */ }
    }
  }
})

test('the EOF flush contract: end() returns the tail and never parses it', () => {
  // Pins the contract the wiring above depends on: `end()` hands the caller a
  // string to LOG, and does not attempt to interpret a partial frame.
  const seen: unknown[] = []
  const parser = createLineParser((envelope) => { seen.push(envelope) })

  parser(Buffer.from('{"kind":"event","event":{"type":"x"}}\n', 'utf8'))
  parser(Buffer.from('{"kind":"eve', 'utf8'))

  assert.equal(seen.length, 1, 'only the complete frame is emitted')
  const remainder = parser.end()
  assert.equal(remainder, '{"kind":"eve', 'the incomplete tail is RETURNED, not parsed')
  assert.equal(seen.length, 1, 'flushing must not emit a partial frame as an envelope')
})

test('the EOF flush releases bytes the decoder held back mid-character', () => {
  // The decoder withholds an incomplete multi-byte sequence. Without a reachable
  // end(), those bytes vanished silently with the decoder.
  const parser = createLineParser(() => { /* noop */ })
  const korean = Buffer.from('도착', 'utf8')

  // Feed a partial line that also ends mid-character.
  parser(Buffer.from('{"a":"', 'utf8'))
  parser(korean.subarray(0, 2)) // first 2 of 3 bytes of '도'

  const remainder = parser.end()
  assert.ok(remainder.startsWith('{"a":"'), 'the buffered partial line is returned')
  assert.ok(remainder.length > '{"a":"'.length, 'the held-back bytes are released rather than dropped')
})
