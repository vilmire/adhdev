// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    RemoteProjectAttachSection,
    REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND,
    type RemoteProjectAttachMachine,
} from '../../../src/components/settings/RemoteProjectAttachSection'

import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const LOCALES: Record<string, any> = { en, ko, ja, 'zh-CN': zhCN, es }

async function flush() {
    for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('RemoteProjectAttachSection (owner-only per-machine switch)', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    it('defaults to OFF per machine, shows the both-machines note, loads current values, and toggles via remote_project_attach_settings', async () => {
        const stateByDaemon: Record<string, boolean> = {
            daemon_mach_source1: false,
            daemon_mach_target1: true,
        }
        const sendCommand = vi.fn(async (daemonId: string, command: string, payload?: Record<string, unknown>) => {
            expect(command).toBe(REMOTE_PROJECT_ATTACH_SETTINGS_COMMAND)
            if (payload?.action === 'get') {
                return {
                    success: true,
                    allowRemoteProjectAttach: stateByDaemon[daemonId] ?? false,
                    enabled: stateByDaemon[daemonId] ?? false,
                }
            }
            if (payload?.action === 'set') {
                const next = Boolean(payload.enabled)
                stateByDaemon[daemonId] = next
                return {
                    success: true,
                    allowRemoteProjectAttach: next,
                    enabled: next,
                }
            }
            return { success: false, error: 'unexpected action' }
        })

        const machines: RemoteProjectAttachMachine[] = [
            { id: 'daemon_mach_source1', name: 'SourceMac', hostname: 'source-mac', online: true },
            { id: 'daemon_mach_target1', name: 'MainPC', hostname: 'mainpc-win', online: true },
            { id: 'daemon_mach_offline1', name: 'Laptop', hostname: 'laptop', online: false },
        ]

        await act(async () => {
            root.render(<RemoteProjectAttachSection machines={machines} sendCommand={sendCommand} />)
            await flush()
        })

        // Shows the note that both machines must have the setting enabled
        const note = container.querySelector('[data-testid="remote-project-attach-both-note"]')
        expect(note).not.toBeNull()
        expect(note!.textContent).toContain('Both the source and target machines')

        // Queries each online machine with action: 'get'
        expect(sendCommand).toHaveBeenCalledWith('daemon_mach_source1', 'remote_project_attach_settings', { action: 'get' })
        expect(sendCommand).toHaveBeenCalledWith('daemon_mach_target1', 'remote_project_attach_settings', { action: 'get' })
        expect(sendCommand).not.toHaveBeenCalledWith('daemon_mach_offline1', expect.anything(), expect.anything())

        const switches = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
        expect(switches).toHaveLength(3)
        // SourceMac starts OFF (false), MainPC loaded ON (true), Laptop is offline (disabled & OFF)
        expect(switches[0].getAttribute('aria-checked')).toBe('false')
        expect(switches[1].getAttribute('aria-checked')).toBe('true')
        expect(switches[2].getAttribute('aria-checked')).toBe('false')
        expect(switches[2].disabled).toBe(true)

        // Owner toggles SourceMac ON
        await act(async () => {
            switches[0].click()
            await flush()
        })
        expect(sendCommand).toHaveBeenCalledWith('daemon_mach_source1', 'remote_project_attach_settings', {
            action: 'set',
            enabled: true,
        })
        expect(switches[0].getAttribute('aria-checked')).toBe('true')

        // Owner toggles MainPC OFF
        await act(async () => {
            switches[1].click()
            await flush()
        })
        expect(sendCommand).toHaveBeenCalledWith('daemon_mach_target1', 'remote_project_attach_settings', {
            action: 'set',
            enabled: false,
        })
        expect(switches[1].getAttribute('aria-checked')).toBe('false')
    })

    it('surfaces an error banner if toggling fails and keeps the previous switch state', async () => {
        const sendCommand = vi.fn(async (_daemonId: string, _command: string, payload?: Record<string, unknown>) => {
            if (payload?.action === 'get') {
                return { success: true, allowRemoteProjectAttach: false, enabled: false }
            }
            return { success: false, error: 'Disk full while saving config.json' }
        })

        const machines: RemoteProjectAttachMachine[] = [
            { id: 'daemon_mach_source1', name: 'SourceMac', online: true },
        ]

        await act(async () => {
            root.render(<RemoteProjectAttachSection machines={machines} sendCommand={sendCommand} />)
            await flush()
        })

        const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
        expect(toggle.getAttribute('aria-checked')).toBe('false')

        await act(async () => {
            toggle.click()
            await flush()
        })

        expect(toggle.getAttribute('aria-checked')).toBe('false')
        const errorBanner = container.querySelector('[data-testid="remote-project-attach-error"]')
        expect(errorBanner).not.toBeNull()
        expect(errorBanner!.textContent).toContain('Disk full while saving config.json')
    })

    it('defines all settings.remoteProjectAttach i18n keys across all 5 locales', () => {
        const requiredKeys = [
            'sectionTitle',
            'sectionDescription',
            'bothMachinesNote',
            'rowDescription',
            'noMachines',
            'statusOn',
            'statusOff',
            'statusOffline',
            'saveFailed',
        ]
        for (const [locale, bundle] of Object.entries(LOCALES)) {
            const section = bundle?.settings?.remoteProjectAttach
            expect(section, `missing settings.remoteProjectAttach in ${locale}`).toBeDefined()
            for (const key of requiredKeys) {
                expect(typeof section[key], `${locale}.settings.remoteProjectAttach.${key}`).toBe('string')
                expect(section[key].trim().length, `${locale}.settings.remoteProjectAttach.${key} non-empty`).toBeGreaterThan(0)
            }
        }
    })
})
