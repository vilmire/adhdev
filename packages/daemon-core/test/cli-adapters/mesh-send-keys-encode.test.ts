import { describe, expect, it } from 'vitest';
import {
  encodeMeshSendKeys,
  MESH_SEND_KEY_ENCODING,
  MESH_DESTRUCTIVE_KEYS,
  MESH_SEND_KEYS_MAX_ITEMS,
  MESH_SEND_KEYS_MAX_TEXT_BYTES,
} from '../../src/cli-adapters/provider-cli-shared.js';

// MESH-SEND-KEYS (feature 3: key injection). The structured key sequence is
// validated + encoded into exact terminal bytes. text+ENTER is one contiguous
// string (atomic submit). Destructive keys (CTRL_C/ESC) are flagged. Raw byte
// input is impossible — only text or the closed key enum.

describe('encodeMeshSendKeys', () => {
  it('maps each named key to its exact terminal byte sequence', () => {
    expect(MESH_SEND_KEY_ENCODING.ENTER).toBe('\r');
    expect(MESH_SEND_KEY_ENCODING.ESC).toBe('\x1b');
    expect(MESH_SEND_KEY_ENCODING.CTRL_C).toBe('\x03');
    expect(MESH_SEND_KEY_ENCODING.UP).toBe('\x1b[A');
    expect(MESH_SEND_KEY_ENCODING.DOWN).toBe('\x1b[B');
    expect(MESH_SEND_KEY_ENCODING.RIGHT).toBe('\x1b[C');
    expect(MESH_SEND_KEY_ENCODING.LEFT).toBe('\x1b[D');
    expect(MESH_SEND_KEY_ENCODING.TAB).toBe('\t');
    expect(MESH_SEND_KEY_ENCODING.BACKSPACE).toBe('\x7f');
  });

  it('encodes text + ENTER as one atomic contiguous string', () => {
    const r = encodeMeshSendKeys([{ text: 'hello world' }, { key: 'ENTER' }]);
    expect(r.sequence).toBe('hello world\r');
    expect(r.keys).toEqual(['ENTER']);
    expect(r.submits).toBe(true);
    expect(r.hasDestructive).toBe(false);
  });

  it('flags destructive keys (CTRL_C / ESC)', () => {
    expect(encodeMeshSendKeys([{ key: 'CTRL_C' }]).hasDestructive).toBe(true);
    expect(encodeMeshSendKeys([{ key: 'ESC' }]).hasDestructive).toBe(true);
    expect(encodeMeshSendKeys([{ key: 'DOWN' }, { key: 'ENTER' }]).hasDestructive).toBe(false);
    // The destructive set is exactly CTRL_C + ESC.
    expect([...MESH_DESTRUCTIVE_KEYS].sort()).toEqual(['CTRL_C', 'ESC']);
  });

  it('concatenates a multi-key navigation sequence in order', () => {
    const r = encodeMeshSendKeys([{ key: 'DOWN' }, { key: 'DOWN' }, { key: 'ENTER' }]);
    expect(r.sequence).toBe('\x1b[B\x1b[B\r');
    expect(r.keys).toEqual(['DOWN', 'DOWN', 'ENTER']);
    expect(r.submits).toBe(true);
  });

  it('marks submits=false when literal text follows an ENTER', () => {
    const r = encodeMeshSendKeys([{ text: 'a' }, { key: 'ENTER' }, { text: 'b' }]);
    expect(r.sequence).toBe('a\rb');
    expect(r.submits).toBe(false);
  });

  it('rejects an unknown key name', () => {
    expect(() => encodeMeshSendKeys([{ key: 'F13' } as any])).toThrow(/unknown key/);
  });

  it('rejects an empty sequence', () => {
    expect(() => encodeMeshSendKeys([])).toThrow(/non-empty/);
  });

  it('rejects an over-limit item count', () => {
    const many = Array.from({ length: MESH_SEND_KEYS_MAX_ITEMS + 1 }, () => ({ key: 'DOWN' as const }));
    expect(() => encodeMeshSendKeys(many)).toThrow(/exceeds/);
  });

  it('rejects over-limit total literal text (bytes)', () => {
    const big = 'x'.repeat(MESH_SEND_KEYS_MAX_TEXT_BYTES + 1);
    expect(() => encodeMeshSendKeys([{ text: big }])).toThrow(/text exceeds/);
  });

  it('counts text in UTF-8 bytes for the limit', () => {
    // '한' = 3 bytes; MAX/3 + 1 glyphs exceeds the byte cap even though char count is lower.
    const glyphs = Math.floor(MESH_SEND_KEYS_MAX_TEXT_BYTES / 3) + 1;
    expect(() => encodeMeshSendKeys([{ text: '한'.repeat(glyphs) }])).toThrow(/text exceeds/);
  });
});
