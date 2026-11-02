// @vitest-environment jsdom
/**
 * Pop-out without an opener. `window.open` can navigate the SAME tab (embedded browser panes,
 * webviews, installed PWAs) so `window.opener` is null and the postMessage handshake never
 * happens; the content must travel through the one-shot same-origin handoff instead.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ArtifactViewerPage from '../../src/pages/ArtifactViewerPage'
import { HANDOFF_MAX_AGE_MS, putArtifactHandoff, setArtifactHandoffStore } from '../../src/components/attachments/artifact-handoff'
import { goBackToDashboard, openArtifactInNewWindow } from '../../src/components/attachments/artifact-popout'
import { DriverBundleInstallPopout } from '../../src/components/attachments/DriverBundleInstall'
import type { ArtifactViewerItem } from '../../src/components/attachments/artifact-viewer-item'
import { memoryStore } from './artifact-handoff-memory-store'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const item = (over: Partial<ArtifactViewerItem> = {}): ArtifactViewerItem =>
    ({ title: 'Secret Plan', filename: 'secret-plan.md', kind: 'markdown', mime: 'text/markdown', sizeBytes: 12, text: '# Hello handoff', blob: null, ...over })

let container: HTMLDivElement
let root: Root
let store: ReturnType<typeof memoryStore>
const render = async (node: React.ReactNode) => { await act(async () => { root.render(node) }) }
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const setSearch = (search: string) => window.history.replaceState(null, '', `/artifact-view${search}`)
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`)

beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    store = memoryStore(); setArtifactHandoffStore(store)
    ;(window as any).opener = null
})
afterEach(() => {
    act(() => root.unmount()); container.remove()
    setArtifactHandoffStore(null); setSearch('')
    delete (window as any).opener
    vi.useRealTimers(); vi.restoreAllMocks()
})

/** Run the opener side, capture the URL the window was opened with, and "navigate" to it. */
async function openAndNavigate(shown: ArtifactViewerItem) {
    const open = vi.spyOn(window, 'open').mockReturnValue({ postMessage: vi.fn(), closed: false } as unknown as Window)
    expect(await openArtifactInNewWindow(shown)).toBe('opened')
    const url = String(open.mock.calls[0]![0])
    setSearch(url.slice(url.indexOf('?')))
    return url
}

describe('handoff when the pop-out has no opener', () => {
    it('renders a text artifact from the handle', async () => {
        await openAndNavigate(item())
        await render(<ArtifactViewerPage />)
        await flush()
        expect(q('artifact-fullscreen-title')!.textContent).toBe('Secret Plan')
        expect(container.textContent).toContain('Hello handoff')
    })

    it('renders an image Blob from the handle', async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
        await openAndNavigate(item({ title: 'Shot', filename: 'shot.png', kind: 'image', mime: 'image/png', text: null, blob, sizeBytes: 3 }))
        const parked = [...store.records.values()][0]!.item as ArtifactViewerItem
        expect(parked.blob).toBeInstanceOf(Blob)
        const create = vi.fn(() => 'blob:img'); const orig = URL.createObjectURL
        URL.createObjectURL = create as any
        try {
            await render(<ArtifactViewerPage />)
            await flush()
            expect(q('artifact-fullscreen-title')!.textContent).toBe('Shot')
            expect(q('artifact-viewer-page-status')).toBeNull()
        } finally { URL.createObjectURL = orig }
    })

    it('deletes the record once read, so a reload shows the dead-end message', async () => {
        await openAndNavigate(item())
        expect(store.records.size).toBe(1)
        await render(<ArtifactViewerPage />)
        await flush()
        expect(store.records.size).toBe(0)
        act(() => root.unmount()); root = createRoot(container)
        setArtifactHandoffStore(store) // a real reload also drops the in-memory read cache
        await render(<ArtifactViewerPage key="reload" />)
        await flush()
        expect(q('artifact-viewer-page-status')!.textContent).toContain('Open this artifact again')
    })

    it('sweeps records older than 10 minutes on each write', async () => {
        const old = Date.now() - HANDOFF_MAX_AGE_MS - 1000
        await putArtifactHandoff(item({ title: 'old' }), old)
        const fresh = await putArtifactHandoff(item({ title: 'fresh' }), Date.now() - 1000)
        await putArtifactHandoff(item({ title: 'now' }))
        const titles = [...store.records.values()].map(r => (r.item as ArtifactViewerItem).title).sort()
        expect(titles).toEqual(['fresh', 'now'])
        expect(store.records.has(fresh)).toBe(true)
    })

    it('treats an expired record as absent even if it was not swept yet', async () => {
        const handle = await putArtifactHandoff(item(), Date.now() - HANDOFF_MAX_AGE_MS - 5000)
        setSearch(`?h=${handle}`)
        await render(<ArtifactViewerPage />)
        await flush()
        expect(q('artifact-fullscreen-viewer')).toBeNull()
        expect(q('artifact-viewer-page-status')!.textContent).toContain('Open this artifact again')
    })

    it('puts only a random handle in the URL: no id, filename, title or content', async () => {
        const url = await openAndNavigate(item({ title: 'Secret Plan', filename: 'secret-plan.md', text: 'TOPSECRETBODY' }))
        expect(url).toMatch(/^\/artifact-view\?h=[0-9a-f]{32}$/)
        for (const leak of ['secret', 'plan', 'TOPSECRET', 'md']) expect(url.toLowerCase()).not.toContain(leak.toLowerCase())
        const second = vi.mocked(window.open); second.mockClear()
        await openArtifactInNewWindow(item())
        expect(String(second.mock.calls[0]![0])).not.toBe(url)
    })

    it('does not park the driver-install machine list at rest', async () => {
        vi.spyOn(window, 'open').mockReturnValue({ postMessage: vi.fn(), closed: false } as unknown as Window)
        await openArtifactInNewWindow(item({ driverMachines: [{ id: 'dA', label: 'Mac' }] }))
        expect([...store.records.values()][0]!.item).not.toHaveProperty('driverMachines')
    })

    it('does not offer a driver install without an opener', async () => {
        const bundle = JSON.stringify({ format: 'adhdev-driver-bundle', version: 1, type: 'fake-tool', name: 'Fake', treeDigest: 'sha256:x', files: [] })
        await render(<DriverBundleInstallPopout item={item({ kind: 'json', text: bundle, driverMachines: [{ id: 'dA', label: 'Mac' }] })} />)
        expect(q('driver-bundle-install')).toBeNull()
    })
})

describe('when the content cannot be parked or shown', () => {
    it('falls back to the in-page viewer when the store fails: no window is opened', async () => {
        setArtifactHandoffStore({ put: async () => { throw new Error('QuotaExceeded') }, take: async () => null, sweep: async () => {} })
        const open = vi.spyOn(window, 'open')
        expect(await openArtifactInNewWindow(item())).toBe('unavailable')
        expect(open).not.toHaveBeenCalled()
    })

    it('still opens when only the sweep fails', async () => {
        setArtifactHandoffStore({ ...store, sweep: async () => { throw new Error('boom') } })
        vi.spyOn(window, 'open').mockReturnValue({ postMessage: vi.fn(), closed: false } as unknown as Window)
        expect(await openArtifactInNewWindow(item())).toBe('opened')
        expect(store.records.size).toBe(1)
    })

    it('a blocked window leaves nothing parked', async () => {
        vi.spyOn(window, 'open').mockReturnValue(null)
        expect(await openArtifactInNewWindow(item())).toBe('blocked')
        await flush()
        expect(store.records.size).toBe(0)
    })

    it('shows the message plus a back button at once when there is no opener and no handle', async () => {
        await render(<ArtifactViewerPage />)
        await act(async () => { await new Promise(r => setTimeout(r, 5)) }) // the 0 ms timer, not the 5 s one
        expect(q('artifact-viewer-page-status')!.textContent).toContain('Open this artifact again')
        expect(q('artifact-viewer-page-back')!.textContent).toBe('Back to dashboard')
    })

    it('waits for the read (no timeout at 0 ms) when there is a handle', async () => {
        let release!: (v: null) => void
        setArtifactHandoffStore({ ...store, take: () => new Promise(r => { release = r }) })
        setSearch(`?h=${'a'.repeat(32)}`)
        vi.useFakeTimers()
        await render(<ArtifactViewerPage />)
        await act(async () => { vi.advanceTimersByTime(60_000) })
        expect(q('artifact-viewer-page-status')!.textContent).toContain('Waiting')
        expect(q('artifact-viewer-page-back')).toBeNull()
        await act(async () => { release(null); await Promise.resolve() })
        expect(q('artifact-viewer-page-status')!.textContent).toContain('Open this artifact again')
    })

    it('ignores a malformed handle', async () => {
        setSearch('?h=../../etc/passwd')
        await render(<ArtifactViewerPage />)
        await act(async () => { await new Promise(r => setTimeout(r, 5)) }) // the 0 ms timer, not the 5 s one
        expect(q('artifact-viewer-page-status')!.textContent).toContain('Open this artifact again')
    })
})

describe('way back', () => {
    it('viewer opened from the handle without an opener has a Back control', async () => {
        await openAndNavigate(item())
        await render(<ArtifactViewerPage />)
        await flush()
        const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
        vi.spyOn(window.history, 'length', 'get').mockReturnValue(3)
        await act(async () => { (q('artifact-fullscreen-back') as HTMLButtonElement).click() })
        expect(back).toHaveBeenCalledTimes(1)
    })

    it('goBackToDashboard goes back in history, else to /', () => {
        const nav = { assign: vi.fn() }
        const hist = { length: 2, back: vi.fn() }
        goBackToDashboard(hist, nav); expect(hist.back).toHaveBeenCalled(); expect(nav.assign).not.toHaveBeenCalled()
        goBackToDashboard({ ...hist, length: 1, back: vi.fn() }, nav); expect(nav.assign).toHaveBeenCalledWith('/')
    })

    it('has no Back control when the opener is alive (the window is closed instead)', async () => {
        const opener = { postMessage: vi.fn() }
        ;(window as any).opener = opener
        await openAndNavigate(item())
        await render(<ArtifactViewerPage />)
        await flush()
        expect(q('artifact-fullscreen-title')!.textContent).toBe('Secret Plan')
        expect(q('artifact-fullscreen-back')).toBeNull()
    })
})
