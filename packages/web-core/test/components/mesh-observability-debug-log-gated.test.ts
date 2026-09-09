import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

/**
 * ★ G5-4 THE UNGATED-DEBUG-LOG REGRESSION.
 *
 * MeshObservabilitySurface's selected-node effect called
 * `console.info('[RepoMeshGraphDebug]', ...)` with no gate at all — it fires
 * on every selected-node CHANGE, which includes every poll tick that mutates
 * selectedGraphNode/selectedNodeStatus identity while a node stays selected,
 * not just clicks. Gated the same way useDevRenderTrace gates render traces:
 * a `window.__ADHDEV_DEBUG_..__` flag + localStorage opt-in.
 *
 * Source-level (not mounted) because MeshObservabilitySurface is a page-scale
 * component with a large required-props surface — same convention as
 * repo-mesh-create-hang-regression.test.ts.
 */
describe('MeshObservabilitySurface — G5-4 debug console.info is gated', () => {
    it('the console.info call site is preceded by an isMeshGraphDebugEnabled() gate', () => {
        const source = read('../../src/components/MeshGraph/MeshObservabilitySurface.tsx')
        const marker = "console.info('[RepoMeshGraphDebug]'"
        const callIdx = source.indexOf(marker)
        expect(callIdx).toBeGreaterThan(-1)

        // Walk back to the start of the enclosing useEffect to find its guard line.
        const effectStart = source.lastIndexOf('useEffect(() => {', callIdx)
        expect(effectStart).toBeGreaterThan(-1)
        const guardRegion = source.slice(effectStart, callIdx)
        expect(guardRegion).toMatch(/if\s*\([^)]*isMeshGraphDebugEnabled\(\)[^)]*\)\s*return/)
    })

    it('isMeshGraphDebugEnabled follows the same window-flag + localStorage opt-in shape as useDevRenderTrace', () => {
        const source = read('../../src/components/MeshGraph/MeshObservabilitySurface.tsx')
        expect(source).toContain('function isMeshGraphDebugEnabled')
        expect(source).toMatch(/window\.__ADHDEV_DEBUG_\w+__\s*===\s*true/)
        expect(source).toMatch(/localStorage\.getItem\('adhdev_debug_\w+'\)\s*===\s*'1'/)
    })
})
