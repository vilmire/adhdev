// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ArtifactFullscreenViewer from '../../src/components/attachments/ArtifactFullscreenViewer'
import { downloadArtifactViewerItem, DOWNLOAD_REVOKE_DELAY_MS, type ArtifactViewerItem } from '../../src/components/attachments/artifact-viewer-item'
import {
    ARTIFACT_VIEWER_PAYLOAD,
    ARTIFACT_VIEWER_READY,
    openArtifactInNewWindow,
} from '../../src/components/attachments/artifact-popout'
import ArtifactViewerPage from '../../src/pages/ArtifactViewerPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const MD = '# One\n\ntext\n\n## Two\n\nmore\n\n### Three\n\n```\n# not a heading\n```\n'

function item(over: Partial<ArtifactViewerItem> = {}): ArtifactViewerItem {
    return { title: 'Doc', filename: 'doc.md', kind: 'markdown', mime: 'text/markdown', sizeBytes: 10, text: MD, blob: null, ...over }
}

let container: HTMLDivElement
let root: Root

async function render(node: React.ReactNode) {
    await act(async () => { root.render(node) })
}

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('ArtifactFullscreenViewer', () => {
    it('closes with Esc and restores focus to the opener', async () => {
        const opener = document.createElement('button')
        document.body.appendChild(opener)
        opener.focus()
        const onClose = vi.fn()
        await render(<ArtifactFullscreenViewer item={item()} onClose={onClose} />)
        expect(document.querySelector('[data-testid="artifact-fullscreen-viewer"]')).not.toBeNull()
        expect(document.activeElement).not.toBe(opener)
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
        expect(onClose).toHaveBeenCalledTimes(1)
        expect(document.activeElement).toBe(opener)
        opener.remove()
    })

    it('opens above a parent dialog and Esc does not also close that dialog', async () => {
        // The viewer can open from inside the mesh surface dialog (z = --z-modal-backdrop),
        // whose own window-level Escape handler must not fire when the viewer closes.
        const parentClose = vi.fn()
        const parentHandler = (event: KeyboardEvent) => { if (event.key === 'Escape') parentClose() }
        document.addEventListener('keydown', parentHandler, true)
        const onClose = vi.fn()
        await render(<ArtifactFullscreenViewer item={item()} onClose={onClose} />)
        const viewer = document.querySelector('[data-testid="artifact-fullscreen-viewer"]') as HTMLElement
        expect(viewer.closest('[class*="z-[var(--z-modal)]"]') ?? (viewer.className.includes('z-[var(--z-modal)]') ? viewer : null)).not.toBeNull()
        await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
        expect(onClose).toHaveBeenCalledTimes(1)
        expect(parentClose).not.toHaveBeenCalled()
        document.removeEventListener('keydown', parentHandler, true)
    })

    it('text size controls change the content scale', async () => {
        await render(<ArtifactFullscreenViewer item={item()} onClose={() => {}} />)
        const content = () => document.querySelector('[data-testid="artifact-fullscreen-content"]') as HTMLElement
        expect(content().dataset.textScale).toBe('1')
        await act(async () => { (document.querySelector('[data-testid="artifact-text-larger"]') as HTMLElement).click() })
        expect(Number(content().dataset.textScale)).toBeCloseTo(1.1)
        await act(async () => { (document.querySelector('[data-testid="artifact-text-smaller"]') as HTMLElement).click() })
        await act(async () => { (document.querySelector('[data-testid="artifact-text-smaller"]') as HTMLElement).click() })
        expect(Number(content().dataset.textScale)).toBeCloseTo(0.9)
        await act(async () => { (document.querySelector('[data-testid="artifact-text-reset"]') as HTMLElement).click() })
        expect(content().dataset.textScale).toBe('1')
    })

    it('shows a table of contents only for 3+ headings (ignoring fenced code)', async () => {
        await render(<ArtifactFullscreenViewer item={item()} onClose={() => {}} />)
        const toc = document.querySelector('[data-testid="artifact-toc"]')
        expect(toc).not.toBeNull()
        expect(toc!.querySelectorAll('li').length).toBe(3)
        await render(<ArtifactFullscreenViewer item={item({ text: '# A\n\n## B\n' })} onClose={() => {}} />)
        expect(document.querySelector('[data-testid="artifact-toc"]')).toBeNull()
    })
})

describe('viewer review fixes', () => {
    it('starts with the contents panel closed on a narrow viewport (toggle still works)', async () => {
        const orig = window.matchMedia
        window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as any
        try {
            await render(<ArtifactFullscreenViewer item={item()} onClose={() => {}} />)
            expect(document.querySelector('[data-testid="artifact-toc"]')).toBeNull()
            await act(async () => { (document.querySelector('[data-testid="artifact-toc-toggle"]') as HTMLElement).click() })
            expect(document.querySelector('[data-testid="artifact-toc"]')).not.toBeNull()
        } finally {
            window.matchMedia = orig
        }
    })

    it('arrow keys navigate, except inside a horizontal scroller that can still scroll that way', async () => {
        const onNavigate = vi.fn()
        await render(<ArtifactFullscreenViewer item={item()} onClose={() => {}} position={{ index: 1, total: 3 }} onNavigate={onNavigate} />)
        const scroller = document.createElement('div')
        scroller.style.overflowX = 'auto'
        Object.defineProperty(scroller, 'scrollWidth', { value: 500, configurable: true })
        Object.defineProperty(scroller, 'clientWidth', { value: 100, configurable: true })
        scroller.scrollLeft = 0
        document.querySelector('[data-testid="artifact-fullscreen-content"]')!.appendChild(scroller)
        const press = (key: string) => act(async () => { scroller.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
        await press('ArrowRight') // can still scroll right -> no navigation
        expect(onNavigate).not.toHaveBeenCalled()
        await press('ArrowLeft') // already at the left edge -> navigate
        expect(onNavigate).toHaveBeenCalledWith(-1)
    })

    it('copy and contents are icon buttons with accessible names and tooltips', async () => {
        await render(<ArtifactFullscreenViewer item={item()} onClose={() => {}} />)
        for (const id of ['artifact-fullscreen-copy', 'artifact-toc-toggle']) {
            const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement
            expect(el.getAttribute('aria-label')).toBeTruthy()
            expect(el.getAttribute('title')).toBeTruthy()
            expect(el.querySelector('svg')).not.toBeNull()
        }
    })

    it('download revokes its object URL only after a delay', async () => {
        vi.useFakeTimers()
        const create = vi.fn(() => 'blob:dl')
        const revoke = vi.fn()
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
        const o = [URL.createObjectURL, URL.revokeObjectURL]
        URL.createObjectURL = create as any
        URL.revokeObjectURL = revoke as any
        try {
            expect(downloadArtifactViewerItem(item())).toBe(true)
            expect(revoke).not.toHaveBeenCalled()
            vi.advanceTimersByTime(DOWNLOAD_REVOKE_DELAY_MS)
            expect(revoke).toHaveBeenCalledWith('blob:dl')
        } finally {
            URL.createObjectURL = o[0]!
            URL.revokeObjectURL = o[1]!
        }
    })
})

describe('pop-out handshake', () => {
    it('opener replies to a ready message from the child window only', async () => {
        const child = { postMessage: vi.fn(), closed: false } as unknown as Window
        vi.spyOn(window, 'open').mockReturnValue(child)
        expect(openArtifactInNewWindow(item())).toBe(true)
        expect(window.open).toHaveBeenCalledWith('/artifact-view', '_blank', expect.stringContaining('popup'))
        const ready = { type: ARTIFACT_VIEWER_READY }
        // wrong origin
        window.dispatchEvent(new MessageEvent('message', { data: ready, origin: 'https://evil.example', source: child }))
        // wrong source
        window.dispatchEvent(new MessageEvent('message', { data: ready, origin: window.location.origin, source: window }))
        expect(child.postMessage).not.toHaveBeenCalled()
        window.dispatchEvent(new MessageEvent('message', { data: ready, origin: window.location.origin, source: child }))
        expect(child.postMessage).toHaveBeenCalledTimes(1)
        const [msg, target] = (child.postMessage as any).mock.calls[0]
        expect(target).toBe(window.location.origin)
        expect(msg.type).toBe(ARTIFACT_VIEWER_PAYLOAD)
        expect(msg.payload.title).toBe('Doc')
    })

    it('reports a blocked window', () => {
        vi.spyOn(window, 'open').mockReturnValue(null)
        expect(openArtifactInNewWindow(item())).toBe(false)
    })

    it('child asks the opener, renders the payload, and ignores foreign origins', async () => {
        const opener = { postMessage: vi.fn() } as unknown as Window
        ;(window as any).opener = opener
        await render(<ArtifactViewerPage />)
        expect((opener.postMessage as any).mock.calls[0]).toEqual([{ type: ARTIFACT_VIEWER_READY }, window.location.origin])
        const payload = { type: ARTIFACT_VIEWER_PAYLOAD, payload: item({ title: 'Hello' }) }
        await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: payload, origin: 'https://evil.example', source: opener })) })
        expect(document.querySelector('[data-testid="artifact-fullscreen-viewer"]')).toBeNull()
        await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { type: ARTIFACT_VIEWER_PAYLOAD, payload: { nope: 1 } }, origin: window.location.origin, source: opener })) })
        expect(document.querySelector('[data-testid="artifact-fullscreen-viewer"]')).toBeNull()
        await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: payload, origin: window.location.origin, source: opener })) })
        expect(document.querySelector('[data-testid="artifact-fullscreen-title"]')!.textContent).toBe('Hello')
        ;(window as any).opener = null
    })

    it('shows a friendly message when no payload arrives in time or there is no opener', async () => {
        vi.useFakeTimers()
        ;(window as any).opener = { postMessage: vi.fn() }
        await render(<ArtifactViewerPage timeoutMs={5000} />)
        const status = () => document.querySelector('[data-testid="artifact-viewer-page-status"]')!.textContent
        expect(status()).toContain('Waiting')
        await act(async () => { vi.advanceTimersByTime(5000) })
        expect(status()).toContain('Open this artifact again from the dashboard')
        ;(window as any).opener = null
        await render(<ArtifactViewerPage key="no-opener" />)
        await act(async () => { vi.advanceTimersByTime(10) })
        expect(status()).toContain('Open this artifact again')
    })
})
