// @vitest-environment jsdom
/**
 * The pop-out artifact window has no daemon connection (by design), so its "Install driver" bar
 * relays the install to the opener: the opener serves its machine list with the payload, answers
 * install requests with its own copy of the bundle, and only for machines it listed.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ARTIFACT_VIEWER_DRIVER_INSTALL,
    ARTIFACT_VIEWER_DRIVER_RESULT,
    ARTIFACT_VIEWER_PATH,
    ARTIFACT_VIEWER_READY,
    isArtifactPopoutWirePayload,
    openArtifactInNewWindow,
} from '../../src/components/attachments/artifact-popout'
import { DriverBundleInstallPopout } from '../../src/components/attachments/DriverBundleInstall'
import type { ArtifactViewerItem } from '../../src/components/attachments/artifact-viewer-item'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const bundle = JSON.stringify({ format: 'adhdev-driver-bundle', version: 1, type: 'fake-tool', name: 'Fake Tool', treeDigest: 'sha256:x', files: [] })
const item = (over: Partial<ArtifactViewerItem> = {}): ArtifactViewerItem => ({ title: 't', filename: 'fake-tool.driver-bundle.json', kind: 'json',
    mime: 'application/json', sizeBytes: bundle.length, text: bundle, blob: null, ...over })

afterEach(() => { vi.restoreAllMocks() })

describe('opener side of the pop-out driver install', () => {
    function openWith(install: (id: string) => Promise<{ ok: boolean; code?: string }>) {
        const win = { postMessage: vi.fn(), closed: false } as unknown as Window
        vi.spyOn(window, 'open').mockReturnValue(win)
        expect(openArtifactInNewWindow(item(), { driverInstall: { machines: [{ id: 'dA', label: 'Mac' }], install } })).toBe(true)
        const send = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: win }))
        return { win: win as unknown as { postMessage: ReturnType<typeof vi.fn> }, send }
    }

    it('serves the machine list with the payload and validates it on the wire', () => {
        const { win, send } = openWith(async () => ({ ok: true }))
        expect(window.open).toHaveBeenCalledWith(ARTIFACT_VIEWER_PATH, '_blank', expect.any(String))
        send({ type: ARTIFACT_VIEWER_READY })
        const payload = win.postMessage.mock.calls[0][0].payload
        expect(payload.driverMachines).toEqual([{ id: 'dA', label: 'Mac' }])
        expect(isArtifactPopoutWirePayload(payload)).toBe(true)
        expect(isArtifactPopoutWirePayload({ ...payload, driverMachines: [{ id: 1 }] })).toBe(false)
    })

    it('runs the install for a listed machine and answers the request, refusing unlisted targets', async () => {
        const install = vi.fn(async () => ({ ok: false, code: 'type_conflict' }))
        const { win, send } = openWith(install)
        await act(async () => { send({ type: ARTIFACT_VIEWER_DRIVER_INSTALL, requestId: 'r1', targetId: 'dA' }); await Promise.resolve() })
        expect(install).toHaveBeenCalledWith('dA')
        expect(win.postMessage).toHaveBeenCalledWith({ type: ARTIFACT_VIEWER_DRIVER_RESULT, requestId: 'r1', ok: false, code: 'type_conflict' }, window.location.origin)
        await act(async () => { send({ type: ARTIFACT_VIEWER_DRIVER_INSTALL, requestId: 'r2', targetId: 'evil' }); await Promise.resolve() })
        expect(install).toHaveBeenCalledTimes(1)
        expect(win.postMessage).toHaveBeenCalledWith({ type: ARTIFACT_VIEWER_DRIVER_RESULT, requestId: 'r2', ok: false, code: 'unknown_target' }, window.location.origin)
    })
})

describe('DriverBundleInstallPopout', () => {
    let root: Root | null = null
    let host: HTMLElement | null = null
    afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; delete (window as any).opener })
    async function mount(shown: ArtifactViewerItem) {
        host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
        await act(async () => { root!.render(<DriverBundleInstallPopout item={shown} />) })
        return host
    }

    it('renders nothing without opener-supplied machines', async () => {
        const el = await mount(item())
        expect(el.querySelector('[data-testid="driver-bundle-install"]')).toBeNull()
    })

    it('asks the opener to install on the chosen machine and shows the outcome', async () => {
        const opener = { closed: false, postMessage: vi.fn() }
        ;(window as any).opener = opener
        const el = await mount(item({ driverMachines: [{ id: 'dA', label: 'Mac' }, { id: 'dB', label: 'Win' }] }))
        const select = el.querySelector('[data-testid="driver-bundle-target"]') as HTMLSelectElement
        expect([...select.options].map(o => o.value)).toEqual(['dA', 'dB'])
        await act(async () => { select.value = 'dB'; select.dispatchEvent(new Event('change', { bubbles: true })) })
        await act(async () => { (el.querySelector('[data-testid="driver-bundle-install-button"]') as HTMLButtonElement).click() })
        const sent = opener.postMessage.mock.calls[0][0]
        expect(sent).toMatchObject({ type: ARTIFACT_VIEWER_DRIVER_INSTALL, targetId: 'dB' })
        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: { type: ARTIFACT_VIEWER_DRIVER_RESULT, requestId: sent.requestId, ok: true }, origin: window.location.origin, source: opener as any }))
            await Promise.resolve()
        })
        expect(el.querySelector('[data-testid="driver-bundle-outcome"]')?.textContent).toMatch(/Needs you|확인 필요|approve|installed|설치/i)
    })
})
