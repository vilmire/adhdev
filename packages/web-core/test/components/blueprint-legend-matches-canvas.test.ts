/**
 * ★ THE LEGEND DESCRIBES WHAT IS DRAWN, NOT A FIXED VOCABULARY.
 *
 * The blueprint's bottom-right key printed all three edge states —
 * satisfied / waiting / failed — unconditionally. On the live mesh that
 * disagreed with the picture: 19 of 20 graphs carry `gates:0`, so there are
 * almost no edges at all, and the key advertised three colour distinctions the
 * canvas never made. A reader then hunts the canvas for colours that are not
 * there, which is worse than no key.
 *
 * The fix derives the key from the edges actually rendered, so it is
 * self-correcting: it collapses to nothing on an edgeless canvas and grows
 * back the moment real dependency edges exist.
 *
 * This is pinned as source structure because @xyflow/react measures nothing
 * under jsdom and emits ZERO edges regardless of input — the same constraint
 * blueprint-mission-thread-touch-toggle.test.ts documents — so a rendered
 * edge-count assertion would pass whatever the legend did.
 *
 * Red-when-reverted: restoring the hardcoded
 * `{(['satisfied','waiting','failed'] as const).map(...)}` as the legend body
 * fails both assertions here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const VIEW = path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshTaskDagView.tsx')
const source = fs.readFileSync(VIEW, 'utf8')

describe('edge legend', () => {
    it('is derived from the rendered edges, not hardcoded', () => {
        // The derivation exists and reads BOTH edge sources the canvas draws
        // from — task dependency edges and the fused graph overlay's.
        expect(source).toMatch(/const legendStates = useMemo/)
        expect(source).toMatch(/for \(const edge of dag\.edges\) present\.add\(edge\.state\)/)
        expect(source).toMatch(/for \(const edge of fused\.edges\) present\.add\(edge\.state\)/)
    })

    it('hides itself entirely when the canvas draws no edges', () => {
        // An empty key must not render an empty bordered box.
        expect(source).toMatch(/\{legendStates\.length > 0 && \(/)
        expect(source).toMatch(/\{legendStates\.map\(state => \(/)
    })
})

describe('never-ending canvas animations respect reduced motion', () => {
    it('gates the pulsing status dot behind motion-safe', () => {
        // `animate-pulse` is an infinite animation: besides the a11y contract,
        // a canvas that never settles never presents a stable frame, which is
        // what a capture path waits for before it times out.
        expect(source).toContain('motion-safe:animate-pulse')
        // No ungated site remains: every `animate-pulse` carries the prefix.
        const pulseSites = [...source.matchAll(/animate-pulse/g)].length
        const gatedSites = [...source.matchAll(/motion-safe:animate-pulse/g)].length
        expect(pulseSites).toBeGreaterThan(0)
        expect(gatedSites).toBe(pulseSites)
    })

    it('stops the dashed edge animation under reduced motion', () => {
        // @xyflow/react's own stylesheet runs `dashdraw ... infinite` on any
        // edge marked `animated`; only CSS can hold it still.
        const css = fs.readFileSync(path.join(import.meta.dirname, '../../src/index.css'), 'utf8')
        expect(css).toMatch(/\.react-flow__edge\.animated path\s*\{\s*animation: none/)
    })
})
