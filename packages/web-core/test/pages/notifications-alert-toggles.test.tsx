// @vitest-environment jsdom
//
// Notifications page = alert toggles only (UI simplification 2026-09-27).
// The per-category auto-approve bulk switch (not a notification), the raw
// CLI/ACP/IDE category headers, the (on/total) counters and the per-provider
// rows that duplicated Machine → Providers are gone. What stays: browser alert
// toggles, and two agent alerts ("Approval needed", "No progress") applied to
// every provider, plus a link to Machine → Providers for per-provider tuning.
// Auto-approve stays configurable in Provider settings, New Session → Advanced
// and the mesh's Advanced settings.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NotificationsPage from '../../src/pages/Notifications'
import { TransportProvider } from '../../src/context/TransportContext'

// Daemon shape: settings = providerType → schema[], values = providerType → values.
const SETTINGS_PAYLOAD = {
    success: true,
    settings: {
        'claude-cli': [
            { key: 'autoApprove', type: 'boolean', default: false, label: 'Auto approve' },
            { key: 'approvalAlert', type: 'boolean', default: true, label: 'Approval alert' },
            { key: 'noProgressAlert', type: 'boolean', default: true, label: 'No progress alert' },
        ],
        'codex-cli': [
            { key: 'autoApprove', type: 'boolean', default: false, label: 'Auto approve' },
            { key: 'approvalAlert', type: 'boolean', default: true, label: 'Approval alert' },
            { key: 'longGeneratingAlert', type: 'boolean', default: true, label: 'Long generating alert' },
        ],
    },
    values: {
        'claude-cli': { approvalAlert: true, noProgressAlert: false },
        'codex-cli': { approvalAlert: true, longGeneratingAlert: true },
    },
}

const MACHINE = {
    id: 'daemon_1',
    machineId: 'mach_1',
    hostname: 'devbox',
    status: 'online',
    providers: [
        { type: 'claude-cli', name: 'Claude', displayName: 'Claude Code', category: 'cli', icon: 'claude' },
        { type: 'codex-cli', name: 'Codex', displayName: 'Codex', category: 'cli', icon: 'codex' },
    ],
}

describe('Notifications page — alert toggles only', () => {
    let container: HTMLDivElement
    let root: Root
    let sendCommand: ReturnType<typeof vi.fn>

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        sendCommand = vi.fn(async (_id: string, type: string) => (type === 'get_provider_settings' ? SETTINGS_PAYLOAD : { success: true }))
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    async function render() {
        await act(async () => {
            root.render(
                <MemoryRouter>
                    <TransportProvider value={{ sendCommand: sendCommand as any }}>
                        <NotificationsPage machines={[MACHINE as any]} />
                    </TransportProvider>
                </MemoryRouter>,
            )
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
        })
    }

    it('shows two agent alert toggles and no auto-approve / category / per-provider rows', async () => {
        await render()
        const section = container.querySelector('[data-testid="agent-alert-toggles"]') as HTMLElement
        expect(section).not.toBeNull()
        const switches = Array.from(section.querySelectorAll('[role="switch"]'))
        expect(switches).toHaveLength(2)
        const text = container.textContent || ''
        expect(text).toContain('Approval needed')
        expect(text).toContain('No progress')
        expect(text).not.toContain('Auto Approve')
        expect(text).not.toContain('Auto approve')
        expect(text).not.toMatch(/\(\d+\/\d+\)/)
        expect(text).not.toContain('CLI')
        expect(text).not.toContain('Show per-provider details')
        expect(text).not.toContain('Claude Code')
    })

    it('reflects mixed state and applies a toggle to every provider that has the alert (legacy key included)', async () => {
        await render()
        const section = container.querySelector('[data-testid="agent-alert-toggles"]') as HTMLElement
        const [approval, noProgress] = Array.from(section.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
        expect(approval.getAttribute('aria-checked')).toBe('true')
        // claude off + codex on → not "all on", flagged as mixed.
        expect(noProgress.getAttribute('aria-checked')).toBe('false')
        expect(section.textContent).toContain('(some off)')

        await act(async () => { noProgress.click(); await Promise.resolve(); await Promise.resolve() })
        const writes = sendCommand.mock.calls.filter(call => call[1] === 'set_provider_setting').map(call => call[2])
        expect(writes).toEqual(expect.arrayContaining([
            { providerType: 'claude-cli', key: 'noProgressAlert', value: true },
            { providerType: 'codex-cli', key: 'longGeneratingAlert', value: true },
        ]))
        expect(writes.some(write => write.key === 'autoApprove')).toBe(false)
    })

    it('links per-provider tuning to Machine → Providers', async () => {
        await render()
        const link = container.querySelector('[data-testid="per-provider-link"] a') as HTMLAnchorElement
        expect(link).not.toBeNull()
        expect(link.getAttribute('href')).toBe('/machines/daemon_1')
        expect(link.textContent).toBe('Machine → Providers')
    })
})
