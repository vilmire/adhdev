// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactViewerItem } from '../../src/components/attachments/artifact-viewer-item'

const daemons = vi.hoisted(() => ({ ides: [] as any[] }))
vi.mock('../../src/context/BaseDaemonContext', () => ({ useBaseDaemons: () => ({ ides: daemons.ides }) }))
import DriverBundleInstall, { isDriverBundleItem, peekDriverBundle, unwrapDriverImportReply } from '../../src/components/attachments/DriverBundleInstall'
import { TransportProvider } from '../../src/context/TransportContext'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const bundle = JSON.stringify({ format: 'adhdev-driver-bundle', version: 1, type: 'fake-tool', name: 'Fake Tool', treeDigest: 'sha256:x', files: [] })
const item = (over: Partial<ArtifactViewerItem> = {}): ArtifactViewerItem => ({ title: 't', filename: 'fake-tool.driver-bundle.json', kind: 'json',
    mime: 'application/json', sizeBytes: bundle.length, text: bundle, blob: null, ...over })

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; daemons.ides = [] })
async function mount(sendCommand: (id: string, type: string, payload?: any) => Promise<any>, shown: ArtifactViewerItem = item()) {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root!.render(<TransportProvider value={{ sendCommand }}><DriverBundleInstall item={shown} /></TransportProvider>) })
    return host
}
const button = (el: HTMLElement) => el.querySelector('[data-testid="driver-bundle-install-button"]') as HTMLButtonElement

describe('driver bundle artifact detection', () => {
    it('only json artifacts named *.driver-bundle.json with text qualify', () => {
        expect(isDriverBundleItem(item())).toBe(true)
        expect(isDriverBundleItem(item({ filename: 'notes.json' }))).toBe(false)
        expect(isDriverBundleItem(item({ kind: 'text' }))).toBe(false)
        expect(isDriverBundleItem(item({ text: null }))).toBe(false)
        expect(peekDriverBundle(bundle)).toEqual({ type: 'fake-tool', name: 'Fake Tool' })
        expect(peekDriverBundle('{"format":"other"}')).toBeNull()
        expect(peekDriverBundle('nope')).toBeNull()
    })
    it('unwraps the cloud P2P envelope and the raw standalone body', () => {
        expect(unwrapDriverImportReply({ success: true, result: { success: false, code: 'type_conflict' } })).toMatchObject({ code: 'type_conflict' })
        expect(unwrapDriverImportReply({ success: true, type: 'x' })).toMatchObject({ success: true, type: 'x' })
    })
})

describe('DriverBundleInstall', () => {
    it('without a known machine the button is disabled instead of guessing a target', async () => {
        const send = vi.fn()
        const el = await mount(send)
        expect(button(el).disabled).toBe(true)
        expect(send).not.toHaveBeenCalled()
    })
    it('sends the bundle to the chosen machine as driver_import and reports the approval hint', async () => {
        daemons.ides = [{ id: 'daemon-a', type: 'adhdev-daemon', hostname: 'mac' }, { id: 'daemon-b', type: 'adhdev-daemon', nickname: 'win-box' }, { id: 'ide-1', type: 'cursor' }]
        const send = vi.fn(async () => ({ success: true, result: { success: true, stagedId: 'driver-activation-1' } }))
        const el = await mount(send)
        const select = el.querySelector('[data-testid="driver-bundle-target"]') as HTMLSelectElement
        expect([...select.options].map(o => o.value)).toEqual(['daemon-a', 'daemon-b'])
        await act(async () => { select.value = 'daemon-b'; select.dispatchEvent(new Event('change', { bubbles: true })) })
        await act(async () => { button(el).click() })
        expect(send).toHaveBeenCalledWith('daemon-b', 'driver_import', { bundle })
        expect(el.querySelector('[data-testid="driver-bundle-outcome"]')?.textContent).toMatch(/Needs you|확인 필요|approve/i)
    })
    it('surfaces the daemon refusal code (including the cloud envelope) and thrown errors', async () => {
        daemons.ides = [{ id: 'daemon-a', type: 'adhdev-daemon' }]
        const el = await mount(vi.fn(async () => ({ success: true, result: { success: false, code: 'bundle_digest_mismatch' } })))
        await act(async () => { button(el).click() })
        expect(el.querySelector('[data-testid="driver-bundle-outcome"]')?.textContent).toContain('bundle_digest_mismatch')
    })
    it('renders nothing for a json that is not a driver bundle', async () => {
        const el = await mount(vi.fn(), item({ text: '{"a":1}' }))
        expect(el.querySelector('[data-testid="driver-bundle-install"]')).toBeNull()
    })
})
