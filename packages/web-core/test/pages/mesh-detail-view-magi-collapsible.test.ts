import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

/**
 * ★ G5-7 THE ALWAYS-EXPANDED-MAGI-SECTION REGRESSION.
 *
 * The MAGI task_kind → panel binding editor Section had no `collapsible`
 * prop, so (per Section.tsx: `isOpen = collapsible ? open : true`) it was
 * unconditionally expanded with no collapse affordance at all — unlike the
 * Safety & Git and Coordinator Prompt sections on the same page, which are
 * both `collapsible defaultOpen={false}`. (They all live in the Advanced tab
 * now, so the per-section "advanced" badge was dropped as redundant.)
 *
 * Source-level (not mounted) because MeshDetailView is page-scale with a
 * large required-props surface — same convention as
 * repo-mesh-create-hang-regression.test.ts.
 */
describe('MeshDetailView — G5-7 MAGI section is collapsible, matching sibling advanced sections', () => {
    it('the MAGI Section has collapsible + defaultOpen={false}, like Safety & Git', () => {
        const source = read('../../src/pages/repo-mesh/MeshDetailView.tsx')
        const magiIdx = source.indexOf("t('mesh.detail.magiTitle')")
        expect(magiIdx).toBeGreaterThan(-1)
        // Look at the <Section ...> opening tag surrounding the magiTitle usage.
        const sectionStart = source.lastIndexOf('<Section', magiIdx)
        const sectionOpenEnd = source.indexOf('>', source.indexOf('description=', magiIdx))
        const sectionTag = source.slice(sectionStart, sectionOpenEnd)
        expect(sectionTag).toContain('collapsible')
        expect(sectionTag).toContain('defaultOpen={false}')
        // Inside the Advanced tab a second "advanced" badge is noise.
        expect(sectionTag).not.toContain("t('mesh.detail.advanced')")
    })
})
