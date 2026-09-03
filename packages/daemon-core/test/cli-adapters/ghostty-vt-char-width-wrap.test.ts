import { describe, it, expect } from 'vitest'
import { GhosttyVtTerminalBackend } from '../../src/cli-adapters/terminal-backends/ghostty-vt-backend.js'

/**
 * Character-width regression cases for the shared ghostty-vt backend.
 *
 * These pin the wrapping contract that EVERY spec CLI provider (claude, codex,
 * kimi, grok, cursor, opencode, antigravity) renders through. A width
 * disagreement between the VT and the child process is what fragments a
 * repainted line across the buffer, so the widths themselves are the invariant
 * worth freezing — a future VT bump that reclassified braille as double-width
 * would silently halve the usable columns for every spinner-drawing CLI.
 *
 * Written as "how many rows does N copies of this char occupy at cols=N" so a
 * failure names the actual consequence (wrap) rather than an internal width
 * number the backend never exposes.
 */
function rowsUsed(text: string, cols: number, rows = 8): number {
    const backend = new GhosttyVtTerminalBackend({ cols, rows, scrollback: 0 })
    try {
        backend.write(text)
        const out = backend.getText()
        if (!out) return 0
        return out.split('\n').filter((line) => line.length > 0).length
    } finally {
        backend.dispose()
    }
}

describe('ghostty-vt character widths', () => {
    // Narrow (width 1): exactly `cols` copies fill one row without wrapping.
    it.each([
        ['ASCII', 'A'],
        ['braille spinner frame (U+28FF block)', '⣿'],
        ['braille spinner frame (sparse)', '⠻'],
    ])('treats %s as single-width', (_label, ch) => {
        expect(rowsUsed(ch.repeat(10), 10)).toBe(1)
        // One more than `cols` must wrap — proves the row above was genuinely
        // full rather than the content having been silently dropped.
        expect(rowsUsed(ch.repeat(11), 10)).toBe(2)
    })

    // Wide (width 2): `cols` copies need two rows.
    it.each([
        ['CJK', '가'],
        ['emoji', '\u{1F600}'],
    ])('treats %s as double-width', (_label, ch) => {
        expect(rowsUsed(ch.repeat(10), 10)).toBe(2)
        // Half as many fit on a single row.
        expect(rowsUsed(ch.repeat(5), 10)).toBe(1)
    })

    // The concrete shape behind the antigravity-cli defect: an 18-column line
    // repainted in place with CR. At the real width it stays one row no matter
    // how many frames are drawn; one column narrower, every frame spills a
    // character onto a new row and the buffer fills with fragments.
    it('keeps an in-place CR repaint on one row when it fits the width', () => {
        const line = '⣻  Running command' // 18 single-width cells
        let text = ''
        for (let i = 0; i < 40; i++) text += `\r${line}`

        expect(rowsUsed(text, 18)).toBe(1)
    })

    it('fragments an in-place CR repaint when the line exceeds the width', () => {
        const line = '⣻  Running command'
        let text = ''
        for (let i = 0; i < 40; i++) text += `\r${line}`

        // cols=17 -> the trailing 'd' wraps every frame, one new row per repaint.
        // This is the failure the COLUMNS/LINES strip in sanitizeSpawnEnv
        // prevents: it only happens when the child lays out to a width the VT
        // does not share.
        expect(rowsUsed(text, 17, 60)).toBeGreaterThan(1)
    })
})
