/**
 * `.adhdev/mesh.json` coordinator layer projection.
 *
 * Guards the defect this fixes: a repo that commits
 * `coordinator.systemPromptAppend` contributes real text to every coordinator
 * prompt, while the mesh settings editor (seeded from machine-local meshes.json
 * only) showed an empty Append box. These tests pin the projection that feeds the
 * read-only notice.
 *
 * INJECTION CHECK: reverting extractRepoMeshJsonCoordinatorLayer to read
 * `raw.config` directly (dropping the `raw.result` unwrap) turns the cloud-shape
 * test red; returning a layer unconditionally turns the "no repo file" and
 * "declares nothing" tests red.
 */
import { describe, expect, it } from 'vitest'
import { extractRepoMeshJsonCoordinatorLayer } from '../../../src/pages/repo-mesh/RepoMeshJsonAppendNotice'

const APPEND = 'Always run the fast suite before reporting.'

describe('extractRepoMeshJsonCoordinatorLayer', () => {
    it('reads the repo append from the standalone (unwrapped) response shape', () => {
        const layer = extractRepoMeshJsonCoordinatorLayer({
            success: true,
            sourceType: 'repo_file',
            path: '/repo/.adhdev/mesh.json',
            config: { version: 1, coordinator: { systemPromptAppend: APPEND } },
        })

        expect(layer).not.toBeNull()
        expect(layer!.append).toBe(APPEND)
        expect(layer!.override).toBe('')
        expect(layer!.sourceType).toBe('repo_file')
        expect(layer!.path).toBe('/repo/.adhdev/mesh.json')
    })

    it('reads the repo append through the cloud transport wrapper', () => {
        // Cloud wraps the daemon body once as { result: <body> }. Reading only the
        // outer object is the historical silent-empty bug class.
        const layer = extractRepoMeshJsonCoordinatorLayer({
            success: true,
            result: {
                success: true,
                sourceType: 'repo_file',
                path: '/repo/.adhdev/mesh.json',
                config: { version: 1, coordinator: { systemPromptAppend: APPEND } },
            },
        })

        expect(layer).not.toBeNull()
        expect(layer!.append).toBe(APPEND)
    })

    it('surfaces a repo-declared override alongside the append', () => {
        const layer = extractRepoMeshJsonCoordinatorLayer({
            success: true,
            sourceType: 'repo_file',
            config: {
                version: 1,
                coordinator: { systemPromptOverride: 'FULL BASE', systemPromptAppend: APPEND },
            },
        })

        expect(layer!.override).toBe('FULL BASE')
        expect(layer!.append).toBe(APPEND)
    })

    it('renders nothing when the repo has no mesh.json', () => {
        const layer = extractRepoMeshJsonCoordinatorLayer({
            success: true,
            sourceType: 'unavailable',
            source: 'unavailable',
        })

        expect(layer).toBeNull()
    })

    it('renders nothing when the repo file declares no coordinator prompt text', () => {
        // A repo may use mesh.json only for providerDefaults / operatingNotes. That
        // must not draw an empty "From this repo" box.
        const layer = extractRepoMeshJsonCoordinatorLayer({
            success: true,
            sourceType: 'repo_file',
            config: { version: 1, providerDefaults: { autoApproveModes: { 'claude-cli': 'accept-edits' } } },
        })

        expect(layer).toBeNull()
    })

    it('treats whitespace-only prompt text as nothing to show', () => {
        const layer = extractRepoMeshJsonCoordinatorLayer({
            success: true,
            sourceType: 'repo_file',
            config: { version: 1, coordinator: { systemPromptAppend: '   \n  ' } },
        })

        expect(layer).toBeNull()
    })

    it('reports an unparseable repo file instead of hiding it', () => {
        // sourceType 'invalid' means the repo INTENDED a layer and the daemon fell
        // back to "no repo base" — worth showing, unlike a plain absent file.
        const layer = extractRepoMeshJsonCoordinatorLayer({
            success: true,
            sourceType: 'invalid',
            path: '/repo/.adhdev/mesh.json',
            error: 'version must be 1 (got 2)',
        })

        expect(layer).not.toBeNull()
        expect(layer!.sourceType).toBe('invalid')
        expect(layer!.error).toBe('version must be 1 (got 2)')
    })

    it('renders nothing when the daemon command itself failed', () => {
        const layer = extractRepoMeshJsonCoordinatorLayer({ success: false, error: 'daemon offline' })
        expect(layer).toBeNull()
    })

    it('renders nothing for a malformed / empty response', () => {
        expect(extractRepoMeshJsonCoordinatorLayer(null)).toBeNull()
        expect(extractRepoMeshJsonCoordinatorLayer(undefined)).toBeNull()
        expect(extractRepoMeshJsonCoordinatorLayer('nope')).toBeNull()
    })
})
