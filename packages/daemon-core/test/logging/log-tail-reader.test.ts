import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import { getCurrentDaemonLogPath, getDaemonLogDir } from '../../src/logging/logger'
import { readDaemonLogTail, DEFAULT_TAIL_BYTES, MAX_TAIL_BYTES } from '../../src/logging/log-tail-reader'

// Use a fixed date far from any real daemon log so this test never reads/clobbers
// a live log file. The reader resolves the path from this date.
const TEST_DATE = '1999-01-02'
const testLogPath = getCurrentDaemonLogPath(new Date(`${TEST_DATE}T00:00:00.000Z`))
const testBackupPath = testLogPath.replace(/\.log$/, '.1.log')

function writeTestLog(content: string): void {
  fs.mkdirSync(getDaemonLogDir(), { recursive: true })
  fs.writeFileSync(testLogPath, content, 'utf-8')
}

afterEach(() => {
  try { fs.unlinkSync(testLogPath) } catch { /* noop */ }
  try { fs.unlinkSync(testBackupPath) } catch { /* noop */ }
})

describe('readDaemonLogTail', () => {
  it('returns the tail lines of a small file (oldest-first) with truncated=false', () => {
    writeTestLog('[12:00:01] line one\n[12:00:02] line two\n[12:00:03] line three\n')
    const result = readDaemonLogTail({ date: TEST_DATE })
    expect(result.success).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.lines).toEqual([
      '[12:00:01] line one',
      '[12:00:02] line two',
      '[12:00:03] line three',
    ])
    expect(result.logPath).toBe(testLogPath)
  })

  it('byte-bounds a large file and sets truncated=true, keeping the newest lines and a clean leading line', () => {
    // Build a file bigger than the tail window. Each line is ~40 bytes.
    const lines: string[] = []
    for (let i = 0; i < 10000; i++) {
      lines.push(`[12:00:00] log line number ${String(i).padStart(6, '0')} payload`)
    }
    writeTestLog(lines.join('\n') + '\n')
    const tailBytes = 8 * 1024
    const result = readDaemonLogTail({ date: TEST_DATE, tailBytes })
    expect(result.success).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.bytesReturned).toBeLessThanOrEqual(tailBytes)
    // Newest lines retained.
    expect(result.lines[result.lines.length - 1]).toContain('009999')
    // The leading partial line was dropped → first line is a complete line.
    expect(result.lines[0]).toMatch(/^\[12:00:00\] log line number \d{6} payload$/)
  })

  it('caps tailBytes at MAX_TAIL_BYTES even when a larger value is requested', () => {
    const big = 'x'.repeat(MAX_TAIL_BYTES * 2)
    writeTestLog(`[12:00:00] ${big}\n`)
    const result = readDaemonLogTail({ date: TEST_DATE, tailBytes: MAX_TAIL_BYTES * 4 })
    expect(result.success).toBe(true)
    expect(result.bytesReturned).toBeLessThanOrEqual(MAX_TAIL_BYTES)
  })

  it('defaults to DEFAULT_TAIL_BYTES when tailBytes is absent/invalid', () => {
    const big = 'y'.repeat(DEFAULT_TAIL_BYTES * 3)
    writeTestLog(`[12:00:00] ${big}\n`)
    const result = readDaemonLogTail({ date: TEST_DATE, tailBytes: -5 })
    expect(result.success).toBe(true)
    expect(result.bytesReturned).toBeLessThanOrEqual(DEFAULT_TAIL_BYTES)
  })

  it('grep filters to matching lines (case-insensitive regex)', () => {
    writeTestLog([
      '[12:00:01] [INF] [CDP] connected',
      '[12:00:02] [ERR] [P2P] connection failed',
      '[12:00:03] [WRN] [Mesh] slow peer',
      '[12:00:04] [ERR] [Mesh] timeout',
    ].join('\n') + '\n')
    const result = readDaemonLogTail({ date: TEST_DATE, grep: 'err' })
    expect(result.success).toBe(true)
    expect(result.filtered).toBe(true)
    expect(result.lines).toEqual([
      '[12:00:02] [ERR] [P2P] connection failed',
      '[12:00:04] [ERR] [Mesh] timeout',
    ])
    expect(result.grep).toBe('err')
  })

  it('grep finds a match that sits BEYOND the tail-byte window (full-file scan past polling spam)', () => {
    // The wanted line is written FIRST, then buried under far more than tailBytes
    // of high-frequency polling spam. A tail-then-filter reader would never see it
    // because it scrolled out of the byte window before the grep ran.
    const wanted = '[12:00:00] [Mesh] dispatch get_mesh_node_logs -> node_73b2 inject forward'
    const spam: string[] = [wanted]
    for (let i = 0; i < 5000; i++) {
      spam.push(`[12:00:0${i % 9}] [Mesh] Incoming P2P 'get_pending_mesh_events' poll ${String(i).padStart(6, '0')}`)
    }
    writeTestLog(spam.join('\n') + '\n')

    // Tail window far smaller than the spam tail so the wanted line is out of it.
    const result = readDaemonLogTail({ date: TEST_DATE, grep: 'dispatch.*inject', tailBytes: 8 * 1024 })
    expect(result.success).toBe(true)
    expect(result.fullScan).toBe(true)
    // The match is recovered despite being far outside the tail window.
    expect(result.lines).toContain(wanted)
    expect(result.matchedLineCount).toBe(1)
    // The spam lines were excluded by the filter, and the full file was scanned.
    expect(result.excludedByFilter).toBe(5000)
    expect(result.filtered).toBe(true)
    expect(result.scannedBytes).toBeGreaterThan(8 * 1024)
  })

  it('byte-caps the MATCHING lines (newest matches kept, truncated=true) in filter mode', () => {
    // Many matching lines, each ~50 bytes; cap to a small window so only the
    // newest handful fit and older matches are dropped from the front.
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) {
      lines.push(`[12:00:00] [Mesh] MATCH dispatch entry number ${String(i).padStart(6, '0')} end`)
    }
    writeTestLog(lines.join('\n') + '\n')
    const tailBytes = 2 * 1024
    const result = readDaemonLogTail({ date: TEST_DATE, grep: 'MATCH dispatch', tailBytes })
    expect(result.success).toBe(true)
    expect(result.matchedLineCount).toBe(1000)
    // Only a subset shipped, bounded by the byte cap.
    expect(result.lines.length).toBeLessThan(1000)
    expect(result.bytesReturned).toBeLessThanOrEqual(tailBytes)
    // Newest matches retained, oldest dropped → truncated.
    expect(result.truncated).toBe(true)
    expect(result.lines[result.lines.length - 1]).toContain('000999')
    expect(result.lines).not.toContain(lines[0])
  })

  it('includes the .1.log size-rotation backup in a filtered full-file scan', () => {
    fs.mkdirSync(getDaemonLogDir(), { recursive: true })
    // Older content lives in the rotation backup; the active file holds spam.
    fs.writeFileSync(testBackupPath, '[12:00:00] [Mesh] ROTATED dispatch line in backup\n', 'utf-8')
    const spam: string[] = []
    for (let i = 0; i < 200; i++) spam.push(`[12:00:01] [Mesh] poll ${i}`)
    writeTestLog(spam.join('\n') + '\n')
    const result = readDaemonLogTail({ date: TEST_DATE, grep: 'ROTATED dispatch' })
    expect(result.success).toBe(true)
    expect(result.lines).toContain('[12:00:00] [Mesh] ROTATED dispatch line in backup')
    expect(result.matchedLineCount).toBe(1)
  })

  it('no-filter mode keeps the legacy byte-bounded tail behaviour (fullScan=false)', () => {
    writeTestLog('[12:00:01] a\n[12:00:02] b\n')
    const result = readDaemonLogTail({ date: TEST_DATE })
    expect(result.success).toBe(true)
    expect(result.fullScan).toBe(false)
    expect(result.filtered).toBe(false)
    expect(result.excludedByFilter).toBe(0)
    expect(result.lines).toEqual(['[12:00:01] a', '[12:00:02] b'])
  })

  it('grep falls back to literal substring on an invalid regex', () => {
    writeTestLog('[12:00:01] value [abc\n[12:00:02] other\n')
    const result = readDaemonLogTail({ date: TEST_DATE, grep: '[abc' }) // unbalanced → invalid regex
    expect(result.success).toBe(true)
    expect(result.lines).toEqual(['[12:00:01] value [abc'])
  })

  it('sinceMs keeps only lines at/after the floor (and lines without a timestamp)', () => {
    writeTestLog([
      '[12:00:01] early',
      '[12:00:05] later',
      'continuation without timestamp',
      '[12:00:09] latest',
    ].join('\n') + '\n')
    const floor = new Date(`${TEST_DATE}T00:00:00.000`)
    floor.setHours(12, 0, 5, 0)
    const result = readDaemonLogTail({ date: TEST_DATE, sinceMs: floor.getTime() })
    expect(result.success).toBe(true)
    expect(result.lines).toContain('[12:00:05] later')
    expect(result.lines).toContain('[12:00:09] latest')
    expect(result.lines).toContain('continuation without timestamp')
    expect(result.lines).not.toContain('[12:00:01] early')
  })

  it('preserves multibyte UTF-8 across the truncation boundary', () => {
    // Fill with multibyte content so the byte-window edge lands inside a line.
    const lines: string[] = []
    for (let i = 0; i < 2000; i++) {
      lines.push(`[12:00:00] 한글로그줄 ${String(i).padStart(5, '0')} 내용 끝`)
    }
    writeTestLog(lines.join('\n') + '\n')
    const result = readDaemonLogTail({ date: TEST_DATE, tailBytes: 4 * 1024 })
    expect(result.success).toBe(true)
    expect(result.truncated).toBe(true)
    // No replacement char (U+FFFD) means no multibyte sequence was split.
    expect(result.lines.join('\n')).not.toContain('�')
    expect(result.lines[0]).toMatch(/^\[12:00:00\] 한글로그줄 \d{5} 내용 끝$/)
  })

  it('falls back to the .1.log rotation backup when the active file is absent', () => {
    fs.mkdirSync(getDaemonLogDir(), { recursive: true })
    fs.writeFileSync(testBackupPath, '[12:00:00] from backup\n', 'utf-8')
    const result = readDaemonLogTail({ date: TEST_DATE })
    expect(result.success).toBe(true)
    expect(result.logPath).toBe(testBackupPath)
    expect(result.lines).toEqual(['[12:00:00] from backup'])
  })

  it('returns success=false with an error when no log file exists', () => {
    const result = readDaemonLogTail({ date: TEST_DATE })
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.lines).toEqual([])
  })
})
