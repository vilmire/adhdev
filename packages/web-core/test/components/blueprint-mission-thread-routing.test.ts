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
 *
 * ## Third pass (2026-09-15, live on rc.30)
 *
 * The fix above was half-right and shipped anyway, because every test in this
 * file asserted which SIDE a hop uses — a proxy for the thing that matters.
 * The proxy held and the thing failed: a same-column hop got the blessed
 * `bottom → top` route and drew straight down the column, through a card of
 * another mission stacked in the gap (`M-GRAPH-FEATURE-UNRELIAB…`). The
 * function could not have done otherwise — it was handed the two endpoint boxes
 * and nothing else, so no card between them existed as far as it was concerned.
 * The horizontal hop lower in the same thread exited sideways and looked fine,
 * which is why the defect read as "the fix works on some hops but not others".
 *
 * Two changes: `buildMissionThreadHops` now takes the obstacle set and only
 * takes the vertical route when the corridor is clear, detouring sideways when
 * it is not; and the `no hop corridor contains a card body` block below asserts
 * the GEOMETRY — no card's box inside the region the line is confined to —
 * instead of asserting a side name. Red-when-reverted for that block: drop the
 * `obstacles` argument at the call site (or the `blocked` check in the
 * function) and `does not run a vertical hop through a card stacked between the
 * endpoints`, `detours toward the side with room…` and the full-layout case
 * all fail with the "passes through" message, while the side-level tests above
 * keep passing — which is precisely the gap that let this reach live.
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

    /* ★ THE GEOMETRIC LEVEL.
     *
     * Everything above asserts which SIDE a hop uses. That is not the property
     * anyone cares about — it is a proxy for it, and on 2026-09-15 the proxy
     * held while the property failed: `routes vertically between two cards in
     * the same column` passed, and the vertical route it blessed ran straight
     * through a third card stacked in that column, because nothing in the
     * function or the test could see that card.
     *
     * So assert the property directly. `hopCorridor` turns a hop into the
     * region the line is constrained to — the vertical span for a vertical hop,
     * the horizontal one for a sideways hop — and the test states that no
     * card's body lies in it. That is a geometry calculation, and geometry
     * calculations are unit-testable even though the smoothstep curve drawn
     * inside the corridor is not.
     */
    describe('no hop corridor contains a card body', () => {
        /* The region a hop's line is confined to, given the sides it uses.
         * Vertical hops run down the x-span the two cards share; sideways hops
         * (both ends on one side) bracket around the cards on that flank. */
        function hopCorridor(
            source: MissionThreadBox,
            target: MissionThreadBox,
            sourceSide: string,
            targetSide: string,
        ): MissionThreadBox | null {
            if ((sourceSide === 'bottom' && targetSide === 'top') || (sourceSide === 'top' && targetSide === 'bottom')) {
                const upper = source.y <= target.y ? source : target
                const lower = source.y <= target.y ? target : source
                const x = Math.max(upper.x, lower.x)
                const right = Math.min(upper.x + upper.width, lower.x + lower.width)
                const y = upper.y + upper.height
                return { x, y, width: right - x, height: lower.y - y }
            }
            return null // sideways hops leave the column; nothing to assert here
        }

        function assertNoCardInAnyCorridor(
            chain: ReadonlyArray<{ id: string }>,
            boxes: Record<string, MissionThreadBox>,
        ) {
            const obstacles = Object.entries(boxes).map(([id, box]) => ({ id, box }))
            const hops = buildMissionThreadHops(chain, boxesOf(boxes), undefined, obstacles)
            expect(hops.length).toBeGreaterThan(0)
            for (const hop of hops) {
                const corridor = hopCorridor(
                    boxes[hop.sourceId], boxes[hop.targetId], hop.sourceSide, hop.targetSide,
                )
                if (!corridor || corridor.width <= 0 || corridor.height <= 0) continue
                for (const { id, box } of obstacles) {
                    if (id === hop.sourceId || id === hop.targetId) continue
                    const overlapsX = box.x < corridor.x + corridor.width && box.x + box.width > corridor.x
                    const overlapsY = box.y < corridor.y + corridor.height && box.y + box.height > corridor.y
                    expect(
                        overlapsX && overlapsY,
                        `hop ${hop.sourceId}→${hop.targetId} (${hop.sourceSide}→${hop.targetSide}) passes through ${id}`,
                    ).toBe(false)
                }
            }
            return hops
        }

        it('does not run a vertical hop through a card stacked between the endpoints', () => {
            /* ★ THE rc.30 SCREENSHOT, as geometry. Three cards in one ELK
             * column; the mission owns the outer two, and some other mission's
             * card sits in the gap. Straight down is through it. */
            const boxes = {
                top: box(0, 0),
                blocker: box(0, 160),
                bottom: box(0, 320),
            }
            const hops = assertNoCardInAnyCorridor([{ id: 'top' }, { id: 'bottom' }], boxes)
            // Concretely: it must NOT have taken the vertical route.
            expect(hops[0].sourceSide).not.toBe('bottom')
            expect(hops[0].sourceSide).toBe(hops[0].targetSide)
        })

        it('still takes the clean vertical route when the column between them is empty', () => {
            // The detour is a fallback, not the new default — a blocker OFF to
            // the side must not push this hop sideways.
            const boxes = {
                top: box(0, 0),
                bottom: box(0, 320),
                elsewhere: box(600, 160),
            }
            const hops = assertNoCardInAnyCorridor([{ id: 'top' }, { id: 'bottom' }], boxes)
            expect(hops[0]).toEqual({
                sourceId: 'top', targetId: 'bottom', sourceSide: 'bottom', targetSide: 'top',
            })
        })

        it('detours toward the side with room rather than back across the canvas', () => {
            // Column pinned against a neighbour on the left: going left would
            // put the line through that neighbour's flank. Right has open canvas.
            const boxes = {
                top: box(400, 0),
                blocker: box(400, 160),
                bottom: box(400, 320),
                leftNeighbour: box(400 - CARD_W - 8, 100),
            }
            const hops = assertNoCardInAnyCorridor([{ id: 'top' }, { id: 'bottom' }], boxes)
            expect(hops[0].sourceSide).toBe('right')
        })

        it('holds over the full reported layout — a mission threaded across a populated canvas', () => {
            /* Several columns, several missions interleaved, chained
             * newest-first the way the view model orders them. The property is
             * asserted over every hop at once. */
            const boxes: Record<string, MissionThreadBox> = {
                m1: box(0, 0),
                other1: box(0, 150),
                m2: box(0, 300),
                other2: box(300, 0),
                m3: box(300, 300),
                other3: box(300, 150),
                m4: box(600, 150),
            }
            assertNoCardInAnyCorridor([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }], boxes)
        })
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
