/**
 * ExtractButtons ordinal mode (label_group / key_group) — unnumbered modal
 * rows with per-button key tokens.
 *
 * The default extraction requires capture group 1 to be a NUMERIC display
 * index. cursor-agent's approval modal (live capture, v2026.08.11) renders
 * NO numbering — each row carries its own key hint in a parenthetical:
 *
 *    Run this command?
 *    Not in allowlist: python3
 *     → Run (once) (y)
 *       Add Shell(python3) to allowlist? (tab)
 *       Run Everything (shift+tab)
 *       Skip & tell the agent what to do instead (esc or n)
 *
 * Ordinal mode indexes buttons by match order and maps each captured key
 * token to the byte sequence to type; an unmappable token drops its row
 * (fail closed — never type an unknown key).
 */
import { describe, expect, it } from 'vitest';
import { extractButtonsFromRule, mapButtonKeyToken } from '../../../src/providers/spec/evaluator.js';

const ESC = '\u001b';

// Verbatim from the live PTY capture (daemon FSM debug endpoint, 2026-08-17).
const CURSOR_MODAL = [
    ' Run this command?',
    ' Not in allowlist: python3',
    '  → Run (once) (y)',
    '    Add Shell(python3) to allowlist? (tab)',
    '    Run Everything (shift+tab)',
    '    Skip & tell the agent what to do instead (esc or n)',
].join('\n');

const CURSOR_RULE = {
    pattern: '^\\s*(?:→\\s*)?(\\S[^\\n]*?)\\s*\\((y|n|tab|shift\\+tab|esc(?:\\s+or\\s+n)?)\\)\\s*$',
    flags: 'gm',
    label_group: 1,
    key_group: 2,
    min_count: 2,
};

describe('mapButtonKeyToken', () => {
    it('maps letters, named keys, and alternative tokens', () => {
        expect(mapButtonKeyToken('y')).toBe('y');
        expect(mapButtonKeyToken('n')).toBe('n');
        expect(mapButtonKeyToken('tab')).toBe('\t');
        expect(mapButtonKeyToken('shift+tab')).toBe(`${ESC}[Z`);
        expect(mapButtonKeyToken('esc')).toBe(ESC);
        // "esc or n" prefers the plain letter — a bare letter cannot double
        // as a global cancel the way ESC can.
        expect(mapButtonKeyToken('esc or n')).toBe('n');
        expect(mapButtonKeyToken('enter')).toBe('\r');
    });
    it('fails closed on unknown tokens', () => {
        expect(mapButtonKeyToken('f13')).toBe(null);
        expect(mapButtonKeyToken('')).toBe(null);
    });
});

describe('extractButtonsFromRule — ordinal mode', () => {
    it('extracts the live cursor approval modal: 4 ordinal buttons with their own keys', () => {
        const buttons = extractButtonsFromRule(CURSOR_RULE as any, CURSOR_MODAL);
        expect(buttons.map(b => ({ index: b.index, label: b.label, key: b.key }))).toEqual([
            { index: 1, label: 'Run (once)', key: 'y' },
            { index: 2, label: 'Add Shell(python3) to allowlist?', key: '\t' },
            { index: 3, label: 'Run Everything', key: `${ESC}[Z` },
            { index: 4, label: 'Skip & tell the agent what to do instead', key: 'n' },
        ]);
        // The cursor marker row ("→ Run (once)") is flagged current.
        expect(buttons[0].current).toBe(true);
        expect(buttons[1].current).toBe(false);
    });

    it('drops a row whose key token cannot be mapped (fail closed)', () => {
        const hay = '  → Do it (f13)\n    Skip (n)';
        const buttons = extractButtonsFromRule(CURSOR_RULE as any, hay);
        expect(buttons.map(b => b.label)).toEqual(['Skip']);
        expect(buttons[0].index).toBe(1);
    });

    it('numbered-mode extraction is untouched (group1 index, key_for_index template)', () => {
        const rule = {
            pattern: '^\\s*(\\d+)\\s*\\([●○]\\)\\s*(.+?)\\s*$',
            flags: 'gm',
            key_for_index: '{index}',
        };
        const hay = ' 1 (●) Yes, proceed\n 2 (○) No, cancel';
        const buttons = extractButtonsFromRule(rule as any, hay);
        expect(buttons.map(b => ({ index: b.index, label: b.label, key: b.key }))).toEqual([
            { index: 1, label: 'Yes, proceed', key: '1' },
            { index: 2, label: 'No, cancel', key: '2' },
        ]);
    });
});
