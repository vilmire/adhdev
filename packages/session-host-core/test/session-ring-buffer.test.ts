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

/**
 * TRIM-BOUNDARY regression cover.
 *
 * Eviction drops whole chunks, and a chunk boundary is a PTY read boundary — an
 * arbitrary offset. The chunk left at the head could therefore begin partway
 * through an escape sequence or a multi-byte character, and `snapshot(0)` hands
 * that raw text straight to the browser xterm ("Load older terminal output"
 * skips the emulator viewport). The reported screenshot showed the result:
 * orphaned `.` and `5` glyphs above the output and a large blank band at the
 * top, because `[H` / `32m` printed literally and a leading `\x1b[2J\x1b[H`
 * never arrived to clear and home the screen.
 *
 * The load-bearing test is `every cut offset` below. Like the every-byte-split
 * sweep in `ipc-line-parser-utf8.test.ts`, it is the only one that covers the
 * defect properly: which offsets tear a sequence is exactly what we must not
 * have to guess, and a handful of hardcoded offsets would miss most of them.
 */

/** Forces the head chunk to be exactly `head`, then one more chunk after it. */
function bufferWithEvictedHead(head: string, tail: string): SessionRingBuffer {
  // maxBytes small enough that appending `tail` evicts the first chunk.
  const filler = 'F'.repeat(64)
  const maxBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8')
  const buffer = new SessionRingBuffer({ maxBytes })
  buffer.append(filler)
  buffer.append(head)
  buffer.append(tail)
  return buffer
}

/** A realistic session opening: clear+home, SGR-styled banner, Hangul prompt. */
const SESSION_OPENING = '\x1b[2J\x1b[H\x1b[1m\x1b[32mClaude Code v2.1.220\x1b[0m\r\n워커 폴더에 BATRP라는 폴더 만들어\r\n'

test('trim never leaves the replay head starting inside an escape sequence or a torn character, at EVERY cut offset', () => {
  // Every interior cut, not a sampled few: the corruption only appears when the
  // cut lands mid-sequence, and those offsets are what we must not have to
  // guess. Each iteration simulates eviction having removed `cut` characters.
  for (let cut = 1; cut < SESSION_OPENING.length; cut += 1) {
    const head = SESSION_OPENING.slice(cut)
    const buffer = bufferWithEvictedHead(head, 'tail-marker\r\n')
    const { text } = buffer.snapshot(0)

    assert.ok(
      !text.includes('�'),
      `cut at ${cut}: replay contains a U+FFFD replacement character`,
    )

    // The head must not begin with the tail of a cut CSI. Anything printable
    // before the first ESC that looks like `[2J` / `32m` / `J` would render as
    // literal garbage in the terminal — the reported `.` and `5` fragments.
    const firstEsc = text.indexOf('\x1b')
    const beforeEsc = firstEsc === -1 ? text : text.slice(0, firstEsc)
    assert.ok(
      !/^\[?[0-9;?:]*[\x40-\x7e]/.test(beforeEsc) || /^[A-Za-z가-힣]/.test(beforeEsc),
      `cut at ${cut}: replay starts with the tail of a cut escape sequence (${JSON.stringify(text.slice(0, 12))})`,
    )

    assert.ok(text.endsWith('tail-marker\r\n'), `cut at ${cut}: later output must survive the repair`)
  }
})

test('trim drops a torn multi-byte character rather than replaying it as U+FFFD', () => {
  // A byte-level cut inside the 3-byte Hangul `워` has already decayed to
  // U+FFFD by the time it reaches the buffer (chunks are JS strings). This is
  // the same corruption class `createLineParser` guards against on the IPC
  // socket path; there the other half can be re-joined, here it is gone, so the
  // only correct repair is to drop the debris.
  const bytes = Buffer.from(SESSION_OPENING, 'utf8')
  const hangulAt = Buffer.byteLength(SESSION_OPENING.slice(0, SESSION_OPENING.indexOf('워')), 'utf8')

  for (let skew = 1; skew <= 2; skew += 1) {
    const head = bytes.subarray(hangulAt + skew).toString('utf8')
    assert.ok(head.startsWith('�'), `precondition: a byte cut at +${skew} produces U+FFFD`)

    const buffer = bufferWithEvictedHead(head, 'tail\r\n')
    const { text } = buffer.snapshot(0)
    assert.ok(!text.includes('�'), `byte cut at +${skew}: U+FFFD leaked into the replay`)
    assert.ok(text.startsWith('커 폴더에'), `byte cut at +${skew}: repair should resume at the next intact character`)
  }
})

test('trim drops a torn astral character instead of replaying a lone surrogate', () => {
  // 4-byte UTF-8 (emoji) arrives as a surrogate pair; a cut between the halves
  // leaves an unpaired surrogate, which is not a renderable character.
  const source = '🚀 done\r\n'
  const head = source.slice(1) // drop the high surrogate, keep the low one
  assert.equal(head.charCodeAt(0) >= 0xdc00 && head.charCodeAt(0) <= 0xdfff, true, 'precondition: lone low surrogate')

  const buffer = bufferWithEvictedHead(head, 'tail\r\n')
  const { text } = buffer.snapshot(0)
  const lead = text.charCodeAt(0)
  assert.ok(!(lead >= 0xd800 && lead <= 0xdfff), 'replay must not start with an unpaired surrogate')
  assert.ok(text.startsWith(' done'), 'repair should resume at the next intact character')
})

test('trim leaves an already-clean head untouched', () => {
  // The repair must not eat legitimate output. A head that starts on ordinary
  // text — including text whose first characters happen to be digits or a
  // letter — has to survive byte-for-byte, or the fix would silently shorten
  // every replay.
  for (const head of ['plain output line\r\n', '2 files changed\r\n', 'J is a letter\r\n', '워커 폴더에\r\n', '\x1b[2J\x1b[Hclean\r\n']) {
    const buffer = bufferWithEvictedHead(head, 'tail\r\n')
    const { text } = buffer.snapshot(0)
    assert.equal(text, `${head}tail\r\n`, `a clean head must be replayed verbatim: ${JSON.stringify(head)}`)
  }
})

test('trim keeps the byte accounting consistent after repairing the head', () => {
  // healHead shortens a chunk in place; if totalBytes were not adjusted the
  // buffer would under-report and start evicting early (or never).
  const head = SESSION_OPENING.slice(5) // orphaned `[H…`
  const tail = 'tail\r\n'
  const buffer = bufferWithEvictedHead(head, tail)

  const { text } = buffer.snapshot(0)
  assert.equal(
    buffer.getState().scrollbackBytes,
    Buffer.byteLength(text, 'utf8'),
    'scrollbackBytes must equal the bytes actually retained after repair',
  )
})

test('the reported orphan-fragment shapes no longer reach the replay', () => {
  // The exact shapes measured during the investigation of the mobile
  // screenshot. Each previously rendered as literal text in the terminal.
  const cases: Array<[number, string]> = [
    [5, '[H'],   // CSI introducer evicted -> `[H` printed literally
    [12, '2m'],  // half an SGR printed literally
  ]
  for (const [cut, garbage] of cases) {
    const buffer = bufferWithEvictedHead(SESSION_OPENING.slice(cut), 'tail\r\n')
    const { text } = buffer.snapshot(0)
    assert.ok(
      !text.startsWith(garbage),
      `cut at ${cut}: replay still begins with the literal fragment ${JSON.stringify(garbage)}`,
    )
  }
})
