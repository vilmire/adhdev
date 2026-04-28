import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SESSION_RING_BUFFER_MAX_BYTES, SessionRingBuffer } from '../src/index.js'

test('default session ring buffer retains multi-megabyte terminal conversations for manual older-output replay', () => {
  assert.ok(
    DEFAULT_SESSION_RING_BUFFER_MAX_BYTES >= 2 * 1024 * 1024,
    'manual Load older terminal output should retain more than a tiny 512KiB tail for long conversations',
  )

  const buffer = new SessionRingBuffer()
  const chunk = `${'x'.repeat(16 * 1024)}\n`
  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  const chunksToExceedOldLimit = Math.ceil((768 * 1024) / chunkBytes)

  for (let i = 0; i < chunksToExceedOldLimit; i += 1) {
    buffer.append(`chunk-${i}: ${chunk}`)
  }

  const snapshot = buffer.snapshot(0)
  assert.equal(snapshot.truncated, false, 'default retention should not truncate below 768KiB')
  assert.match(snapshot.text, /chunk-0:/, 'oldest retained output should still be available to sinceSeq=0 replay')
})
