/**
 * ★ THE ROUTING HELPER IS WIRED IN, THE THREAD IS LEGIBLE, AND IT STAYS STILL.
 *
 * Companion to blueprint-mission-thread-routing.test.ts, which pins the hop
 * geometry in isolation. That test passes just as happily when the helper is
 * dead code — the same trap `blueprint-archive-grid-wiring.test.ts` was written
 * for, where an earlier pass left a green helper that the canvas never called.
 *
 * Source-text rather than behavioural for the same reason as that file: the
 * thread is built inside a `useMemo` over an async ELK pass behind
 * @xyflow/react, which measures nothing under jsdom (nodes get no geometry,
 * edges come out empty), so a rendered assertion on edge routing passes
 * vacuously whatever the component did.
 *
 * Three properties, all owner-visible:
 *
 *  1. **Routing is consumed.** The hops must reach the edge as
 *     `sourceHandle`/`targetHandle`, and the handles they name must exist on
 *     the card — React Flow silently falls back to the default handle for an
 *     unknown id, which restores the right→left-only routing that drew the line
 *     through the card.
 *  2. **Contrast comes from the theme.** The owner's second complaint was that
 *     the thread was too faint to identify ("티가 너무 안남"). The stroke is a
 *     theme token so both grounds are tuned deliberately, not an rgba literal
 *     at the call site.
 *  3. **It does not animate.** `babbc4ad` put the canvas's perpetual animations
 *     behind `prefers-reduced-motion` after they timed out three screenshot
 *     captures. Making a line MORE prominent is exactly the change that invites
 *     an animated dash, so the absence is pinned here rather than left to
 *     reviewer memory.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const VIEW = path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshTaskDagView.tsx')
const THEME = path.join(import.meta.dirname, '../../src/components/MeshGraph/meshGraphTheme.ts')
const CSS = path.join(import.meta.dirname, '../../src/index.css')
const source = fs.readFileSync(VIEW, 'utf8')
const theme = fs.readFileSync(THEME, 'utf8')
const css = fs.readFileSync(CSS, 'utf8')

/** The mission-thread edge literal, which every assertion below reads. */
const threadBlock = source.slice(source.indexOf('const missionThreads'), source.indexOf('return [...missionThreads'))

describe('the mission thread consumes the routed hops', () => {
    it('calls buildMissionThreadHops with real card geometry', () => {
        expect(source).toContain('buildMissionThreadHops')
        expect(threadBlock).toMatch(/const hops = buildMissionThreadHops\(/)
        // Geometry, not just ids: the hop sides are meaningless without boxes,
        // and a `() => undefined` box lookup silently degrades every hop to the
        // right→left fallback.
        expect(threadBlock).toContain('estimateTaskCardHeight')
        expect(threadBlock).toContain('TASK_CARD_WIDTH')
    })

    it('passes each hop through to the edge as a named handle', () => {
        expect(threadBlock).toMatch(/sourceHandle: missionThreadHandleId\(hop\.sourceSide, 'source'\)/)
        expect(threadBlock).toMatch(/targetHandle: missionThreadHandleId\(hop\.targetSide, 'target'\)/)
    })

    it('renders a card handle for every side a hop can name', () => {
        // A handle id an edge names but the card does not render is not an
        // error in React Flow — the edge quietly re-anchors to the default
        // handle, i.e. right→left, i.e. the bug.
        expect(source).toMatch(/MISSION_THREAD_SIDES[^=]*=\s*\[['"]left['"], ['"]right['"], ['"]top['"], ['"]bottom['"]\]/)
        expect(source).toContain('MISSION_THREAD_HANDLES.map')
        // Both roles per side: a source-type handle cannot receive an edge.
        expect(source).toMatch(/missionThreadHandleId\(side, 'source'\)/)
        expect(source).toMatch(/missionThreadHandleId\(side, 'target'\)/)
    })

    it('builds the handle id in exactly one place', () => {
        // The card's handles and the edge's handle refs must never drift into
        // two spellings; a mismatch degrades silently, as above.
        const definitions = source.match(/function missionThreadHandleId\(/g) ?? []
        expect(definitions).toHaveLength(1)
        expect(source).toMatch(/return `mt-\$\{role\}-\$\{side\}`/)
    })
})

describe('the mission thread is legible', () => {
    it('takes its stroke from the theme, not an rgba literal at the call site', () => {
        expect(threadBlock).toContain('meshTheme.missionThreadColor')
        // The literals the owner reported as too faint must be gone.
        expect(source).not.toContain('rgba(139, 148, 255, 0.85)')
        expect(source).not.toContain('rgba(88, 92, 235, 0.8)')
    })

    it('defines the token for both grounds, opaque so neither bleeds through', () => {
        const values = theme.match(/missionThreadColor: '([^']+)'/g) ?? []
        expect(values).toHaveLength(2)
        // Solid hex, not a translucent rgba: the old alpha let the ground show
        // through and flattened the line into the blueprint grid.
        for (const value of values) expect(value).toMatch(/missionThreadColor: '#[0-9a-f]{6}'/)
    })

    it('draws thicker than a dependency edge and above the cards', () => {
        // Dependency edges are 1.6px. The thread has to out-weigh them to read
        // as deliberate rather than as a stray artefact.
        expect(threadBlock).toMatch(/strokeWidth: 2\.5/)
        // zIndex 0 let card bodies paint over the line wherever they met.
        expect(threadBlock).toMatch(/zIndex: 5/)
    })
})

describe('the mission thread stays still', () => {
    it('is never marked animated', () => {
        // @xyflow/react adds `.animated` on this flag, and that class carries
        // `dashdraw ... infinite` — a canvas that never presents a stable frame,
        // which is what timed out Page.captureScreenshot on this view.
        expect(threadBlock).toMatch(/animated: false/)
        expect(threadBlock).not.toMatch(/animated: true/)
    })

    it('leaves the reduced-motion gate that holds the canvas still intact', () => {
        // Guards the gate `babbc4ad` added, since making the thread more
        // prominent is exactly the change that would tempt an animated dash.
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
        expect(css).toMatch(/\.react-flow__edge\.animated path\s*\{\s*animation: none/)
    })
})
