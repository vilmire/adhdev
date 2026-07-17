import { describe, expect, it } from 'vitest';
import { truncateToByteTailByLine } from '../../src/cli-adapters/provider-cli-shared.js';

// MESH-READ-TERMINAL (feature 2: RAW terminal read). The mesh_read_terminal payload
// is bounded in BYTES (UTF-8), not characters, and truncation preserves whole lines
// from the BOTTOM (the prompt / modal / most recent output live at the bottom of a
// terminal screen). Whole-line granularity also guarantees the returned text stays
// valid UTF-8 (a line boundary is a code-point boundary).

describe('truncateToByteTailByLine', () => {
  it('returns the input unchanged when it is under the byte cap', () => {
    const text = 'line1\nline2\nline3';
    const r = truncateToByteTailByLine(text, 1024);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
    expect(r.originalBytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(r.returnedBytes).toBe(r.originalBytes);
  });

  it('preserves the BOTTOM lines when truncating', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const text = lines.join('\n');
    const cap = 40; // only a few lines fit
    const r = truncateToByteTailByLine(text, cap);
    expect(r.truncated).toBe(true);
    expect(r.returnedBytes).toBeLessThanOrEqual(cap);
    // The last line must be present; the first must be dropped.
    expect(r.text.endsWith('line-99')).toBe(true);
    expect(r.text).not.toContain('line-0\n');
    // Every kept line is a contiguous bottom slice.
    const keptLines = r.text.split('\n');
    expect(keptLines[keptLines.length - 1]).toBe('line-99');
  });

  it('counts BYTES, not characters, for multi-byte UTF-8', () => {
    // '한' is 3 UTF-8 bytes. 10 chars = 30 bytes per line.
    const line = '한'.repeat(10);
    const text = `${line}\n${line}\n${line}`; // 3 lines
    // Cap that fits ~1 line (30 bytes) but not 2 (61 bytes with join).
    const r = truncateToByteTailByLine(text, 35);
    expect(r.truncated).toBe(true);
    expect(r.returnedBytes).toBeLessThanOrEqual(35);
    // Returned text must be valid UTF-8 (no replacement char from a split code point).
    expect(r.text).not.toContain('�');
    // Byte length is an exact multiple of 3 (whole '한' glyphs only).
    expect(Buffer.byteLength(r.text, 'utf8') % 3).toBe(0);
  });

  it('reports accurate originalBytes / returnedBytes for a multi-byte screen', () => {
    const line = '한'.repeat(10); // 30 bytes
    const text = Array.from({ length: 5 }, () => line).join('\n'); // 5*30 + 4 = 154 bytes
    expect(Buffer.byteLength(text, 'utf8')).toBe(154);
    const r = truncateToByteTailByLine(text, 65);
    expect(r.originalBytes).toBe(154);
    expect(r.returnedBytes).toBe(Buffer.byteLength(r.text, 'utf8'));
    expect(r.returnedBytes).toBeLessThanOrEqual(65);
  });

  it('hard-clips a single over-long line on a UTF-8 boundary from its END', () => {
    // One line, no newlines, that alone exceeds the cap. '한' = 3 bytes.
    const line = '한'.repeat(50); // 150 bytes
    const r = truncateToByteTailByLine(line, 20);
    expect(r.truncated).toBe(true);
    expect(r.returnedBytes).toBeLessThanOrEqual(20);
    // No split code point.
    expect(r.text).not.toContain('�');
    expect(Buffer.byteLength(r.text, 'utf8') % 3).toBe(0);
    // The TAIL of the line is what's kept (ends with the original's last glyph).
    expect(line.endsWith(r.text)).toBe(true);
  });
});
