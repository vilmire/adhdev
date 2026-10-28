// QA quality fixes: image fit semantics, broken image, changed-since-registered,
// title tooltip, "N+" position, and the open-error code mapping.
// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ArtifactFullscreenViewer from '../../src/components/attachments/ArtifactFullscreenViewer'
import { toArtifactViewerItem, type ArtifactViewerItem } from '../../src/components/attachments/artifact-viewer-item'
import { classifyArtifactOpenError } from '../../src/components/attachments/artifact-open-error'
import { isArtifactPopoutWirePayload } from '../../src/components/attachments/artifact-popout'
import { readArtifactFetchCommandResponse } from '../../src/hooks/useArtifactRead'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function item(over: Partial<ArtifactViewerItem> = {}): ArtifactViewerItem {
    return { title: 'Doc', filename: 'doc.md', kind: 'markdown', mime: 'text/markdown', sizeBytes: 10, text: 'hello', blob: null, ...over }
}
const img = (over: Partial<ArtifactViewerItem> = {}) => item({ kind: 'image', mime: 'image/png', filename: 'a.png', title: 'Pic', text: null, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), ...over })

let container: HTMLDivElement
let root: Root
const origCreate = URL.createObjectURL
const origRevoke = URL.revokeObjectURL
const render = async (node: React.ReactNode) => { await act(async () => { root.render(node) }) }
beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    URL.createObjectURL = vi.fn(() => 'blob:fit') as any
    URL.revokeObjectURL = vi.fn() as any
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
})

describe('image fit (issue 1)', () => {
    it('100% fits the whole image inside the body without upscaling; zoom scales the fit box', async () => {
        await render(<ArtifactFullscreenViewer item={img()} onClose={() => {}} />)
        const image = document.querySelector<HTMLImageElement>('[data-testid="artifact-fullscreen-image"]')!
        expect(image.style.maxWidth).toBe('100%')
        expect(image.style.maxHeight).toBe('100%')
        expect(image.style.width).toBe('auto')
        expect(image.style.height).toBe('auto')
        const box = () => document.querySelector<HTMLElement>('[data-testid="artifact-image-box"]')!
        expect(box().style.width).toBe('100%')
        expect(box().style.height).toBe('100%')
        await act(async () => { (document.querySelector('[data-testid="artifact-zoom-in"]') as HTMLButtonElement).click() })
        expect(box().style.width).toBe('125%')
        await act(async () => { (document.querySelector('[data-testid="artifact-zoom-out"]') as HTMLButtonElement).click() })
        await act(async () => { (document.querySelector('[data-testid="artifact-zoom-out"]') as HTMLButtonElement).click() })
        expect(box().style.width).toBe('75%')
        await act(async () => { (document.querySelector('[data-testid="artifact-zoom-fit"]') as HTMLButtonElement).click() })
        expect(box().style.width).toBe('100%')
    })
})

describe('broken image (issue 2)', () => {
    it('shows a message instead of an empty image and keeps download available', async () => {
        await render(<ArtifactFullscreenViewer item={img()} onClose={() => {}} />)
        const image = document.querySelector('[data-testid="artifact-fullscreen-image"]')!
        await act(async () => { image.dispatchEvent(new Event('error')) })
        expect(document.querySelector('[data-testid="artifact-fullscreen-image"]')).toBeNull()
        expect(document.querySelector('[data-testid="artifact-image-broken"]')?.textContent).toContain("can't be displayed")
        expect(document.querySelector('[data-testid="artifact-fullscreen-download"]')).not.toBeNull()
    })
})

describe('changed since registered (issue 3)', () => {
    it('carries sha256Changed from the payload into the viewer item and pop-out wire shape', () => {
        const payload: any = { title: 'T', filename: 'f.md', kind: 'markdown', mime: 'text/markdown', sizeBytes: 3, textContent: 'abc', bytes: new Uint8Array([97, 98, 99]), sha256Changed: true }
        const viewerItem = toArtifactViewerItem(payload)
        expect(viewerItem.sha256Changed).toBe(true)
        expect(isArtifactPopoutWirePayload({ ...viewerItem })).toBe(true)
        expect(toArtifactViewerItem({ ...payload, sha256Changed: false }).sha256Changed).toBe(false)
    })

    it('shows a notice only when the file changed', async () => {
        await render(<ArtifactFullscreenViewer item={item({ sha256Changed: true })} onClose={() => {}} />)
        expect(document.querySelector('[data-testid="artifact-changed-notice"]')?.textContent).toContain('changed after it was registered')
        await render(<ArtifactFullscreenViewer item={item({ sha256Changed: false })} onClose={() => {}} />)
        expect(document.querySelector('[data-testid="artifact-changed-notice"]')).toBeNull()
    })
})

describe('header title and position (issues 9, 11)', () => {
    it('exposes the full title as a tooltip', async () => {
        const long = 'A very long artifact title '.repeat(8)
        await render(<ArtifactFullscreenViewer item={item({ title: long })} onClose={() => {}} />)
        expect(document.querySelector('[data-testid="artifact-fullscreen-title"]')?.getAttribute('title')).toBe(long)
    })

    it('shows "N+" when more artifacts exist beyond the loaded ones', async () => {
        await render(<ArtifactFullscreenViewer item={item()} onClose={() => {}} onNavigate={() => {}} position={{ index: 0, total: 100, more: true }} />)
        expect(document.querySelector('[data-testid="artifact-fullscreen-position"]')?.textContent).toBe('1/100+')
        await render(<ArtifactFullscreenViewer item={item()} onClose={() => {}} onNavigate={() => {}} position={{ index: 0, total: 100 }} />)
        expect(document.querySelector('[data-testid="artifact-fullscreen-position"]')?.textContent).toBe('1/100')
    })
})

describe('open error mapping (issue 6)', () => {
    it('maps known daemon codes to localized message keys', () => {
        expect(classifyArtifactOpenError('artifact_not_found')).toBe('mesh.obs.artifactsErrNotFound')
        expect(classifyArtifactOpenError('path_outside_workspace')).toBe('mesh.obs.artifactsErrWorkspaceGone')
        expect(classifyArtifactOpenError('invalid_workspace_root')).toBe('mesh.obs.artifactsErrWorkspaceGone')
        expect(classifyArtifactOpenError('artifact_session_mismatch')).toBe('mesh.obs.artifactsErrMismatch')
        expect(classifyArtifactOpenError('missing_session_context')).toBe('mesh.obs.artifactsErrNoSession')
        expect(classifyArtifactOpenError('timeout')).toBe('mesh.obs.artifactsErrOffline')
        expect(classifyArtifactOpenError('request_failed', 'Request timed out after 30000ms')).toBe('mesh.obs.artifactsErrOffline')
        expect(classifyArtifactOpenError('request_failed', 'Peer daemon unreachable')).toBe('mesh.obs.artifactsErrOffline')
        expect(classifyArtifactOpenError('artifact_too_large')).toBe('mesh.obs.artifactsErrTooLarge')
        expect(classifyArtifactOpenError('something_new', 'weird')).toBe('mesh.obs.artifactsErrGeneric')
        expect(classifyArtifactOpenError(null)).toBe('mesh.obs.artifactsErrGeneric')
    })

    it('readArtifactFetchCommandResponse returns the bare daemon code, not the English sentence', () => {
        const expected = { artifactId: 'a', sessionId: 's', daemonId: 'd', attachment: {} as any }
        const fromCode = readArtifactFetchCommandResponse({ success: false, code: 'artifact_not_found', error: 'Artifact file not found: missing.md (artifact_not_found)' }, expected)
        expect(fromCode.errorCode).toBe('artifact_not_found')
        expect(fromCode.error).toContain('Artifact file not found')
        expect(readArtifactFetchCommandResponse({ success: false, error: 'Path escapes (path_outside_workspace)' }, expected).errorCode).toBe('path_outside_workspace')
        expect(readArtifactFetchCommandResponse({ success: false, error: 'artifact_not_found' }, expected).errorCode).toBe('artifact_not_found')
        expect(readArtifactFetchCommandResponse({ success: false, error: 'Something odd happened' }, expected).errorCode).toBe('request_failed')
    })
})
