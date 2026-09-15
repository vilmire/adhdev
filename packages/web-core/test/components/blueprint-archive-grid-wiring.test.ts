/**
 * ★ THE ROW-PACKING HELPER IS ACTUALLY WIRED INTO THE LAYOUT.
 *
 * Companion to blueprint-archive-grid-layout.test.ts, which pins the maths of
 * `archiveColumnCount` in isolation. That test passes just as happily when the
 * helper is dead code — and an earlier pass of this very fix left exactly that
 * state: the helper existed, every unit assertion was green, and the canvas on
 * screen had not changed at all because `layoutArchive` still advanced y for
 * every chip at one fixed x.
 *
 * So this file pins the CONSUMPTION. It is source-text rather than behavioural
 * because the layout runs inside an async ELK pass behind @xyflow/react, which
 * measures nothing under jsdom (nodes get no geometry, edges come out empty) —
 * a rendered assertion on chip coordinates passes vacuously whatever the
 * layout did.
 *
 * Red-when-reverted: deleting the `archiveColumnCount` call from
 * `layoutArchive`, or dropping the measured width that feeds it, fails here
 * even though the pure-maths test above stays green.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const VIEW = path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshTaskDagView.tsx')
const source = fs.readFileSync(VIEW, 'utf8')

describe('layoutArchive consumes the column count', () => {
    it('imports and calls archiveColumnCount', () => {
        expect(source).toContain('archiveColumnCount')
        // The call, not merely the import.
        expect(source).toMatch(/const chipColumns = archiveColumnCount\(/)
    })

    it('advances a column cursor and wraps at the row width', () => {
        // The chip branch must step x by chip width + gap, and only advance y
        // once the row is full. A reverted single column has neither.
        expect(source).toMatch(/chipColumn \* \(COLLAPSED_GRAPH_WIDTH \+ COLLAPSED_STACK_GAP_X\)/)
        expect(source).toMatch(/if \(chipColumn >= chipColumns\)/)
    })

    it('threads a measured canvas width into the layout', () => {
        // archiveColumnCount is only meaningful if something measures the
        // canvas; a hardcoded constant would silently pin one column count.
        expect(source).toContain('canvasWidth')
        expect(source).toContain('ResizeObserver')
        // The layout re-runs when the measured width changes, otherwise a
        // resize leaves the old column count on screen.
        expect(source).toMatch(/\}, \[dagFingerprint, canvasWidth\]\)/)
    })

    it('starts an expanded graph on a fresh row', () => {
        // Expanded graphs keep their own ELK width, so they are not packed;
        // a partial chip row must be flushed first or the two overlap.
        expect(source).toMatch(/if \(chipColumn > 0\) \{/)
    })
})
