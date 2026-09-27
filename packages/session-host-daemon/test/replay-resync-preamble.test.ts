import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRuntimeSnapshot } from '../src/session-protocol.js'
import type { SessionBufferSnapshot, SessionHostRecord } from '@adhdev/session-host-core'

/**
 * TRIM-BOUNDARY defence cover (the second half of the ring-buffer replay fix).
 *
 * `SessionRingBuffer` repairs a torn *prefix*, but it cannot restore state that
 * was evicted rather than damaged. When eviction cuts after the session's
 * opening `\x1b[2J\x1b[H`, the retained head is well-formed text and no buffer
 * repair applies — yet the receiving terminal was never told to clear or home,
 * so replayed output lands wherever the cursor happened to be. That is the
 * large blank band at the top of the reported mobile screenshot.
 *
 * These tests pin the resync preamble that covers that gap, and — just as
 * importantly — pin that it does NOT fire on incremental reads, where clearing
 * would erase the scrollback the client is extending.
 */

function snapshot(text: string): SessionBufferSnapshot {
  return { seq: 42, text, truncated: false } as SessionBufferSnapshot
}

const record = { meta: { sessionHostCols: 120, sessionHostRows: 40 } } as unknown as SessionHostRecord

test('a from-scratch replay is prefixed with clear+home so evicted screen state cannot skew row placement', () => {
  // The cut landed after the opening clear/home: the text itself is clean, so
  // the buffer layer has nothing to repair, and only the preamble prevents the
  // blank-band symptom.
  const merged = mergeRuntimeSnapshot(snapshot('더에 BATRP라는 폴더 만들어\r\n'), record, {
    sinceSeq: 0,
    runtimeText: '',
  })

  assert.ok(merged.text.startsWith('\x1b[2J\x1b[H'), 'sinceSeq=0 replay must start from a known screen state')
  assert.ok(merged.text.endsWith('더에 BATRP라는 폴더 만들어\r\n'), 'the retained output must still be replayed')
  assert.equal(merged.cols, 120)
  assert.equal(merged.rows, 40)
})

test('an incremental read is never cleared — that would erase the scrollback the client is extending', () => {
  const delta = 'next line of output\r\n'
  const merged = mergeRuntimeSnapshot(snapshot(delta), record, { sinceSeq: 17, runtimeText: '' })

  assert.equal(merged.text, delta, 'sinceSeq>0 is a delta appended to what the client already shows')
})

test('a replay that already begins with clear+home is not double-prefixed', () => {
  const text = '\x1b[2J\x1b[Hbanner\r\n'
  const merged = mergeRuntimeSnapshot(snapshot(text), record, { sinceSeq: 0, runtimeText: '' })

  assert.equal(merged.text, text, 'the preamble must not be duplicated when the stream already carries it')
})

test('an empty replay stays empty rather than becoming a bare screen clear', () => {
  const merged = mergeRuntimeSnapshot(snapshot(''), record, { sinceSeq: 0, runtimeText: '' })

  assert.equal(merged.text, '', 'nothing to replay means nothing to send — not a gratuitous screen wipe')
})

test('the live runtime viewport path is untouched by the preamble', () => {
  // When the emulator viewport is available it is already a coherent
  // full-screen render; it replaces the raw buffer wholesale and must not be
  // rewritten here.
  const runtimeText = 'rendered viewport contents'
  const merged = mergeRuntimeSnapshot(snapshot('raw buffer'), record, { runtimeText })

  assert.equal(merged.text, runtimeText)
  assert.equal(merged.truncated, false)
})
