/**
 * ★ THE MISSION THREAD ROUTES AROUND CARDS, NOT THROUGH THEM.
 *
 * The purple dotted mission thread was observed on the rc.30 preview running
 * straight through the left edge of the `M-BLUEPRINT-CANVAS-UX` card instead of
 * routing around it.
 *
 * This is the SECOND time the thread's route has had to be fixed (`3e4a4631`,
 * "stop the blueprint mission thread from crossing the canvas"), and the first
 * fix is not what regressed — it is still in force and still tested in
 * blueprint-view-model.test.ts. What that fix did was align the chain's SORT
 * DIRECTION with `orderTasksForElk`, on the reasoning that a hop running
 * backwards along the placement axis forces smoothstep into a detour.
 *
 * That reasoning had an unstated premise: that time order implies x order. It
 * does not. ELK lays the canvas out with `elk.direction: RIGHT`, which advances
 * x by dependency LAYER. Two tasks of one mission with no dependency between
 * them share a layer and therefore an x, whatever their timestamps say. Since
 * a card exposes only `target=Left` / `source=Right`, a hop between two such
 * cards must leave the right edge and re-enter a left edge at the SAME x — and
 * smoothstep closes that loop by running back across the column, through
 * whatever card sits between them.
 *
 * Today's archive row-packing (`651ce625`, `archiveColumnCount`) is what made
 * it visible rather than what caused it: entries that used to sit in a single
 * column at one x now spread across up to four columns, so same-row hops became
 * common, and in a row of newest-first cards the hop to the next card is a
 * leftward one. The defect predates that commit; the layout change exposed it.
 *
 * The fix gives each hop the SIDES it should use, derived from the two cards'
 * real boxes. Red-when-reverted: make `buildMissionThreadHops` always return
 * `right → left` (its pre-fix behaviour) and `routes vertically between two
 * cards in the same column`, `leaves by the left edge when the target is to the
 * left`, and `never routes a hop through a card that sits between the two
 * endpoints` all fail.
 */
import { describe, expect, it } from 'vitest'
import { buildMissionThreadHops, type MissionThreadBox } from '../../src/components/MeshGraph/blueprintViewModel'

// The real card geometry these hops are drawn against.
const CARD_W = 236
const CARD_H = 96

const box = (x: number, y: number, width = CARD_W, height = CARD_H): MissionThreadBox => ({ x, y, width, height })

/** A hop drawn right→left between these boxes would cross `between`. */
function boxesOf(map: Record<string, MissionThreadBox>) {
    return (id: string) => map[id]
}

describe('buildMissionThreadHops', () => {
    it('keeps the natural right → left reading when the target is genuinely to the right', () => {
        // The case that always worked, and must keep working: consecutive ELK
        // layers. Nothing sits between them, so the plain reading is correct.
        const boxes = { a: box(0, 0), b: box(400, 0) }
        const hops = buildMissionThreadHops([{ id: 'a' }, { id: 'b' }], boxesOf(boxes))
        expect(hops).toEqual([
            { sourceId: 'a', targetId: 'b', sourceSide: 'right', targetSide: 'left' },
        ])
    })

    it('leaves by the left edge when the target is to the left', () => {
        // Forced right→left here, the line leaves the right edge of `b`, has to
        // reach the left edge of `a` far to its left, and smoothstep brings it
        // back across everything in between. Leaving by the LEFT edge keeps it
        // outside the column.
        const boxes = { a: box(0, 0), b: box(400, 0) }
        const hops = buildMissionThreadHops([{ id: 'b' }, { id: 'a' }], boxesOf(boxes))
        expect(hops[0].sourceSide).toBe('left')
        expect(hops[0].targetSide).toBe('right')
    })

    it('routes vertically between two cards in the same column', () => {
        // THE REPORTED CASE. Same x — one ELK layer, or one archive column.
        // There is no horizontal route between these that does not double back
        // across the column; the only clean one is straight down.
        const boxes = { top: box(0, 0), bottom: box(0, 300) }
        const hops = buildMissionThreadHops([{ id: 'top' }, { id: 'bottom' }], boxesOf(boxes))
        expect(hops[0]).toEqual({
            sourceId: 'top', targetId: 'bottom', sourceSide: 'bottom', targetSide: 'top',
        })
        // And upward, the mirror image.
        const up = buildMissionThreadHops([{ id: 'bottom' }, { id: 'top' }], boxesOf(boxes))
        expect(up[0]).toEqual({
            sourceId: 'bottom', targetId: 'top', sourceSide: 'top', targetSide: 'bottom',
        })
    })

    it('treats a few pixels of x drift as the same column, not a horizontal hop', () => {
        // Two cards 8px apart are one column to the eye. Calling that a
        // horizontal hop reintroduces a near-zero-width detour — a hairpin
        // right at the card edge, which is the crossing in miniature.
        const boxes = { a: box(0, 0), b: box(8, 300) }
        const hops = buildMissionThreadHops([{ id: 'a' }, { id: 'b' }], boxesOf(boxes))
        expect(hops[0].sourceSide).toBe('bottom')
        expect(hops[0].targetSide).toBe('top')
    })

    it('never routes a hop through a card that sits between the two endpoints', () => {
        /* The property, stated over the actual reported layout: one archive row
         * of three cards, chained newest-first so the thread runs leftwards
         * along it. `mid` sits between the two endpoints of the long hop.
         *
         * A hop is "through" a card when it leaves by a side that points INTO
         * the span containing that card: leaving `right` when the target is to
         * the left means crossing everything in between. */
        const boxes = {
            left: box(0, 0),
            mid: box(CARD_W + 16, 0),
            right: box((CARD_W + 16) * 2, 0),
        }
        const chain = [{ id: 'right' }, { id: 'mid' }, { id: 'left' }]
        const hops = buildMissionThreadHops(chain, boxesOf(boxes))

        for (const hop of hops) {
            const source = boxes[hop.sourceId as keyof typeof boxes]
            const target = boxes[hop.targetId as keyof typeof boxes]
            const targetIsLeft = target.x + target.width <= source.x
            if (targetIsLeft) {
                // Must exit left; exiting right would sweep back over `mid`.
                expect(hop.sourceSide).toBe('left')
                expect(hop.targetSide).toBe('right')
            }
        }
        // Concretely: both hops in this row go leftwards, so neither may exit right.
        expect(hops.map(h => h.sourceSide)).toEqual(['left', 'left'])
    })

    it('falls back to the plain reading when a box has not been measured yet', () => {
        // Geometry arrives a frame after the nodes do. A hop with no box must
        // still draw — dropping it would make the thread flicker on every
        // layout pass — it just cannot be routed intelligently yet.
        const hops = buildMissionThreadHops([{ id: 'a' }, { id: 'b' }], () => undefined)
        expect(hops).toEqual([
            { sourceId: 'a', targetId: 'b', sourceSide: 'right', targetSide: 'left' },
        ])
    })

    it('produces one hop per adjacent pair, and none for a chain that cannot form one', () => {
        const boxes = { a: box(0, 0), b: box(400, 0), c: box(800, 0) }
        expect(buildMissionThreadHops([{ id: 'a' }, { id: 'b' }, { id: 'c' }], boxesOf(boxes))).toHaveLength(2)
        expect(buildMissionThreadHops([{ id: 'a' }], boxesOf(boxes))).toEqual([])
        expect(buildMissionThreadHops([], boxesOf(boxes))).toEqual([])
    })
})
