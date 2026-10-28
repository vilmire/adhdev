// QA quality fixes: image fit semantics, broken image, changed-since-registered,
// title tooltip, "N+" position, and the open-error code mapping.
// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ArtifactFullscreenViewer from '../../src/components/attachments/ArtifactFullscreenViewer'
import { toArtifactViewerItem, type ArtifactViewerItem } from '../../src/components/attachments/artifact-viewer-item'
import { ARTIFACT_FALLBACK_TRANSLATIONS, getArtifactErrorCopy } from '../../src/components/attachments/artifact-i18n'
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

describe('image fit and zoom (issue 1)', () => {
    async function loadImage(natural: { w: number; h: number }, body: { w: number; h: number }) {
        await render(<ArtifactFullscreenViewer item={img()} onClose={() => {}} />)
        const bodyEl = document.querySelector<HTMLElement>('[data-testid="artifact-fullscreen-body"]')!
        Object.defineProperty(bodyEl, 'clientWidth', { configurable: true, value: body.w })
        Object.defineProperty(bodyEl, 'clientHeight', { configurable: true, value: body.h })
        const image = document.querySelector<HTMLImageElement>('[data-testid="artifact-fullscreen-image"]')!
        Object.defineProperty(image, 'naturalWidth', { configurable: true, value: natural.w })
        Object.defineProperty(image, 'naturalHeight', { configurable: true, value: natural.h })
        await act(async () => { image.dispatchEvent(new Event('load')) })
        return () => document.querySelector<HTMLImageElement>('[data-testid="artifact-fullscreen-image"]')!
    }
    const size = (el: HTMLImageElement) => [Math.round(parseFloat(el.style.width)), Math.round(parseFloat(el.style.height))]
    const click = async (id: string) => { await act(async () => { (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click() }) }

    it('small image: 100% is natural size (never upscaled); zoom-in enlarges it', async () => {
        const image = await loadImage({ w: 320, h: 200 }, { w: 1280, h: 767 })
        expect(size(image())).toEqual([320, 200])
        await click('artifact-zoom-in'); await click('artifact-zoom-in'); await click('artifact-zoom-in'); await click('artifact-zoom-in')
        expect(size(image())).toEqual([640, 400]) // 200%
        await click('artifact-zoom-fit')
        expect(size(image())).toEqual([320, 200])
    })

    it('large image: 100% fits the whole image in the body; 150% is 1.5x the fitted size', async () => {
        const image = await loadImage({ w: 4000, h: 3000 }, { w: 1280, h: 600 })
        // fit = min(1, 1280/4000, 600/3000) = 0.2
        expect(size(image())).toEqual([800, 600])
        await click('artifact-zoom-in'); await click('artifact-zoom-in')
        expect(size(image())).toEqual([1200, 900])
        await click('artifact-zoom-out'); await click('artifact-zoom-out'); await click('artifact-zoom-out')
        expect(size(image())).toEqual([600, 450]) // 75%
    })

    it('centres via auto margins on a flex scroll container (no justify-center clipping)', async () => {
        const image = await loadImage({ w: 10, h: 10 }, { w: 100, h: 100 })
        expect(image().className).toContain('m-auto')
        const body = document.querySelector<HTMLElement>('[data-testid="artifact-fullscreen-body"]')!
        expect(body.className).toContain('flex')
        expect(body.className).not.toContain('justify-center')
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
    it('maps known daemon codes to localized copy and unknown codes to the generic message', () => {
        const t = ((key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key) as any
        const copy = (code: string | null, raw?: string) => getArtifactErrorCopy(t, 'en', code, raw)
        const fb = ARTIFACT_FALLBACK_TRANSLATIONS.en
        expect(copy('artifact_not_found')).toBe(fb['artifact.errorFileMissing'])
        expect(copy('path_outside_workspace')).toBe(fb['artifact.errorWorkspaceGone'])
        expect(copy('invalid_workspace_root')).toBe(fb['artifact.errorWorkspaceGone'])
        expect(copy('artifact_session_mismatch')).toBe(fb['artifact.errorMismatch'])
        expect(copy('artifact_mismatch')).toBe(fb['artifact.errorMismatch'])
        expect(copy('missing_session_context')).toBe(fb['artifact.errorMissingSession'])
        expect(copy('timeout')).toBe(fb['artifact.errorOffline'])
        expect(copy('request_failed', 'Request timed out after 30000ms')).toBe(fb['artifact.errorOffline'])
        expect(copy('request_failed', 'Peer daemon unreachable')).toBe(fb['artifact.errorOffline'])
        expect(copy('artifact_access_denied')).toBe(fb['artifact.errorDenied'])
        expect(copy('artifact_too_large')).toBe(fb['artifact.errorFileTooLarge'])
        // Unknown code: generic copy, never the raw English sentence.
        expect(copy('something_new', 'Weird raw sentence')).toBe(fb['artifact.errorGeneric'])
        expect(copy(null)).toBe(fb['artifact.errorGeneric'])
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
