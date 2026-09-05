import test from 'node:test'
import assert from 'node:assert/strict'
import { createLineParser } from '../src/ipc.js'
import type { SessionHostWireEnvelope } from '../src/types.js'

/**
 * UTF8-CHUNK-BOUNDARY regression cover.
 *
 * The parser used to call `chunk.toString()` on each socket Buffer in
 * isolation. A multi-byte UTF-8 sequence straddling a chunk boundary was
 * decoded as two truncated sequences and each half collapsed to U+FFFD. The
 * corruption is silent: U+FFFD is legal JSON string content, so the envelope
 * still parses and only the value is wrong. An owner's 11,994-char Korean
 * prompt lost the `도` starting at wire offset 8190 to the 8192-byte boundary
 * and arrived as `�착`.
 *
 * The load-bearing test is `every byte split point` below: it is the only one
 * that would have caught the original defect, because the bug reproduces at
 * exactly the offsets where a character happens to straddle a chunk.
 */

function collect(): { parser: ReturnType<typeof createLineParser>; seen: SessionHostWireEnvelope[] } {
  const seen: SessionHostWireEnvelope[] = []
  const parser = createLineParser((envelope) => { seen.push(envelope) })
  return { parser, seen }
}

/** An envelope whose payload mixes scripts with 1-, 2-, 3- and 4-byte encodings. */
function makeEnvelope(text: string): SessionHostWireEnvelope {
  return {
    kind: 'event',
    event: { type: 'session_output', sessionId: 'sess-utf8', data: text },
  } as unknown as SessionHostWireEnvelope
}

function payloadOf(envelope: SessionHostWireEnvelope): string {
  return (envelope as unknown as { event: { data: string } }).event.data
}

test('createLineParser: reassembles a multi-byte payload across EVERY byte split point', () => {
  // 1-byte ASCII, 2-byte Latin/Cyrillic, 3-byte Hangul/CJK, 4-byte emoji
  // (surrogate pairs) — every UTF-8 sequence length is represented, so a
  // boundary landing anywhere inside any of them is exercised.
  const text = 'ascii ÆØÅ дом 도착했습니다 漢字 🚀👩‍💻🇰🇷 tail'
  const line = Buffer.from(`${JSON.stringify(makeEnvelope(text))}\n`, 'utf8')

  // Every interior split, not a sampled few: the defect only shows when the
  // cut lands mid-sequence, and which offsets those are is what we must not
  // have to guess.
  for (let split = 1; split < line.length; split += 1) {
    const { parser, seen } = collect()
    parser(line.subarray(0, split))
    parser(line.subarray(split))

    assert.equal(seen.length, 1, `split at byte ${split}: expected exactly one envelope`)
    assert.equal(
      payloadOf(seen[0]),
      text,
      `split at byte ${split}: payload was corrupted (multi-byte sequence torn across chunks)`,
    )
    assert.ok(
      !payloadOf(seen[0]).includes('�'),
      `split at byte ${split}: payload contains U+FFFD replacement characters`,
    )
  }
})

test('createLineParser: reproduces the reported 8192-byte boundary corruption shape', () => {
  // The live incident: a long Korean prompt where a 3-byte `도` began at wire
  // offset 8190 and the socket delivered 8192-byte chunks. Rebuild that shape
  // exactly rather than asserting on a synthetic short string.
  const filler = '가'.repeat(2000) // 3 bytes each — pushes the target past 8190
  const text = `${filler}도착`
  const json = `${JSON.stringify(makeEnvelope(text))}\n`
  const bytes = Buffer.from(json, 'utf8')

  const { parser, seen } = collect()
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    parser(bytes.subarray(offset, offset + 8192))
  }

  assert.equal(seen.length, 1)
  assert.equal(payloadOf(seen[0]), text)
  assert.ok(payloadOf(seen[0]).endsWith('도착'), 'the character on the chunk boundary must survive intact')
})

test('createLineParser: byte-identical reassembly of a chunked stream at random splits', () => {
  const text = '경계 🚀 boundary 検証 ÆØÅ'
  const envelopes = [makeEnvelope(`${text} #1`), makeEnvelope(`${text} #2`), makeEnvelope(`${text} #3`)]
  const bytes = Buffer.from(envelopes.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8')

  // Deterministic uneven chunking (no RNG — the split sizes must be replayable
  // when this test fails).
  const sizes = [1, 2, 3, 5, 7, 11, 13, 17, 23, 29, 31, 37]
  const { parser, seen } = collect()
  let offset = 0
  let i = 0
  while (offset < bytes.length) {
    const size = sizes[i % sizes.length]
    parser(bytes.subarray(offset, offset + size))
    offset += size
    i += 1
  }

  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map(payloadOf), [`${text} #1`, `${text} #2`, `${text} #3`])
})

test('createLineParser: string chunks still work (back-compat with pre-Buffer callers)', () => {
  // String input is already decoded; it must bypass the decoder untouched
  // rather than being re-encoded through Buffer.from.
  const text = '도착 🚀 ÆØÅ'
  const json = `${JSON.stringify(makeEnvelope(text))}\n`

  const { parser, seen } = collect()
  parser(json.slice(0, 12))
  parser(json.slice(12))

  assert.equal(seen.length, 1)
  assert.equal(payloadOf(seen[0]), text)
})

test('createLineParser: handles multiple envelopes in a single chunk and a split trailing line', () => {
  const a = makeEnvelope('첫번째 🚀')
  const b = makeEnvelope('두번째 漢字')
  const bytes = Buffer.from(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, 'utf8')

  const { parser, seen } = collect()
  parser(bytes)
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.map(payloadOf), ['첫번째 🚀', '두번째 漢字'])
})

test('createLineParser: end() flushes an incomplete tail instead of dropping it silently', () => {
  const text = '미완성 도착'
  const bytes = Buffer.from(`${JSON.stringify(makeEnvelope(text))}\n`, 'utf8')

  // Cut mid-way through the payload AND mid-sequence, then EOF. The line never
  // completed, so no envelope may be emitted — but the held-back bytes must be
  // reported to the caller rather than disappearing with the decoder.
  const { parser, seen } = collect()
  parser(bytes.subarray(0, 40))
  const remainder = parser.end()

  assert.equal(seen.length, 0, 'a truncated line must not be parsed as an envelope')
  assert.ok(remainder.length > 0, 'end() must surface the unterminated tail')
  assert.equal(parser.end(), '', 'end() is idempotent — the buffer is drained')
})

test('createLineParser: end() does not throw on a half-written envelope', () => {
  // A peer dying mid-write must not become an uncaught exception in the
  // process observing it.
  const { parser } = collect()
  parser(Buffer.from('{"kind":"even', 'utf8'))
  assert.doesNotThrow(() => parser.end())
})

test('createLineParser: ignores blank lines and surrounding whitespace', () => {
  const envelope = makeEnvelope('공백 처리')
  const bytes = Buffer.from(`\n  \n${JSON.stringify(envelope)}\n\n`, 'utf8')

  const { parser, seen } = collect()
  parser(bytes)
  assert.equal(seen.length, 1)
  assert.equal(payloadOf(seen[0]), '공백 처리')
})
