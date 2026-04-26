import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { __testing } from '../src/runtime.js'

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
