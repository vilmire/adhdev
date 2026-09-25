// @vitest-environment jsdom
//
// PROVIDERS TAB — behavioral suite (owner feedback 2026-09-25).
//
// Three complaints, each pinned here against the REAL component driven through
// its only seam (the injected sendDaemonCommand), counting the daemon commands
// it actually sends:
//
//  1. "Every click runs something in the background." The tab re-sent
//     get_provider_settings + check_provider_updates on EVERY status tick once
//     a sync had happened (fetchSettings depended on the `providers` array,
//     which is a new identity per status update), and re-read whole lists after
//     writes that had already succeeded — flipping the Refresh spinner each time.
//  2. A newer provider profile is an inline "Update" next to the provider, and
//     it updates THAT provider only (`only: true`) — not a number badge.
//  3. The "cannot verify" model-list chips and the Create (clone provider)
//     button are gone; the "discovery failed" (stale) chips remain.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ProvidersTab from '../../src/pages/machine/ProvidersTab'
import type { ProviderInfo } from '../../src/pages/machine/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Pin = { type: string; activeVersion: string; latestVersion: string; stale: boolean }

interface Harness {
    calls: Array<{ type: string; args: any }>
    pins: Pin[]
    /** Reply overrides per command type. */
    replies: Record<string, (args: any) => unknown>
}

function makeProviders(overrides: Partial<ProviderInfo> = {}): ProviderInfo[] {
    return [
        { type: 'codex-cli', displayName: 'Codex CLI', icon: '', category: 'cli', enabled: true, machineStatus: 'detected', ...overrides } as any,
        { type: 'claude-cli', displayName: 'Claude Code', icon: '', category: 'cli', enabled: true, machineStatus: 'detected' } as any,
    ]
}

const SCHEMA = [{ key: 'autoApprove', type: 'boolean', default: true, public: true, label: 'Auto approve' }]

function makeSend(h: Harness) {
    return vi.fn(async (_id: string, type: string, args?: any) => {
        h.calls.push({ type, args })
        const override = h.replies[type]
        if (override) return override(args)
        switch (type) {
            case 'get_provider_settings':
                return {
                    success: true,
                    settings: { 'codex-cli': SCHEMA, 'claude-cli': SCHEMA },
                    values: { 'codex-cli': { enabled: true, autoApprove: true }, 'claude-cli': { enabled: true, autoApprove: true } },
                }
            case 'check_provider_updates':
                return {
                    success: true,
                    providers: h.pins,
                    channelStaleness: { staleTypes: h.pins.filter(p => p.stale).map(p => p.type), newTypes: [] },
                    modelStaleness: { cannotVerifyTypes: ['claude-cli', 'hermes-cli'], staleTypes: ['codex-cli'] },
                }
            case 'get_quota_provider_enabled':
                return { enabled: true }
            case 'get_quota_account_label':
                return { enabled: false }
            case 'get_provider_source_config':
                return { success: true }
            case 'activate_provider_updates':
                return { success: true, activated: [{ type: 'codex-cli', from: '1.0.0', to: '1.1.0' }], channelSync: { status: 'activated' } }
            default:
                return { success: true }
        }
    })
}

let container: HTMLDivElement
let root: Root
let h: Harness

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    h = {
        calls: [],
        pins: [
            { type: 'codex-cli', activeVersion: '1.0.0', latestVersion: '1.1.0', stale: true },
            { type: 'claude-cli', activeVersion: '1.0.0', latestVersion: '1.0.0', stale: false },
        ],
        replies: {},
    }
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

async function flush() {
    for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    }
}

const count = (type: string) => h.calls.filter(c => c.type === type).length

async function render(props: Record<string, unknown>) {
    await act(async () => { root.render(<ProvidersTab {...(props as any)} />) })
    await flush()
}

function buttonsByText(text: string): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]'))
        .filter(el => (el.textContent || '').trim() === text || (el.textContent || '').includes(text))
}

function rowCard(displayName: string): HTMLElement {
    const header = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find(b => (b.textContent || '').includes(displayName))
    if (!header) throw new Error(`row ${displayName} not rendered`)
    return header.parentElement as HTMLElement
}

describe('ProvidersTab — no background refetch', () => {
    it('B1: status churn (new providers identity every tick) sends no daemon command', async () => {
        const send = makeSend(h)
        // refreshNonce is passed on purpose: under the old code a non-zero nonce
        // armed an effect that re-fetched whenever fetchSettings changed identity.
        const base = { machineId: 'm1', sendDaemonCommand: send, refreshNonce: 1 }
        await render({ ...base, providers: makeProviders() })
        const settingsBefore = count('get_provider_settings')
        const pinsBefore = count('check_provider_updates')
        for (let i = 0; i < 6; i++) {
            await render({ ...base, providers: makeProviders(i === 5 ? { machineStatus: 'not_detected' } as any : {}) })
        }
        expect(count('get_provider_settings')).toBe(settingsBefore)
        expect(count('check_provider_updates')).toBe(pinsBefore)
    })

    it('B2: provider metadata arriving AFTER the settings read re-derives rows without a refetch', async () => {
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: [] })
        expect(container.textContent).not.toContain('Codex CLI')
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        expect(container.textContent).toContain('Codex CLI')
        expect(count('get_provider_settings')).toBe(1)
    })

    it('B3: disabling a provider is one write — no settings re-read, no spinner', async () => {
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        const before = count('get_provider_settings')
        const refresh = buttonsByText('Refresh')[0] as HTMLButtonElement
        const toggle = rowCard('Codex CLI').querySelector<HTMLElement>('[role="switch"]')!
        let resolveSet: (v: unknown) => void = () => {}
        h.replies.set_provider_setting = () => new Promise(r => { resolveSet = r })
        await act(async () => { toggle.click() })
        // Mid-flight: the explicit-refresh button must not flicker to a spinner.
        expect(refresh.disabled).toBe(false)
        await act(async () => { resolveSet({ success: true }) })
        await flush()
        const sets = h.calls.filter(c => c.type === 'set_provider_setting')
        expect(sets).toHaveLength(1)
        expect(sets[0].args).toMatchObject({ providerType: 'codex-cli', key: 'enabled', value: false })
        expect(count('get_provider_settings')).toBe(before)
        expect(refresh.disabled).toBe(false)
    })

    it('B4: a successful quota toggle does not fan out re-reads; a refused one reconciles only that provider', async () => {
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        const card = rowCard('Codex CLI')
        await act(async () => { (card.querySelector('button') as HTMLButtonElement).click() }) // expand
        const quotaSwitch = () => card.querySelector<HTMLElement>('[role="switch"][aria-label="Quota tracking"]')!
        const before = count('get_quota_provider_enabled')
        await act(async () => { quotaSwitch().click() })
        await flush()
        expect(count('set_quota_provider_enabled')).toBe(1)
        expect(count('get_quota_provider_enabled')).toBe(before)

        h.replies.set_quota_provider_enabled = () => ({ success: false, error: 'nope' })
        await act(async () => { quotaSwitch().click() })
        await flush()
        const reReads = h.calls.slice().filter(c => c.type === 'get_quota_provider_enabled').slice(before)
        expect(reReads).toHaveLength(1)
        expect(reReads[0].args).toEqual({ providerType: 'codex-cli' })
    })

    it('B5: Detect does not re-read settings (detection lands via status)', async () => {
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        const card = rowCard('Codex CLI')
        await act(async () => { (card.querySelector('button') as HTMLButtonElement).click() })
        const before = count('get_provider_settings')
        const detect = Array.from(card.querySelectorAll('button')).find(b => b.textContent === 'Detect')!
        await act(async () => { detect.click() })
        await flush()
        expect(count('detect_provider')).toBe(1)
        expect(count('get_provider_settings')).toBe(before)
    })
})

describe('ProvidersTab — inline per-provider Update', () => {
    it('B6: a stale provider shows "Update" in its collapsed header; clicking updates ONLY that provider', async () => {
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        const codexUpdate = Array.from(rowCard('Codex CLI').querySelectorAll<HTMLElement>('[role="button"]'))
            .filter(el => el.textContent === 'Update')
        expect(codexUpdate).toHaveLength(1)
        expect(Array.from(rowCard('Claude Code').querySelectorAll('[role="button"]')).some(el => el.textContent === 'Update')).toBe(false)
        // One stale provider → no "Update all".
        expect(buttonsByText('Update all')).toHaveLength(0)

        const pinsBefore = count('check_provider_updates')
        const headerExpandedBefore = container.textContent?.includes('Roll back')
        await act(async () => { codexUpdate[0].click() })
        await flush()
        const activations = h.calls.filter(c => c.type === 'activate_provider_updates')
        expect(activations).toHaveLength(1)
        expect(activations[0].args).toEqual({ types: ['codex-cli'], only: true })
        expect(count('check_provider_updates')).toBe(pinsBefore + 1)
        // The click did not also toggle the row open (stopPropagation).
        expect(container.textContent?.includes('Roll back')).toBe(headerExpandedBefore)
    })

    it('B6b: "Update all" appears only when several providers are behind, and sends the full sync', async () => {
        h.pins = h.pins.map(p => ({ ...p, latestVersion: '1.1.0', stale: true }))
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        const all = buttonsByText('Update all')
        expect(all).toHaveLength(1)
        await act(async () => { all[0].click() })
        await flush()
        const activations = h.calls.filter(c => c.type === 'activate_provider_updates')
        expect(activations).toHaveLength(1)
        expect(activations[0].args).toEqual({})
    })

    it('B9: reports channel staleness up so the tab dot needs no extra command', async () => {
        const send = makeSend(h)
        const onChannelStaleness = vi.fn()
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders(), onChannelStaleness })
        expect(onChannelStaleness).toHaveBeenCalledWith({ staleTypes: ['codex-cli'], newTypes: [] })
        expect(count('get_status_metadata')).toBe(0)
    })
})

describe('ProvidersTab — removed surfaces', () => {
    it('B7: model list keeps the "discovery failed" chip and drops "cannot verify"', async () => {
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        const text = container.textContent || ''
        expect(text).toContain('Model lists')
        expect(text).toContain('unverified')
        expect(text.toLowerCase()).not.toContain('cannot verify')
        expect(text).not.toContain('hermes-cli')
        expect(text).not.toContain('machine.providers.')
    })

    it('B8: there is no Create (clone provider) button, and the modal is gone', async () => {
        const send = makeSend(h)
        await render({ machineId: 'm1', sendDaemonCommand: send, providers: makeProviders() })
        expect(buttonsByText('Create')).toHaveLength(0)
        // A missing i18n key would render raw — make sure it is not that either.
        expect(container.textContent).not.toContain('machine.providers.create')
        expect(fs.existsSync(path.join(import.meta.dirname, '../../src/pages/machine/ProviderCloneModal.tsx'))).toBe(false)
    })
})
