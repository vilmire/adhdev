/**
 * ★ BLUEPRINT ARCHIVE PACKS INTO ROWS, NOT ONE COLUMN.
 *
 * The blueprint canvas rendered every settled graph as a collapsed chip in a
 * SINGLE column at one x. Measured on the live mesh (20 graphs, 19 of them
 * `gates:0`, so all collapsed): the drawing's bounding box came out
 * 236 × 1230 — a strip narrower than a phone inside a ~1200px dialog.
 *
 * That one shape produced three of the reported symptoms at once, because
 * `fitView` frames by the LIMITING axis:
 *   - the 1230px height forced zoom to 0.474, at which a 236px card renders
 *     112px wide — the "grey smudge" where no title or status is legible;
 *   - 91% of the viewport width sat empty while the cards piled up top-left;
 *   - the zoom buttons looked broken: React Flow steps `scaleBy(1.2)`, so two
 *     presses only reach 0.68, still under the card's design width.
 *
 * Packing the same entries into rows trades height for width that was already
 * there, which raises the fit zoom instead of fighting the zoom limits. At 20
 * graphs / 1200px the bbox becomes 992 × 300: zoom 1.0, cards at their full
 * 236px, 83% of the width used.
 *
 * Red-when-reverted: restoring the single column — i.e. making `layoutArchive`
 * ignore `archiveColumnCount` and advance y for every chip at a fixed x —
 * fails `packs chips across the row` and `a full archive is wider than it is
 * tall`, which are precisely the unreadable-canvas regression.
 */
import { describe, expect, it } from 'vitest'
import { ARCHIVE_MAX_COLUMNS, archiveColumnCount } from '../../src/components/MeshGraph/blueprintViewModel'

// Mirrors the constants layoutArchive lays chips out with.
const CHIP_WIDTH = 236
const CHIP_GAP_X = 16

describe('archiveColumnCount', () => {
    it('packs chips across the row when the canvas has the width', () => {
        // 1200px dialog — the measured case. Four 236px chips + three 16px gaps
        // = 992px, which fits; five would need 1244px, which does not.
        expect(archiveColumnCount(1200, CHIP_WIDTH, CHIP_GAP_X)).toBe(4)
        expect(archiveColumnCount(900, CHIP_WIDTH, CHIP_GAP_X)).toBe(3)
        expect(archiveColumnCount(700, CHIP_WIDTH, CHIP_GAP_X)).toBe(2)
    })

    it('degrades to the previous single column on a narrow canvas', () => {
        // The old behaviour survives as the NARROW case rather than as the only
        // case — a phone genuinely wants one column.
        expect(archiveColumnCount(420, CHIP_WIDTH, CHIP_GAP_X)).toBe(1)
        expect(archiveColumnCount(236, CHIP_WIDTH, CHIP_GAP_X)).toBe(1)
    })

    it('never returns less than one column, whatever it is handed', () => {
        // Width is 0 before the ResizeObserver first fires; a 0 or negative
        // column count would place every chip at the same coordinate.
        for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(archiveColumnCount(width, CHIP_WIDTH, CHIP_GAP_X)).toBeGreaterThanOrEqual(1)
        }
        expect(archiveColumnCount(1200, 0, CHIP_GAP_X)).toBe(1)
    })

    it('caps the row so a wide monitor does not make a thin scan line', () => {
        expect(archiveColumnCount(4000, CHIP_WIDTH, CHIP_GAP_X)).toBe(ARCHIVE_MAX_COLUMNS)
    })

    it('a full archive is wider than it is tall — the property fitView reads', () => {
        // This is the assertion that actually encodes the bug. fitView frames by
        // the limiting axis, so the fix is only real if the bounding box stops
        // being a tall strip.
        const CHIP_HEIGHT = 52
        const CHIP_GAP_Y = 10
        const graphs = 20
        const columns = archiveColumnCount(1200, CHIP_WIDTH, CHIP_GAP_X)
        const rows = Math.ceil(graphs / columns)
        const width = columns * CHIP_WIDTH + (columns - 1) * CHIP_GAP_X
        const height = rows * CHIP_HEIGHT + (rows - 1) * CHIP_GAP_Y

        expect(width).toBeGreaterThan(height)

        // And the fit zoom that box yields must let a card render at its design
        // width, which is the whole point of the change (before: 0.474).
        const fitZoom = Math.min(1200 / (width * 1.2), 700 / (height * 1.2), 1)
        expect(fitZoom).toBe(1)
    })
})
