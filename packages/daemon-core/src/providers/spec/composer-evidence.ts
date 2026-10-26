/**
 * composer-evidence — what the CLI's editable input row holds right now
 * (SUBMIT-UNCONFIRMED-RECLAIM).
 *
 * "The composer" is the cursor's row: spec CLIs (claude, agy, codex) keep the
 * cursor on their input line. It is read EXACTLY from the native viewport
 * (TerminalAdapter.getCursorRow → ghostty getViewport, cursor row with cells):
 * the row, the cursor column and the cells come from one snapshot, on either
 * screen. Nothing here guesses from formatter output, scrollback or rows near
 * the bottom, and nothing is normalised: content is compared cell for cell.
 *
 * Chrome vs content (review R6-2). The only cells treated as chrome are, left
 * of the cursor, leading blanks with at most one box-frame vertical (`│` `┃`)
 * before the prompt glyph, and right of the cursor, blanks with at most one
 * box-frame vertical. ASCII `|`, any other box character, and anything else
 * non-blank is CONTENT. Four answers, never a boolean read both ways:
 *  - `unknown` — no exact read; content right of the cursor; no prompt glyph;
 *  - `empty`   — prompt glyph followed by blanks only;
 *  - `chip`    — prompt glyph, then only paste chip(s);
 *  - `text`    — any other content left of the cursor, verbatim.
 * Pure functions: no timers, no writes, content never logged.
 */

/** A CLI's collapsed-paste chip (Claude Code / Codex / agy), or an image
 *  attachment chip (Claude Code's `[Image #N]`). */
const CHIP_SOURCE = String.raw`\[(?:Pasted\s*(?:text|Content)|Image\s*#\d+)[^\]\n]*\]`;
const ONE_CHIP_RE = new RegExp(`^${CHIP_SOURCE}$`, 'i');
const CHIPS_ONLY_RE = new RegExp(`^(?:${CHIP_SOURCE} *)+$`, 'i');
/** An unterminated chip: the CLI is mid-way through painting one. */
const PARTIAL_CHIP_RE = /^\[(?:P(?:a(?:s(?:t(?:e(?:d[^\]]*)?)?)?)?)?|I(?:m(?:a(?:g(?:e[^\]]*)?)?)?)?)?$/i;

const LEAD_RE = /^ *(?:[│┃] *)?[>❯›»] ?/;
const RIGHT_CHROME_RE = /^ *(?:[│┃] *)?$/;
const BLANK_RE = /^ *$/;

/** The adapter surface read here (TerminalAdapter satisfies it). */
export interface ComposerScreen {
    getCursorRow?(): { row: number; col: number; left: string; right: string } | null;
}

/** The exact row a read came from — what "back to how it was" is compared to. */
export interface RowCells { row: number; col: number; left: string; right: string }

export type ComposerRead =
    | { kind: 'unknown' }
    | { kind: 'empty'; row: number; cells: RowCells }
    | { kind: 'chip'; row: number; text: string; cells: RowCells }
    | { kind: 'text'; row: number; text: string; cells: RowCells };

/** Read the cursor row. Any failure or ambiguity is `unknown`. */
export function readComposer(screen: ComposerScreen): ComposerRead {
    try {
        if (typeof screen.getCursorRow !== 'function') return { kind: 'unknown' };
        const cur = screen.getCursorRow();
        if (!cur || !Number.isInteger(cur.row) || cur.row < 0 || !Number.isInteger(cur.col) || typeof cur.left !== 'string' || typeof cur.right !== 'string') return { kind: 'unknown' };
        if (!RIGHT_CHROME_RE.test(cur.right)) return { kind: 'unknown' };
        const lead = LEAD_RE.exec(cur.left);
        if (!lead) return { kind: 'unknown' };
        const cells: RowCells = { row: cur.row, col: cur.col, left: cur.left, right: cur.right };
        // Exact cells left of the cursor, trailing blanks included.
        const text = cur.left.slice(lead[0].length);
        if (BLANK_RE.test(text)) return { kind: 'empty', row: cur.row, cells };
        if (CHIPS_ONLY_RE.test(text)) return { kind: 'chip', row: cur.row, text, cells };
        return { kind: 'text', row: cur.row, text, cells };
    } catch {
        return { kind: 'unknown' };
    }
}

/** The same row showing exactly the same visible cells — blanks are blanks,
 *  wherever the cursor sits among them (an empty prompt's cursor may rest at
 *  any blank). Any residue, left or right of the cursor, makes it differ. */
export function sameVisibleRow(read: ComposerRead, cells: RowCells): boolean {
    return read.kind !== 'unknown' && read.cells.row === cells.row
        && (read.cells.left + read.cells.right).trimEnd() === (cells.left + cells.right).trimEnd();
}

/** The non-blank chrome right of the cursor, by ABSOLUTE column (a DEL moves
 *  the cursor left; a box frame stays where it is). */
export function rightChrome(cells: RowCells): string {
    return Array.from(cells.right).map((ch, i) => (ch === ' ' ? '' : `${cells.col + i}:${ch}`)).filter(Boolean).join(',');
}

/** A read of exactly the same row, cell for cell, with the cursor in the same place. */
export function sameRow(read: ComposerRead, cells: RowCells): boolean {
    return read.kind !== 'unknown' && read.cells.row === cells.row && read.cells.col === cells.col
        && read.cells.left === cells.left && read.cells.right === cells.right;
}

/**
 * What a read after a paste of `body` into an EMPTY row shows (reviews R6-1/3):
 *  - `own_chip`    — exactly ONE chip and nothing else;
 *  - `own_literal` — exactly the body, verbatim (a single-line body only);
 *  - `rendering`   — nothing yet, a strict prefix of the literal body, or a
 *                    chip still being painted;
 *  - `foreign`     — anything else: more than one chip, a different string
 *                    (even by one blank), extra text;
 *  - `unknown`     — no exact read.
 * A first sighting counts as ours only if every read before it was
 * `rendering` or `unknown`; the caller watches every frame (submit-verdict.ts).
 */
export type RenderClass = 'own_chip' | 'own_literal' | 'rendering' | 'foreign' | 'unknown';
export function classifyRender(read: ComposerRead, body: string): RenderClass {
    if (read.kind === 'unknown') return 'unknown';
    if (read.kind === 'empty') return 'rendering';
    if (read.kind === 'chip') return ONE_CHIP_RE.test(read.text) ? 'own_chip' : 'foreign';
    if (PARTIAL_CHIP_RE.test(read.text)) return 'rendering';
    const literal = !/[\r\n\t]/.test(body);
    if (literal && read.text === body) return 'own_literal';
    if (literal && body.startsWith(read.text)) return 'rendering';
    return 'foreign';
}

/** `next` is `prev` with characters removed from its end only — what a DEL
 *  press does to the content left of the cursor, and nothing else. */
export function isStrictPrefixOf(next: string, prev: string): boolean {
    const a = Array.from(next);
    const b = Array.from(prev);
    return a.length < b.length && a.every((ch, i) => ch === b[i]);
}
