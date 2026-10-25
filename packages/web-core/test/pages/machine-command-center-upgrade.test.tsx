// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MachineCommandCenter from '../../src/pages/machine/MachineCommandCenter'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The machine-detail update button gave no feedback at all; a refused or failed
// upgrade looked exactly like nothing happening.
let root: Root | null = null
afterEach(() => { act(() => root?.unmount()); root = null })

function render(upgradeState: any) {
    const el = document.createElement('div')
    root = createRoot(el)
    const entry: any = { id: 'daemon_mach_1', type: 'adhdev-daemon', version: '1.0.82-rc.30', serverVersion: '1.0.82-rc.31', versionMismatch: true, updatePolicy: { channel: 'preview', targetVersion: '1.0.82-rc.31' } }
    act(() => root!.render(<MachineCommandCenter machineEntry={entry} providers={[]} recentLaunches={[]} currentConversations={[]} onUpgradeDaemon={vi.fn()} upgradeState={upgradeState} onOpenRecent={vi.fn()} onOpenConversation={vi.fn()} />))
    return el
}

describe('machine command center update feedback', () => {
    it('shows the failure reason after a refused upgrade', () => {
        const el = render({ state: 'error', message: 'Cannot update: node update policy unavailable; refresh and try again' })
        expect(el.querySelector('[data-testid="daemon-update-result"]')?.textContent).toMatch(/policy unavailable/)
    })

    it('disables the button while the command is in flight', () => {
        const el = render({ state: 'loading', message: '' })
        expect((el.querySelector('[data-testid="daemon-update-button"]') as HTMLButtonElement)?.disabled).toBe(true)
        expect(el.querySelector('[data-testid="daemon-update-result"]')).toBeNull()
    })
})
