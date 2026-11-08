// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DriverGrantsPanel } from '../../../src/components/settings/driverGrants'
import en from '../../../src/i18n/locales/en/common.json'

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

const driver = (over: Record<string, unknown> = {}, on: Record<string, boolean> = {}) => ({
    type: 'computer-use', name: 'Computer Use', providerVersion: '1.0.0', activation: 'ready', platformSupported: true,
    grants: [
        { id: 'screen', title: 'x', description: 'x', granted: on.screen === true },
        { id: 'input', title: 'x', description: 'x', granted: on.input === true },
    ],
    ...over,
})

describe('DriverGrantsPanel (machine Providers tab)', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove() })
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const mount = async (send: any) => { await act(async () => { root.render(<DriverGrantsPanel machineId="daemon_a" sendCommand={send} />); await flush() }) }

    it('shows the activation state and an Approve action that resolves the staged activation', async () => {
        let activation = 'needs_approval'
        const send = vi.fn(async (_id: string, cmd: string) => {
            if (cmd === 'assistant_staged_resolve') { activation = 'ready'; return { success: true } }
            return { drivers: [driver({ activation, stagedId: 'driver-activation-1' }, { screen: true })] }
        })
        await mount(send)
        expect(q('driver-permissions-activation-computer-use')!.textContent).toBe(en.settings.driverPermissions.activation.needs_approval)
        const btn = q('driver-permissions-approve-computer-use') as HTMLButtonElement
        expect(btn.disabled).toBe(false)
        await act(async () => { btn.click(); await flush() })
        expect(send).toHaveBeenCalledWith('daemon_a', 'assistant_staged_resolve', { id: 'driver-activation-1', decision: 'apply' })
        expect(q('driver-permissions-approve-computer-use')).toBeNull()
        expect(q('driver-permissions-activation-computer-use')!.textContent).toBe(en.settings.driverPermissions.activation.ready)
    })

    it('never auto-approves; approve is disabled until a permission is on and absent without a staged request', async () => {
        const send = vi.fn(async () => ({ drivers: [driver({ activation: 'needs_approval', stagedId: 's1' })] }))
        await mount(send)
        expect((q('driver-permissions-approve-computer-use') as HTMLButtonElement).disabled).toBe(true)
        expect(send.mock.calls.some(c => (c as any[])[1] === 'assistant_staged_resolve')).toBe(false)
        act(() => root.unmount()); root = createRoot(container)
        await mount(vi.fn(async () => ({ drivers: [driver({ activation: 'needs_approval' })] })))
        expect(q('driver-permissions-approve-computer-use')).toBeNull()
        expect(q('driver-permissions-needs-approval-computer-use')!.textContent).toContain(en.settings.driverPermissions.needsApprovalNoRequest)
    })

    it('a failed approve reports the code and keeps the driver off', async () => {
        const send = vi.fn(async (_id: string, cmd: string) => cmd === 'assistant_staged_resolve'
            ? { success: false, code: 'stale' }
            : { drivers: [driver({ activation: 'needs_approval', stagedId: 's1' }, { screen: true })] })
        await mount(send)
        await act(async () => { q('driver-permissions-approve-computer-use')!.click(); await flush() })
        expect(q('driver-permissions-error')!.textContent).toContain('stale')
        expect(q('driver-permissions-activation-computer-use')!.textContent).toBe(en.settings.driverPermissions.activation.needs_approval)
    })

    it('a timed-out save that actually landed is not reported as a failure', async () => {
        let landed = false
        const send = vi.fn(async (_id: string, cmd: string) => {
            if (cmd === 'driver_grants_set') { landed = true; throw new Error('Timeout') }
            return { drivers: [driver({}, { screen: landed })] }
        })
        await mount(send)
        await act(async () => { q('driver-permissions-toggle-computer-use-screen')!.click(); await flush() })
        expect(q('driver-permissions-error')).toBeNull()
        expect((q('driver-permissions-toggle-computer-use-screen') as HTMLInputElement).checked).toBe(true)
    })

    it('a timed-out save that did not land rolls back with an error', async () => {
        const send = vi.fn(async (_id: string, cmd: string) => { if (cmd === 'driver_grants_set') throw new Error('Timeout'); return { drivers: [driver()] } })
        await mount(send)
        await act(async () => { q('driver-permissions-toggle-computer-use-screen')!.click(); await flush() })
        expect((q('driver-permissions-toggle-computer-use-screen') as HTMLInputElement).checked).toBe(false)
        expect(q('driver-permissions-error')!.textContent).toContain(en.settings.driverPermissions.saveFailed)
    })
})
