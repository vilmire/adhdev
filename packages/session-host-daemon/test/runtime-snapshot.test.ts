import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { __testing } from '../src/runtime.js'

// codePointLength: counts Unicode code points (not UTF-16 code units), so a
// surrogate-pair emoji counts as 1 "character" the same way a combining-mark
// cluster or a wide CJK syllable does for the assertions below.
function codePointLength(text: string): number {
  return Array.from(text).length
}

test('xterm viewport snapshots preserve ANSI styling and row movement without scrollback replay', async () => {
  const mirror = __testing.createXtermMirror({ cols: 20, rows: 2, scrollback: 100 })

  try {
    mirror.write('old-logo-1\r\nold-logo-2\r\n\x1b[31mCLAUDE\x1b[0m\r\nREADY')
    await delay(50)

    const snapshot = mirror.formatVT()

    assert.match(snapshot, /\x1b\[31m/, 'snapshot should preserve SGR color/style escapes')
    assert.match(snapshot, /CLAUDE/)
    assert.match(snapshot, /READY/)
    assert.doesNotMatch(snapshot, /old-logo-[12]/, 'snapshot should serialize only the active viewport, not stale scrollback')
    assert.equal(snapshot.includes('\r\n'), true, 'snapshot should replay rows with CRLF, not bare LF')
    assert.equal(/(?<!\r)\n/.test(snapshot), false, 'snapshot should not contain bare LF row boundaries')
  } finally {
    mirror.dispose()
  }
})

test('xterm viewport snapshots restore the live cursor before incremental line updates', async () => {
  const original = __testing.createXtermMirror({ cols: 20, rows: 4, scrollback: 100 })
  const replayed = __testing.createXtermMirror({ cols: 20, rows: 4, scrollback: 100 })

  try {
    original.write('A\r\nB\r\nC\x1b[1A\rX')
    await delay(50)
    const snapshot = original.formatVT()

    replayed.write(snapshot)
    await delay(50)

    original.write('\x1b[1B\rY')
    replayed.write('\x1b[1B\rY')
    await delay(50)

    const originalAfterUpdate = original.formatVT()
    const replayedAfterUpdate = replayed.formatVT()

    assert.match(snapshot, /\x1b\[2;2H/, 'snapshot should restore cursor to the live row/column after replay')
    assert.equal(replayedAfterUpdate, originalAfterUpdate, 'incremental cursor-relative updates should land on the same row after snapshot replay')
    assert.equal((replayedAfterUpdate.match(/Y/g) || []).length, 1)
  } finally {
    original.dispose()
    replayed.dispose()
  }
})

// M-TERMINAL-VIEW-CORRUPTION regression coverage: wide-char (CJK/fullwidth)
// spacer cells, emoji, combining marks, and line-end wrap must never surface
// as inserted ASCII spaces in the plain-text / VT snapshot, and column math
// (cursor position) must stay correct throughout. These lock in the existing
// correct behavior of formatXtermViewportPlain()/formatVT() — the pure-TS
// xterm mirror path that actually serves the dashboard's runtime_snapshot —
// as opposed to the native ghostty-vt binding, which is not exercised here
// (see ghostty-vt-node's own native-binding tests for that surface).

test('Korean text round-trips through the xterm mirror with no inserted spaces', async () => {
  const mirror = __testing.createXtermMirror({ cols: 40, rows: 5, scrollback: 100 })
  try {
    const text = '워커 폴더에 파일을 만들어'
    await new Promise<void>((resolve) => mirror.write(text, resolve))

    const plain = mirror.formatPlainText()
    assert.equal(plain, text, 'plain-text snapshot must match the source Korean text exactly, with no inserted spaces between syllables')
  } finally {
    mirror.dispose()
  }
})

test('mixed ASCII/CJK text preserves exact spacing and column count', async () => {
  const mirror = __testing.createXtermMirror({ cols: 40, rows: 5, scrollback: 100 })
  try {
    const text = 'Do you want 워커 to proceed?'
    await new Promise<void>((resolve) => mirror.write(text, resolve))

    const plain = mirror.formatPlainText()
    assert.equal(plain, text, 'mixed ASCII/CJK text must not gain extra spaces around the wide-char run')
  } finally {
    mirror.dispose()
  }
})

test('emoji and combining characters are preserved as single grapheme-adjacent units', async () => {
  const mirror = __testing.createXtermMirror({ cols: 40, rows: 5, scrollback: 100 })
  try {
    const text = 'Hi \u{1F600} test é café' // 😀, combining acute accent (é as e + combining mark twice)
    await new Promise<void>((resolve) => mirror.write(text, resolve))

    const plain = mirror.formatPlainText()
    assert.equal(plain, text, 'emoji and combining-mark clusters must round-trip without inserted spaces')
  } finally {
    mirror.dispose()
  }
})

test('a wide character at the line-end wrap boundary wraps whole, without splitting or padding into a stray space', async () => {
  const mirror = __testing.createXtermMirror({ cols: 10, rows: 5, scrollback: 100 })
  try {
    // 9 narrow columns filled, then a 2-column-wide char that cannot fit in
    // the remaining 1 column of row 0 — a real terminal auto-wraps the whole
    // wide char to the next row rather than splitting it across the boundary.
    await new Promise<void>((resolve) => mirror.write('123456789워커', resolve))

    const plain = mirror.formatPlainText()
    const lines = plain.split('\n')
    assert.equal(lines[0], '123456789', 'the narrow run should fill exactly the first row with no trailing space from the wrapped wide char')
    assert.equal(lines[1], '워커', 'the wide char pair should wrap whole onto the next row')
    assert.ok(!lines[0].includes(' '), 'no inserted space at the wrap boundary')
  } finally {
    mirror.dispose()
  }
})

test('cursor column position accounts for wide-character width (2 columns per CJK syllable)', async () => {
  const mirror = __testing.createXtermMirror({ cols: 40, rows: 5, scrollback: 100 })
  try {
    await new Promise<void>((resolve) => mirror.write('워커', resolve))
    const cursor = mirror.getCursorPosition()
    assert.equal(cursor.col, 4, 'two double-width syllables must advance the cursor by 4 columns, not 2 (char count) or some other drift')
    assert.equal(cursor.row, 0)
  } finally {
    mirror.dispose()
  }
})

test('code-point count is preserved end to end for Korean, mixed, and emoji text (no phantom characters inserted)', async () => {
  const fresh = __testing.createXtermMirror({ cols: 80, rows: 5, scrollback: 100 })
  try {
    for (const text of [
      '워커 폴더에 BATRP라는 폴더 만들어',
      'Do you want 워커 to proceed?',
      'Hi \u{1F600} test',
    ]) {
      fresh.write('\x1b[2J\x1b[H') // reset viewport between samples
      await new Promise<void>((resolve) => fresh.write(text, resolve))
      const plain = fresh.formatPlainText()
      assert.equal(codePointLength(plain), codePointLength(text), `code-point count must be preserved for: ${JSON.stringify(text)}`)
      assert.equal(plain, text)
    }
  } finally {
    fresh.dispose()
  }
})

// This test documents the exact race PtySessionRuntime.flushPendingWrites()
// exists to close: TerminalMirrorHandle.write() (xterm.js's WriteBuffer) is
// asynchronous, so a synchronous read taken immediately after write() returns
// can observe a buffer that has not parsed that chunk yet — stale/incomplete
// text and a stale cursor position, not corrupted text. Awaiting the write's
// own completion callback (which is what flushPendingWrites() does inside
// PtySessionRuntime) makes the read see the fully-parsed state.
test('a synchronous read right after write() can race the async xterm WriteBuffer; awaiting the write callback does not', async () => {
  const mirror = __testing.createXtermMirror({ cols: 40, rows: 5, scrollback: 100 })
  try {
    const text = '워커 폴더에 파일을 만들어'

    // "Before" shape: fire-and-forget write, then read synchronously — this is
    // exactly what runtime.ts's onData handler did prior to the fix (write()
    // with no callback, followed immediately by respondToTerminalQueries()/
    // getSnapshotText() in the same synchronous tick).
    mirror.write(text)
    const staleCursor = mirror.getCursorPosition()
    const stalePlain = mirror.formatPlainText()
    assert.equal(stalePlain, '', 'a same-tick synchronous read must not see the not-yet-parsed chunk (demonstrates the race, not a text-corruption bug)')
    assert.deepEqual(staleCursor, { col: 0, row: 0 }, 'a same-tick cursor read is stale — this is the mechanism that could feed a wrong DSR (\\x1b[6n) reply back to the PTY process')

    // "After" shape: await the write's completion callback (what
    // flushPendingWrites()/getSnapshotText() do now) before reading. The
    // WriteBuffer processes queued chunks in FIFO order, so waiting for a
    // second write's callback guarantees the first chunk above has already
    // been parsed too. Using a non-whitespace marker char (rather than a
    // trailing space, which formatPlainText()'s trailing-whitespace trim
    // would strip) keeps the assertion below unambiguous.
    await new Promise<void>((resolve) => {
      mirror.write('.', resolve)
    })

    const settledCursor = mirror.getCursorPosition()
    const settledPlain = mirror.formatPlainText()
    assert.equal(settledPlain, `${text}.`, 'once the write has actually been parsed, the read reflects the full chunk with no dropped or inserted characters')
    // Assert against the real terminal's own column advance (the thing under
    // test) rather than a hand-derived width table.
    assert.equal(settledCursor.col, 26, 'cursor column must reflect real display width (2 cols per Hangul syllable), not UTF-16/code-point length')
    assert.equal(settledCursor.row, 0)
  } finally {
    mirror.dispose()
  }
})
