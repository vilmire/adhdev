// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DriverPermissionsSection, type DriverPermissionsMachine } from '../../../src/components/settings/DriverPermissionsSection'
import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function setValue(el: HTMLSelectElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
}

const ONE: DriverPermissionsMachine[] = [{ id: 'daemon_a', name: 'MacA', online: true }]
const TWO: DriverPermissionsMachine[] = [
    { id: 'daemon_a', name: 'MacA', online: true },
    { id: 'daemon_b', name: 'WinB', online: false },
    { id: 'daemon_c', name: 'LinC', online: true },
]

const driver = (over: Record<string, unknown> = {}, granted: Record<string, boolean> = {}) => ({
    type: 'computer-use',
    name: 'Computer Use',
    providerVersion: '1.2.3',
    activation: 'ready',
    platformSupported: true,
    grants: [
        { id: 'screen', title: 'Manifest screen', description: 'Manifest screen desc', granted: granted.screen === true },
        { id: 'input', title: 'Manifest input', description: 'Manifest input desc', granted: granted.input === true },
        { id: 'custom', title: 'Manifest custom', description: 'Manifest custom desc', granted: granted.custom === true },
    ],
    ...over,
})

describe('DriverPermissionsSection', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove() })
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const mount = async (machines: DriverPermissionsMachine[], send: any) => {
        await act(async () => { root.render(<DriverPermissionsSection machines={machines} sendCommand={send} />); await flush() })
    }

    it('renders grants from the reply, default unchecked, with translation before manifest text', async () => {
        const send = vi.fn(async () => ({ drivers: [driver()] }))
        await mount(ONE, send)
        expect(send).toHaveBeenCalledWith('daemon_a', 'driver_grants_get', {})
        expect(q('driver-permissions-card-computer-use')!.textContent).toContain('Computer Use')
        expect(q('driver-permissions-card-computer-use')!.textContent).toContain('v1.2.3')
        for (const id of ['screen', 'input', 'custom']) expect((q(`driver-permissions-toggle-computer-use-${id}`) as HTMLInputElement).checked).toBe(false)
        // translated for known ids, manifest text for unknown ones
        expect(q('driver-permissions-grant-computer-use-screen')!.textContent).toContain('Screen capture')
        expect(q('driver-permissions-grant-computer-use-custom')!.textContent).toContain('Manifest custom desc')
        expect(q('driver-permissions-os-hint-computer-use')).not.toBeNull()
        expect(q('driver-permissions-warning')).not.toBeNull()
    })

    it('single machine has no picker; several machines do, with offline disabled', async () => {
        await mount(ONE, vi.fn(async () => ({ drivers: [] })))
        expect(q('driver-permissions-machine')).toBeNull()
        act(() => root.unmount()); root = createRoot(container)
        const send = vi.fn(async () => ({ drivers: [driver()] }))
        await mount(TWO, send)
        const picker = q('driver-permissions-machine') as HTMLSelectElement
        expect(picker).not.toBeNull()
        const opts = Array.from(picker.options)
        expect(opts.find(o => o.value === 'daemon_b')!.disabled).toBe(true)
        expect(opts.find(o => o.value === 'daemon_c')!.disabled).toBe(false)
        expect(send).not.toHaveBeenCalled()
        await act(async () => { setValue(picker, 'daemon_c'); await flush() })
        expect(send).toHaveBeenCalledWith('daemon_c', 'driver_grants_get', {})
    })

    it('a lone offline machine is not queried', async () => {
        const send = vi.fn()
        await mount([{ id: 'daemon_a', name: 'MacA', online: false }], send)
        expect(q('driver-permissions-offline')).not.toBeNull()
        expect(send).not.toHaveBeenCalled()
    })

    it('toggle sends the payload and adopts the reply as the new state', async () => {
        const send = vi.fn(async (_id: string, cmd: string) => cmd === 'driver_grants_get'
            ? { drivers: [driver()] }
            : driver({}, { screen: true, custom: true }))
        await mount(ONE, send)
        await act(async () => { q('driver-permissions-toggle-computer-use-screen')!.click(); await flush() })
        expect(send).toHaveBeenCalledWith('daemon_a', 'driver_grants_set', { type: 'computer-use', grants: { screen: true } })
        expect((q('driver-permissions-toggle-computer-use-screen') as HTMLInputElement).checked).toBe(true)
        // the reply is authoritative (the daemon also reports `custom` on)
        expect((q('driver-permissions-toggle-computer-use-custom') as HTMLInputElement).checked).toBe(true)
    })

    it('rolls back and shows an error when saving fails', async () => {
        const send = vi.fn(async (_id: string, cmd: string) => { if (cmd === 'driver_grants_set') throw new Error('boom'); return { drivers: [driver()] } })
        await mount(ONE, send)
        await act(async () => { q('driver-permissions-toggle-computer-use-screen')!.click(); await flush() })
        expect((q('driver-permissions-toggle-computer-use-screen') as HTMLInputElement).checked).toBe(false)
        expect(q('driver-permissions-error')!.textContent).toContain(en.settings.driverPermissions.saveFailed)
    })

    it('rolls back on a failure reply with a code', async () => {
        const send = vi.fn(async (_id: string, cmd: string) => cmd === 'driver_grants_set' ? { success: false, code: 'invalid_arguments' } : { drivers: [driver({}, { input: true })] })
        await mount(ONE, send)
        await act(async () => { q('driver-permissions-toggle-computer-use-input')!.click(); await flush() })
        expect((q('driver-permissions-toggle-computer-use-input') as HTMLInputElement).checked).toBe(true)
        expect(q('driver-permissions-error')!.textContent).toContain('invalid_arguments')
    })

    it('turning input on swaps the muted warning for a warning banner with both facts', async () => {
        const send = vi.fn(async (_id: string, cmd: string) => cmd === 'driver_grants_get' ? { drivers: [driver()] } : driver({}, { input: true }))
        await mount(ONE, send)
        expect(q('driver-permissions-warning-strong')).toBeNull()
        expect(q('driver-permissions-warning')!.textContent).toContain(en.settings.driverPermissions.warning.control)
        await act(async () => { q('driver-permissions-toggle-computer-use-input')!.click(); await flush() })
        expect(q('driver-permissions-warning')).toBeNull()
        const strong = q('driver-permissions-warning-strong')!
        expect(strong.textContent).toContain(en.settings.driverPermissions.warning.control)
        expect(strong.textContent).toContain(en.settings.driverPermissions.warning.approval)
    })

    it('shows the approvals notice for needs_approval', async () => {
        await mount(ONE, vi.fn(async () => ({ drivers: [driver({ activation: 'needs_approval', stagedId: 's1' })] })))
        expect(q('driver-permissions-needs-approval-computer-use')).not.toBeNull()
    })

    it('disables the checkboxes on an unsupported platform', async () => {
        await mount(ONE, vi.fn(async () => ({ drivers: [driver({ platformSupported: false })] })))
        expect(q('driver-permissions-unsupported-computer-use')).not.toBeNull()
        for (const id of ['screen', 'input', 'custom']) expect((q(`driver-permissions-toggle-computer-use-${id}`) as HTMLInputElement).disabled).toBe(true)
    })

    it('explains the empty state, ignoring drivers without grants', async () => {
        await mount(ONE, vi.fn(async () => ({ drivers: [driver({ grants: [] })] })))
        expect(q('driver-permissions-empty')!.textContent).toContain('not installed')
    })

    it('handles request failure with retry, and an old daemon with an update notice', async () => {
        const send = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ drivers: [driver()] })
        await mount(ONE, send)
        expect(q('driver-permissions-load-failed')).not.toBeNull()
        await act(async () => { q('driver-permissions-retry')!.click(); await flush() })
        expect(q('driver-permissions-card-computer-use')).not.toBeNull()

        act(() => root.unmount()); root = createRoot(container)
        await mount(ONE, vi.fn(async () => ({ success: false, error: 'Unknown command: driver_grants_get' })))
        expect(q('driver-permissions-outdated')).not.toBeNull()
        act(() => root.unmount()); root = createRoot(container)
        await mount(ONE, vi.fn(async () => { throw new Error('Unknown command: driver_grants_get') }))
        expect(q('driver-permissions-outdated')).not.toBeNull()
    })

    it('unwraps the cloud envelope (`result`)', async () => {
        await mount(ONE, vi.fn(async () => ({ result: { drivers: [driver()] } })))
        expect(q('driver-permissions-card-computer-use')).not.toBeNull()
    })
})

describe('driverPermissions locales', () => {
    const flat = (o: any, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]))
    it('has the same keys in all five locales', () => {
        const base = flat((en as any).settings.driverPermissions).sort()
        for (const l of [ko, ja, zhCN, es]) expect(flat((l as any).settings.driverPermissions).sort()).toEqual(base)
    })
})
