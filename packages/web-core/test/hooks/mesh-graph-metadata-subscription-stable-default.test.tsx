// @vitest-environment jsdom
/**
 * (MESH-GRAPH-DEFAULT) Guards the `extraLiveSessions` default on
 * `useMeshGraphMetadataSubscription`.
 *
 * `RepoMesh.tsx` calls the hook without passing `extraLiveSessions` at all
 * (see `src/pages/RepoMesh.tsx`), so every render falls through to the
 * hook's own default parameter. A `= []` default allocates a fresh array
 * every render — unstable by construction. Today that instability has no
 * visible symptom in `displayedMeshStatus` because `mergeExtraLiveSessions`
 * happens to early-return `metadataLiveSessions` unchanged whenever the
 * (filtered) extras list is empty — but that's an accident of the current
 * merge implementation, not a guarantee: any future change to
 * `mergeExtraLiveSessions`, or a new consumer that reads `extraLiveSessions`
 * itself in a dependency array, would silently reintroduce a real
 * every-render identity change. The fix hoists the default to a shared
 * `EMPTY_LIVE_SESSIONS` module constant, matching the established pattern
 * in `AppShell.tsx` (`EMPTY_SECTIONS`/`EMPTY_ITEMS`).
 *
 * `EMPTY_LIVE_SESSIONS` being stable is trivially true of any module const,
 * so the load-bearing check is that the hook's own default destructure
 * actually reads from it — asserted directly on the hook source, the same
 * convention `dashboard-mesh-graph-dialog-boundary.test.ts` already uses for
 * this file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_LIVE_SESSIONS } from '../../src/hooks/useMeshGraphMetadataSubscription'

function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('useMeshGraphMetadataSubscription extraLiveSessions default (stability contract)', () => {
    it('exports a stable, reusable EMPTY_LIVE_SESSIONS reference', () => {
        expect(EMPTY_LIVE_SESSIONS).toBe(EMPTY_LIVE_SESSIONS)
        expect(EMPTY_LIVE_SESSIONS).toEqual([])
    })

    it('the hook default-destructures extraLiveSessions from the shared constant, not a fresh literal', () => {
        const hookSource = readSource('hooks/useMeshGraphMetadataSubscription.ts')

        // ★ The regression this guards: `extraLiveSessions = [],` allocates a
        // new array every render. `RepoMesh.tsx` never passes the arg, so it
        // would hit that fresh literal on every single render.
        expect(hookSource).toContain('extraLiveSessions = EMPTY_LIVE_SESSIONS,')
        expect(hookSource).not.toContain('extraLiveSessions = [],')
        expect(hookSource).toContain('export const EMPTY_LIVE_SESSIONS: MeshGraphLiveSessionStatus[] = []')
    })

    it('RepoMesh.tsx (the live caller that omits extraLiveSessions) is unchanged by this fix', () => {
        const repoMeshSource = readSource('pages/RepoMesh.tsx')

        expect(repoMeshSource).toContain('useMeshGraphMetadataSubscription({')
        expect(repoMeshSource).not.toContain('extraLiveSessions:')
    })
})
