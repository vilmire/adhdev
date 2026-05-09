import { describe, expect, it } from 'vitest';

import {
  sanitizeTerminalText,
  TerminalTranscriptAccumulator,
} from '../../src/cli-adapters/provider-cli-shared.js';

function feedInFragments(text: string, cuts: number[]): string {
  const accumulator = new TerminalTranscriptAccumulator();
  let cursor = 0;
  let snapshot = '';
  for (const cut of cuts) {
    snapshot = accumulator.append(text.slice(cursor, cut));
    cursor = cut;
  }
  snapshot = accumulator.append(text.slice(cursor));
  return snapshot;
}

describe('TerminalTranscriptAccumulator overwrite handling', () => {
  it('collapses carriage-return progress rewrites to the visible final line', () => {
    const output = sanitizeTerminalText('progress 1%\rprogress 20%\rprogress 100%\n');

    expect(output).toBe('progress 100%\n');
  });

  it('applies cursor-left, backspace, and clear-line rewrites before transcript parsing', () => {
    const output = sanitizeTerminalText([
      'abcdef\x1b[3DXYZ\n',
      'cmd abc\b\b\bXYZ\n',
      'stale text\r\x1b[2Kfresh text\n',
    ].join(''));

    expect(output).toBe([
      'abcXYZ\n',
      'cmd XYZ\n',
      'fresh text\n',
    ].join(''));
  });

  it('preserves parser state for fragmented CSI escape sequences', () => {
    const sequence = 'stale command fragment\r\x1b[2Kfinal summary\n';

    expect(feedInFragments(sequence, [7, 23, 25, 27])).toBe('final summary\n');
    expect(feedInFragments(sequence, [])).toBe('final summary\n');
  });

  it('moves into blank regions without collapsing intentional whitespace', () => {
    const output = sanitizeTerminalText('a\x1b[5Cb\n  indented code\n');

    expect(output).toBe('a     b\n  indented code\n');
  });

  it('supports cursor save and restore rewrites', () => {
    const output = sanitizeTerminalText('prefix \x1b[sold suffix\x1b[ufinal\n');

    expect(output).toBe('prefix finaluffix\n');
  });

  it('supports CSI K variants', () => {
    expect(sanitizeTerminalText('abcde\x1b[3D\x1b[KXY\n')).toBe('abXY\n');
    expect(sanitizeTerminalText('abcde\r\x1b[2KXY\n')).toBe('XY\n');
    // EL 2 does not move the cursor by itself; preserve the terminal cell state.
    expect(sanitizeTerminalText('abcde\x1b[2KXY\n')).toBe('     XY\n');
  });

  it('supports CSI 1J without shifting cells after the cursor', () => {
    expect(sanitizeTerminalText('alpha\nbeta gamma\x1b[5D\x1b[1JXY\n')).toBe('\n     XYmma\n');
  });

  it('does not leak repeated rewritten command fragments like mesh_read_chat readback noise', () => {
    const command = "mon-core/src/config/mesh-config.ts packages/mcp-server/src/server.ts packages/mcp-server/src/tools/mesh-tools.ts | sed -n '1,260p'";
    const sequence = [
      command,
      '\r\x1b[2K',
      command.slice(0, 48),
      '\r\x1b[2K',
      command.slice(0, 90),
      '\r\x1b[2K',
      'Final summary: root cause found in raw PTY transcript append path.\n',
    ].join('');
    const output = sanitizeTerminalText(sequence);

    expect(output).toBe('Final summary: root cause found in raw PTY transcript append path.\n');
    expect(output).not.toContain('mesh-config.ts');
  });

  it('keeps combining marks attached while processing overwrites', () => {
    expect(sanitizeTerminalText('cafe\u0301\rCAFÉ\n')).toBe('CAFÉ\n');
  });
});
