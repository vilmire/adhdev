import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Symptom block for the "Machine daemon candidates" ghost cards (mobile report,
 * 2026-08-14): four cards rendering a raw 64-hex DO id as BOTH the title and the
 * subtitle, with "0 workspace(s) detected".
 *
 * The label path was never at fault — daemonLabel() correctly falls back to
 * shortMachineKey() (17 chars + ellipsis), which is exactly what was photographed.
 * The defect is that phantom raw-DO-id daemons reach the candidate list at all.
 *
 * These are source-shape assertions: both candidate lists are useMemo bodies inside
 * React page components, so asserting the filter is applied at the BUILD site is what
 * pins the fix. The predicate's own behaviour is unit-tested in
 * mesh-shared/test/phantom-daemon-entry.test.ts.
 */
function readSource(relativePath: string): string {
    return readFileSync(resolve(__dirname, '../../src', relativePath), 'utf8')
}

const repoMeshSource = readSource('pages/RepoMesh.tsx')
const setupWizardSource = readSource('components/setup-wizard/SetupWizard.tsx')
const nodeListSource = readSource('pages/repo-mesh/MeshNodeList.tsx')

describe('phantom daemons are excluded from the attachable-candidate list', () => {
    it('filters the mesh page candidate list where it is built, not at render', () => {
        // Filtering at the build site (the useMemo) is what keeps the "N available"
        // counter, the allDaemonsAttached empty-state branch and the rendered cards
        // in agreement. A render-time .filter() would leave the counter lying.
        const memo = repoMeshSource.slice(
            repoMeshSource.indexOf('const attachableDaemons = useMemo('),
        ).slice(0, 400)
        expect(memo).toContain('isPhantomDaemonEntry')
        expect(repoMeshSource).toContain("from '@adhdev/mesh-shared'")
    })

    it('filters the setup wizard candidate list too (a second, independent builder)', () => {
        const memo = setupWizardSource.slice(
            setupWizardSource.indexOf('const attachableDaemons = useMemo('),
        ).slice(0, 500)
        expect(memo).toContain('isPhantomDaemonEntry')
        expect(setupWizardSource).toContain("import { isPhantomDaemonEntry } from '@adhdev/mesh-shared'")
    })

    it('shares the predicate instead of re-implementing the rule inline', () => {
        // Both call sites must import the mesh-shared predicate. An inline
        // `/^[0-9a-f]{64}$/` in a page component is the drift this guards against —
        // the server holds the same rule and the two must not diverge.
        for (const source of [repoMeshSource, setupWizardSource]) {
            expect(source).not.toMatch(/\[0-9a-f\]\{64\}/)
        }
    })

    it('does not touch daemonLabel — the label fallback is correct behaviour', () => {
        // Regression guard on the misdiagnosis: the hash-as-title is the SYMPTOM of a
        // phantom entry, not a labelling bug. shortMachineKey must stay the last-resort
        // fallback for real daemons that genuinely have no name.
        expect(nodeListSource).toContain('shortMachineKey(daemon.id)')
    })
})

describe('daemon candidate cards cannot overflow the viewport on mobile', () => {
    const cardBlock = nodeListSource.slice(
        nodeListSource.indexOf('{attachableDaemons.map(d => ('),
        nodeListSource.indexOf('{/* Add node button */}'),
    )

    it('gives the grid item min-w-0 so its truncating children can shrink', () => {
        // A grid/flex item defaults to `min-width:auto`, which floors the track at the
        // widest content — the 64-char monospace daemon id. Without min-w-0 the card
        // itself grows past the viewport and `truncate` never engages.
        //
        // Anchored to the card's own className expression, NOT a bare
        // `toContain('min-w-0')`: the loose form also matches the explanatory comment
        // and the label span below, so it stayed green when the card's class was
        // removed (verified by fault injection).
        expect(cardBlock).toMatch(/className=\{`text-left rounded-lg border[^`]*\bmin-w-0\b/)
    })

    it('keeps the id subtitle truncating', () => {
        expect(cardBlock).toMatch(/font-mono truncate[^"]*">\{d\.id\}/)
    })

    it('lets the label yield before the host badge', () => {
        expect(cardBlock).toContain('truncate min-w-0')
        expect(cardBlock).toMatch(/text-accent-primary shrink-0/)
    })
})
