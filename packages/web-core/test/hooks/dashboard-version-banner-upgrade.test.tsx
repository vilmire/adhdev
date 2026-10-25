// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDashboardVersionBanner } from '../../src/hooks/useDashboardVersionBanner'
import { DAEMON_UPGRADE_POLICY_UNAVAILABLE_MESSAGE } from '../../src/utils/daemon-upgrade-command'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The banner's update button used to end in a bare "retry" with no reason, and the
// cause (no update policy on the entry) was invisible. It now goes through the shared
// helper and surfaces the reason, still sending nothing when the policy is missing.
let root: Root | null = null
afterEach(() => { act(() => root?.unmount()); root = null })

function mount(ides: any[], send: any) {
    const out: { current: ReturnType<typeof useDashboardVersionBanner> | null } = { current: null }
    function Probe() { out.current = useDashboardVersionBanner({ ides, sendDaemonCommand: send }); return null }
    const el = document.createElement('div')
    root = createRoot(el)
    act(() => root!.render(<Probe />))
    return out
}

const base = { id: 'daemon_mach_1', type: 'adhdev-daemon', version: '1.0.82-rc.30' }

describe('dashboard version banner upgrade', () => {
    it('without an update policy it sends nothing and shows why', async () => {
        const send = vi.fn()
        const h = mount([{ ...base, versionMismatch: true, serverVersion: '1.0.82-rc.31' }], send)
        await act(async () => { await h.current!.handleBannerUpgrade('daemon_mach_1') })
        expect(send).not.toHaveBeenCalled()
        expect(h.current!.upgradingDaemons['daemon_mach_1']).toBe('error')
        expect(h.current!.upgradeMessages['daemon_mach_1']).toBe(DAEMON_UPGRADE_POLICY_UNAVAILABLE_MESSAGE)
    })

    it('with the server policy it sends daemon_upgrade and reports the start', async () => {
        const send = vi.fn().mockResolvedValue({ result: { success: true, version: '1.0.82-rc.31' } })
        const h = mount([{ ...base, versionMismatch: true, serverVersion: '1.0.82-rc.31', updatePolicy: { channel: 'preview', targetVersion: '1.0.82-rc.31' } }], send)
        await act(async () => { await h.current!.handleBannerUpgrade('daemon_mach_1') })
        expect(send).toHaveBeenCalledWith('daemon_mach_1', 'daemon_upgrade', {})
        expect(h.current!.upgradingDaemons['daemon_mach_1']).toBe('done')
        expect(h.current!.upgradeMessages['daemon_mach_1']).toMatch(/1\.0\.82-rc\.31/)
    })

    it('a daemon-side failure is shown with its error text', async () => {
        const send = vi.fn().mockResolvedValue({ result: { success: false, error: 'npm registry unreachable' } })
        const h = mount([{ ...base, versionMismatch: true, updatePolicy: { channel: 'preview' } }], send)
        await act(async () => { await h.current!.handleBannerUpgrade('daemon_mach_1') })
        expect(h.current!.upgradingDaemons['daemon_mach_1']).toBe('error')
        expect(h.current!.upgradeMessages['daemon_mach_1']).toBe('npm registry unreachable')
    })
})
