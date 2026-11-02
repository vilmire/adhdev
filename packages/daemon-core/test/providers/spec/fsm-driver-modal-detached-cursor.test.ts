/**
 * grok 1.0.70 parks its cursor on the repainted `◆ Running … [stop]` spinner row above the
 * permission block. The live modal must still resolve when the block ends the screen on its
 * `N/M:select` footer, and a quoted prompt must still yield no modal.
 */
import { describe, expect, it } from 'vitest';
import { resolveLiveModalSlice } from '../../../src/providers/spec/fsm-driver-modal.js';

const BLOCK = [
  '  ┃',
  '  ┃  ›  Allow (Mesh) Git Status?',
  '  ┃  │ (Mesh) Git Status',
  '  ┃',
  '  ┃  1 (○) Yes, and don\'t ask again for anything (always-approve mode)',
  '  ┃  2 (○) Always allow: (Mesh) Git Status',
  '  ┃  3 (●) Yes',
  '  ┃  4 (○) No, reject (type to add feedback)',
  '  ┃  5 (○) Never allow: (Mesh) Git Status',
  '  ┃',
  '',
  '  1/5:select  │  Tab:next option  │  ←/→:scope  │  Ctrl+f:expand',
];
const HEAD = ['', '  main /w/repo', '', '   ◆ Running (Mesh) Git Status 2m53s    3m2s ⇣23.6k [stop]', ''];
const READY = ['', '  │ ❯', '  Shift+Tab:mode │ Ctrl+x:shortcuts'];

describe('resolveLiveModalSlice with the cursor parked on the spinner row', () => {
  const spinnerRow = 3;

  it('keeps a bottom-most block that ends on the select footer live', () => {
    const lines = [...HEAD, ...BLOCK];
    const slice = resolveLiveModalSlice(lines, { row: spinnerRow, col: 42 }, 0);
    expect(slice.hasLiveModal).toBe(true);
    expect(slice.lines.join('\n')).toContain('3 (●) Yes');
  });

  it('rejects a quoted prompt followed by a live composer', () => {
    const lines = [...HEAD, ...BLOCK, ...READY];
    expect(resolveLiveModalSlice(lines, { row: spinnerRow, col: 42 }, 0).hasLiveModal).toBe(false);
  });

  it('rejects a quoted prompt followed by assistant prose or a spinner', () => {
    const prose = [...HEAD, ...BLOCK, '', '  ◆ I approved that prompt.'];
    expect(resolveLiveModalSlice(prose, { row: spinnerRow, col: 42 }, 0).hasLiveModal).toBe(false);
  });

  it('rejects a block with no select footer (cursor binding still applies)', () => {
    const noFooter = [...HEAD, ...BLOCK.slice(0, 10)];
    expect(resolveLiveModalSlice(noFooter, { row: spinnerRow, col: 42 }, 0).hasLiveModal).toBe(false);
  });

  it('does not extend to other footers (only the N/M:select chrome)', () => {
    const other = [...HEAD, ...BLOCK.slice(0, 10), '', '  Esc to cancel'];
    expect(resolveLiveModalSlice(other, { row: spinnerRow, col: 42 }, 0).hasLiveModal).toBe(false);
  });

  it('rejects a homed or transcript cursor even when the screen ends on the footer', () => {
    const lines = [...HEAD, ...BLOCK];
    expect(resolveLiveModalSlice(lines, { row: 0, col: 0 }, 0).hasLiveModal).toBe(false);
    expect(resolveLiveModalSlice(lines, { row: 1, col: 3 }, 0).hasLiveModal).toBe(false);
  });

  it('rejects anything outside the gutter between the activity row and the footer', () => {
    const painted = [...HEAD, '  some transcript line', ...BLOCK];
    expect(resolveLiveModalSlice(painted, { row: spinnerRow, col: 42 }, 0).hasLiveModal).toBe(false);
    const unguttered = [...HEAD, ...BLOCK.map(l => l.replace('┃', ' '))];
    expect(resolveLiveModalSlice(unguttered, { row: spinnerRow, col: 42 }, 0).hasLiveModal).toBe(false);
  });

  it('rejects a cursor below the block', () => {
    const lines = [...HEAD, ...BLOCK, ''];
    expect(resolveLiveModalSlice(lines, { row: lines.length + 3, col: 0 }, 0).hasLiveModal).toBe(false);
  });

  it('still accepts a cursor inside the block', () => {
    const lines = [...HEAD, ...BLOCK];
    expect(resolveLiveModalSlice(lines, { row: 5 + 6, col: 5 }, 0).hasLiveModal).toBe(true);
  });
});
