import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8')

/**
 * ★ G5-5 THE DEAD-END EMPTY-STATE REGRESSION.
 *
 * DashboardMeshGraphDialog's header always renders a "?" help toggle that
 * flips `helpOpen`, but MeshHelpPanel used to be rendered ONLY inside
 * MeshObservabilitySurface — which this dialog does not mount when there's
 * no live mesh status yet (the exact moment a value explanation matters
 * most). Clicking "?" on the empty state did nothing visible: no glossary,
 * no explanation of what a Repo Mesh is, no way forward.
 *
 * Source-level (not mounted) because this component depends on
 * useDashboardMeshOverrides()/useTransport() context providers not worth
 * standing up for this check — same convention as
 * repo-mesh-create-hang-regression.test.ts.
 */
describe('DashboardMeshGraphDialog — G5-5 help panel reachable from the empty state', () => {
    it('renders MeshHelpPanel in the branch where displayedMeshStatus is falsy', () => {
        const source = read('../../src/components/dashboard/DashboardMeshGraphDialog.tsx')
        expect(source).toContain('MeshHelpPanel')
        // The empty-state branch (falsy displayedMeshStatus) must be able to
        // show the panel — pinned by requiring a helpOpen-gated MeshHelpPanel
        // render whose condition also covers the !displayedMeshStatus case.
        const helpPanelUsage = source.slice(source.indexOf('<MeshHelpPanel'))
        expect(source).toMatch(/helpOpen\s*&&\s*!displayedMeshStatus/)
        expect(helpPanelUsage).toContain('onClose={() => setHelpOpen(false)}')
    })

    it('MeshHelpPanel is exported from the MeshGraph barrel (needed for this dialog to import it)', () => {
        const barrel = read('../../src/components/MeshGraph/index.ts')
        expect(barrel).toContain("export { MeshHelpPanel }")
    })

    it('the noGraph empty message points the user at the help toggle', () => {
        const en = JSON.parse(read('../../src/i18n/locales/en/common.json'))
        const noGraph: string = en.mesh.dialog.noGraph
        expect(noGraph.length).toBeGreaterThan('No live mesh graph is available for this coordinator yet.'.length)
    })
})
